import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

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

export interface NumstatEntry {
  added: number
  deleted: number
  binary: boolean
}

/**
 * `git diff --numstat` output keyed by path. A rename is printed as `old => new` or with
 * braces (`src/{a => b}/x.ts`); it is keyed by the new path, since that is the one the
 * porcelain status names. Binaries print `-` for both counts.
 */
export function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>()
  for (const line of stdout.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const binary = m[1] === '-' && m[2] === '-'
    out.set(renameTarget(m[3]), {
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      binary
    })
  }
  return out
}

function renameTarget(p: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p)
  // "{a => }/x" or "{ => b}/x" leave a doubled slash once the empty side is dropped.
  if (braced) return (braced[1] + braced[3] + braced[4]).replace(/\/\//g, '/')
  const plain = p.indexOf(' => ')
  return plain >= 0 ? p.slice(plain + 4) : p
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
    counts = parseNumstat((await git(cwd, ['diff', '--numstat', 'HEAD'])).stdout)
  } else {
    // No commits yet, so nothing to diff against: staged and unstaged are summed instead.
    const cached = parseNumstat((await git(cwd, ['diff', '--numstat', '--cached'])).stdout)
    const worktree = parseNumstat((await git(cwd, ['diff', '--numstat'])).stdout)
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
    // Porcelain shows a rename as "old -> new"; numstat is keyed by the new path.
    const arrow = f.path.indexOf(' -> ')
    const c = counts.get(arrow >= 0 ? f.path.slice(arrow + 4) : f.path)
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
export async function getFileDiff(cwd: string, filePath: string): Promise<GitFileDiff> {
  // Porcelain names a rename "old -> new"; the worktree side is the new path.
  const arrow = filePath.indexOf(' -> ')
  const oldPath = arrow >= 0 ? filePath.slice(0, arrow) : filePath
  const newPath = arrow >= 0 ? filePath.slice(arrow + 4) : filePath
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
  if (tracked.code === 0 || arrow >= 0) {
    const args = ['diff', 'HEAD', '--']
    if (arrow >= 0) args.push(oldPath)
    args.push(newPath)
    result.patch = (await git(cwd, args)).stdout
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
  return new Promise((resolve) => {
    execFile('git', ['show', spec], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? Buffer.alloc(0) : stdout)
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
