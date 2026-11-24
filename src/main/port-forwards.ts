import type { Client } from 'ssh2'
import { getHost } from './ssh'
import { getRemoteClient } from './sftp'
import { t } from './i18n'
import { openForwardListener, type ForwardListener } from './port-forwards-net'
import {
  ForwardTable,
  forwardTargetChanged,
  listenErrorKind,
  usableForwards,
  type ForwardStatus,
  type PortForward
} from './port-forwards-pure'

/**
 * Local port forwards over a host's pooled SSH connection (sftp.ts getRemoteClient), the
 * one the Remote Session's files and terminal already ride. A tunnel only ever starts from
 * the user's gesture (a Start click, or opening the host's session for an autoStart one)
 * and is never restarted behind their back: when its connection closes it is listed as
 * stopped with the reason, and the user starts it again.
 */

export type { ForwardStatus } from './port-forwards-pure'

const table = new ForwardTable<Client>()
const listeners = new Map<string, ForwardListener>()
/** The connections that already have this module's close listener: one per connection,
 *  however many tunnels ride it. */
const watched = new WeakSet<Client>()

const keyOf = (hostId: string, forwardId: string): string => `${hostId}\u0000${forwardId}`

let onChanged: ((list: ForwardStatus[]) => void) | null = null
/** Set by index.ts, which sends `ssh:forwards-changed` to the window. */
export function setForwardsChangedSink(fn: (list: ForwardStatus[]) => void): void {
  onChanged = fn
}

function emit(): void {
  onChanged?.(table.list())
}

export function listActiveForwards(): ForwardStatus[] {
  return table.list()
}

function closeListener(hostId: string, forwardId: string): void {
  const k = keyOf(hostId, forwardId)
  listeners.get(k)?.close()
  listeners.delete(k)
}

function watchConn(conn: Client): void {
  if (watched.has(conn)) return
  watched.add(conn)
  conn.once('close', () => {
    let any = false
    for (const { hostId, forwardId } of table.runningOn(conn)) {
      closeListener(hostId, forwardId)
      if (table.stop(hostId, forwardId, t('main.forwards.connectionClosed'))) any = true
    }
    if (any) emit()
  })
}

export type StartResult = { ok: true; localPort: number } | { ok: false; error: string }

/**
 * Starts one of a host's saved forwards. Connects first when needed, which may ask for the
 * password: this is only called for the user's click or session. A forward already running
 * answers with its port.
 */
export async function startForward(hostId: string, forwardId: string): Promise<StartResult> {
  const running = table.get(hostId, forwardId)
  if (running?.active) return { ok: true, localPort: running.localPort }
  const host = getHost(hostId)
  if (!host) return { ok: false, error: t('main.ssh.hostNotFound') }
  // Read from the store and checked again: a host from a profile import never went
  // through the save path's validation.
  const forward = usableForwards(host.forwards).find((f) => f.id === forwardId)
  if (!forward) return { ok: false, error: t('main.forwards.notFound') }
  if (!table.begin(hostId, forwardId)) return { ok: false, error: t('main.forwards.starting') }

  let started = false
  try {
    const client = await getRemoteClient(hostId, { interactive: true })
    if (!client.ok) return { ok: false, error: client.error }
    const conn = client.conn
    const res = await openForwardListener({
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      forwardOut: (srcIP, srcPort, dstIP, dstPort, cb) =>
        conn.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, ch) => cb(err, ch)),
      onConnections: (n) => {
        if (table.setConnections(hostId, forwardId, n)) emit()
      },
      onChannel: (error) => {
        const msg = error === undefined ? undefined : t('main.forwards.channelFailed', { error })
        if (table.setError(hostId, forwardId, msg)) emit()
      }
    })
    if (!res.ok) return { ok: false, error: listenFailure(forward, res.code, res.message) }
    table.running(hostId, forward, res.listener.port, conn)
    listeners.set(keyOf(hostId, forwardId), res.listener)
    started = true
    watchConn(conn)
    emit()
    return { ok: true, localPort: res.listener.port }
  } finally {
    if (!started) table.abandon(hostId, forwardId)
  }
}

function listenFailure(f: PortForward, code: string | undefined, message: string): string {
  switch (listenErrorKind(code)) {
    case 'inUse':
      return t('main.forwards.portInUse', { port: f.localPort })
    case 'denied':
      return t('main.forwards.portDenied', { port: f.localPort })
    default:
      return t('main.forwards.listenFailed', { error: message })
  }
}

/** Stops a tunnel the user stopped, or dismisses one that stopped on its own. */
export function stopForward(hostId: string, forwardId: string): { ok: true } {
  closeListener(hostId, forwardId)
  if (table.stop(hostId, forwardId)) emit()
  return { ok: true }
}

/** Every tunnel of a host: the host was deleted or its session closed. */
export function stopHostForwards(hostId: string): void {
  let any = false
  for (const s of table.ofHost(hostId)) {
    closeListener(hostId, s.forwardId)
    if (table.stop(hostId, s.forwardId)) any = true
  }
  if (any) emit()
}

/** App quit, or the last window closed. */
export function stopAllForwards(): void {
  for (const l of listeners.values()) l.close()
  listeners.clear()
  for (const s of table.list()) table.stop(s.hostId, s.forwardId)
}

/**
 * After the host was saved: a running tunnel whose forward was removed or now points
 * somewhere else is stopped, since it no longer does what the form says. A changed label
 * or autoStart leaves it running.
 */
export function reconcileHostForwards(hostId: string): void {
  const host = getHost(hostId)
  const saved = new Map(usableForwards(host?.forwards).map((f) => [f.id, f]))
  let any = false
  for (const s of table.ofHost(hostId)) {
    const was = table.startedWith(hostId, s.forwardId)
    const now = saved.get(s.forwardId)
    if (!now || (was && forwardTargetChanged(was, now))) {
      closeListener(hostId, s.forwardId)
      if (table.stop(hostId, s.forwardId)) any = true
    }
  }
  if (any) emit()
}

/**
 * The host's autoStart forwards, for when its Remote Session has opened. Idempotent: the
 * ones already running are left alone. Failures are listed for the session's popover
 * rather than thrown, one per forward.
 */
export async function startAutoForwards(hostId: string): Promise<{ forwardId: string; result: StartResult }[]> {
  const host = getHost(hostId)
  const auto = usableForwards(host?.forwards).filter((f) => f.autoStart)
  const out: { forwardId: string; result: StartResult }[] = []
  for (const f of auto) {
    if (table.get(hostId, f.id)?.active || table.isStarting(hostId, f.id)) continue
    out.push({ forwardId: f.id, result: await startForward(hostId, f.id) })
  }
  return out
}
