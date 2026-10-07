/**
 * Pure, dependency-free helpers for the SFTP session manager (src/main/sftp.ts). Split out
 * so they're unit-testable without pulling in `ssh.ts` -> `electron`'s `app`, which isn't
 * available outside a running Electron process (and so isn't available under vitest).
 */

/**
 * Reject anything that isn't a POSIX-absolute path, or that contains a `..` segment.
 */
export function isSafeRemotePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (!p.startsWith('/')) return false
  const segments = p.split('/')
  if (segments.includes('..')) return false
  return true
}

/**
 * Keyed single-flight cache for long-lived connections: it stores the *promise* of an
 * open, not the opened value, so concurrent callers for the same key share one attempt
 * in flight instead of each dialing in (and the losers leaking). A failed open (a result
 * with `ok: false`, or a rejection) drops its entry so the next call starts fresh.
 *
 * `open` receives an `evict` callback bound to its own entry: call it when the thing it
 * opened dies (socket close, channel error) so the next caller reconnects. It only removes
 * the entry it was created for, so a stale connection closing late never evicts a newer
 * one under the same key.
 */
export class SingleFlightCache<R extends { ok: boolean }> {
  private readonly entries = new Map<string, Promise<R>>()

  get(key: string, open: (evict: () => void) => Promise<R>): Promise<R> {
    const existing = this.entries.get(key)
    if (existing) return existing

    let promise: Promise<R> | undefined
    const evict = (): void => {
      if (promise && this.entries.get(key) === promise) this.entries.delete(key)
    }
    promise = Promise.resolve()
      .then(() => open(evict))
      .then(
        (r) => {
          if (!r.ok) evict()
          return r
        },
        (e: unknown) => {
          evict()
          throw e
        }
      )
    this.entries.set(key, promise)
    return promise
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** Removes and returns the entry for `key` (settled or still in flight). */
  take(key: string): Promise<R> | undefined {
    const p = this.entries.get(key)
    this.entries.delete(key)
    return p
  }

  /** Removes and returns every entry. */
  takeAll(): Promise<R>[] {
    const all = [...this.entries.values()]
    this.entries.clear()
    return all
  }
}

/**
 * Parse a zsh/bash history file's raw text into a de-duped, chronological command list.
 * zsh's extended-history format prefixes each line with `: <timestamp>:<duration>;` —
 * strip it. Consecutive duplicate commands (very common — repeated `ls`, `git status`,
 * etc.) collapse into one. The file is already oldest-first, so the result stays
 * oldest-first; capping keeps only the most recent `cap` entries.
 */
export function parseHistoryLines(raw: string, cap = 500): string[] {
  const out: string[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const cmd = rawLine.replace(/^: \d+:\d+;/, '').trim()
    if (!cmd) continue
    if (out[out.length - 1] === cmd) continue
    out.push(cmd)
  }
  return out.length > cap ? out.slice(out.length - cap) : out
}
