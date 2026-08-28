import * as fs from 'fs'
import * as path from 'path'
import {
  appendTopic,
  countDone,
  countPending,
  deleteAt,
  duplicateAt,
  editAt,
  locateTopic,
  parseTopics,
  pickPrimary,
  setDoneAt,
  type BacklogTopic
} from './backlog-pure'

// ─── Backlog fused with the repo ──────────────────────────────────────────────
// Mirror of src/renderer/src/types.ts — keep both in sync.
//
// The week planner's tasks exist only in Argos. These are the `- [ ]` boxes already
// written in the project's own record, so they outlive the app and travel with the
// repo. When a project has one, that file is the truth and Argos's own unscheduled
// tasks are legacy.
//
// This module is the fs half only: find the record, read it, hand the decisions to
// `backlog-pure.ts`, write the result back. Nothing here judges anything.

export type { BacklogTopic }

export interface BacklogRecord {
  /** Absolute path of the primary record. */
  path: string
  /** Relative to the project root — what the UI names. */
  relPath: string
  topics: BacklogTopic[]
  /**
   * Unticked topics in the whole file. The real count, never the length of a list the
   * UI capped for display — a backlog that says 12 when it holds 40 is worse than no
   * count at all.
   */
  pending: number
  done: number
}

/** No record is a normal state, not an error: most projects do not keep one. */
export type BacklogReadResult =
  | { found: true; record: BacklogRecord }
  | { found: false; looked: string[] }

/** Addressing one topic for a write. Index first, title as the fallback. */
export interface BacklogRef {
  line: number
  title: string
}

/**
 * Two conflicts, deliberately distinct. `stale` means the file moved under the view
 * and nothing matches any more — reload. `ambiguous` means more than one line matches,
 * which is exactly the case a text `findIndex` used to silently write to the first of;
 * it needs the user to say which, not a guess.
 */
export type BacklogWriteResult =
  | { ok: true; record: BacklogRecord }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'ambiguous'; matches: number }
  | { ok: false; error: 'no-record' }
  | { ok: false; error: 'failed'; message: string }

/**
 * Every place a record is allowed to live, in priority order.
 *
 * The UI shows this list when a project keeps no record, so it has to be the whole
 * rule and not a sample of it — a user told Argos looked in four places, having put
 * their file in a fifth one it does accept, concludes the feature is broken.
 * `pickPrimary` owns the ranking; this is the same set spelled out.
 */
const LOOKED = [
  'BACKLOG.md',
  'docs/BACKLOG.md',
  'TODO.md',
  'docs/TODO.md',
  'TASKS.md',
  'docs/TASKS.md',
  'ROADMAP.md',
  'docs/ROADMAP.md'
]

// ─── Finding the record ───────────────────────────────────────────────────────

/** Names in one directory, or nothing at all if it cannot be listed. */
function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * The primary record's relative path, or null.
 *
 * The root and `docs/` only, one level each — never a walk. A recursive search would
 * turn opening a project into a full-tree scan and would find a dependency's own
 * TODO.md under node_modules, which belongs to somebody else entirely.
 */
function findPrimary(projectPath: string): string | null {
  const rels = [
    ...listDir(projectPath),
    ...listDir(path.join(projectPath, 'docs')).map((n) => `docs/${n}`)
  ]
  return pickPrimary(rels)
}

// ─── Reading and writing the file ─────────────────────────────────────────────

/**
 * Write via a sibling temp file and a rename.
 *
 * `rename` is atomic within a directory, so a reader — or a crash — sees the whole old
 * file or the whole new one, never half of either. This is the user's own file, tracked
 * in git and typed by hand: a truncated BACKLOG.md is a real loss, and no checkbox tick
 * is worth risking one. `writeJsonFileAtomic` does the same thing for JSON; this is its
 * text twin, kept local because that helper stringifies its input.
 */
function writeTextAtomic(p: string, text: string): void {
  // Beside the target, not in the system temp dir: `rename` is only atomic within a
  // filesystem, and the two are routinely on different ones.
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, p)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Already gone, or never made.
    }
    throw e
  }
}

/**
 * The file's own line ending.
 *
 * Preserved on every write, because rewriting a whole file's endings turns a one-line
 * tick into a diff of the entire file — which is how a feature like this gets
 * uninstalled by the next person to review the commit. First ending seen wins; a mixed
 * file keeps whatever it mostly is.
 */
function detectEol(text: string): string {
  return /\r\n/.test(text) ? '\r\n' : '\n'
}

function toRecord(abs: string, relPath: string, text: string): BacklogRecord {
  const topics = parseTopics(text)
  return {
    path: abs,
    relPath,
    topics,
    pending: countPending(topics),
    done: countDone(topics)
  }
}

/** What the record holds right now, if the project keeps one. */
export function readBacklog(projectPath: string): BacklogReadResult {
  try {
    const rel = findPrimary(projectPath)
    if (!rel) return { found: false, looked: LOOKED }
    const abs = path.join(projectPath, ...rel.split('/'))
    const text = fs.readFileSync(abs, 'utf-8')
    return { found: true, record: toRecord(abs, rel, stripBom(text)) }
  } catch {
    // An unreadable record reads the same as none: the UI's next move is identical,
    // and there is nothing here the user can act on that the read did not already say.
    return { found: false, looked: LOOKED }
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Every write is a read-modify-write against the file as it is on disk right now, and
 * returns the record as it is after the write.
 *
 * Both halves matter. Re-reading first is what makes `locateTopic`'s staleness check
 * mean anything — the view may be minutes old and the file may have been edited in an
 * editor since. Re-reading after is so the renderer never has to model what its own
 * edit did to the file; it is handed the truth instead of predicting it.
 */
function mutate(
  projectPath: string,
  apply: (lines: string[], topics: BacklogTopic[]) => string[] | { error: BacklogWriteResult }
): BacklogWriteResult {
  let abs: string
  let rel: string
  try {
    const found = findPrimary(projectPath)
    if (!found) return { ok: false, error: 'no-record' }
    rel = found
    abs = path.join(projectPath, ...rel.split('/'))
  } catch (e) {
    return { ok: false, error: 'failed', message: messageOf(e) }
  }

  try {
    const raw = stripBom(fs.readFileSync(abs, 'utf-8'))
    const eol = detectEol(raw)
    const lines = raw.split(/\r?\n/)
    const topics = parseTopics(raw)

    const result = apply(lines, topics)
    if (!Array.isArray(result)) return result.error

    writeTextAtomic(abs, result.join(eol))

    const after = stripBom(fs.readFileSync(abs, 'utf-8'))
    return { ok: true, record: toRecord(abs, rel, after) }
  } catch (e) {
    return { ok: false, error: 'failed', message: messageOf(e) }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Resolve a ref against the freshly-parsed file, or hand back the conflict as a value. */
function resolve(
  topics: BacklogTopic[],
  ref: BacklogRef
): { ok: true; line: number } | { error: BacklogWriteResult } {
  const found = locateTopic(topics, ref)
  if (found.ok) return found
  if (found.error === 'ambiguous') {
    return { error: { ok: false, error: 'ambiguous', matches: found.matches } }
  }
  return { error: { ok: false, error: 'stale' } }
}

// ─── The five writes ──────────────────────────────────────────────────────────

export function createTopic(
  projectPath: string,
  title: string,
  section: string | null
): BacklogWriteResult {
  const clean = (title ?? '').trim()
  if (clean.length === 0) {
    return { ok: false, error: 'failed', message: 'A topic needs a title.' }
  }
  return mutate(projectPath, (lines) => appendTopic(lines, clean, section))
}

export function setTopicDone(
  projectPath: string,
  ref: BacklogRef,
  done: boolean
): BacklogWriteResult {
  return mutate(projectPath, (lines, topics) => {
    const at = resolve(topics, ref)
    if (!('ok' in at)) return at
    return setDoneAt(lines, at.line, done)
  })
}

export function editTopic(
  projectPath: string,
  ref: BacklogRef,
  title: string
): BacklogWriteResult {
  const clean = (title ?? '').trim()
  if (clean.length === 0) {
    return { ok: false, error: 'failed', message: 'A topic needs a title.' }
  }
  return mutate(projectPath, (lines, topics) => {
    const at = resolve(topics, ref)
    if (!('ok' in at)) return at
    return editAt(lines, at.line, clean)
  })
}

export function duplicateTopic(projectPath: string, ref: BacklogRef): BacklogWriteResult {
  return mutate(projectPath, (lines, topics) => {
    const at = resolve(topics, ref)
    if (!('ok' in at)) return at
    return duplicateAt(lines, at.line)
  })
}

export function deleteTopic(projectPath: string, ref: BacklogRef): BacklogWriteResult {
  return mutate(projectPath, (lines, topics) => {
    const at = resolve(topics, ref)
    if (!('ok' in at)) return at
    return deleteAt(lines, at.line)
  })
}
