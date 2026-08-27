import * as fs from 'fs'
import * as path from 'path'
import { ARCHIVED_DIR, safeSessionPath } from './claude-data'
import { appendTitle, deleteTranscript, FileOpResult, moveTranscript } from './session-files'

/**
 * Archive, unarchive, rename, move and delete a conversation, addressed the way the
 * renderer addresses one.
 *
 * Every operation is file-level. Nothing here edits or removes a message: a rename
 * appends a `custom-title` line exactly as the CLI's `/rename` does, and the rest
 * move or unlink whole files. The transcript stays a transcript.
 *
 * "Archived" is not a flag in any store — it is the file sitting in the project's
 * `archived/` subdirectory. That is what makes it survive the app, and what makes
 * unarchiving the same operation in reverse rather than a second concept.
 *
 * This module's whole job is resolving ids through `safeSessionPath` before handing
 * absolute paths to session-files.ts. Ids come from the renderer and reach the
 * filesystem, so every one of them is checked here first.
 */

export type LifecycleResult = FileOpResult

async function shuffle(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  fromArchived: boolean
): Promise<LifecycleResult> {
  const from = await safeSessionPath(sourceId, encodedDir, sessionId, fromArchived)
  const to = await safeSessionPath(sourceId, encodedDir, sessionId, !fromArchived)
  if (!from || !to) return { ok: false, error: 'not-found' }
  return moveTranscript(from, to)
}

export function archiveSession(sourceId: string, encodedDir: string, sessionId: string) {
  return shuffle(sourceId, encodedDir, sessionId, false)
}

export function unarchiveSession(sourceId: string, encodedDir: string, sessionId: string) {
  return shuffle(sourceId, encodedDir, sessionId, true)
}

export async function deleteSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  archived = false
): Promise<LifecycleResult> {
  const file = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  if (!file) return { ok: false, error: 'not-found' }
  return deleteTranscript(file)
}

export async function renameSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  title: string,
  archived = false
): Promise<LifecycleResult> {
  const file = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  if (!file) return { ok: false, error: 'not-found' }
  return appendTitle(file, sessionId, title)
}

/**
 * Move a conversation to another project.
 *
 * The `cwd` recorded inside the transcript is NOT rewritten. Moving is a cosmetic
 * relocation of where the conversation is filed; where it ran is a fact about the
 * past, and resume still resolves from it.
 */
export async function moveSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  toSourceId: string,
  toEncodedDir: string,
  archived = false
): Promise<LifecycleResult> {
  const from = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  const to = await safeSessionPath(toSourceId, toEncodedDir, sessionId, archived)
  if (!from || !to) return { ok: false, error: 'not-found' }
  return moveTranscript(from, to)
}

/** Whether a project holds any archived transcript. */
export async function countArchived(projectsDir: string, encodedDir: string): Promise<number> {
  try {
    const files = await fs.promises.readdir(path.join(projectsDir, encodedDir, ARCHIVED_DIR))
    return files.filter((f) => f.endsWith('.jsonl')).length
  } catch {
    // The subdirectory only exists after the first archive; absent is the normal case.
    return 0
  }
}
