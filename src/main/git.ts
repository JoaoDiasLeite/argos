import { execFile } from 'child_process'
import * as fs from 'fs'

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      })
    })
  })
}

export interface GitFile {
  path: string
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  files: GitFile[]
  ahead: number
  behind: number
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  if (!cwd || !fs.existsSync(cwd)) return { isRepo: false, branch: '', files: [], ahead: 0, behind: 0 }

  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.stdout.trim() !== 'true') return { isRepo: false, branch: '', files: [], ahead: 0, behind: 0 }

  const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.stdout.trim()

  const statusRes = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  const files: GitFile[] = []
  for (const line of statusRes.stdout.split('\n')) {
    if (!line.trim()) continue
    const index = line[0]
    const worktree = line[1]
    const filePath = line.slice(3).replace(/^"|"$/g, '')
    files.push({
      path: filePath,
      index,
      worktree,
      staged: index !== ' ' && index !== '?',
      untracked: index === '?' && worktree === '?'
    })
  }

  let ahead = 0
  let behind = 0
  const ab = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  if (ab.code === 0) {
    const [b, a] = ab.stdout.trim().split(/\s+/).map(Number)
    behind = b || 0
    ahead = a || 0
  }

  return { isRepo: true, branch, files, ahead, behind }
}

export interface RepoName {
  /** Basename of the origin remote's URL, without a trailing `.git`. */
  remote?: string
  /** Basename of the repository root (`git rev-parse --show-toplevel`). */
  toplevel?: string
}

/**
 * Basename of a remote URL's path, independent of which of the three forms git accepts
 * it came in as: an HTTPS/ssh/git/file URL with a scheme, the SSH scp-like shorthand
 * (`user@host:owner/repo.git`, which is not a URL — `new URL()` rejects it), or a plain
 * local filesystem path. Exported (rather than folded into getRepoName) so the three
 * forms can be unit-tested without shelling out to git.
 */
export function repoNameFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined

  let pathPart: string
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    // Has a scheme (https://, ssh://, git://, file://, ...): let URL do the parsing.
    try {
      pathPart = new URL(trimmed).pathname
    } catch {
      pathPart = trimmed
    }
  } else if (/^[^/\\@]+@[^/\\:]+:/.test(trimmed)) {
    // SSH scp-like shorthand ("git@host:owner/repo.git"): path is everything after
    // the colon. Guarded on a leading "user@host" so a Windows drive letter like
    // "C:\repo" (no "@") doesn't get misread as this form.
    pathPart = trimmed.slice(trimmed.indexOf(':') + 1)
  } else {
    // Local filesystem path, absolute or relative, Windows or POSIX.
    pathPart = trimmed
  }

  const normalized = pathPart.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = normalized.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (!last) return undefined
  return last.replace(/\.git$/, '')
}

const repoNameCache = new Map<string, RepoName>()

/** Drops all cached repo-name lookups; not time-based since a repo's identity rarely changes. */
export function clearRepoNameCache(): void {
  repoNameCache.clear()
}

/**
 * The origin remote's URL, verbatim — the basename in `getRepoName` throws away the
 * host, and the host is what says which forge a project lives on. Empty when the
 * folder is not a repo or has no origin; never throws.
 */
export async function getRemoteUrl(cwd: string): Promise<string> {
  if (!cwd || !fs.existsSync(cwd)) return ''
  try {
    const res = await git(cwd, ['config', '--get', 'remote.origin.url'])
    return res.code === 0 ? res.stdout.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Repo identity for display purposes: the origin remote's basename (if a remote is
 * configured) and the basename of the working tree's toplevel. Cached per `cwd` since
 * this is asked for on every project every time a view opens, and a repo's name is
 * effectively static. Never throws — a missing folder or a non-repo both resolve to
 * `{}` so a stale project among many doesn't break the rest of the batch.
 */
export async function getRepoName(cwd: string): Promise<RepoName> {
  const cached = repoNameCache.get(cwd)
  if (cached) return cached

  if (!cwd || !fs.existsSync(cwd)) {
    const empty: RepoName = {}
    repoNameCache.set(cwd, empty)
    return empty
  }

  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.stdout.trim() !== 'true') {
    const empty: RepoName = {}
    repoNameCache.set(cwd, empty)
    return empty
  }

  const result: RepoName = {}

  const remoteRes = await git(cwd, ['config', '--get', 'remote.origin.url'])
  if (remoteRes.code === 0 && remoteRes.stdout.trim()) {
    result.remote = repoNameFromRemoteUrl(remoteRes.stdout.trim())
  }

  const toplevelRes = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (toplevelRes.code === 0 && toplevelRes.stdout.trim()) {
    // git always emits forward slashes here, even on Windows.
    const segments = toplevelRes.stdout.trim().split('/').filter(Boolean)
    result.toplevel = segments[segments.length - 1]
  }

  repoNameCache.set(cwd, result)
  return result
}

export interface GitCommit {
  hash: string
  /** ISO date "YYYY-MM-DD". */
  date: string
  author: string
  subject: string
}

/**
 * Recent commits, newest first, for a standup digest. When `authorOnly`, filters to the
 * repo's configured user (user.email) so a shared repo still yields the caller's work.
 * Returns [] for a non-repo or on any failure — callers treat git as best-effort context.
 * Fields are separated by the 0x1F unit-separator (emitted via git's %x1f) so commit
 * subjects containing spaces or pipes parse cleanly.
 */
export async function getLog(cwd: string, sinceDays = 3, authorOnly = true): Promise<GitCommit[]> {
  if (!cwd || !fs.existsSync(cwd)) return []
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.stdout.trim() !== 'true') return []

  const args = [
    'log',
    `--since=${sinceDays} days ago`,
    '--date=short',
    '--pretty=format:%h%x1f%ad%x1f%an%x1f%s',
    '--max-count=80'
  ]
  if (authorOnly) {
    const emailRes = await git(cwd, ['config', 'user.email'])
    const email = emailRes.stdout.trim()
    if (email) args.push(`--author=${email}`)
  }

  const res = await git(cwd, args)
  if (res.code !== 0 || !res.stdout.trim()) return []
  const commits: GitCommit[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const [hash, date, author, subject] = line.split('\x1f')
    if (subject) commits.push({ hash, date, author, subject })
  }
  return commits
}
