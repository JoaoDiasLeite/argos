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
