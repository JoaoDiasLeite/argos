/**
 * The executor's contract and its pure parts (docs/OPS_AGENT_PLAN.md §4): the backend
 * interface, the output cap, the backup naming, the per-host FIFO queue and the executor
 * wrapper. No electron, no ssh2, no fs, so the fake backend and the tool tests can use the
 * real queue and abort fan-out instead of a lookalike. The ssh2 backend is `ops-exec.ts`.
 */

// ─── Contract ─────────────────────────────────────────────────────────────────────

export interface ExecOpts {
  timeoutMs: number
  /** Per stream. Bytes past it are counted, not kept. */
  maxOutputBytes: number
  /** Written to the command's stdin, which is then closed (sudo -S passwords). */
  stdin?: string
  signal: AbortSignal
}

/**
 * `ok` says the command was started and its channel closed on its own or by our timeout:
 * a non-zero exit is still `ok: true` with that `exitCode`, and a timeout is `ok: true`
 * with `timedOut`. `ok: false` means it never ran, the connection dropped, or the run was
 * aborted, and `error` says which. Output is whatever arrived before that point.
 */
export interface ExecResult {
  ok: boolean
  exitCode: number | null
  signal?: string
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  error?: string
}

export type OpsReadResult =
  | { ok: true; content: string }
  | { ok: true; tooLarge: true }
  | { ok: true; binary: true }
  | { ok: false; error: string }

export interface OpsListEntry {
  name: string
  type: string
  size: number
  mtime: number
}

export type OpsListResult = { ok: true; entries: OpsListEntry[] } | { ok: false; error: string }

export type OpsWriteResult =
  | { ok: true; backupPath?: string; beforeSha256?: string; afterSha256: string }
  | { ok: false; error: string }

export interface OpsBackend {
  /** Run argv (already gated) on the host. The implementation quotes with shellJoin. stdin, if given, is written then closed (used for sudo -S passwords). */
  exec(hostId: string, argv: string[], opts: ExecOpts): Promise<ExecResult>
  read(hostId: string, path: string, maxBytes: number): Promise<OpsReadResult>
  list(hostId: string, path: string): Promise<OpsListResult>
  write(hostId: string, path: string, content: string, backup: boolean): Promise<OpsWriteResult>
  /** Upload a script to a private temp dir on the host, run it with args, delete it. */
  runScript(hostId: string, name: string, content: Buffer, args: string[], opts: ExecOpts): Promise<ExecResult>
  reachable(hostId: string, timeoutMs: number): Promise<{ ok: boolean; message: string }>
}

/** An ExecResult for a command that never produced anything. */
export function failedExec(error: string, durationMs = 0): ExecResult {
  return {
    ok: false,
    exitCode: null,
    timedOut: false,
    durationMs,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    error
  }
}

// ─── Output cap ───────────────────────────────────────────────────────────────────

export interface Capture {
  push(chunk: Buffer | string): void
  /** Kept bytes as UTF-8, with a `[truncated N bytes]` marker when bytes were dropped. */
  text(): string
  /** Every byte seen, kept or not: the ledger records the real size. */
  readonly bytes: number
  readonly truncated: boolean
}

/**
 * Keep the first `maxBytes` of a stream and count the rest. Counting continues past the
 * cap because "the command printed 40 MB" is itself a finding the ledger should hold.
 */
export function makeCapture(maxBytes: number): Capture {
  const cap = Math.max(0, Math.floor(maxBytes))
  const chunks: Buffer[] = []
  let kept = 0
  let seen = 0
  return {
    push(chunk) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk
      seen += buf.length
      if (kept >= cap) return
      const part = buf.length <= cap - kept ? buf : buf.subarray(0, cap - kept)
      chunks.push(part)
      kept += part.length
    },
    text() {
      const s = Buffer.concat(chunks).toString('utf-8')
      return seen > kept ? `${s}\n[truncated ${seen - kept} bytes]` : s
    },
    get bytes() {
      return seen
    },
    get truncated() {
      return seen > kept
    }
  }
}

// ─── Backup naming ────────────────────────────────────────────────────────────────

/**
 * `<path>.argos-<ISO time>.bak`, colons replaced so the name is also valid when the file
 * is later copied to a Windows machine. Milliseconds keep two writes in one second apart.
 */
export function backupPathFor(path: string, at: Date): string {
  return `${path}.argos-${at.toISOString().replace(/:/g, '-')}.bak`
}

// ─── Per-host FIFO queue ──────────────────────────────────────────────────────────

export interface HostQueue {
  /** Run fn after every earlier call on this host has settled. Hosts never wait on each other. */
  run<T>(hostId: string, fn: () => Promise<T>): Promise<T>
  /** Calls on this host that a new call would wait behind (running + waiting). */
  queuedBehind(hostId: string): number
}

/**
 * One promise chain per host. The chain link swallows the previous result, so a rejected
 * fn ends its own call and never blocks the next one. Empty chains are dropped so a long
 * session does not keep one entry per host it ever touched.
 */
export function makeHostQueue(): HostQueue {
  const tails = new Map<string, Promise<void>>()
  const pending = new Map<string, number>()
  return {
    run<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(hostId) ?? Promise.resolve()
      pending.set(hostId, (pending.get(hostId) ?? 0) + 1)
      const result = prev.then(() => fn())
      const done = (): void => {
        const n = (pending.get(hostId) ?? 1) - 1
        if (n <= 0) pending.delete(hostId)
        else pending.set(hostId, n)
        if (tails.get(hostId) === tail) tails.delete(hostId)
      }
      const tail: Promise<void> = result.then(done, done)
      tails.set(hostId, tail)
      return result
    },
    queuedBehind(hostId: string): number {
      return pending.get(hostId) ?? 0
    }
  }
}

// ─── Executor ─────────────────────────────────────────────────────────────────────

/**
 * A signal that aborts when any of the inputs does (AbortSignal.any is not in Node 20's
 * types). `dispose` detaches it: the app-wide signal lives for the whole session, and a
 * listener left on it per call would pile up for as long as the app runs.
 */
export function anySignal(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController()
  const off: (() => void)[] = []
  const dispose = (): void => {
    for (const f of off.splice(0)) f()
  }
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason)
      return { signal: ctl.signal, dispose }
    }
  }
  for (const s of signals) {
    const onAbort = (): void => {
      dispose()
      ctl.abort(s.reason)
    }
    s.addEventListener('abort', onAbort, { once: true })
    off.push(() => s.removeEventListener('abort', onAbort))
  }
  return { signal: ctl.signal, dispose }
}

export interface OpsExecutor {
  /**
   * The backend with the app-wide abort folded into every exec/runScript signal. It is NOT
   * serialised itself: wrap each call (or a group of calls that must stay together, like
   * a read then a write) in `run`. Calling `run` from inside `run` on the same host
   * deadlocks, so never nest.
   */
  backend: OpsBackend
  run<T>(hostId: string, fn: () => Promise<T>): Promise<T>
  queuedBehind(hostId: string): number
  /** End every in-flight exec/runScript on every host (app quit, "stop all"). */
  abortAll(reason?: string): void
}

/** Wraps a backend with per-host serialisation (one call at a time per host, FIFO) and an app-wide abort fan-out. */
export function createExecutor(backend: OpsBackend): OpsExecutor {
  const queue = makeHostQueue()
  let app = new AbortController()
  const withApp = async (opts: ExecOpts, call: (o: ExecOpts) => Promise<ExecResult>): Promise<ExecResult> => {
    const linked = anySignal([opts.signal, app.signal])
    try {
      return await call({ ...opts, signal: linked.signal })
    } finally {
      linked.dispose()
    }
  }
  const wrapped: OpsBackend = {
    exec: (hostId, argv, opts) => withApp(opts, (o) => backend.exec(hostId, argv, o)),
    read: (hostId, path, maxBytes) => backend.read(hostId, path, maxBytes),
    list: (hostId, path) => backend.list(hostId, path),
    write: (hostId, path, content, backup) => backend.write(hostId, path, content, backup),
    runScript: (hostId, name, content, args, opts) =>
      withApp(opts, (o) => backend.runScript(hostId, name, content, args, o)),
    reachable: (hostId, timeoutMs) => backend.reachable(hostId, timeoutMs)
  }
  return {
    backend: wrapped,
    run: (hostId, fn) => queue.run(hostId, fn),
    queuedBehind: (hostId) => queue.queuedBehind(hostId),
    abortAll(reason = 'aborted') {
      // A fresh controller, so calls made after the abort (a new run) are not born dead.
      const old = app
      app = new AbortController()
      old.abort(reason)
    }
  }
}
