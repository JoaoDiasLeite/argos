import { safeProjectDir } from './claude-data'
import { ProjectOpResult, removeEmptyProjectDir } from './project-files'
import { forgetProjectPrefs } from './store'

/**
 * Project-level operations, addressed the way the renderer addresses a project.
 *
 * The two halves of "tidying the project list" are deliberately different things.
 * Archiving a project is a *preference* — a key in the store, nothing on disk moves,
 * and it reverses by unticking it. Deleting one is *files*: the directory goes, and
 * nothing brings it back.
 *
 * Which is why the delete refuses rather than warns. A project still holding a
 * transcript, active or archived, is not an empty project, and there is no undo
 * behind the confirmation dialog to make "are you sure?" an acceptable last line of
 * defence.
 *
 * This module's whole job is resolving ids through `safeProjectDir` before handing
 * an absolute path to project-files.ts. Ids come from the renderer and reach the
 * filesystem, so every one of them is checked here first.
 */

export type { ProjectOpResult }

export async function deleteProject(sourceId: string, encodedDir: string): Promise<ProjectOpResult> {
  const dir = await safeProjectDir(sourceId, encodedDir)
  if (!dir) return { ok: false, error: 'not-found' }
  const res = await removeEmptyProjectDir(dir)
  // Only once the directory is actually gone. Preferences left behind resurrect a
  // ghost row — pinned, or filed away — the next time a directory with that name
  // appears under the same source.
  if (res.ok) forgetProjectPrefs(sourceId, encodedDir)
  return res
}
