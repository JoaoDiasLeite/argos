/**
 * Parsing and grouping for the Codex reader. Pure: no `fs`, no `electron`, so it
 * can be tested without a main process.
 *
 * Codex records a conversation as `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
 * whose first line is a `session_meta` header carrying the `cwd`. There is no
 * per-project directory the way Claude Code has one, so "which project is this"
 * is a grouping decision made here rather than something read off the filesystem.
 */

/**
 * A real folder path as a directory name.
 *
 * Claude Code's own encoding — every non-alphanumeric character becomes a dash —
 * and the canonical copy of it, which `claude-data.ts` re-exports as `encodePath`.
 * It lives in this module rather than beside the reader that has used it longest
 * because BOTH readers now depend on it agreeing exactly: the Codex reader has no
 * directory to take an id from, so it derives one from the cwd, and the same folder
 * opened in Codex and in Claude Code must land on the same project row. One
 * implementation is the only way to keep that true, and a pure module is the only
 * place both can reach without dragging Electron into a unit test.
 *
 * Lossy on purpose — it is an id, not a round-trip. The real path travels beside it.
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The last path segment of a Windows or POSIX path. */
export function pathBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export interface RolloutName {
  sessionId: string
  /** Local time the CLI stamped into the name, or 0 if it did not parse. */
  startedAt: number
}

/**
 * `rollout-2026-09-09T11-20-05-01a085ae-….jsonl` → its session id and start time.
 *
 * Null for anything else in the directory, which is how the scan tells a transcript
 * from a lock file or a leftover `.tmp`. Matching the uuid shape rather than
 * "everything after the timestamp" matters because the timestamp's own separators
 * are dashes too — the two only come apart by counting the uuid's groups.
 *
 * The name's timestamp is written in LOCAL time (the header inside the file carries
 * the UTC one), so it is assembled field by field rather than handed to `Date.parse`,
 * which would read the same digits differently depending on the exact spelling.
 */
const ROLLOUT_NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

export function parseRolloutFileName(file: string): RolloutName | null {
  const m = ROLLOUT_NAME.exec(file)
  if (!m) return null
  const [, y, mo, d, h, mi, s, uuid] = m
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const startedAt = at.getTime()
  return { sessionId: uuid, startedAt: Number.isNaN(startedAt) ? 0 : startedAt }
}

/**
 * The `<YYYY>/<MM>/<DD>` a rollout's own name says it belongs under.
 *
 * Archiving moves the file out of that tree and unarchiving has to put it back, with
 * no header read to go on: the name carries the date, in local time, and it is the
 * same date the directory it came from was named after. Reconstructing it from the
 * name is therefore exact, and not a guess at what `mtime` might mean by now.
 */
export function rolloutDateSegments(file: string): [string, string, string] | null {
  const m = ROLLOUT_NAME.exec(file)
  return m ? [m[1], m[2], m[3]] : null
}

/**
 * `session_index.jsonl`'s entries reduced to id → thread name.
 *
 * The file is append-only and the same id reappears every time its name changes, so
 * the LAST entry for an id is the one that stands — the same "last one wins" rule
 * `listSessions` applies to Claude Code's appended `custom-title`.
 *
 * Takes already-parsed entries, because the streaming reader in jsonl.ts is what
 * reads the file and it already drops the line a live Codex may be halfway through
 * writing. An entry without a usable name is skipped here and deliberately does NOT
 * erase an earlier one — a malformed record is missing information, not an
 * instruction to forget the name.
 */
export function reduceThreadNames(entries: Iterable<unknown>): Map<string, string> {
  const names = new Map<string, string>()
  for (const obj of entries) {
    if (!obj || typeof obj !== 'object') continue
    const rec = obj as { id?: unknown; thread_name?: unknown }
    if (typeof rec.id !== 'string' || !rec.id) continue
    if (typeof rec.thread_name !== 'string') continue
    const name = rec.thread_name.trim()
    if (!name) continue
    names.set(rec.id, name)
  }
  return names
}

/** The `input_text` / `output_text` parts of a Codex message, joined. */
export function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type !== 'input_text' && b.type !== 'output_text' && b.type !== 'text') continue
    if (typeof b.text === 'string') out += (out ? ' ' : '') + b.text
  }
  return out
}

/**
 * A single wrapper block the CLI injected, anchored at the start of the text.
 *
 * Codex opens every conversation by putting its own context into the *user's*
 * channel — `<environment_context>`, `<recommended_plugins>`, `<user_instructions>`.
 * Taking the first user entry at face value therefore produces a preview made of the
 * sandbox policy, exactly the failure `isInjectedUserEntry` exists to avoid on the
 * Claude Code side.
 *
 * Anchored, and only snake_case tags, so this strips the plumbing without eating a
 * message that merely happens to contain markup. If nothing survives the stripping
 * the entry was ALL plumbing, and the caller falls through to the next one.
 */
const LEADING_INJECTED_BLOCK = /^\s*<([a-z][a-z0-9_]*)>[\s\S]*?<\/\1>\s*/

export function codexUserText(content: unknown): string {
  let text = codexContentText(content)
  let prev = ''
  while (text !== prev) {
    prev = text
    text = text.replace(LEADING_INJECTED_BLOCK, '')
  }
  return text.replace(/\s+/g, ' ').trim()
}

/** One transcript, as much as the cheap header-only scan knows about it. */
export interface CodexRolloutFacts {
  sessionId: string
  /** Absolute path of the `.jsonl`. */
  file: string
  /** The `cwd` from the `session_meta` header — the only thing that names a project. */
  cwd: string
  createdAt: number
  /** File mtime, the stand-in for "last active" before anything is read. */
  mtime: number
}

export interface CodexProjectGroup {
  encodedDir: string
  realPath: string
  name: string
  sessionCount: number
  lastActive: number
}

/**
 * One project per distinct cwd.
 *
 * Grouping by the ENCODED path rather than the raw one, because that is the id the
 * renderer will send back: two spellings of the same folder that encode alike have
 * to be one row, or clicking it lists half its sessions. The first spelling seen
 * supplies `realPath`, which is arbitrary but stable within a scan.
 */
export function groupRolloutsByCwd(rollouts: Iterable<CodexRolloutFacts>): CodexProjectGroup[] {
  const groups = new Map<string, CodexProjectGroup>()
  for (const r of rollouts) {
    if (!r.cwd) continue
    const encodedDir = encodeProjectPath(r.cwd)
    const existing = groups.get(encodedDir)
    if (existing) {
      existing.sessionCount++
      if (r.mtime > existing.lastActive) existing.lastActive = r.mtime
    } else {
      groups.set(encodedDir, {
        encodedDir,
        realPath: r.cwd,
        name: pathBasename(r.cwd),
        sessionCount: 1,
        lastActive: r.mtime
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.lastActive - a.lastActive)
}
