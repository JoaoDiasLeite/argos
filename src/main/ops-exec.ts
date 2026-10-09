/**
 * The ops executor's ssh2 backend (docs/OPS_AGENT_PLAN.md §4). It rides the one `Client`
 * per host that sftp.ts keeps, so an ops run and a Connect tab share host-key trust and
 * auth. Everything here returns a result shape; nothing throws across IPC.
 *
 * Argv arrives already gated. This module only quotes it (`shellJoin`) and runs it: it
 * never decides what may run, and it never sees the raw string the model sent.
 *
 * The decisions that can be tested without a server (output cap, backup name, the
 * per-host queue, abort fan-out) live in ops-exec-pure.ts and are re-exported here.
 */
import { randomBytes } from 'crypto'
import * as path from 'path'
import type { ClientChannel, SFTPWrapper, Stats } from 'ssh2'
import { getRemoteClient, sftpList, sftpRead } from './sftp'
import { isSafeRemotePath } from './sftp-pure'
import { testConnection } from './ssh'
import { shellJoin } from './ops-gate-pure'
import { sha256Hex } from './ops-audit-pure'
import { t } from './i18n'
import {
  backupPathFor,
  failedExec,
  makeCapture,
  type ExecOpts,
  type ExecResult,
  type OpsBackend,
  type OpsListResult,
  type OpsReadResult,
  type OpsWriteResult,
  type ScriptHooks
} from './ops-exec-pure'

export {
  createExecutor,
  type ExecOpts,
  type ExecResult,
  type OpsBackend,
  type OpsExecutor,
  type OpsListEntry,
  type OpsListResult,
  type OpsReadResult,
  type OpsWriteResult
} from './ops-exec-pure'

/** After SIGTERM, how long a command gets before we close its channel. */
const TERM_GRACE_MS = 5000
/** After close(), how long we wait for the channel to say so before giving up on it. */
const CLOSE_GRACE_MS = 2000
/** A file bigger than this is not copied for a backup; the write is refused instead. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
/** SFTP status code for "no such file". */
const SFTP_NO_SUCH_FILE = 2

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ─── exec ─────────────────────────────────────────────────────────────────────────

async function exec(hostId: string, argv: string[], opts: ExecOpts): Promise<ExecResult> {
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  if (opts.signal.aborted) return failedExec('aborted before start')
  if (argv.length === 0) return failedExec('empty argv')
  const client = await getRemoteClient(hostId)
  if (!client.ok) return failedExec(client.error, elapsed())
  if (opts.signal.aborted) return failedExec('aborted before start', elapsed())
  const conn = client.conn

  return new Promise<ExecResult>((resolve) => {
    const out = makeCapture(opts.maxOutputBytes)
    const err = makeCapture(opts.maxOutputBytes)
    let stream: ClientChannel | null = null
    let exitCode: number | null = null
    let exitSignal: string | undefined
    let timedOut = false
    let aborted = false
    let failure: string | undefined
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const finish = (error?: string): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      opts.signal.removeEventListener('abort', onAbort)
      conn.removeListener('close', onConnClose)
      const why = error ?? failure ?? (aborted ? 'aborted' : undefined)
      resolve({
        ok: why === undefined,
        exitCode,
        ...(exitSignal ? { signal: exitSignal } : {}),
        timedOut,
        durationMs: elapsed(),
        stdout: out.text(),
        stderr: err.text(),
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        truncated: out.truncated || err.truncated,
        ...(why !== undefined ? { error: why } : {})
      })
    }

    // TERM first so the command can clean up; many sshd builds ignore channel signals,
    // so the close after the grace period is what actually ends it. No KILL (plan §4).
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      if (!stream) return finish()
      try {
        stream.signal('TERM')
      } catch {
        // The server may refuse signals; the close below still ends the channel.
      }
      timers.push(
        setTimeout(() => {
          try {
            stream?.close()
          } catch {
            // Already closing.
          }
          timers.push(setTimeout(() => finish(), CLOSE_GRACE_MS))
        }, TERM_GRACE_MS)
      )
    }
    function onAbort(): void {
      aborted = true
      stop()
    }
    function onConnClose(): void {
      finish(failure ?? 'connection closed before the command finished')
    }

    opts.signal.addEventListener('abort', onAbort, { once: true })
    conn.on('close', onConnClose)
    timers.push(
      setTimeout(() => {
        timedOut = true
        stop()
      }, Math.max(1, opts.timeoutMs))
    )

    try {
      conn.exec(shellJoin(argv), { pty: false }, (e, ch) => {
        if (e) return finish(e.message)
        stream = ch
        if (settled) {
          // Aborted or dropped while the channel was opening; do not leave it running.
          try {
            ch.close()
          } catch {
            // ignore
          }
          return
        }
        ch.on('data', (d: Buffer) => out.push(d))
        ch.stderr.on('data', (d: Buffer) => err.push(d))
        ch.on('exit', (code: number | null, sig?: string) => {
          if (typeof code === 'number') exitCode = code
          else if (sig) exitSignal = sig
        })
        ch.on('error', (ce: Error) => {
          failure = ce.message
        })
        ch.on('close', () => finish())
        try {
          if (opts.stdin !== undefined) ch.end(opts.stdin)
          else ch.end()
        } catch (we) {
          failure = message(we)
        }
      })
    } catch (e) {
      finish(message(e))
    }
  })
}

// ─── SFTP helpers ─────────────────────────────────────────────────────────────────

type Fail = { ok: false; error: string }

/**
 * A private SFTP channel on the shared connection, ended after `fn`. Our own rather than
 * sftp.ts's session channel because writes need raw bytes and stat codes that its
 * string-returning helpers do not expose, and sftp.ts is not ours to change.
 */
async function withSftp<T>(hostId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T | Fail> {
  const client = await getRemoteClient(hostId)
  if (!client.ok) return { ok: false, error: client.error }
  const sftp = await new Promise<SFTPWrapper | Fail>((resolve) => {
    try {
      client.conn.sftp((e, s) => resolve(e ? { ok: false, error: e.message } : s))
    } catch (e) {
      resolve({ ok: false, error: message(e) })
    }
  })
  if ('ok' in sftp) return sftp
  try {
    return await fn(sftp)
  } catch (e) {
    return { ok: false, error: message(e) }
  } finally {
    try {
      sftp.end()
    } catch {
      // Channel already gone.
    }
  }
}

const p = {
  stat: (s: SFTPWrapper, f: string) =>
    new Promise<{ st: Stats } | { code: number | string | undefined; error: string }>((resolve) =>
      s.stat(f, (e, st) =>
        resolve(e ? { code: (e as Error & { code?: number | string }).code, error: e.message } : { st })
      )
    ),
  readFile: (s: SFTPWrapper, f: string) =>
    new Promise<Buffer>((resolve, reject) => s.readFile(f, (e, b) => (e ? reject(e) : resolve(b)))),
  writeFile: (s: SFTPWrapper, f: string, data: Buffer, mode?: number) =>
    new Promise<void>((resolve, reject) =>
      s.writeFile(f, data, mode === undefined ? {} : { mode }, (e) => (e ? reject(e) : resolve()))
    ),
  chmod: (s: SFTPWrapper, f: string, mode: number) =>
    new Promise<void>((resolve, reject) => s.chmod(f, mode, (e) => (e ? reject(e) : resolve()))),
  mkdir: (s: SFTPWrapper, d: string, mode: number) =>
    new Promise<Error | null>((resolve) => s.mkdir(d, { mode }, (e) => resolve(e ?? null))),
  realpath: (s: SFTPWrapper, f: string) =>
    new Promise<string>((resolve, reject) => s.realpath(f, (e, r) => (e ? reject(e) : resolve(r)))),
  unlink: (s: SFTPWrapper, f: string) => new Promise<void>((resolve) => s.unlink(f, () => resolve())),
  rmdir: (s: SFTPWrapper, d: string) => new Promise<void>((resolve) => s.rmdir(d, () => resolve()))
}

// ─── read / list / write ──────────────────────────────────────────────────────────

async function read(hostId: string, filePath: string, maxBytes: number): Promise<OpsReadResult> {
  try {
    const r = await sftpRead(hostId, filePath, maxBytes)
    if (!r.ok) return { ok: false, error: r.error ?? 'read failed' }
    if (r.tooLarge) return { ok: true, tooLarge: true }
    if (r.binary) return { ok: true, binary: true }
    return { ok: true, content: r.content ?? '' }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

async function list(hostId: string, dir: string): Promise<OpsListResult> {
  try {
    const r = await sftpList(hostId, dir)
    if (!r.ok) return { ok: false, error: r.error ?? 'list failed' }
    return {
      ok: true,
      entries: (r.entries ?? []).map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }))
    }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

/**
 * Backup, then write. The backup keeps the original's permission bits, since it may be a
 * file only root should read. No backup is made for a file that does not exist yet; any
 * other stat failure refuses the write, because "could not back up" must not quietly
 * become "wrote without a backup".
 */
async function write(hostId: string, filePath: string, content: string, backup: boolean): Promise<OpsWriteResult> {
  if (!isSafeRemotePath(filePath)) return { ok: false, error: 'Invalid remote path' }
  const bytes = Buffer.from(content, 'utf-8')
  return withSftp<OpsWriteResult>(hostId, async (sftp) => {
    let backupPath: string | undefined
    let beforeSha256: string | undefined
    if (backup) {
      const st = await p.stat(sftp, filePath)
      if ('st' in st) {
        if (!st.st.isFile()) return { ok: false, error: `${filePath} is not a regular file` }
        if (st.st.size > MAX_BACKUP_BYTES) {
          return { ok: false, error: `${filePath} is ${st.st.size} bytes, too large to back up` }
        }
        const before = await p.readFile(sftp, filePath)
        beforeSha256 = sha256Hex(before)
        backupPath = backupPathFor(filePath, new Date())
        await p.writeFile(sftp, backupPath, before, st.st.mode & 0o777)
      } else if (st.code !== SFTP_NO_SUCH_FILE) {
        return { ok: false, error: `Could not stat ${filePath} for a backup: ${st.error}` }
      }
    }
    await p.writeFile(sftp, filePath, bytes)
    return {
      ok: true,
      ...(backupPath ? { backupPath } : {}),
      ...(beforeSha256 ? { beforeSha256 } : {}),
      afterSha256: sha256Hex(bytes)
    }
  })
}

// ─── runScript ────────────────────────────────────────────────────────────────────

const SCRIPT_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Upload to `~/.argos-ops/<random>/<name>` (0700 dir and file), exec it with the args as
 * separate quoted words, and remove both in `finally`. Done over SFTP because `mkdir -p`
 * as a shell wrapper is exactly the composition the gate forbids.
 */
async function runScript(
  hostId: string,
  name: string,
  content: Buffer,
  args: string[],
  opts: ExecOpts,
  hooks: ScriptHooks = {}
): Promise<ExecResult> {
  if (!SCRIPT_NAME.test(name) || name === '.' || name === '..') return failedExec(`Invalid script name: ${name}`)
  if (opts.signal.aborted) return failedExec('aborted before start')
  const r = await withSftp<ExecResult>(hostId, async (sftp) => {
    const home = await p.realpath(sftp, '.')
    const base = path.posix.join(home, '.argos-ops')
    await p.mkdir(sftp, base, 0o700) // fails harmlessly when it already exists
    const baseSt = await p.stat(sftp, base)
    if (!('st' in baseSt) || !baseSt.st.isDirectory()) return failedExec(`Could not create ${base}`)
    const dir = path.posix.join(base, randomBytes(8).toString('hex'))
    const mk = await p.mkdir(sftp, dir, 0o700)
    if (mk) return failedExec(`Could not create ${dir}: ${mk.message}`)
    const remote = path.posix.join(dir, name)
    let uploaded = false
    try {
      await p.writeFile(sftp, remote, content, 0o700)
      await p.chmod(sftp, remote, 0o700) // the server's umask may have trimmed the mode
      uploaded = true
      await hooks.uploaded?.(remote)
      const r = await exec(hostId, [remote, ...args], opts)
      await hooks.finished?.(r)
      return r
    } finally {
      await p.unlink(sftp, remote)
      await p.rmdir(sftp, dir)
      if (uploaded) await hooks.removed?.(remote)
    }
  })
  return 'exitCode' in r ? r : failedExec(r.error)
}

// ─── reachable ────────────────────────────────────────────────────────────────────

async function reachable(hostId: string, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ ok: boolean; message: string }>((resolve) => {
    timer = setTimeout(
      // Only openOpsSession's refusal shows this, so it is in the operator's language.
      () => resolve({ ok: false, message: t('runbook.session.noAnswer', { seconds: Math.round(timeoutMs / 1000) }) }),
      timeoutMs
    )
  })
  try {
    return await Promise.race([
      testConnection(hostId).catch((e) => ({ ok: false, message: message(e) })),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createSshBackend(): OpsBackend {
  return { exec, read, list, write, runScript, reachable }
}
