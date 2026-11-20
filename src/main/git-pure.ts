// Parsers for git's NUL-separated (-z) output. With -z git does not C-quote odd file
// names ("caf\303\251.txt") and does not join renames with " -> ", so spaces, accents
// and arrows in a name all arrive intact.

export interface PorcelainEntry {
  /** Index and worktree status letters (the two XY columns). */
  index: string
  worktree: string
  /** The current path; for a rename or copy, the destination. */
  path: string
  /** The source path of a rename or copy. */
  origPath?: string
}

/** `git status --porcelain=v1 -z`: `XY path\0`, and for R/C a second field `orig\0`. */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = []
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.length < 4) continue // the empty tail after the last NUL, or noise
    const index = f[0]
    const worktree = f[1]
    const entry: PorcelainEntry = { index, worktree, path: f.slice(3) }
    // The rename/copy letter can sit on either side (staged or not).
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const orig = fields[++i]
      if (orig) entry.origPath = orig
    }
    out.push(entry)
  }
  return out
}

export interface NumstatEntry {
  added: number
  deleted: number
  binary: boolean
}

/**
 * `git diff --numstat -z` keyed by path. A rename is `A\tD\t\0old\0new\0` (empty path
 * field, then both names); it is keyed by the new path, the one status names. Binaries
 * print `-` for both counts.
 */
export function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>()
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[i])
    if (!m) continue
    let p = m[3]
    if (p === '') {
      i += 2 // old, new
      p = fields[i] ?? ''
    }
    if (!p) continue
    const binary = m[1] === '-' && m[2] === '-'
    out.set(p, { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary })
  }
  return out
}
