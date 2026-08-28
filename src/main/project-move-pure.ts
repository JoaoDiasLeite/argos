import * as path from 'path'
import { isRootPath } from './local-fs-pure'
import type { RoomsLayout } from './store'

/**
 * The decisions behind changing a project's folder, with nothing that touches the
 * disk — where the target is allowed to be, and how the things that named the old
 * location get re-keyed to the new one.
 *
 * Split out because this is the half worth testing: FRIDAY's `move-project.js` runs
 * nine blocks before its first write, and every one of the refusals below is a case
 * that, taken wrongly, either loses a folder or leaves the app pointing at nothing.
 * The writes themselves are three renames and some JSON; the judgement is here.
 *
 * `import type { RoomsLayout }` is erased at compile time, so this module stays
 * loadable in a plain test process even though store.ts reaches Electron at load.
 */

/** Strip trailing separators so `C:\dev\foo\` and `C:\dev\foo` compare as one path. */
function trimTrailingSep(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  // A root loses everything if we strip it — `C:\` must not become `C:`.
  return trimmed.length > 0 ? trimmed : p
}

/** Normalise for comparison: real normalisation, no trailing separator, lower case. */
function comparable(p: string): string {
  return trimTrailingSep(path.normalize(p)).toLowerCase()
}

/**
 * The volume a path lives on: a drive root (`c:\`) for a local path, or the
 * `\\host\share` pair for a UNC one — which is what a WSL distro's projects look
 * like from Windows.
 *
 * Returns null when the path names no volume at all: a bare relative path, or a
 * rootless `\foo`. Callers treat that as "not a usable target" rather than as a
 * volume that happens to match nothing.
 */
export function volumeOf(p: string): string | null {
  if (typeof p !== 'string' || p.trim().length === 0) return null
  const raw = p.trim()
  // Read the POSIX case off the raw string: on Windows `path.normalize` rewrites
  // `/home/me` to `\home\me`, which is indistinguishable from a rootless path.
  // Reached only when a caller hands over an unmapped WSL path; the move maps those
  // to UNC before it gets here.
  if (/^\/[^/]/.test(raw) || raw === '/') return '/'
  const norm = path.normalize(raw)
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(norm)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`
  const drive = /^([A-Za-z]):[\\/]/.exec(norm)
  if (drive) return `${drive[1]}:\\`
  return null
}

/** Same volume, compared case-insensitively as Windows compares them. */
export function sameVolume(a: string, b: string): boolean {
  const va = volumeOf(a)
  const vb = volumeOf(b)
  // Two unknowns are not a match. "I could not tell" must not read as "yes".
  if (va === null || vb === null) return false
  return va.toLowerCase() === vb.toLowerCase()
}

/**
 * True when `child` is `parent` itself or sits underneath it.
 *
 * The separator in the comparison is the whole point: a bare `startsWith` says
 * `C:\dev\foobar` is inside `C:\dev\foo`, which is how a move that should have been
 * allowed gets refused and — worse, in the other direction — how a delete walks into
 * a sibling.
 */
export function isInside(parent: string, child: string): boolean {
  const p = comparable(parent)
  const c = comparable(child)
  if (p === c) return true
  const sep = p.endsWith(path.sep) ? '' : path.sep
  return c.startsWith(p + sep)
}

export type TargetVerdict =
  | { ok: true; target: string }
  | { ok: false; error: 'invalid-target' | 'same-path' | 'target-inside-source' | 'cross-volume' }

/**
 * Everything about the destination that can be decided without touching the disk.
 *
 * Ordered deliberately: shape first, then identity, then containment, then volume.
 * Each refusal is a different sentence in the UI, and answering with the first true
 * one keeps the message about the thing the user can actually fix.
 */
export function verifyTarget(from: string, rawTo: string): TargetVerdict {
  // An empty or whitespace target is a form the user never filled in, not a path.
  if (typeof rawTo !== 'string' || rawTo.trim().length === 0) return { ok: false, error: 'invalid-target' }
  const target = trimTrailingSep(path.normalize(rawTo.trim()))
  // `path.isAbsolute` alone accepts a rootless `\foo` on Windows, which names no
  // volume and cannot be renamed onto. Requiring a volume as well is what rejects
  // both that and a bare relative path.
  if (!path.isAbsolute(target) || volumeOf(target) === null) return { ok: false, error: 'invalid-target' }
  // Moving a project *to* `C:\` or to the root of a UNC share is not a move anyone
  // means: it would put the project's contents at the top of a whole volume, and
  // there is no folder there to name the project after.
  if (isRootPath(target)) return { ok: false, error: 'invalid-target' }

  if (comparable(from) === comparable(target)) return { ok: false, error: 'same-path' }
  // Moving a folder into itself is the one that eats the folder: the rename either
  // fails halfway or produces a tree that contains its own parent.
  if (isInside(from, target)) return { ok: false, error: 'target-inside-source' }
  // Refuse rather than copy. A copy of a project tree is a different operation with
  // different risks and a different failure mode — half a copy, with no way to tell
  // which half — and quietly upgrading a move into one is not a decision this code
  // gets to make for the user. Ask them to copy it themselves and move on.
  if (!sameVolume(from, target)) return { ok: false, error: 'cross-volume' }

  return { ok: true, target }
}

// ─── Re-keying ────────────────────────────────────────────────────────────────

/**
 * Swap one project key for another in a list of `<sourceId>:<encodedDir>` keys.
 *
 * Never creates a duplicate: the new key can already be present when a directory of
 * that name was pinned before, and a list with the same key twice makes a single
 * unpin look like it did nothing.
 */
export function rekeyProjectKeys(keys: string[], fromKey: string, toKey: string): string[] {
  const out: string[] = []
  for (const key of keys) {
    const next = key === fromKey ? toKey : key
    if (!out.includes(next)) out.push(next)
  }
  return out
}

/**
 * Does this stored `projectPath` name the moved project — the folder itself or
 * anything under it?
 *
 * The "under it" half is not an edge case: a saved chat can have run in a subfolder
 * of the project, and matching only the exact folder leaves those pointing into a
 * directory that no longer exists. The remainder of the path is preserved verbatim;
 * only the prefix is replaced.
 *
 * Returns the input unchanged when it names something else, and `undefined` for a
 * record that never had a path.
 */
export function rekeyProjectPath(
  stored: string | undefined,
  fromPath: string,
  toPath: string
): string | undefined {
  if (typeof stored !== 'string' || stored.length === 0) return stored
  if (!isInside(fromPath, stored)) return stored
  const from = trimTrailingSep(path.normalize(fromPath))
  const norm = trimTrailingSep(path.normalize(stored))
  // Normalising rewrote the remainder's separators to Windows's. Put them back in
  // the destination's own style, or a WSL project's POSIX subfolder comes out as
  // `/home/me/new\sub` — a path that nothing on either side of the boundary opens.
  const rest = norm.slice(from.length)
  const to = trimTrailingSep(toPath)
  return to + (to.includes('/') && !to.includes('\\') ? rest.replace(/\\/g, '/') : rest)
}

/**
 * Re-key a rooms layout, which is keyed by the project's real path.
 *
 * Anything under the moved folder is re-keyed too, and correctly so: a project
 * nested inside the one being moved moved with it. `__unassigned__` and other
 * non-path keys never match a real folder, so they pass through untouched.
 */
export function rekeyRoomsLayout(layout: RoomsLayout, fromPath: string, toPath: string): RoomsLayout {
  const order: string[] = []
  for (const key of layout.order) {
    const next = rekeyProjectPath(key, fromPath, toPath) ?? key
    // Same reason as `rekeyProjectKeys`: the destination may already have a room.
    if (!order.includes(next)) order.push(next)
  }
  const names: Record<string, string> = {}
  for (const [key, value] of Object.entries(layout.names)) {
    const next = rekeyProjectPath(key, fromPath, toPath) ?? key
    // First one wins, so a pre-existing name at the destination is not overwritten
    // by the moved project's — the destination's name is the one the user set last
    // for that folder.
    if (!(next in names)) names[next] = value
  }
  return { order, names }
}
