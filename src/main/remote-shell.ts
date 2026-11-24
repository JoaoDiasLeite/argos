import { ClientChannel } from 'ssh2'
import * as os from 'os'
import * as pty from 'node-pty'
import { getHostWithSessionSecrets, getRemoteClient } from './sftp'
import { ShellRegistry, type CreateResult } from './remote-shell-pure'
import { containerShellArgs, containerShellCommand, type ContainerRuntime } from './remote-containers-pure'
import { resolveWindowsExe } from './terminal'
import { t } from './i18n'
import { getHost } from './ssh'
import { elevateCommandFor } from './ssh-host-pure'
import {
  appendTail,
  decideSecretSend,
  elevationSecret,
  isOnlyFocusReports,
  matchSecretPrompt,
  SecretSendGuard,
  wantsForce,
  type PromptSelf,
  type SecretPromptKind
} from './secret-prompt-pure'

/**
 * Interactive ssh2 shell channels backing the Remote Session ("Connect") terminal — one per
 * renderer-supplied id, opened on the SAME ssh2 connection SFTP already has open for a host
 * (see getRemoteClient in sftp.ts), instead of shelling out to the system `ssh` binary via
 * node-pty (which authenticates independently and is fragile — host-key/agent/password
 * prompts, PATH). Ids are validated with the same charset guard terminal.ts uses. Every
 * function here is defensive and returns a `{ ok: false, error }` shape (or nothing, for
 * fire-and-forget calls) — nothing throws across the IPC boundary.
 */

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id)
}

const KILLED_ERROR = 'Terminal closed before it started'

/** What the registry holds: an ssh2 channel, or the pty of a shell in a container on this
 *  computer (localContainerShellCreate). Write, resize and kill go through it alike. */
interface ShellChannel {
  write(data: string): void
  resize(cols: number, rows: number): void
  end(): void
}

const shells = new ShellRegistry<ShellChannel>()

/**
 * What main knows about a shell on a remote host, for "Send password" and "Elevate": which
 * host it belongs to (never taken from the renderer), the stripped tail of its output, the
 * last prompt hint sent, and the Elevate responder while one is armed. Local container ptys
 * have no entry. Keyed by id but tied to the channel, so a restart that reuses the id is not
 * touched by the old channel's late output or close.
 */
interface HostShellState {
  channel: ShellChannel
  hostId: string
  /** The host's user and address, read once when the shell opens (not secret), so the hint
   *  for a `user@host's password:` prompt can tell this host from a nested ssh without
   *  reading the encrypted store on every chunk. */
  self: PromptSelf | null
  tail: string
  hint: SecretPromptKind | null
  armed: { timer: ReturnType<typeof setTimeout> } | null
}

const hostShells = new Map<string, HostShellState>()
const sendGuard = new SecretSendGuard()

/** How long an Elevate click waits for its password prompt. */
const ELEVATE_WINDOW_MS = 8000

export type SecretHintSink = (id: string, kind: SecretPromptKind | null) => void
let hintSink: SecretHintSink = () => {}

/** Where `remote-shell:secret-hint` events go (index.ts sends them to the main window). */
export function setSecretHintSink(sink: SecretHintSink): void {
  hintSink = sink
}

function setHint(id: string, st: HostShellState, kind: SecretPromptKind | null): void {
  if (st.hint === kind) return
  st.hint = kind
  hintSink(id, kind)
}

function disarm(st: HostShellState): void {
  if (!st.armed) return
  clearTimeout(st.armed.timer)
  st.armed = null
}

/** Drops a shell's state (all of it, the Elevate timer included). With `channel`, only if
 *  the entry still belongs to that channel. */
function forgetHostShell(id: string, channel?: ShellChannel): void {
  const st = hostShells.get(id)
  if (!st || (channel && st.channel !== channel)) return
  disarm(st)
  hostShells.delete(id)
  sendGuard.forget(id)
}

/** Writes a secret and treats the prompt as answered: the tail is cleared so the next click,
 *  or the Elevate responder, needs a fresh prompt rather than typing it again into whatever
 *  reads stdin next on a slow link. Never logs or rethrows anything that could carry it. */
function writeSecret(id: string, st: HostShellState, data: string): boolean {
  try {
    st.channel.write(data)
  } catch {
    return false
  }
  sendGuard.noteSent(id, Date.now())
  st.tail = ''
  setHint(id, st, null)
  return true
}

/** Output from a host shell: update the tail and the hint, and answer an armed Elevate. */
function feedOutput(id: string, channel: ShellChannel, data: string): void {
  const st = hostShells.get(id)
  if (!st || st.channel !== channel) return
  st.tail = appendTail(st.tail, data)
  // A mismatching `user@host's password:` (a nested ssh) is no match: no hint, and the
  // Elevate responder leaves it alone.
  const match = matchSecretPrompt(st.tail, st.self ?? undefined)
  if (st.armed && match && (match.kind === 'sudo' || match.kind === 'login')) {
    disarm(st)
    const host = getHostWithSessionSecrets(st.hostId)
    const secret = host ? elevationSecret(host) : undefined
    if (secret && writeSecret(id, st, secret + '\r')) return
  }
  setHint(id, st, match?.kind ?? null)
}

function sshChannel(stream: ClientChannel): ShellChannel {
  return {
    write: (data) => stream.write(data),
    // ssh2 ClientChannel#setWindow arg order: rows, cols, height (px), width (px).
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    end: () => stream.end()
  }
}

export function remoteShellCreate(
  id: string,
  hostId: string,
  cols: number,
  rows: number,
  onData: (id: string, data: string) => void,
  onExit: (id: string, code: number) => void,
  container?: { runtime: ContainerRuntime; sudo: boolean; id: string }
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false, error: t('main.terminal.invalidIdShort') })
  // A container tab runs `<runtime> exec -it <id> …` on its own pty instead of the login
  // shell, so `exit` ends the tab's channel. Built here from the validated id only.
  let command: string | null = null
  if (container !== undefined) {
    // Shape-checked as well: it comes over IPC.
    const c = container !== null && typeof container === 'object' ? container : null
    command = c ? containerShellCommand(c.runtime, c.sudo === true, c.id) : null
    if (!command) return Promise.resolve({ ok: false, error: t('main.containers.invalid') })
  }

  // The id is reserved before the connection is awaited (see ShellRegistry): a kill that
  // lands while this is still connecting (the tab closed, a StrictMode remount) closes the
  // channel the moment it opens instead of leaving it orphaned, and a concurrent create for
  // the same id joins this one rather than opening a second channel. A live id resolves ok
  // straight away (benign re-create).
  return shells.create(id, async (ticket) => {
    // The user opened this terminal: the connection may ask for a missing password.
    const res = await getRemoteClient(hostId, { interactive: true })
    if (!res.ok) return { ok: false, error: res.error }
    if (ticket.killed) return { ok: false, error: KILLED_ERROR }

    const safeCols = Number.isInteger(cols) && cols > 0 ? cols : 80
    const safeRows = Number.isInteger(rows) && rows > 0 ? rows : 24

    return new Promise<CreateResult>((resolve) => {
      try {
        const pty = { term: 'xterm-color', cols: safeCols, rows: safeRows }
        const open = (cb: (err: Error | undefined, stream: ClientChannel) => void) =>
          command ? res.conn.exec(command, { pty }, cb) : res.conn.shell(pty, cb)
        open((err, stream) => {
          if (err) {
            resolve({ ok: false, error: err.message })
            return
          }
          const channel = sshChannel(stream)
          if (!shells.adopt(id, ticket, channel)) {
            try {
              stream.close()
            } catch {
              // no-op
            }
            resolve({ ok: false, error: KILLED_ERROR })
            return
          }
          // A container exec on the host belongs to the host too: `sudo docker exec` asks
          // for the host's password.
          forgetHostShell(id)
          const h = getHost(hostId)
          const self = h ? { username: h.username, host: h.host } : null
          hostShells.set(id, { channel, hostId, self, tail: '', hint: null, armed: null })
          const onChunk = (d: Buffer) => {
            const text = d.toString('utf8')
            feedOutput(id, channel, text)
            onData(id, text)
          }
          stream.on('data', onChunk)
          stream.stderr?.on('data', onChunk)
          // An exec channel reports the command's exit status before it closes.
          let exitCode = 0
          stream.on('exit', (code: number | null) => {
            if (typeof code === 'number') exitCode = code
          })
          stream.on('close', () => {
            // Only a channel the far end closed reports an exit; one we killed (or one a
            // fresh create already replaced) stays quiet towards the id's new owner.
            forgetHostShell(id, channel)
            if (shells.release(id, channel)) onExit(id, exitCode)
          })
          resolve({ ok: true })
        })
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  })
}

/**
 * A shell inside a container on THIS computer, for the Servers screen's local containers:
 * a pty running `<runtime> exec -it <id> sh -c …` from an argument vector, built here from
 * the validated id only. It shares the registry (and so write, resize and kill) with the
 * ssh channels; RemoteTerminal reaches it with a null host.
 */
export function localContainerShellCreate(
  id: string,
  cols: number,
  rows: number,
  onData: (id: string, data: string) => void,
  onExit: (id: string, code: number) => void,
  container: unknown
): Promise<CreateResult> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false, error: t('main.terminal.invalidIdShort') })
  const c = container !== null && typeof container === 'object' ? (container as { runtime?: unknown; id?: unknown }) : null
  const runtime = c?.runtime === 'docker' || c?.runtime === 'podman' ? c.runtime : null
  const args = runtime && typeof c?.id === 'string' ? containerShellArgs(runtime, c.id) : null
  if (!runtime || !args) return Promise.resolve({ ok: false, error: t('main.containers.invalid') })

  return shells.create(id, async (ticket) => {
    if (ticket.killed) return { ok: false, error: KILLED_ERROR }
    let p: pty.IPty
    try {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      p = pty.spawn(resolveWindowsExe(process.platform === 'win32' ? `${runtime}.exe` : runtime), args, {
        name: 'xterm-color',
        cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
        rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
        cwd: os.homedir(),
        env
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const channel: ShellChannel = {
      write: (data) => p.write(data),
      resize: (c2, r2) => p.resize(c2, r2),
      end: () => p.kill()
    }
    if (!shells.adopt(id, ticket, channel)) {
      try {
        p.kill()
      } catch {
        // no-op
      }
      return { ok: false, error: KILLED_ERROR }
    }
    p.onData((d) => onData(id, d))
    p.onExit(({ exitCode }) => {
      if (shells.release(id, channel)) onExit(id, exitCode)
    })
    return { ok: true }
  })
}

export function remoteShellWrite(id: string, data: string): void {
  if (!isSafeId(id)) return
  if (typeof data !== 'string') return
  const channel = shells.get(id)
  if (!channel) return
  // The user typing into the shell takes over from an armed Elevate. xterm's focus reports
  // do not count, so the terminal regaining focus after the click does not disarm it.
  const st = hostShells.get(id)
  if (st && st.channel === channel && !isOnlyFocusReports(data)) disarm(st)
  try {
    channel.write(data)
  } catch {
    // no-op
  }
}

export function remoteShellResize(id: string, cols: number, rows: number): void {
  if (!isSafeId(id)) return
  if (!Number.isInteger(cols) || cols <= 0) return
  if (!Number.isInteger(rows) || rows <= 0) return
  const channel = shells.get(id)
  if (!channel) return
  try {
    channel.resize(cols, rows)
  } catch {
    // no-op
  }
}

export function remoteShellKill(id: string): { ok: boolean } {
  if (!isSafeId(id)) return { ok: false }
  forgetHostShell(id)
  const outcome = shells.kill(id)
  if (outcome.kind === 'none') return { ok: false }
  if (outcome.kind === 'live') {
    try {
      outcome.channel.end()
    } catch {
      // no-op
    }
  }
  return { ok: true }
}

export function remoteShellKillAll(): void {
  for (const id of [...hostShells.keys()]) forgetHostShell(id)
  for (const channel of shells.killAll()) {
    try {
      channel.end()
    } catch {
      // no-op
    }
  }
}

export type SendSecretResult =
  | { ok: true }
  // 'labs-off': refused in index.ts while the experimental features are off.
  | { ok: false; reason: 'unknown-shell' | 'not-a-host-shell' | 'no-secret' | 'no-prompt' | 'rate-limited' | 'labs-off' }

/** The live host shell for `id`, or why there is none. A live id without an entry is a local
 *  container pty. */
function hostShellFor(id: unknown): HostShellState | { reason: 'unknown-shell' | 'not-a-host-shell' } {
  if (!isSafeId(id)) return { reason: 'unknown-shell' }
  const channel = shells.get(id)
  if (!channel) return { reason: 'unknown-shell' }
  const st = hostShells.get(id)
  if (!st || st.channel !== channel) return { reason: 'not-a-host-shell' }
  return st
}

/**
 * "Send password": types the saved secret the shell's current prompt asks for, followed by
 * Enter. With no prompt in sight it refuses (`no-prompt`) and opens a short window in which
 * the user may confirm a forced send, which types the elevation or login password WITHOUT
 * Enter so a mistake can be erased with Ctrl+U. If a prompt has appeared by the time the
 * forced send arrives, it is answered normally instead. The secret is read from the store
 * here, written to the channel and dropped: never returned, logged or put in an event. A
 * password typed at the connect prompt and not saved counts as the login password while its
 * connection lives (getHostWithSessionSecrets).
 */
export function remoteShellSendSecret(id: unknown, opts: unknown): SendSecretResult {
  const st = hostShellFor(id)
  if ('reason' in st) return { ok: false, reason: st.reason }
  const sid = id as string
  const now = Date.now()
  const host = getHostWithSessionSecrets(st.hostId)
  const decision = decideSecretSend(sendGuard, sid, st.tail, host, wantsForce(opts), now)
  if ('reason' in decision) return { ok: false, reason: decision.reason }
  disarm(st)
  return writeSecret(sid, st, decision.write) ? { ok: true } : { ok: false, reason: 'unknown-shell' }
}

export type ElevateResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-shell' | 'not-a-host-shell' | 'no-secret' | 'rate-limited' | 'labs-off' }

/**
 * "Elevate": types the host's elevation command (from the fixed list, never free text) and,
 * for the next few seconds, answers the first sudo or login password prompt with the
 * elevation secret, once. Answering without a click of its own is acceptable only here: the
 * user's click put that command into the shell a moment before.
 */
export function remoteShellElevate(id: unknown): ElevateResult {
  const st = hostShellFor(id)
  if ('reason' in st) return { ok: false, reason: st.reason }
  const sid = id as string
  if (sendGuard.rateLimited(sid, Date.now())) return { ok: false, reason: 'rate-limited' }
  const host = getHostWithSessionSecrets(st.hostId)
  if (!host || !elevationSecret(host)) return { ok: false, reason: 'no-secret' }
  disarm(st)
  try {
    st.channel.write(`${elevateCommandFor(host)}\r`)
  } catch {
    return { ok: false, reason: 'unknown-shell' }
  }
  // Counts towards the rate limit, so a double click does not type the command twice.
  sendGuard.noteSent(sid, Date.now())
  // Only a prompt printed after the command counts.
  st.tail = ''
  setHint(sid, st, null)
  const armed = {
    timer: setTimeout(() => {
      if (st.armed === armed) st.armed = null
    }, ELEVATE_WINDOW_MS)
  }
  st.armed = armed
  return { ok: true }
}
