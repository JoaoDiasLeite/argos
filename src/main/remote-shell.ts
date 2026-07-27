import { ClientChannel } from 'ssh2'
import { getRemoteClient } from './sftp'

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

const shells = new Map<string, ClientChannel>()

export async function remoteShellCreate(
  id: string,
  hostId: string,
  cols: number,
  rows: number,
  onData: (id: string, data: string) => void,
  onExit: (id: string, code: number) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeId(id)) return { ok: false, error: 'Invalid terminal id' }
  if (shells.has(id)) return { ok: true } // benign re-create (StrictMode remount) — reuse

  const res = await getRemoteClient(hostId)
  if (!res.ok) return { ok: false, error: res.error }

  const safeCols = Number.isInteger(cols) && cols > 0 ? cols : 80
  const safeRows = Number.isInteger(rows) && rows > 0 ? rows : 24

  return new Promise((resolve) => {
    try {
      res.conn.shell({ term: 'xterm-color', cols: safeCols, rows: safeRows }, (err, stream) => {
        if (err) {
          resolve({ ok: false, error: err.message })
          return
        }
        shells.set(id, stream)
        stream.on('data', (d: Buffer) => onData(id, d.toString('utf8')))
        stream.stderr?.on('data', (d: Buffer) => onData(id, d.toString('utf8')))
        stream.on('close', () => {
          shells.delete(id)
          onExit(id, 0)
        })
        resolve({ ok: true })
      })
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
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
  const stream = shells.get(id)
  if (!stream) return { ok: false }
  try {
    stream.end()
  } catch {
    // no-op
  }
  shells.delete(id)
  return { ok: true }
}

export function remoteShellKillAll(): void {
  for (const [id, stream] of shells) {
    try {
      stream.end()
    } catch {
      // no-op
    }
    shells.delete(id)
  }
}
