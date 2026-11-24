import { dialog } from 'electron'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { Client, SFTPWrapper, Stats, utils as ssh2Utils } from 'ssh2'
import type { Duplex } from 'stream'
import {
  getHost,
  connectClient,
  forwardThroughGateway,
  reachGateway,
  saveHostPassword,
  setJumpPool,
  type EffectiveSshHost
} from './ssh'
import {
  looksLikePasswordPrompt,
  sanitizeServerPrompt,
  secretToAskBeforeConnect,
  withSessionSecrets,
  type SessionSecrets
} from './connect-auth-pure'
import { isSafeRemotePath, parseHistoryLines, SingleFlightCache } from './sftp-pure'
import { t } from './i18n'

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

type SessionResult = { ok: true; session: Session } | { ok: false; error: string }

// One entry per host id, holding the *promise* of the session rather than the session:
// opening a server tab fires sftpConnect, sftpList and the terminal's getRemoteClient at
// the same time, and caching only the finished session let each of them dial in on its
// own — the last one to get ready won the slot and the others stayed open forever. With
// the promise cached they all share the one attempt in flight. A failed attempt drops its
// entry (see SingleFlightCache) so the next call retries.
const sessions = new SingleFlightCache<SessionResult>()

/** Whether a call may ask the user for a secret while connecting (see openSession). */
export interface ConnectOpts {
  interactive?: boolean
}

/** What main asks the user for while a Remote Session connects. `prompt` is shown as plain
 *  text: for `keyboard` it is the server's own text (sanitised and capped). */
export interface HostSecretAsk {
  hostId: string
  hostName: string
  kind: 'password' | 'passphrase' | 'keyboard'
  prompt: string
  echo: boolean
  /** Offer "save this password" (the login password only). */
  canSave: boolean
}
export type HostSecretAsker = (req: HostSecretAsk, signal: AbortSignal) => Promise<{ value: string; save: boolean } | null>

// Set by index.ts, which owns the windows. Without one nothing can be asked, as for a
// non-interactive call.
let askHostSecret: HostSecretAsker | null = null
export function setHostSecretAsker(asker: HostSecretAsker): void {
  askHostSecret = asker
}

/**
 * The open attempt that owns a host's cache entry: the abort for a prompt still waiting on the
 * user, and the secrets typed at it, kept in main memory only while that pooled connection
 * lives. Dropped when the entry is evicted (the connection or its SFTP channel closed), on a
 * disconnect, or when the attempt fails; an old connection's late close only drops its own.
 */
interface OpenAttempt {
  abort: AbortController
  secrets: SessionSecrets
}
const attempts = new Map<string, OpenAttempt>()

function dropAttempt(hostId: string, attempt?: OpenAttempt): void {
  const cur = attempts.get(hostId)
  if (!cur || (attempt && cur !== attempt)) return
  cur.abort.abort()
  attempts.delete(hostId)
}

/**
 * The saved host, its login resolved through a linked credential (getHost), with the
 * in-memory secrets of its live session filled in where nothing is saved, for main's own use
 * only (the terminal's Send password and Elevate). Never saved, sent to the renderer or shown
 * to the agent.
 */
export function getHostWithSessionSecrets(hostId: string): EffectiveSshHost | null {
  const h = getHost(hostId)
  return h ? withSessionSecrets(h, attempts.get(hostId)?.secrets) : null
}

// Connect (or reuse a live or in-flight connection) for a host id and open its SFTP
// subsystem. Whoever starts the attempt decides whether it may ask: the calls that serve the
// user's Remote Session are interactive, the ops agent's are not. A call that joins an
// attempt in flight shares its outcome either way.
function getSession(hostId: string, interactive: boolean): Promise<SessionResult> {
  return sessions.get(hostId, (evict) => openSession(hostId, evict, interactive))
}

/** ssh2's parse error for `keyPath` (with `passphrase` when given), or undefined when it
 *  parses. A file that cannot be read is undefined too: connect reports that one itself. */
function keyParseError(keyPath: string, passphrase?: string): string | undefined {
  try {
    const parsed = ssh2Utils.parseKey(fs.readFileSync(keyPath), passphrase)
    return parsed instanceof Error ? parsed.message : undefined
  } catch {
    return undefined
  }
}

// Dials the host and opens SFTP on it. Registers `evict` on the underlying conn/sftp so a
// dropped connection is never left dangling in the cache — the next call always reconnects
// fresh instead of hanging off a dead client.
async function openSession(hostId: string, evict: () => void, interactive: boolean): Promise<SessionResult> {
  const saved = getHost(hostId)
  if (!saved) return { ok: false, error: 'Host not found' }
  // Before anything is asked: a host whose shared credential is gone has no login to ask for.
  if (saved.credentialMissing) return { ok: false, error: t('main.ssh.credentialMissing') }

  const attempt: OpenAttempt = { abort: new AbortController(), secrets: {} }
  dropAttempt(hostId)
  attempts.set(hostId, attempt)
  const signal = attempt.abort.signal
  const asker = interactive ? askHostSecret : null
  const fail = (error: string): SessionResult => {
    dropAttempt(hostId, attempt)
    endRide(hostId, ride)
    return { ok: false, error }
  }
  // The gateway this attempt rides, recorded as soon as it is reached so a gateway in use by
  // an attempt still opening is not released under it.
  let ride: string | undefined

  // A host behind a gateway: the gateway first (its own pooled session, which asks for its own
  // password when this call may ask), so its prompt comes before the target's. A jump that does
  // not resolve fails here, before anything waits on a pooled entry.
  const gw = await reachGateway(hostId, !!asker)
  if (!gw.ok) return fail(gw.error)
  if (gw.gateway) {
    ride = gw.gateway.id
    ridesOn.set(hostId, ride)
  }
  if (signal.aborted) return fail(t('main.ssh.connectCancelled'))

  // What this attempt logs in with. A secret typed here only joins `attempt.secrets` once the
  // connection is ready, so a mistyped one is neither kept nor saved.
  let host = saved
  let typedPassword: string | undefined
  let typedPassphrase: string | undefined
  let savePassword = false
  const parseError =
    asker && saved.authType === 'key' && saved.privateKeyPath && !saved.passphrase
      ? keyParseError(saved.privateKeyPath)
      : undefined
  const need = asker ? secretToAskBeforeConnect(saved, parseError) : null
  if (asker && need) {
    const answer = await asker(
      {
        hostId,
        hostName: saved.name,
        kind: need,
        prompt: t(need === 'password' ? 'main.ssh.askPassword' : 'main.ssh.askPassphrase', {
          user: saved.username,
          host: saved.host
        }),
        echo: false,
        // A host on a shared credential keeps no password of its own to save it in.
        canSave: need === 'password' && !saved.credentialId
      },
      signal
    )
    if (!answer || signal.aborted) return fail(t('main.ssh.connectCancelled'))
    if (need === 'password') {
      typedPassword = answer.value
      savePassword = answer.save
      host = { ...saved, password: answer.value }
    } else {
      // Checked here so a wrong passphrase is one clear error rather than a parse failure
      // inside connect: one ask, one try.
      const wrong = saved.privateKeyPath ? keyParseError(saved.privateKeyPath, answer.value) : undefined
      if (wrong) return fail(wrong)
      typedPassphrase = answer.value
      host = { ...saved, passphrase: answer.value }
    }
  }

  // The channel through the gateway, opened only now that every secret is in hand.
  let sock: Duplex | undefined
  const gateway = gw.gateway?.conn
  if (gw.gateway) {
    const via = await forwardThroughGateway(gw.gateway, saved)
    if (!via.ok) return fail(via.error)
    sock = via.sock
    if (signal.aborted) {
      sock?.destroy()
      return fail(t('main.ssh.connectCancelled'))
    }
  }

  const res = await new Promise<SessionResult>((resolve) => {
    const conn = new Client()
    let settled = false
    const finish = (r: SessionResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    // A cancelled prompt, a disconnect while connecting: end the attempt, which then fails
    // with "cancelled" from the close or error that follows.
    const onAbort = () => {
      try {
        conn.end()
      } catch {
        // no-op
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const outcome = (error: string): SessionResult =>
      signal.aborted ? { ok: false, error: t('main.ssh.connectCancelled') } : { ok: false, error }

    conn.on('ready', () => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) {
        onAbort()
        finish(outcome(''))
        return
      }
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end()
          finish({ ok: false, error: err.message })
          return
        }
        const session: Session = { conn, sftp }
        // The cache entry and the secrets typed for it go together.
        const evictAll = () => {
          evict()
          dropAttempt(hostId, attempt)
        }
        // A broken SFTP channel takes its connection down with it: evicting alone would
        // leave the conn open with nothing left referencing it. A plain sftp close needs
        // no end — the conn either closes too or stays in use by a terminal shell.
        const evictAndEnd = () => {
          evictAll()
          try {
            conn.end()
          } catch {
            // no-op
          }
        }
        sftp.on('close', evictAll)
        sftp.on('error', evictAndEnd)
        conn.on('close', evictAll)
        // Riding a gateway: when its connection goes, this one's channel is dead too. Ended
        // and evicted at once rather than left for a keepalive to notice a minute later.
        if (gateway) {
          gateway.once('close', evictAndEnd)
          conn.once('close', () => {
            gateway.removeListener('close', evictAndEnd)
            // The last rider gone: its gateway closes too, unless a tab holds it.
            endRide(hostId, ride)
          })
        }
        finish({ ok: true, session })
      })
    })
    conn.on('error', (e) => {
      evict()
      finish(outcome(e.message))
    })
    // A socket the far end closes cleanly before the handshake (a VirtualBox NAT forward
    // whose guest is off, a firewall that accepts then drops) emits close with no error;
    // without this the promise never settles and every later call to the host queues
    // behind it.
    conn.on('close', () => {
      finish(outcome('connection closed before the SSH session was ready'))
    })

    try {
      connectClient(conn, host, {
        interactive: !!asker,
        via: gw.gateway ? { id: gw.gateway.id, name: gw.gateway.name } : undefined,
        askSecret: asker
          ? async (prompt, echo) => {
              const answer = await asker(
                { hostId, hostName: saved.name, kind: 'keyboard', prompt: sanitizeServerPrompt(prompt), echo, canSave: false },
                signal
              )
              if (!answer || signal.aborted) {
                // Cancel ends the attempt instead of sending an empty answer the server
                // would count as a failed try.
                attempt.abort.abort()
                return null
              }
              // A password host asked again at the keyboard (the first password was
              // refused): what the user typed now is the password this session logs in with.
              if (saved.authType === 'password' && !saved.password && !echo && looksLikePasswordPrompt(prompt)) {
                typedPassword = answer.value
                // That prompt had no "save" box: what the first one ticked does not carry over.
                savePassword = false
              }
              return answer.value
            }
          : undefined
      }, sock)
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  if (!res.ok) {
    // A channel through the gateway that never carried a session is closed here: the gateway
    // stays up for whatever else rides it.
    sock?.destroy()
    return fail(res.error)
  }
  // Logged in: only now is a typed secret known to be right.
  if (typedPassword !== undefined) {
    const stored = savePassword && !saved.credentialId && saveHostPassword(hostId, typedPassword).ok
    if (!stored) attempt.secrets.password = typedPassword
  }
  if (typedPassphrase !== undefined) attempt.secrets.passphrase = typedPassphrase
  return res
}

// Accessor for the Remote Session terminal (remote-shell.ts) — hands back the live ssh2
// `Client` for a host, connecting via getSession if needed, so the interactive shell
// channel rides the SAME connection SFTP already has open instead of dialing in again.
//
// Not interactive unless asked: the ops agent dials through here too, and it must never
// put a prompt in front of the user (its own sudo prompt is a separate flow).
export async function getRemoteClient(
  hostId: string,
  opts: ConnectOpts = {}
): Promise<{ ok: true; conn: Client } | { ok: false; error: string }> {
  const res = await getSession(hostId, opts.interactive === true)
  return res.ok ? { ok: true, conn: res.session.conn } : { ok: false, error: res.error }
}

// A host behind a gateway reaches it through the same pool, so the gateway's one connection
// is shared by its own session and every host that rides it.
setJumpPool({
  dial: (hostId, interactive) => getRemoteClient(hostId, { interactive }),
  isPooled: (hostId) => sessions.has(hostId),
  release: (hostId) => releaseGateway(hostId)
})

/**
 * Which gateway each pooled session rides (rider id to gateway id), as it was when it opened,
 * so a gateway is released by what really rides it, whatever the settings say by now (a group
 * whose gateway was just removed, say).
 */
const ridesOn = new Map<string, string>()

function ridersOf(gatewayId: string): string[] {
  return [...ridesOn].filter(([rider, gw]) => gw === gatewayId && sessions.has(rider)).map(([rider]) => rider)
}

/** Closes a gateway's pooled connection when no tab holds it and no pooled session rides it. */
function releaseGateway(gatewayId: string): void {
  if (heldByUser.has(gatewayId) || ridersOf(gatewayId).length > 0) return
  endSession(gatewayId)
}

/** A rider's session is over (closed, or its attempt failed): forget the ride, and release
 *  the gateway if that was the last thing using it. Only its own ride: a newer attempt for
 *  the same host may already have recorded another. */
function endRide(hostId: string, gatewayId: string | undefined): void {
  if (!gatewayId || ridesOn.get(hostId) !== gatewayId) return
  ridesOn.delete(hostId)
  releaseGateway(gatewayId)
}

// sftpList and sftpRead are shared with the ops agent and ask only when told to; the other
// calls below serve the user's Remote Session alone, so they may ask (`true`).
export async function sftpConnect(
  hostId: string
): Promise<{ ok: boolean; home?: string; cwd?: string; error?: string }> {
  heldByUser.add(hostId)
  const res = await getSession(hostId, true)
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
  dir: string,
  opts: ConnectOpts = {}
): Promise<{ ok: boolean; entries?: RemoteEntry[]; error?: string }> {
  if (!isSafeRemotePath(dir)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId, opts.interactive === true)
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
  maxBytes = DEFAULT_MAX_READ_BYTES,
  opts: ConnectOpts = {}
): Promise<{ ok: boolean; content?: string; tooLarge?: boolean; binary?: boolean; error?: string }> {
  if (!isSafeRemotePath(filePath)) return { ok: false, error: 'Invalid remote path' }
  const res = await getSession(hostId, opts.interactive === true)
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
  if (!isSafeRemotePath(filePath)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.writeFile(filePath, content, 'utf-8', (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true })
    )
  })
}

export async function sftpMkdir(hostId: string, dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(dir)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
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
  if (!isSafeRemotePath(from) || !isSafeRemotePath(to)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }
  return new Promise((resolve) => {
    res.session.sftp.rename(from, to, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }))
  })
}

export async function sftpDelete(hostId: string, targetPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeRemotePath(targetPath)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }
  const sftp = res.session.sftp

  const stat = await new Promise<Stats | null>((resolve) => {
    sftp.stat(targetPath, (err, st) => resolve(err ? null : st))
  })
  if (!stat) return { ok: false, error: t('main.sftp.fileNotFound') }

  return new Promise((resolve) => {
    if (stat.isDirectory()) {
      // v1: surface "directory not empty" rather than silently recursing — a "delete
      // folder and contents" confirm flow is left as a follow-up (see plan notes).
      sftp.rmdir(targetPath, (err) =>
        resolve(err ? { ok: false, error: t('main.sftp.dirMayNotBeEmpty', { error: err.message }) } : { ok: true })
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
  if (!isSafeRemotePath(remotePath)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }

  const dlg = await dialog.showSaveDialog({
    title: t('main.sftp.dialog.save'),
    defaultPath: path.posix.basename(remotePath)
  })
  if (dlg.canceled || !dlg.filePath) return { ok: true, canceled: true }

  return new Promise((resolve) => {
    res.session.sftp.fastGet(remotePath, dlg.filePath as string, (err) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true, savedTo: dlg.filePath })
    )
  })
}

// Puts a local file, or a local folder and everything under it, at `remote`. A folder that
// already exists remotely is merged into rather than treated as a failure.
async function putRecursive(sftp: SFTPWrapper, local: string, remote: string): Promise<boolean> {
  const st = await fsp.stat(local).catch(() => null)
  if (!st) return false
  if (!st.isDirectory()) {
    return new Promise((resolve) => sftp.fastPut(local, remote, (err) => resolve(!err)))
  }
  await new Promise<void>((resolve) => sftp.mkdir(remote, () => resolve()))
  const names = await fsp.readdir(local).catch(() => null)
  if (!names) return false
  let ok = true
  for (const name of names) {
    if (!(await putRecursive(sftp, path.join(local, name), path.posix.join(remote, name)))) ok = false
  }
  return ok
}

// Uploads `localPaths` (files or folders dropped onto the browser) into `remoteDir`, or asks
// for files with an open dialog when none are given.
export async function sftpUpload(
  hostId: string,
  remoteDir: string,
  localPaths?: string[]
): Promise<{ ok: boolean; uploaded?: string[]; error?: string }> {
  if (!isSafeRemotePath(remoteDir)) return { ok: false, error: t('main.sftp.invalidRemotePath') }
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }

  let locals = localPaths ?? []
  if (!localPaths) {
    const dlg = await dialog.showOpenDialog({
      title: t('main.sftp.dialog.upload'),
      properties: ['openFile', 'multiSelections']
    })
    if (dlg.canceled || dlg.filePaths.length === 0) return { ok: true, uploaded: [] }
    locals = dlg.filePaths
  }

  const uploaded: string[] = []
  const failed: string[] = []
  for (const local of locals) {
    const remote = path.posix.join(remoteDir, path.basename(local))
    if (await putRecursive(res.session.sftp, local, remote)) uploaded.push(remote)
    else failed.push(path.basename(local))
  }
  if (failed.length > 0) return { ok: false, uploaded, error: t('main.sftp.uploadFailed', { names: failed.join(', ') }) }
  return { ok: true, uploaded }
}

const HISTORY_FILES = ['.bash_history', '.zsh_history']

export async function sftpHistory(hostId: string): Promise<{ ok: boolean; commands?: string[]; error?: string }> {
  const res = await getSession(hostId, true)
  if (!res.ok) return { ok: false, error: res.error }
  const sftp = res.session.sftp

  const home = await new Promise<string | null>((resolve) => {
    sftp.realpath('.', (err, absPath) => resolve(err ? null : absPath))
  })
  if (!home) return { ok: false, error: t('main.files.noHomeDir') }

  for (const name of HISTORY_FILES) {
    const filePath = path.posix.join(home, name)
    const raw = await new Promise<string | null>((resolve) => {
      sftp.readFile(filePath, (err, buf) => resolve(err ? null : buf.toString('utf-8')))
    })
    if (raw !== null) return { ok: true, commands: parseHistoryLines(raw) }
  }
  return { ok: true, commands: [] }
}

// Ends the connection behind a cache entry once it settles — straight away for a live
// session, or as soon as it gets ready for one still connecting (dropping only the entry
// would leave that connection open once its handshake finished).
function endWhenSettled(entry: Promise<SessionResult>): void {
  void entry.then(
    (r) => {
      if (!r.ok) return
      try {
        r.session.conn.end()
      } catch {
        // no-op
      }
    },
    () => {
      // no-op
    }
  )
}

/**
 * The hosts the user has a Remote Session open on (sftpConnect, until the renderer's
 * disconnect for the last one). Only for gateways: a gateway's connection outlives its own
 * tab while a host rides it, and is closed with the last rider when no tab holds it.
 */
const heldByUser = new Set<string>()

function endSession(hostId: string): void {
  // Also dismisses a prompt still waiting on this host's attempt.
  dropAttempt(hostId)
  const entry = sessions.take(hostId)
  if (entry) endWhenSettled(entry)
}

/**
 * The user closed the last session on a host. Its connection ends, unless it is a gateway
 * other pooled hosts ride (closing it would cut them off); and a gateway it rode is closed too
 * once nothing else holds it.
 */
export function sftpDisconnect(hostId: string): { ok: boolean } {
  heldByUser.delete(hostId)
  // A gateway others ride stays up for them. The gateway this host rode is released when its
  // connection closes (endRide).
  if (ridersOf(hostId).length === 0) endSession(hostId)
  return { ok: true }
}

/**
 * Closes a host's pooled connection whatever uses it: its address, login or gateway changed,
 * or it was deleted. The hosts riding it are the caller's to close too (their channels die
 * with it, and their tunnels are stopped explicitly).
 */
export function sftpForceDisconnect(hostId: string): void {
  endSession(hostId)
}

export function sftpDisconnectAll(): void {
  heldByUser.clear()
  ridesOn.clear()
  for (const hostId of [...attempts.keys()]) dropAttempt(hostId)
  for (const entry of sessions.takeAll()) endWhenSettled(entry)
}
