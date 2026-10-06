/**
 * An in-memory OpsBackend for tests and for the `ARGOS_OPS_FAKE=1` dev flag, so the whole
 * gate + tool + ledger path runs (and screenshots render) without a server. No electron,
 * no ssh2. It records every call so a test can assert that a denied call never reached
 * the backend, and it honours the same abort, timeout and output-cap rules as the real
 * one so "timed out" and "truncated" look the same in both.
 */
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import {
  backupPathFor,
  failedExec,
  makeCapture,
  type ExecOpts,
  type ExecResult,
  type OpsBackend,
  type OpsListEntry
} from './ops-exec-pure'

export interface FakeScript {
  /**
   * What a command returns. For runScript it is called with `[name, ...args]`. Default:
   * exit 0, stdout `ok`.
   */
  exec?: (argv: string[]) => Partial<ExecResult> | Promise<Partial<ExecResult>>
  /** Absolute path → content. `write` adds to it; directories are implied by the paths. */
  files?: Record<string, string>
  /** hostId → reachable. Hosts not listed are reachable. */
  reachable?: Record<string, boolean>
  /** Simulated latency of exec/runScript. Past the call's timeoutMs it becomes a timeout. */
  delayMs?: number
}

export interface FakeCall {
  kind: 'exec' | 'read' | 'list' | 'write' | 'runScript' | 'reachable'
  hostId: string
  args: unknown
}

export type FakeBackend = OpsBackend & {
  calls: FakeCall[]
  /** The live file map, after writes and backups. */
  files: Record<string, string>
}

/** Resolves after ms, or early with 'aborted'. */
function wait(ms: number, signal: AbortSignal): Promise<'done' | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('done')
    }, ms)
    function onAbort(): void {
      clearTimeout(t)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createFakeBackend(script: FakeScript = {}): FakeBackend {
  const calls: FakeCall[] = []
  const files: Record<string, string> = { ...(script.files ?? {}) }
  const delayMs = script.delayMs ?? 0

  async function respond(argv: string[], opts: ExecOpts): Promise<ExecResult> {
    const startedAt = Date.now()
    if (opts.signal.aborted) return failedExec('aborted before start')
    const timedOut = delayMs > opts.timeoutMs
    const waited = await wait(timedOut ? opts.timeoutMs : delayMs, opts.signal)
    if (waited === 'aborted') return failedExec('aborted', Date.now() - startedAt)
    if (timedOut) {
      return {
        ok: true,
        exitCode: null,
        signal: 'TERM',
        timedOut: true,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false
      }
    }
    const part = script.exec ? await script.exec(argv) : {}
    const out = makeCapture(opts.maxOutputBytes)
    const err = makeCapture(opts.maxOutputBytes)
    out.push(part.stdout ?? 'ok')
    err.push(part.stderr ?? '')
    const result: ExecResult = {
      ok: true,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      stdoutBytes: out.bytes,
      stderrBytes: err.bytes,
      truncated: out.truncated || err.truncated,
      ...part,
      // The partial's text, with the call's cap applied like the real backend would.
      stdout: out.text(),
      stderr: err.text()
    }
    if (result.error === undefined) delete result.error
    return result
  }

  return {
    calls,
    files,

    exec(hostId, argv, opts) {
      calls.push({ kind: 'exec', hostId, args: { argv: [...argv], stdin: opts.stdin, timeoutMs: opts.timeoutMs } })
      return respond(argv, opts)
    },

    async read(hostId, p, maxBytes) {
      calls.push({ kind: 'read', hostId, args: { path: p, maxBytes } })
      const content = files[p]
      if (content === undefined) return { ok: false, error: 'No such file' }
      if (Buffer.byteLength(content, 'utf-8') > maxBytes) return { ok: true, tooLarge: true }
      if (content.includes('\0')) return { ok: true, binary: true }
      return { ok: true, content }
    },

    async list(hostId, dir) {
      calls.push({ kind: 'list', hostId, args: { path: dir } })
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const seen = new Map<string, OpsListEntry>()
      for (const [f, content] of Object.entries(files)) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const [name, ...deeper] = rest.split('/')
        if (!name || seen.has(name)) continue
        seen.set(
          name,
          deeper.length
            ? { name, type: 'directory', size: 0, mtime: 0 }
            : { name, type: 'file', size: Buffer.byteLength(content, 'utf-8'), mtime: 0 }
        )
      }
      if (seen.size === 0) return { ok: false, error: 'No such directory' }
      return { ok: true, entries: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
    },

    async write(hostId, p, content, backup) {
      calls.push({ kind: 'write', hostId, args: { path: p, content, backup } })
      if (!path.posix.isAbsolute(p)) return { ok: false, error: 'Invalid remote path' }
      let backupPath: string | undefined
      let beforeSha256: string | undefined
      const before = files[p]
      if (backup && before !== undefined) {
        backupPath = backupPathFor(p, new Date())
        beforeSha256 = sha256Hex(before)
        files[backupPath] = before
      }
      files[p] = content
      return {
        ok: true,
        ...(backupPath ? { backupPath } : {}),
        ...(beforeSha256 ? { beforeSha256 } : {}),
        afterSha256: sha256Hex(content)
      }
    },

    async runScript(hostId, name, content, args, opts, hooks = {}) {
      calls.push({
        kind: 'runScript',
        hostId,
        args: { name, args: [...args], sha256: sha256Hex(content), stdin: opts.stdin, timeoutMs: opts.timeoutMs }
      })
      // The same order of hooks as the ssh backend, around a made-up upload path.
      const remote = `/home/ops/.argos-ops/fake/${name}`
      await hooks.uploaded?.(remote)
      const r = await respond([name, ...args], opts)
      await hooks.finished?.(r)
      await hooks.removed?.(remote)
      return r
    },

    async reachable(hostId, timeoutMs) {
      calls.push({ kind: 'reachable', hostId, args: { timeoutMs } })
      const ok = script.reachable?.[hostId] ?? true
      return ok ? { ok: true, message: `Connected to ${hostId} (fake)` } : { ok: false, message: 'Timed out while waiting for handshake' }
    }
  }
}
