import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { parseNumstat, parsePorcelainZ, type NumstatEntry } from './git-pure'

/** Ceiling for one git call; a stuck process is killed rather than hanging the IPC. */
const GIT_TIMEOUT_MS = 20_000
/** Status, diffs and blob reads can legitimately take a while on a big repo. */
const GIT_SLOW_TIMEOUT_MS = 60_000

// No prompt: a git waiting for credentials must fail, not sit there. quotePath=false
// keeps accented names readable in the text we do not parse (patches).
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const GIT_PREFIX = ['-c', 'core.quotePath=false']

function git(
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_PREFIX, ...args],
      { cwd, maxBuffer: 20 * 1024 * 1024, timeout, env: GIT_ENV },
      (err, stdout, stderr) => {
        const e = err as { code?: unknown; killed?: boolean; signal?: string } | null
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          code: e && typeof e.code === 'number' ? e.code : e ? 1 : 0,
          // execFile kills the child on timeout, leaving killed + a signal on the error.
          timedOut: !!e && e.killed === true && !!e.signal
        })
      }
    )
  })
}

/** A hung git must reach the renderer as a rejected call, handled like any other git
 *  error, not as an empty repo or a forever-pending promise. */
function failIfTimedOut(res: { timedOut: boolean }, what: string): void {
  if (res.timedOut) throw new Error(`git ${what} timed out`)
}

export interface GitFile {
  path: string
  /** Source path of a rename or copy; `path` is then the destination. */
  origPath?: string
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
  /** Lines added vs HEAD (the whole file for an untracked one). Undefined when unknown. */
  added?: number
  deleted?: number
  binary?: boolean
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
  failIfTimedOut(inside, 'rev-parse')
  if (inside.stdout.trim() !== 'true') return { isRepo: false, branch: '', files: [], ahead: 0, behind: 0 }

  const branchRes = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.stdout.trim()

  const statusRes = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], GIT_SLOW_TIMEOUT_MS)
  failIfTimedOut(statusRes, 'status')
  const files: GitFile[] = parsePorcelainZ(statusRes.stdout).map((e) => ({
    path: e.path,
    ...(e.origPath ? { origPath: e.origPath } : {}),
    index: e.index,
    worktree: e.worktree,
    staged: e.index !== ' ' && e.index !== '?',
    untracked: e.index === '?' && e.worktree === '?'
  }))

  await addLineCounts(cwd, files)

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

/** Untracked files are read whole to count them; past this they are left as "binary"
 *  rather than pulling a large artefact into memory just for a number. */
const UNTRACKED_COUNT_CAP = 2 * 1024 * 1024
/** Above this a side of a diff is not sent to the renderer at all. */
const DIFF_SIDE_CAP = 1024 * 1024

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

function countLines(text: string): number {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

async function addLineCounts(cwd: string, files: GitFile[]): Promise<void> {
  if (files.length === 0) return
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  let counts: Map<string, NumstatEntry>
  if (head.code === 0) {
    counts = parseNumstat((await git(cwd, ['diff', '--numstat', '-z', 'HEAD'], GIT_SLOW_TIMEOUT_MS)).stdout)
  } else {
    // No commits yet, so nothing to diff against: staged and unstaged are summed instead.
    const cached = parseNumstat((await git(cwd, ['diff', '--numstat', '-z', '--cached'], GIT_SLOW_TIMEOUT_MS)).stdout)
    const worktree = parseNumstat((await git(cwd, ['diff', '--numstat', '-z'], GIT_SLOW_TIMEOUT_MS)).stdout)
    counts = new Map(cached)
    for (const [p, w] of worktree) {
      const c = counts.get(p)
      counts.set(
        p,
        c ? { added: c.added + w.added, deleted: c.deleted + w.deleted, binary: c.binary || w.binary } : w
      )
    }
  }

  for (const f of files) {
    if (f.untracked) {
      try {
        const full = resolveInRepo(cwd, f.path)
        const stat = fs.statSync(full)
        if (stat.size > UNTRACKED_COUNT_CAP) {
          f.binary = true
          continue
        }
        const buf = fs.readFileSync(full)
        if (looksBinary(buf)) f.binary = true
        else {
          f.added = countLines(buf.toString('utf-8'))
          f.deleted = 0
        }
      } catch {
        // Gone between status and the read, or a directory: no count rather than a wrong one.
      }
      continue
    }
    // numstat is keyed by the new path, which is `path` for a rename too.
    const c = counts.get(f.path)
    if (!c) continue
    if (c.binary) f.binary = true
    else {
      f.added = c.added
      f.deleted = c.deleted
    }
  }
}

/**
 * A repo-relative path resolved inside `cwd`, refusing anything that could step outside
 * it: the path comes from the renderer, and the caller reads whatever file it names.
 */
function resolveInRepo(cwd: string, filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  if (!norm || path.isAbsolute(filePath) || /^[a-zA-Z]:/.test(norm) || norm.startsWith('/') || norm.split('/').includes('..')) {
    throw new Error('bad path')
  }
  return path.join(cwd, norm)
}

export interface GitFileDiff {
  path: string
  oldText: string
  newText: string
  binary: boolean
  tooLarge: boolean
  /** Unified diff text, for copying; synthesised for an untracked file. */
  patch: string
}

/**
 * One file's change vs HEAD, staged and unstaged together: both sides whole (the
 * renderer's DiffView computes its own rows) plus git's patch for "Copy diff". Throws on
 * a path that is absolute or climbs out of the repo.
 */
export async function getFileDiff(cwd: string, filePath: string, origPath?: string): Promise<GitFileDiff> {
  // For a rename the worktree side is the new path and HEAD still has the old one.
  const renamed = !!origPath
  const oldPath = origPath || filePath
  const newPath = filePath
  resolveInRepo(cwd, oldPath)
  const full = resolveInRepo(cwd, newPath)
  const result: GitFileDiff = { path: filePath, oldText: '', newText: '', binary: false, tooLarge: false, patch: '' }

  const oldBuf = await gitShowBuffer(cwd, `HEAD:${oldPath.replace(/\\/g, '/')}`)
  let newBuf: Buffer = Buffer.alloc(0)
  try {
    const stat = fs.statSync(full)
    if (stat.isFile()) {
      if (stat.size > DIFF_SIDE_CAP) result.tooLarge = true
      else newBuf = fs.readFileSync(full)
    }
  } catch {
    // Deleted in the worktree: the new side stays empty.
  }
  if (oldBuf.length > DIFF_SIDE_CAP) result.tooLarge = true
  if (result.tooLarge) return result
  if (looksBinary(oldBuf) || looksBinary(newBuf)) {
    result.binary = true
    return result
  }
  result.oldText = oldBuf.toString('utf-8')
  result.newText = newBuf.toString('utf-8')

  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', newPath])
  if (tracked.code === 0 || renamed) {
    const args = ['diff', 'HEAD', '--']
    if (renamed) args.push(oldPath)
    args.push(newPath)
    const diffRes = await git(cwd, args, GIT_SLOW_TIMEOUT_MS)
    failIfTimedOut(diffRes, 'diff')
    result.patch = diffRes.stdout
  }
  if (!result.patch && result.newText && !result.oldText) {
    // Untracked: `git diff --no-index /dev/null` misbehaves on Windows, and the patch of
    // a new file is only every line added.
    const lines = result.newText.replace(/\n$/, '').split('\n')
    result.patch = `--- /dev/null\n+++ b/${newPath.replace(/\\/g, '/')}\n` + lines.map((l) => `+${l}`).join('\n') + '\n'
  }
  return result
}

/** `git show <rev>:<path>` as raw bytes; empty on any failure (new file, no HEAD). The
 *  buffer is generous so an oversized blob still arrives and is caught as tooLarge. */
function gitShowBuffer(cwd: string, spec: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_PREFIX, 'show', spec],
      { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: GIT_SLOW_TIMEOUT_MS, env: GIT_ENV },
      (err, stdout) => {
        // A timeout must not read as "file is new": that would show the whole file as added.
        if (err && (err as { killed?: boolean }).killed) reject(new Error('git show timed out'))
        else resolve(err ? Buffer.alloc(0) : stdout)
      }
    )
  })
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
