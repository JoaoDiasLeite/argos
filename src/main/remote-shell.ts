import { ClientChannel } from 'ssh2'
import * as os from 'os'
import * as pty from 'node-pty'
import { getRemoteClient } from './sftp'
import { ShellRegistry, type CreateResult } from './remote-shell-pure'
import { containerShellArgs, containerShellCommand, type ContainerRuntime } from './remote-containers-pure'
import { resolveWindowsExe } from './terminal'
import { t } from './i18n'

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
    const res = await getRemoteClient(hostId)
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
          stream.on('data', (d: Buffer) => onData(id, d.toString('utf8')))
          stream.stderr?.on('data', (d: Buffer) => onData(id, d.toString('utf8')))
          // An exec channel reports the command's exit status before it closes.
          let exitCode = 0
          stream.on('exit', (code: number | null) => {
            if (typeof code === 'number') exitCode = code
          })
          stream.on('close', () => {
            // Only a channel the far end closed reports an exit; one we killed (or one a
            // fresh create already replaced) stays quiet towards the id's new owner.
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
  for (const channel of shells.killAll()) {
    try {
      channel.end()
    } catch {
      // no-op
    }
  }
}
