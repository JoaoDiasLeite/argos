import * as fs from 'fs'
import * as path from 'path'

/**
 * The file operations behind archive / unarchive / rename / move / delete, taking
 * resolved absolute paths.
 *
 * Split from session-lifecycle.ts, which resolves ids through the path guard, so
 * these can be tested against real files without pulling in Electron. The guard is
 * not optional because of the split: nothing here is called with a path that did not
 * come from `safeSessionPath`.
 */

export type FileOpResult =
  | { ok: true }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'exists' }
  | { ok: false; error: 'failed'; message: string }

/**
 * Relocate a transcript.
 *
 * `rename` first; `copyFile` + `unlink` when the two ends are on different
 * filesystems. They often are — a WSL root and a Windows `/mnt/c` root are separate
 * devices and `rename` fails there with EXDEV. Copy-then-unlink is deliberately that
 * order: an interruption leaves the conversation in two places, which someone can
 * sort out, rather than in none.
 */
export async function moveTranscript(from: string, to: string): Promise<FileOpResult> {
  if (from === to) return { ok: true }
  if (!fs.existsSync(from)) return { ok: false, error: 'not-found' }
  // Refuse rather than clobber. The same session id at both ends means something
  // else put it there, and overwriting would destroy a conversation to tidy a
  // directory.
  if (fs.existsSync(to)) return { ok: false, error: 'exists' }
  try {
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    try {
      await fs.promises.rename(from, to)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await fs.promises.copyFile(from, to)
      await fs.promises.unlink(from)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}

/** Delete a transcript. Irreversible — archiving is the reversible one. */
export async function deleteTranscript(file: string): Promise<FileOpResult> {
  try {
    await fs.promises.unlink(file)
    return { ok: true }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'not-found' }
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}

/** A title longer than this is a paste of something else, not a title. */
export const MAX_TITLE = 200

export class InvalidTitleError extends Error {}

export function normalizeTitle(raw: unknown): string {
  const clean = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) throw new InvalidTitleError('A title cannot be empty.')
  if (clean.length > MAX_TITLE) {
    throw new InvalidTitleError(`Keep the title under ${MAX_TITLE} characters.`)
  }
  return clean
}

/**
 * Rename by appending a `custom-title` line — the same append-only shape the CLI's
 * own `/rename` writes, read back by the same last-one-wins rule. A rename here shows
 * up in the CLI and one there shows up here, and neither rewrites a byte of the
 * conversation.
 *
 * Normalisation happens here rather than in the handler, for the reason the tag
 * writes learned: validation at the write point cannot be bypassed by a second
 * caller that assembles the line itself.
 */
export async function appendTitle(file: string, sessionId: string, raw: unknown): Promise<FileOpResult> {
  let title: string
  try {
    title = normalizeTitle(raw)
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
  if (!fs.existsSync(file)) return { ok: false, error: 'not-found' }
  try {
    await fs.promises.appendFile(
      file,
      JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n'
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}
