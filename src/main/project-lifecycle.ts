import * as fs from 'fs'
import * as path from 'path'
import { encodePath, projectRealPath, resolveSource, safeProjectDir } from './claude-data'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { isRootPath, posixToWslUnc } from './local-fs-pure'
import { ProjectOpResult, removeEmptyProjectDir, renameDir } from './project-files'
import { isInside, verifyTarget } from './project-move-pure'
import { rekeyProjectPrefs } from './project-prefs'
import { forgetProjectPrefs } from './store'

/**
 * Project-level operations, addressed the way the renderer addresses a project.
 *
 * The three halves of "tidying the project list" are deliberately different things.
 * Archiving a project is a *preference* — a key in the store, nothing on disk moves,
 * and it reverses by unticking it. Deleting one is *files*: the directory goes, and
 * nothing brings it back. Changing its folder is files on both sides at once — the
 * real folder and the transcript directory named after it — plus everything that
 * held either name.
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

// ─── Types shared with the renderer ───────────────────────────────────────────

/**
 * Why a folder change was refused. Each one is a different sentence in the UI, and a
 * single 'failed' would have flattened nine distinct refusals into one shrug.
 *
 * Mirrored by hand in src/renderer/src/types.ts rather than imported: main must not
 * depend on the renderer's module graph. The two definitions are the contract, and
 * they are short enough that keeping them identical is cheaper than a shared build.
 */
export type ProjectMoveRefusal =
  | 'not-found'
  | 'invalid-target'
  | 'same-path'
  | 'target-inside-source'
  | 'target-exists'
  | 'no-parent'
  | 'cross-volume'
  | 'encoded-collision'
  | 'busy'
  | 'failed'

/**
 * The result of changing a project's folder.
 *
 * `warnings` is the honest part: the two renames either both happen or both roll
 * back, but re-keying the source's `.claude.json` and the app's own preferences is
 * best-effort — a failure there leaves a working project with a stale pin, not a
 * broken one, and saying so beats pretending it went perfectly.
 */
export type ProjectMoveResult =
  | { ok: true; encodedDir: string; realPath: string; warnings: string[] }
  | { ok: false; error: ProjectMoveRefusal; detail?: string }

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteProject(sourceId: string, encodedDir: string): Promise<ProjectOpResult> {
  const dir = await safeProjectDir(sourceId, encodedDir)
  if (!dir) return { ok: false, error: 'not-found' }
  // Resolved here, before the delete, and not after: one of the fallbacks that
  // answers this reads the project's own transcripts, which is only possible while
  // they are still on disk. Best-effort — a project whose path cannot be worked out
  // still gets its id-keyed preferences cleared, which is the half that resurrects a
  // row.
  const src = await resolveSource(sourceId)
  let realPath: string | undefined
  if (src) {
    try {
      realPath = await projectRealPath(src, encodedDir)
    } catch {
      realPath = undefined
    }
  }
  const res = await removeEmptyProjectDir(dir)
  // Only once the directory is actually gone. Preferences left behind resurrect a
  // ghost row — pinned, or filed away — the next time a directory with that name
  // appears under the same source.
  if (res.ok) forgetProjectPrefs(sourceId, encodedDir, realPath)
  return res
}

// ─── Change a project's folder ────────────────────────────────────────────────

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/**
 * Change a project's folder: rename the real directory on disk, rename the
 * transcript directory named after it, then re-key everything that held either name.
 *
 * **Nine checks run before any write, and the function is shaped so that is
 * visible.** The validation block below touches nothing — no rename, no mkdir, no
 * write of any kind — and the write block starts only after every one of them has
 * passed. That separation is the whole design: a half-validated move that has
 * already renamed something is the failure mode this shape exists to make
 * impossible. Adding a tenth check means adding it to the first block, not
 * interleaving it with the writes.
 *
 * **Only the first two writes roll back.** After A and B the disk is consistent: the
 * folder is at its new path and its transcripts are in the directory named after
 * that path. C and D are metadata, and they degrade gracefully — a stale pin, or a
 * project showing its old name, is recoverable by hand in a minute. A folder in one
 * place with its transcripts in another is not; that one needs someone to work out
 * what the encoded directory name should have been.
 *
 * **WSL sources have two forms of every path.** The distro's `.claude.json` records
 * POSIX paths (`/home/me/dev/foo`); Windows `fs` operates on the UNC share
 * (`\\wsl.localhost\Ubuntu\home\me\dev\foo`). Both `from` and `to` are mapped to UNC
 * for the disk work, and the POSIX form is what goes back into preferences, into
 * `.claude.json`, and into `encodePath`. Getting that backwards writes UNC paths
 * into a Linux config and silently corrupts the project map.
 *
 * The `cwd` recorded inside each transcript is NOT rewritten — the same rule
 * `moveSession` follows. Where a conversation ran is a fact about the past.
 */
export async function moveProjectFolder(
  sourceId: string,
  encodedDir: string,
  toPath: string,
  busyPaths: string[]
): Promise<ProjectMoveResult> {
  // ── Validation. Nothing below this line writes to the disk. ────────────────

  // 1. The ids address a project directory inside their own source.
  const projectDir = await safeProjectDir(sourceId, encodedDir)
  const src = await resolveSource(sourceId)
  if (!projectDir || !src) return { ok: false, error: 'not-found' }

  // 2. That transcript directory is actually there.
  if (!statOrNull(projectDir)?.isDirectory()) return { ok: false, error: 'not-found' }

  // 3. The real folder, in both forms.
  const isWsl = src.kind === 'wsl' && !!src.distro
  const fromStored = await projectRealPath(src, encodedDir)
  const fromFs = isWsl ? posixToWslUnc(src.distro as string, fromStored) : fromStored
  const rawTo = typeof toPath === 'string' ? toPath.trim() : ''
  if (rawTo.length === 0) return { ok: false, error: 'invalid-target' }
  // A WSL target must be given as a POSIX path. Without this check a relative one
  // would be turned into an absolute UNC path by `posixToWslUnc` and sail past the
  // absoluteness check that is meant to catch it.
  if (isWsl && !rawTo.startsWith('/')) return { ok: false, error: 'invalid-target' }
  const toStored = isWsl ? path.posix.normalize(rawTo).replace(/\/+$/, '') || '/' : rawTo
  if (isWsl && isRootPath(toStored)) return { ok: false, error: 'invalid-target' }
  const toFs = isWsl ? posixToWslUnc(src.distro as string, toStored) : rawTo

  // 4. The source folder exists and is a folder.
  if (!statOrNull(fromFs)?.isDirectory()) return { ok: false, error: 'not-found' }

  // 5. Shape, identity, containment and volume — everything decidable off-disk.
  const verdict = verifyTarget(fromFs, toFs)
  if (!verdict.ok) return { ok: false, error: verdict.error }
  const targetFs = verdict.target
  const targetStored = isWsl ? toStored : targetFs

  // 6. Nothing is there already. Refuse, never merge: two trees interleaved is not
  //    something a rename can undo.
  if (statOrNull(targetFs)) return { ok: false, error: 'target-exists' }

  // 7. The destination's parent exists and is a folder. The move does not invent
  //    directories — a typo'd path would otherwise file the project somewhere the
  //    user never named.
  if (!statOrNull(path.dirname(targetFs))?.isDirectory()) return { ok: false, error: 'no-parent' }

  // 8. The transcript directory the new path encodes to is free. Two projects cannot
  //    share one, and the encoding is lossy enough that a collision is reachable.
  const newEncodedDir = encodePath(targetStored)
  const newProjectDir = path.join(path.resolve(src.projectsDir), newEncodedDir)
  if (newEncodedDir !== encodedDir && statOrNull(newProjectDir)) {
    return { ok: false, error: 'encoded-collision' }
  }

  // 9. No chat is running in the folder or under it. A courtesy check — see
  //    `busyProjectPaths` in index.ts for what it cannot see — with the operating
  //    system's own refusal as the real backstop.
  for (const busy of busyPaths) {
    if (typeof busy !== 'string' || busy.length === 0) continue
    if (isInside(fromStored, busy) || isInside(fromFs, busy)) return { ok: false, error: 'busy' }
  }

  // ── Writes. Everything above has passed. ──────────────────────────────────
  const warnings: string[] = []

  // A. The real folder.
  const movedFolder = await renameDir(fromFs, targetFs)
  if (!movedFolder.ok) {
    return {
      ok: false,
      error: 'failed',
      detail: `the folder could not be moved: ${detailOf(movedFolder)}`
    }
  }

  // B. The transcripts. On failure, undo A — half a move is the one state nobody can
  //    recover from without knowing how the directory name is encoded. Skipped when
  //    the two paths encode to the same name, which the lossy encoding makes
  //    reachable (`a-b` and `a_b` both become `a-b`): there is nothing to rename, and
  //    asking for it would refuse on the destination already existing.
  if (newEncodedDir !== encodedDir) {
    const movedTranscripts = await renameDir(projectDir, newProjectDir)
    if (!movedTranscripts.ok) {
      const undo = await renameDir(targetFs, fromFs)
      const restored = undo.ok
        ? 'the folder was put back where it was'
        : `AND the folder could NOT be put back — it is now at ${targetFs} (${detailOf(undo)})`
      return {
        ok: false,
        error: 'failed',
        detail: `the transcripts could not be moved: ${detailOf(movedTranscripts)}; ${restored}`
      }
    }
  }

  // C. The source's `.claude.json` project map. Best-effort, but not cosmetic:
  //    `resolveRealPath` falls back to reading a transcript's recorded `cwd` when
  //    the map has no entry, and that cwd is the *old* path — so a failure here
  //    makes the moved project keep showing its old name in the UI. It is a warning
  //    rather than a rollback because the disk is already consistent, and it is
  //    listed here rather than in project-prefs.ts because it needs the source's own
  //    config path.
  try {
    rekeyClaudeJson(src.claudeJsonPath, fromStored, targetStored)
  } catch (e) {
    warnings.push(`the project map in ${src.claudeJsonPath} was not updated: ${(e as Error).message}`)
  }

  // D. Pins, filing, rooms, and the records that name a project path.
  warnings.push(
    ...rekeyProjectPrefs({
      sourceId,
      fromEncodedDir: encodedDir,
      toEncodedDir: newEncodedDir,
      fromPath: fromStored,
      toPath: targetStored
    })
  )

  return { ok: true, encodedDir: newEncodedDir, realPath: targetStored, warnings }
}

function detailOf(res: ProjectOpResult): string {
  if (res.ok) return 'ok'
  return res.error === 'failed' ? res.message : res.error
}

/**
 * Move one key of the `projects` object to the project's new path, preserving its
 * value and the rest of the file — this config is Claude Code's, not ours, and it
 * holds settings we know nothing about.
 */
function rekeyClaudeJson(claudeJsonPath: string, fromPath: string, toPath: string): void {
  const raw = readJsonFile<Record<string, unknown>>(claudeJsonPath)
  const projects = raw.projects
  if (!projects || typeof projects !== 'object') return
  const map = projects as Record<string, unknown>
  // Matched the way the rest of the move compares paths — a trailing separator or a
  // different drive-letter case in the config must not read as a different project.
  const key = Object.keys(map).find((k) => isInside(k, fromPath) && isInside(fromPath, k))
  if (key === undefined) return
  // The destination may already have an entry from a previous life at that path;
  // the moving project's settings are the current ones, so they win.
  const value = map[key]
  delete map[key]
  map[toPath] = value
  // Atomically: this is Claude Code's own config, and a truncated one costs the user
  // far more than the pin this rewrite exists to keep straight.
  writeJsonFileAtomic(claudeJsonPath, raw)
}
