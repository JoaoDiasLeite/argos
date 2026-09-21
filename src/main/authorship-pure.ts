/**
 * Who wrote which file — the decisions, with no disk under them.
 *
 * The ledger this backs exists to answer one question before a commit: of the files
 * sitting dirty in the tree, which came from *this* chat? Getting that wrong is the
 * failure the review gate exists to prevent — reviewing a diff as if one agent wrote it
 * when two did — so every rule that can be read without a filesystem lives here, under
 * test.
 */

/**
 * The tools whose call means "this chat wrote that file".
 *
 * The same four the renderer has always tracked for checkpoints (`App.tsx`), kept as one
 * list so the ledger and the checkpoints cannot drift into disagreeing about what
 * authorship means. Bash is deliberately absent: a `sed -i` does write a file, and
 * nothing in the call says which.
 */
const AUTHORING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The file a tool call wrote, or null if that call wrote no single file. */
export function authoredPath(tool: string, input: unknown): string | null {
  if (!AUTHORING_TOOLS.has(tool)) return null
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  // `file_path` for Edit/Write/MultiEdit, `notebook_path` for NotebookEdit; `path` is
  // accepted too because a transcript written by an older CLI can carry it.
  const raw = i.file_path ?? i.notebook_path ?? i.path
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * One spelling for a path that has several.
 *
 * The same file reaches this app under any of four names, depending on which side of
 * which boundary wrote it down: `C:\repo\src\a.ts` from a Windows chat,
 * `\\wsl.localhost\Ubuntu\home\me\repo\src\a.ts` from the share this app reads distros
 * through, `//wsl.localhost/Ubuntu/home/me/repo/src/a.ts` from git's own
 * `--show-toplevel`, and `/home/me/repo/src/a.ts` from the CLI inside the distro. They
 * have to compare equal or a WSL chat attributes nothing.
 *
 * The distro name is dropped rather than kept: it is the only way the share form and the
 * CLI's own form can meet. Two distros holding the same `/home/me/repo` therefore
 * canonicalise alike — harmless here, because every comparison this module makes is
 * against one repo root that came from the same session.
 *
 * A Windows drive is lowercased and `/mnt/<letter>/` is folded onto it, so a distro
 * reaching a Windows checkout through the drive mount lands on the same name as the
 * Windows side of it.
 */
export function canonPath(p: string): string {
  let s = (p ?? '').trim().replace(/\\/g, '/')
  if (!s) return ''
  // \\wsl.localhost\<distro>\… and \\wsl$\<distro>\… (already slash-normalised above).
  const wsl = s.match(/^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)?$/i)
  if (wsl) s = wsl[1] || '/'
  // /mnt/c/… → c:/…
  const mnt = s.match(/^\/mnt\/([a-z])(\/.*)?$/i)
  if (mnt) s = `${mnt[1].toLowerCase()}:${mnt[2] || '/'}`
  // C:/… → c:/…
  s = s.replace(/^([a-z]):/i, (_m, d: string) => `${d.toLowerCase()}:`)
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return s
}

/**
 * Where a file the ledger holds sits inside a repo, as the repo-relative POSIX path
 * `git status` uses — or null when it sits outside, which is how a chat's edits to some
 * other folder are dropped rather than attributed here.
 *
 * A worktree counts as the repo: a mission run in `<repo>.worktrees/<id>` is editing the
 * same file the repo's own status line is about, and the point of the worktree is that
 * it can be reviewed from the repo it came from. Both the explicit path and the layout
 * `createWorktree` lays down (git.ts) are recognised.
 *
 * Comparison is case-insensitive throughout. On Windows and over the WSL share that is
 * simply correct; inside a distro it is not, and the price is two files in one repo whose
 * names differ only in case — which git itself already handles badly enough that it is
 * not worth being wrong about the common case for.
 */
export function toRepoRelative(
  filePath: string,
  repoRoot: string,
  worktreePath?: string
): string | null {
  const file = canonPath(filePath)
  const root = canonPath(repoRoot)
  if (!file || !root) return null

  const under = (parent: string): string | null => {
    if (!parent) return null
    const prefix = parent.endsWith('/') ? parent : `${parent}/`
    return file.toLowerCase().startsWith(prefix.toLowerCase()) ? file.slice(prefix.length) : null
  }

  if (worktreePath) {
    const rel = under(canonPath(worktreePath))
    if (rel) return rel
  }
  const wt = under(`${root}.worktrees`)
  if (wt) {
    // `<id>/<rest>` — the worktree's own directory name is not part of the repo path.
    const rest = wt.split('/').slice(1).join('/')
    return rest || null
  }
  return under(root)
}

/** One chat's claim on a repo: which of its files it wrote, and when it last said so. */
export interface SessionPaths {
  sessionId: string
  /** The chat's name, for the row that says whose file this is. */
  name: string
  /** Repo-relative POSIX paths — `toRepoRelative` has already run. */
  paths: string[]
  updatedAt?: number
}

export interface AttributedFile {
  path: string
  sessionId: string
  name: string
}

export interface Attribution {
  /** Files the active chat wrote. */
  mine: string[]
  /** Files another chat wrote, each naming which. */
  others: AttributedFile[]
  /**
   * Files nobody claimed: a hand edit, another tool, a rebase, a chat from before the
   * ledger existed. Not a category to be embarrassed about — a category to be shown.
   */
  unattributed: string[]
}

/**
 * Split a repo's dirty files three ways.
 *
 * The active chat wins any file it wrote, even if another chat wrote it too — it is the
 * one the reviewer is standing in, and a file both touched is a file it touched. Among
 * the others the most recent writer is named, so a row says who to go and ask.
 *
 * Input order is kept: `git status` sorts, and a reordered file list reads like a
 * different tree.
 */
export function attribute(
  statusPaths: string[],
  ledgers: SessionPaths[],
  activeSessionId?: string
): Attribution {
  const mineSet = new Set<string>()
  for (const l of ledgers) {
    if (activeSessionId && l.sessionId === activeSessionId) for (const p of l.paths) mineSet.add(p)
  }
  // Most recent first, so the writer a row names is the one who wrote it last.
  const rest = ledgers
    .filter((l) => l.sessionId !== activeSessionId)
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const out: Attribution = { mine: [], others: [], unattributed: [] }
  for (const p of statusPaths) {
    if (mineSet.has(p)) {
      out.mine.push(p)
      continue
    }
    const owner = rest.find((l) => l.paths.includes(p))
    if (owner) out.others.push({ path: p, sessionId: owner.sessionId, name: owner.name })
    else out.unattributed.push(p)
  }
  return out
}
