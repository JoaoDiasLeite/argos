import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { rekeyProjectKeys, rekeyProjectPath, rekeyRoomsLayout } from './project-move-pure'
import {
  getArchivedProjects,
  getFavoriteProjects,
  getRoomsLayout,
  projectKey,
  setArchivedProjects,
  setFavoriteProjects,
  setRoomsLayout
} from './store'

/**
 * Everything in the app that names a project, re-keyed when its folder changes.
 *
 * **The inventory.** PLAN.md's rule is that a new preference must be added to *both*
 * the forget-project and the move-project paths — one that lands only in forget
 * survives a delete and vanishes on a move. That rule is only checkable against a
 * list, so here is the list:
 *
 *  1. `store.json` → `favoriteProjects`   — keyed `<sourceId>:<encodedDir>`
 *  2. `store.json` → `archivedProjects`   — same key shape
 *  3. `store.json` → `rooms-layout.order[]` — keyed by the project's real path
 *  4. `store.json` → `rooms-layout.names{}` — same
 *  5. `<userData>/sessions/*.json`  → `projectPath`
 *  6. `<userData>/scheduler/*.json` → `projectPath`
 *  7. `<userData>/sprints/*.json`   → `projectPath`
 *  8. the source's `.claude.json` → the `projects` object, keyed by real path —
 *     handled by the caller in project-lifecycle.ts, because it needs the source's
 *     own config path. Listed here so the inventory is complete rather than
 *     accidentally seven items long.
 *
 * The decisions live in project-move-pure.ts and are tested there; this module is
 * the thin writing half, which is what makes having no test for it acceptable.
 */

/** The three userData directories whose records carry a `projectPath`. */
function pathRecordDirs(): string[] {
  const userData = app.getPath('userData')
  return [path.join(userData, 'sessions'), path.join(userData, 'scheduler'), path.join(userData, 'sprints')]
}

/**
 * Rewrite `projectPath` in every JSON record in one directory. Returns a warning per
 * file that could not be updated, naming it, so the user can fix that one by hand
 * instead of being told "something went wrong".
 */
function rekeyPathRecords(dir: string, fromPath: string, toPath: string): string[] {
  const warnings: string[] = []
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    // A directory that was never created holds nothing to re-key.
    return warnings
  }
  for (const file of files) {
    const full = path.join(dir, file)
    try {
      const record = readJsonFile<{ projectPath?: string }>(full)
      const next = rekeyProjectPath(record.projectPath, fromPath, toPath)
      // Only write when it actually changed: rewriting every record on every move
      // churns mtimes the rest of the app sorts by.
      if (next === record.projectPath) continue
      writeJsonFileAtomic(full, { ...record, projectPath: next })
    } catch (e) {
      warnings.push(`${path.basename(dir)}/${file}: ${(e as Error).message}`)
    }
  }
  return warnings
}

/**
 * Re-key everything that named this project. Returns a warning per surface that
 * could not be updated, never throws: by the time this runs the two renames have
 * already succeeded, and a stale pin is not a reason to fail a move that worked.
 */
export function rekeyProjectPrefs(args: {
  sourceId: string
  fromEncodedDir: string
  toEncodedDir: string
  fromPath: string
  toPath: string
}): string[] {
  const { sourceId, fromEncodedDir, toEncodedDir, fromPath, toPath } = args
  const warnings: string[] = []
  const fromKey = projectKey(sourceId, fromEncodedDir)
  const toKey = projectKey(sourceId, toEncodedDir)

  try {
    setFavoriteProjects(rekeyProjectKeys(getFavoriteProjects(), fromKey, toKey))
  } catch (e) {
    warnings.push(`pinned projects: ${(e as Error).message}`)
  }
  try {
    setArchivedProjects(rekeyProjectKeys(getArchivedProjects(), fromKey, toKey))
  } catch (e) {
    warnings.push(`archived projects: ${(e as Error).message}`)
  }
  try {
    setRoomsLayout(rekeyRoomsLayout(getRoomsLayout(), fromPath, toPath))
  } catch (e) {
    warnings.push(`rooms layout: ${(e as Error).message}`)
  }
  for (const dir of pathRecordDirs()) {
    try {
      warnings.push(...rekeyPathRecords(dir, fromPath, toPath))
    } catch (e) {
      warnings.push(`${path.basename(dir)}: ${(e as Error).message}`)
    }
  }
  return warnings
}
