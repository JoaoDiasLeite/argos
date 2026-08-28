import * as fs from 'fs'
import * as path from 'path'

/**
 * The file operations behind counting and deleting a project directory, taking
 * resolved absolute paths.
 *
 * Split from project-lifecycle.ts, which resolves ids through the path guard, so
 * these can be tested against real directories without pulling in Electron. The
 * guard is not optional because of the split: nothing here is called with a path
 * that did not come from `safeProjectDir`.
 */

/**
 * What a project-level operation answers with.
 *
 * A conflict is a value, not a thrown error: each one needs a different move in the
 * UI, and a `catch` flattens them into one failure. `not-empty` carries the counts so
 * the refusal can say what it is protecting.
 */
export type ProjectOpResult =
  | { ok: true }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'not-empty'; sessions: number; archived: number }
  | { ok: false; error: 'failed'; message: string }

/**
 * Named here rather than imported from claude-data.ts on purpose: that module
 * reaches `store.ts`, which reaches Electron's `app` at load, and this module has to
 * stay loadable in a plain test process. Same value, same meaning as the constant
 * the session side exports.
 */
const ARCHIVED_DIR = 'archived'

export interface ProjectContents {
  sessions: number
  archived: number
}

function countJsonl(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length
  } catch {
    // A missing directory is zero, not an error: `archived/` only exists after the
    // first archive, and a project directory can be gone by the time we look.
    return 0
  }
}

/** Transcripts a project directory holds, active and archived. */
export function countTranscripts(dir: string): ProjectContents {
  return {
    sessions: countJsonl(dir),
    archived: countJsonl(path.join(dir, ARCHIVED_DIR))
  }
}

/**
 * Rename a directory, on the same volume only.
 *
 * Never falls back to copy-then-unlink the way `moveTranscript` does. That fallback
 * is right for one file and wrong for a project tree: a half-finished copy of a
 * whole folder leaves two partial trees and no way to tell which files made it. The
 * cross-volume case is refused upstream by `verifyTarget`, so an `EXDEV` reaching
 * here is a bug in that check — it comes back as `failed` with the message, to be
 * seen and fixed, rather than being silently handled into a copy nobody asked for.
 *
 * Refuses an existing destination rather than merging into it: two project trees
 * interleaved is not something a rename can undo.
 */
export async function renameDir(from: string, to: string): Promise<ProjectOpResult> {
  if (!fs.existsSync(from)) return { ok: false, error: 'not-found' }
  if (fs.existsSync(to)) return { ok: false, error: 'failed', message: `already exists: ${to}` }
  try {
    await fs.promises.rename(from, to)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}

/** Whether any `.jsonl` exists anywhere below `dir`, at any depth. */
function hasTranscriptAnywhere(dir: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasTranscriptAnywhere(path.join(dir, entry.name))) return true
    } else if (entry.name.endsWith('.jsonl')) {
      return true
    }
  }
  return false
}

/**
 * Remove a project directory, refusing while it still holds a transcript anywhere
 * beneath it.
 *
 * The rescan is recursive and happens here, immediately before the delete, rather
 * than trusting the two counts the UI showed: that count is from a moment ago, and
 * the check that protects a conversation has to be the one the delete itself makes.
 * Depth matters too — a `.jsonl` in an unexpected subdirectory is still a
 * conversation, and the two known directories would not have seen it.
 *
 * It refuses rather than warning because there is no undo behind it. Everything else
 * in the directory (an emptied `archived/`, a stray `.DS_Store`) goes with the
 * delete; a transcript never can.
 */
export async function removeEmptyProjectDir(dir: string): Promise<ProjectOpResult> {
  if (!fs.existsSync(dir)) return { ok: false, error: 'not-found' }
  if (hasTranscriptAnywhere(dir)) {
    // The two-directory counts are for the message — the refusal itself came from
    // the recursive scan, which may have found one neither of them covers.
    const { sessions, archived } = countTranscripts(dir)
    return { ok: false, error: 'not-empty', sessions, archived }
  }
  try {
    await fs.promises.rm(dir, { recursive: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}
