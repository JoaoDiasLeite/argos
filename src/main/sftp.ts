import { dialog } from 'electron'
import * as path from 'path'
import { Client, SFTPWrapper, Stats } from 'ssh2'
import { getHost, buildConnectConfig } from './ssh'
import { isSafeRemotePath, parseHistoryLines } from './sftp-pure'

export { isSafeRemotePath, parseHistoryLines }

/**
 * SFTP session manager for the Remote Session ("Connect") view — one long-lived ssh2
 * `Client` + `SFTPWrapper` per host id, lazily connected and reused across calls. Every
 * exported function is defensive and returns a `{ ok: false, error }` shape on failure;
 * nothing here ever throws across the IPC boundary.
 *
 * Path safety: every remote path argument is validated with `isSafeRemotePath` before it
 * touches the wire — remote paths must be POSIX-absolute and contain no `..` segment.
 */

export interface RemoteEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtime: number
}

interface Session {
  conn: Client
  sftp: SFTPWrapper
}

const sessions = new Map<string, Session>()

// Connect (or reuse a live connection) for a host id and open its SFTP subsystem.
// Registers eviction on the underlying conn/sftp so a dropped connection is never left
// dangling in the map — the next call always reconnects fresh instead of hanging off a
// dead client.
function getSession(hostId: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const existing = sessions.get(hostId)
  if (existing) return Promise.resolve({ ok: true, session: existing })

  const host = getHost(hostId)
  if (!host) return Promise.resolve({ ok: false, error: 'Host not found' })

  return new Promise((resolve) => {
    const conn = new Client()
    let settled = false
    const finish = (r: { ok: true; session: Session } | { ok: false; error: string }) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end()
          finish({ ok: false, error: err.message })
          return
        }
        const session: Session = { conn, sftp }
        sessions.set(hostId, session)
        const evict = () => {
          if (sessions.get(hostId) === session) sessions.delete(hostId)
        }
        sftp.on('close', evict)
        sftp.on('error', evict)
        conn.on('close', evict)
        finish({ ok: true, session })
      })
    })
    conn.on('error', (e) => {
      sessions.delete(hostId)
      finish({ ok: false, error: e.message })
    })

    try {
      conn.connect(buildConnectConfig(host))
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

// Accessor for the Remote Session terminal (remote-shell.ts) — hands back the live ssh2
// `Client` for a host, connecting via getSession if needed, so the interactive shell
// channel rides the SAME connection SFTP already has open instead of dialing in again.
export async function getRemoteClient(
  hostId: string
): Promise<{ ok: true; conn: Client } | { ok: false; error: string }> {
  const res = await getSession(hostId)
  return res.ok ? { ok: true, conn: res.session.conn } : { ok: false, error: res.error }
}

export async function sftpConnect(
  hostId: string
): Promise<{ ok: boolean; home?: string; cwd?: string; error?: string }> {
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.realpath('.', (err, absPath) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      resolve({ ok: true, home: absPath, cwd: absPath })
    })
  })
}

function entryType(st: Stats): RemoteEntry['type'] {
  if (st.isDirectory()) return 'directory'
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isFile()) return 'file'
  return 'other'
}

export async function sftpList(
  hostId: string,
  dir: string
): Promise<{ ok: boolean; entries?: RemoteEntry[]; error?: string }> {
  if (!isSafeRemotePath(dir)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.readdir(dir, (err, list) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      const entries: RemoteEntry[] = list.map((e) => ({
        name: e.filename,
        path: path.posix.join(dir, e.filename),
        type: entryType(e.attrs),
        size: e.attrs.size,
        mtime: e.attrs.mtime * 1000
      }))
      entries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
      resolve({ ok: true, entries })
    })
  })
}

const DEFAULT_MAX_READ_BYTES = 1_000_000

export async function sftpRead(
  hostId: string,
  filePath: string,
  maxBytes = DEFAULT_MAX_READ_BYTES
): Promise<{ ok: boolean; content?: string; tooLarge?: boolean; binary?: boolean; error?: string }> {
  if (!isSafeRemotePath(filePath)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  const sftp = res.session.sftp

  const size = await new Promise<number | null>((resolve) => {
    sftp.stat(filePath, (err, stats) => resolve(err ? null : stats.size))
  })
  if (size === null) return { ok: false, error: 'Could not stat file' }
  if (size > maxBytes) return { ok: true, tooLarge: true }

  return new Promise((resolve) => {
    sftp.readFile(filePath, (err, buf) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      if (buf.includes(0)) {
        resolve({ ok: true, binary: true })
        return
      }
      resolve({ ok: true, content: buf.toString('utf-8') })
    })
  })
}

export async function sftpWrite(
  hostId: string,
  filePath: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(filePath)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.writeFile(filePath, content, 'utf-8', (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true })
    )
  })
}

export async function sftpMkdir(hostId: string, dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(dir)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.mkdir(dir, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
  })
}

export async function sftpRename(
  hostId: string,
  from: string,
  to: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(from) || !isSafeRemotePath(to)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.rename(from, to, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
  })
}

export async function sftpDelete(hostId: string, targetPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(targetPath)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  const sftp = res.session.sftp

  const stat = await new Promise<Stats | null>((resolve) => {
    sftp.stat(targetPath, (err, st) => resolve(err ? null : st))
  })
  if (!stat) return { ok: false, error: 'File not found' }

  return new Promise((resolve) => {
    if (stat.isDirectory()) {
      // v1: surface "directory not empty" rather than silently recursing — a "delete
      // folder and contents" confirm flow is left as a follow-up (see plan notes).
      sftp.rmdir(targetPath, (err) =>
        resolve(err ? { ok: false, error: `${err.message} (directory may not be empty)` } : { ok: true })
      )
    } else {
      sftp.unlink(targetPath, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
    }
  })
}

export async function sftpDownload(
  hostId: string,
  remotePath: string
): Promise<{ ok: boolean; savedTo?: string; canceled?: boolean; error?: string }> {
  if (!isSafeRemotePath(remotePath)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }

  const dlg = await dialog.showSaveDialog({
    title: 'Save file',
    defaultPath: path.posix.basename(remotePath)
  })
  if (dlg.canceled || !dlg.filePath) return { ok: true, canceled: true }

  return new Promise((resolve) => {
    res.session.sftp.fastGet(remotePath, dlg.filePath as string, (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true, savedTo: dlg.filePath })
    )
  })
}

export async function sftpUpload(
  hostId: string,
  remoteDir: string
): Promise<{ ok: boolean; uploaded?: string[]; error?: string }> {
  if (!isSafeRemotePath(remoteDir)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }

  const dlg = await dialog.showOpenDialog({
    title: 'Upload files',
    properties: ['openFile', 'multiSelections']
  })
  if (dlg.canceled || dlg.filePaths.length === 0) return { ok: true, uploaded: [] }

  const uploaded: string[] = []
  for (const local of dlg.filePaths) {
    const remote = path.posix.join(remoteDir, path.basename(local))
    const ok = await new Promise<boolean>((resolve) => {
      res.session.sftp.fastPut(local, remote, (err) => resolve(!err))
    })
    if (ok) uploaded.push(remote)
  }
  return { ok: true, uploaded }
}

const HISTORY_FILES = ['.bash_history', '.zsh_history']

export async function sftpHistory(hostId: string): Promise<{ ok: boolean; commands?: string[]; error?: string }> {
  const res = await getSession(hostId)
  if (!res.ok) return { ok: false, error: res.error }
  const sftp = res.session.sftp

  const home = await new Promise<string | null>((resolve) => {
    sftp.realpath('.', (err, absPath) => resolve(err ? null : absPath))
  })
  if (!home) return { ok: false, error: 'Could not resolve home directory' }

  for (const name of HISTORY_FILES) {
    const filePath = path.posix.join(home, name)
    const raw = await new Promise<string | null>((resolve) => {
      sftp.readFile(filePath, (err, buf) => resolve(err ? null : buf.toString('utf-8')))
    })
    if (raw !== null) return { ok: true, commands: parseHistoryLines(raw) }
  }
  return { ok: true, commands: [] }
}

export function sftpDisconnect(hostId: string): { ok: boolean } {
  const session = sessions.get(hostId)
  if (session) {
    try {
      session.conn.end()
    } catch {
      // no-op
    }
    sessions.delete(hostId)
  }
  return { ok: true }
}

export function sftpDisconnectAll(): void {
  for (const [hostId, session] of sessions) {
    try {
      session.conn.end()
    } catch {
      // no-op
    }
    sessions.delete(hostId)
  }
}
