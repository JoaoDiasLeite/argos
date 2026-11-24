import { createHash } from 'crypto'
import type { Client } from 'ssh2'
import { t } from './i18n'
import {
  plainLine,
  plainStep,
  readStatus,
  scrubOutput,
  sudoProbeLine,
  sudoStdinLine,
  sudoStep,
  vpnCommand,
  vpnUsesSudo,
  type ExecOutcome,
  type VpnAction,
  type VpnProfile
} from './vpn-pure'

/**
 * Running a gateway VPN's commands over a connection the caller already holds (the gateway's
 * pooled ssh2 client). Split from vpn-gateway.ts, which dials through the pool, so that the
 * connect paths in ssh.ts and sftp.ts can check a VPN without importing the pool back.
 *
 * sudo: `sudo -n` first; only when sudo says a password is required is the gateway's
 * elevation secret written to the stdin of `sudo -S -p '' -k`. Never on a command line or in
 * the environment, never returned, logged or put in an event; the output is scrubbed of it
 * in case a command echoed it.
 */

export type VpnState = 'up' | 'down' | 'busy' | 'unknown'
export type VpnFailReason = 'needs-password' | 'wrong-password' | 'sudo' | 'timeout' | 'invalid' | 'connect' | 'failed' | 'not-found'

export type VpnRunResult =
  | { ok: true; up: boolean; output?: string }
  | { ok: false; error: string; reason: VpnFailReason; output?: string }

/** What the renderer hears on `vpn:changed`, and what vpnKnown lists. No secret, and only
 *  ever sent to the app's own windows: VPN state never reaches the ops agent. */
export interface VpnStatusEvent {
  gatewayId: string
  vpnId: string
  state: VpnState
  error?: string
  reason?: VpnFailReason
  output?: string
  at: number
}

/** Who the commands run on, for messages and the secret lookup. */
export interface VpnGatewayRef {
  id: string
  name: string
}

export const VPN_TIMEOUT_MS: Record<VpnAction, number> = { status: 15_000, up: 60_000, down: 30_000 }
/** How long a connect waits, after `up`, for the status to say up. */
export const VPN_UP_WAIT_MS = 30_000
const POLL_EVERY_MS = 2_000
/** What is kept of a stream while it runs; the shown output is cut to ~2 KB afterwards. */
const MAX_CAPTURE = 64 * 1024

// Set by sftp.ts, which knows the in-memory secrets of a live session: the gateway's
// elevation secret (elevationSecret over getHostWithSessionSecrets).
let secretSource: ((gatewayId: string) => string | undefined) | null = null
export function setVpnSecretSource(fn: (gatewayId: string) => string | undefined): void {
  secretSource = fn
}

let changedSink: ((ev: VpnStatusEvent) => void) | null = null
export function setVpnChangedSink(fn: (ev: VpnStatusEvent) => void): void {
  changedSink = fn
}

const known = new Map<string, VpnStatusEvent>()
const keyOf = (gatewayId: string, vpnId: string): string => `${gatewayId}\n${vpnId}`

/** The last state seen of every VPN, for the dots of a list that opens after the event. */
export function knownVpnStates(): VpnStatusEvent[] {
  return [...known.values()]
}

/** Forgets what was seen of a gateway's VPNs (it was edited or deleted). */
export function forgetGatewayVpns(gatewayId: string): void {
  for (const [k, v] of known) if (v.gatewayId === gatewayId) known.delete(k)
}

export function noteVpn(gatewayId: string, vpnId: string, state: VpnState, extra: Partial<Pick<VpnStatusEvent, 'error' | 'reason' | 'output'>> = {}): void {
  const ev: VpnStatusEvent = { gatewayId, vpnId, state, ...extra, at: Date.now() }
  known.set(keyOf(gatewayId, vpnId), ev)
  changedSink?.(ev)
}

/** A secret sudo refused on a gateway, by hash only, so the 60 s poll or a retry does not
 *  keep feeding the same wrong password (an account lock after a few). A new secret (the
 *  gateway's form saved, a new session password) is tried again. */
const refused = new Map<string, string>()
const fingerprint = (s: string): string => createHash('sha256').update(s).digest('hex')

interface ExecRun extends ExecOutcome {
  timedOut: boolean
  error?: string
}

const keepTail = (s: string): string => (s.length > MAX_CAPTURE ? s.slice(s.length - MAX_CAPTURE) : s)

/** One exec on `conn`, with a deadline, and `stdin` (if any) written then closed. No pty. */
function execOnce(conn: Client, line: string, timeoutMs: number, stdin?: string): Promise<ExecRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let code: number | null = null
    let settled = false
    let stream: { close: () => void } | null = null
    const done = (r: Partial<ExecRun>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false, ...r })
    }
    const timer = setTimeout(() => {
      try {
        stream?.close()
      } catch {
        // already gone
      }
      done({ timedOut: true })
    }, timeoutMs)
    try {
      conn.exec(line, (err, ch) => {
        if (err) return done({ error: err.message })
        // Opened after the deadline: the run was already reported as timed out, so the
        // command must not start now, and above all no secret is written to it.
        if (settled) {
          try {
            ch.close()
          } catch {
            // already gone
          }
          return
        }
        stream = ch
        ch.on('data', (d: Buffer) => (stdout = keepTail(stdout + d.toString('utf-8'))))
        ch.stderr.on('data', (d: Buffer) => (stderr = keepTail(stderr + d.toString('utf-8'))))
        ch.on('exit', (c: unknown) => {
          code = typeof c === 'number' ? c : null
        })
        ch.on('close', () => done({}))
        ch.on('error', (e: Error) => done({ error: e.message }))
        if (stdin !== undefined) ch.end(stdin)
        else ch.end()
      })
    } catch (e) {
      done({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}

const fail = (reason: VpnFailReason, error: string, output?: string): VpnRunResult => ({ ok: false, reason, error, ...(output ? { output } : {}) })

/** A finished command read for `action`: status is up on exit 0 and down otherwise; up and
 *  down succeed on exit 0. */
function interpret(action: VpnAction, code: number | null, output: string, vpn: VpnProfile): VpnRunResult {
  if (code === null) return fail('failed', t('main.vpn.noExitCode', { name: vpn.name }), output)
  if (code === 126 || code === 127) return fail('failed', t('main.vpn.commandMissing', { name: vpn.name }), output)
  if (action === 'status') {
    const state = readStatus(vpn, code, output)
    if (state === 'error') return fail('failed', t('main.vpn.statusError', { name: vpn.name, code }), output)
    return { ok: true, up: state === 'up', ...(output ? { output } : {}) }
  }
  if (code !== 0) return fail('failed', t(action === 'up' ? 'main.vpn.upFailed' : 'main.vpn.downFailed', { name: vpn.name, code }), output)
  return { ok: true, up: action === 'up', ...(output ? { output } : {}) }
}

/**
 * Runs `action` of `vpn` on the gateway's connection. Every outcome is a result, never a
 * throw. The profile is checked again here (vpnCommand returns null for a bad one), since a
 * host can arrive through an import that never went through the save.
 */
export async function runVpnAction(conn: Client, gateway: VpnGatewayRef, vpn: VpnProfile, action: VpnAction): Promise<VpnRunResult> {
  const cmd = vpnCommand(vpn, action)
  if (!cmd) return fail('invalid', t('main.vpn.invalidProfile', { name: vpn.name }))
  const timeout = VPN_TIMEOUT_MS[action]
  const timedOut = (): VpnRunResult => fail('timeout', t('main.vpn.timedOut', { name: vpn.name, seconds: Math.round(timeout / 1000) }))

  if (!vpnUsesSudo(vpn, action)) {
    const r = await execOnce(conn, plainLine(cmd), timeout)
    if (r.error) return fail('connect', t('main.vpn.execFailed', { gateway: gateway.name, error: r.error }))
    if (r.timedOut) return timedOut()
    const step = plainStep(r)
    const output = scrubOutput(step.output)
    if (!step.ran) return fail('failed', t('main.vpn.shellFailed', { gateway: gateway.name }), output)
    return interpret(action, step.code, output, vpn)
  }

  const secret = secretSource?.(gateway.id) || undefined
  const scrub = (text: string): string => scrubOutput(text, [secret])
  const probe = await execOnce(conn, sudoProbeLine(cmd), timeout)
  if (probe.error) return fail('connect', t('main.vpn.execFailed', { gateway: gateway.name, error: probe.error }))
  if (probe.timedOut) return timedOut()
  let step = sudoStep('probe', probe, !!secret)
  if (step.kind === 'retry-with-secret' && secret) {
    const fp = fingerprint(secret)
    if (refused.get(gateway.id) === fp) return fail('wrong-password', t('main.vpn.wrongPassword', { gateway: gateway.name }))
    const r = await execOnce(conn, sudoStdinLine(cmd), timeout, `${secret}\n`)
    if (r.error) return fail('connect', t('main.vpn.execFailed', { gateway: gateway.name, error: r.error }))
    if (r.timedOut) return timedOut()
    step = sudoStep('stdin', r, true)
    if (step.kind === 'wrong-password') refused.set(gateway.id, fp)
    else refused.delete(gateway.id)
  }
  switch (step.kind) {
    case 'ran':
      return interpret(action, step.code, scrub(step.output), vpn)
    case 'needs-password':
    case 'retry-with-secret':
      return fail('needs-password', t('main.vpn.needsPassword', { gateway: gateway.name }))
    case 'wrong-password':
      return fail('wrong-password', t('main.vpn.wrongPassword', { gateway: gateway.name }), scrub(step.output))
    case 'sudo-error':
      return fail('sudo', t('main.vpn.sudoFailed', { gateway: gateway.name }), scrub(step.output))
  }
}

/** runVpnAction, with the state noted and announced: busy while up or down runs, then the
 *  outcome. A failed status leaves the state unknown (with why), never "down". */
export async function runAndNote(conn: Client, gateway: VpnGatewayRef, vpn: VpnProfile, action: VpnAction): Promise<VpnRunResult> {
  if (action !== 'status') noteVpn(gateway.id, vpn.id, 'busy')
  const res = await runVpnAction(conn, gateway, vpn, action)
  if (res.ok) {
    // After up or down the state is what the command said it did; a status check follows
    // where it matters (the connect flow), and the list refreshes on its own.
    noteVpn(gateway.id, vpn.id, res.up ? 'up' : 'down')
  } else {
    noteVpn(gateway.id, vpn.id, 'unknown', { error: res.error, reason: res.reason, ...(res.output ? { output: res.output } : {}) })
  }
  return res
}

/** Which VPN stopped a connect, for the renderer's "bring it up and try again" button. */
export interface VpnDownInfo {
  gatewayId: string
  gatewayName: string
  vpnId: string
  vpnName: string
}

export type VpnEnsureResult = { ok: true } | { ok: false; error: string; vpnDown?: VpnDownInfo }

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Before a server behind `gateway` is dialled: is its VPN up? If not, and `bringUp` (the
 * server says so, or the user clicked "bring it up and try again"), bring it up and poll the
 * status for up to 30 s; otherwise fail with `vpnDown`, which the Remote Session turns into
 * that button. Background checks pass `bringUp: false` and only ever look.
 */
export async function ensureVpn(
  conn: Client,
  gateway: VpnGatewayRef,
  vpn: VpnProfile,
  opts: { bringUp: boolean; signal?: AbortSignal }
): Promise<VpnEnsureResult> {
  const cancelled = (): VpnEnsureResult => ({ ok: false, error: t('main.ssh.connectCancelled') })
  const vars = { name: vpn.name, gateway: gateway.name }
  const status = await runAndNote(conn, gateway, vpn, 'status')
  if (opts.signal?.aborted) return cancelled()
  if (!status.ok) return { ok: false, error: t('main.vpn.statusFailed', { ...vars, error: status.error }) }
  if (status.up) return { ok: true }
  if (!opts.bringUp) {
    return {
      ok: false,
      error: t('main.vpn.down', vars),
      vpnDown: { gatewayId: gateway.id, gatewayName: gateway.name, vpnId: vpn.id, vpnName: vpn.name }
    }
  }
  const up = await runAndNote(conn, gateway, vpn, 'up')
  if (opts.signal?.aborted) return cancelled()
  if (!up.ok) return { ok: false, error: t('main.vpn.bringUpFailed', { ...vars, error: up.error }) }
  const deadline = Date.now() + VPN_UP_WAIT_MS
  for (;;) {
    const s = await runAndNote(conn, gateway, vpn, 'status')
    if (opts.signal?.aborted) return cancelled()
    if (s.ok && s.up) return { ok: true }
    // A status that cannot run at all (sudo refused) will not get better by waiting.
    if (!s.ok && s.reason !== 'timeout') return { ok: false, error: t('main.vpn.statusFailed', { ...vars, error: s.error }) }
    if (Date.now() + POLL_EVERY_MS > deadline) break
    await wait(POLL_EVERY_MS, opts.signal)
    if (opts.signal?.aborted) return cancelled()
  }
  return { ok: false, error: t('main.vpn.upNotReady', { ...vars, seconds: Math.round(VPN_UP_WAIT_MS / 1000) }) }
}
