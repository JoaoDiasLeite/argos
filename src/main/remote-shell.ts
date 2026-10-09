import { ClientChannel } from 'ssh2'
import { getRemoteClient } from './sftp'
import { ShellRegistry, type CreateResult } from './remote-shell-pure'
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

const shells = new ShellRegistry<ClientChannel>()

export function remoteShellCreate(
  id: string,
  hostId: string,
  cols: number,
  rows: number,
  onData: (id: string, data: string) => void,
  onExit: (id: string, code: number) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false, error: t('main.terminal.invalidIdShort') })

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
        res.conn.shell({ term: 'xterm-color', cols: safeCols, rows: safeRows }, (err, stream) => {
          if (err) {
            resolve({ ok: false, error: err.message })
            return
          }
          if (!shells.adopt(id, ticket, stream)) {
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
          stream.on('close', () => {
            // Only a channel the far end closed reports an exit; one we killed (or one a
            // fresh create already replaced) stays quiet towards the id's new owner.
            if (shells.release(id, stream)) onExit(id, 0)
          })
          resolve({ ok: true })
        })
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  })
}

export function remoteShellWrite(id: string, data: string): void {
  if (!isSafeId(id)) return
  if (typeof data !== 'string') return
  const stream = shells.get(id)
  if (!stream) return
  try {
    stream.write(data)
  } catch {
    // no-op
  }
}

export function remoteShellResize(id: string, cols: number, rows: number): void {
  if (!isSafeId(id)) return
  if (!Number.isInteger(cols) || cols <= 0) return
  if (!Number.isInteger(rows) || rows <= 0) return
  const stream = shells.get(id)
  if (!stream) return
  try {
    // ssh2 ClientChannel#setWindow arg order: rows, cols, height (px), width (px).
    stream.setWindow(rows, cols, 0, 0)
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
  for (const stream of shells.killAll()) {
    try {
      stream.end()
    } catch {
      // no-op
    }
  }
}
