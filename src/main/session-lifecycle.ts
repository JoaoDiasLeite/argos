import * as fs from 'fs'
import * as path from 'path'
import {
  ARCHIVED_DIR,
  projectRealPathById,
  resolveChatSource,
  resolveCodexFor,
  safeSessionPath
} from './claude-data'
import {
  codexArchiveSession,
  codexDeleteSession,
  codexMoveSession,
  codexRenameSession,
  codexUnarchiveSession
} from './codex-data'
import { appendTitle, deleteTranscript, FileOpResult, moveTranscript } from './session-files'
import { forgetCodexSessionTags } from './store'

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
 *
 * A Codex conversation takes the other road at every one of these: it has no project
 * directory to move a file between and no `custom-title` line to append, so each
 * operation is handed to codex-data.ts, which expresses it in Codex's own terms (see
 * that module's Lifecycle section). This module stays the one place the renderer's
 * ids are turned into an operation, whichever CLI wrote the transcript.
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

export async function archiveSession(sourceId: string, encodedDir: string, sessionId: string) {
  const codex = await resolveCodexFor(sourceId)
  if (codex) return codexArchiveSession(codex, sessionId)
  return shuffle(sourceId, encodedDir, sessionId, false)
}

export async function unarchiveSession(sourceId: string, encodedDir: string, sessionId: string) {
  const codex = await resolveCodexFor(sourceId)
  if (codex) return codexUnarchiveSession(codex, sessionId)
  return shuffle(sourceId, encodedDir, sessionId, true)
}

export async function deleteSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  archived = false
): Promise<LifecycleResult> {
  const codex = await resolveCodexFor(sourceId)
  if (codex) {
    const res = await codexDeleteSession(codex, sessionId, archived)
    // The tags of a Codex conversation are Argos's own (see store.ts), so nothing else
    // will ever clear them: a transcript that is gone must not leave a tag entry behind
    // for a session id to collide with later.
    if (res.ok) forgetCodexSessionTags(sourceId, sessionId)
    return res
  }
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
  const codex = await resolveCodexFor(sourceId)
  if (codex) return codexRenameSession(codex, sessionId, title)
  const file = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  if (!file) return { ok: false, error: 'not-found' }
  return appendTitle(file, sessionId, title)
}

/**
 * Rename a chat addressed the way `readChatTranscript` (claude-data.ts) is — by cwd
 * and session id rather than by source/encodedDir — so the terminal sync can rename a
 * chat it only ever knew as "the session this cwd's CLI was told to use". Lives here
 * rather than in claude-data.ts because that module can't import this one back
 * (renameSession is here, and session-lifecycle.ts already imports from claude-data.ts).
 */
export async function renameChatSession(
  cwd: string,
  sessionId: string,
  title: string,
  preferSourceId?: string
): Promise<LifecycleResult> {
  const loc = await resolveChatSource(cwd, sessionId, preferSourceId)
  if (!loc) return { ok: false, error: 'not-found' }
  return renameSession(loc.sourceId, loc.encodedDir, sessionId, title)
}

/**
 * Move a conversation to another project.
 *
 * The `cwd` recorded inside a Claude Code transcript is NOT rewritten. Moving is a
 * cosmetic relocation of where the conversation is filed; where it ran is a fact
 * about the past, and resume still resolves from it.
 *
 * Codex is the exception, and not by choice: its transcripts all live in one date
 * tree, so the recorded cwd is the ONLY thing filing them. Moving one therefore
 * rewrites it, and a later resume starts in the new folder — the renderer says so
 * before asking. A Claude Code transcript cannot move into a Codex project at all:
 * there is no directory to put it in, and rewriting its cwd would change where
 * resuming it runs without moving the file anywhere.
 */
export async function moveSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  toSourceId: string,
  toEncodedDir: string,
  archived = false
): Promise<LifecycleResult> {
  const codex = await resolveCodexFor(sourceId)
  if (codex) {
    const toCwd = await projectRealPathById(toSourceId, toEncodedDir)
    if (!toCwd) return { ok: false, error: 'not-found' }
    return codexMoveSession(codex, sessionId, toCwd, archived)
  }
  if (await resolveCodexFor(toSourceId)) {
    return {
      ok: false,
      error: 'failed',
      message: 'Codex has no project directory to move a Claude Code conversation into.'
    }
  }
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
