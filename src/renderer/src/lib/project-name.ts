/**
 * Resolve the name a project shows to the user.
 *
 * Different screens have picked different names for the same folder: the Sidebar
 * respects a custom rename, Projects and Home fall back to the folder's basename —
 * which is often the worst name available, since a checkout can be named anything
 * while the repository (and its `origin` remote) carries the name that actually
 * matters. This module is the one place that decides, with a fixed precedence:
 * a user rename beats the repo's name, which beats the folder's basename.
 */

/** What git knows about a folder's repository. Mirrors the main process's RepoName. */
export interface RepoName {
  remote?: string
  toplevel?: string
}

export interface ProjectNameSources {
  /** Custom names the user set, keyed by projectKey (see project-key.ts). */
  custom?: Record<string, string>
  /** Repo names per projectKey, as resolved by the main process. */
  repos?: Record<string, RepoName>
}

/**
 * Last path segment, treating both `\` and `/` as separators and ignoring trailing
 * ones. Deliberately minimal rather than importing project-key's normaliser, which is
 * about folding *different spellings of the same folder* onto one key — a concern
 * this module doesn't have; it only ever needs the final segment of one given path.
 *
 * A path that is empty, or reduces to nothing once separators are stripped (e.g.
 * `///`), has no basename to offer — the caller falls back to the raw path rather
 * than showing an empty string.
 */
function basename(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!p) return path
  const idx = p.lastIndexOf('/')
  const name = idx >= 0 ? p.slice(idx + 1) : p
  return name || path
}

/** A path split into non-empty segments, treating both `\` and `/` as separators. */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

/**
 * Given the segments of every path in a colliding group, find the closest ancestor
 * level that reads differently for all of them — index 1 is the immediate parent,
 * 2 the grandparent, and so on (0, the folder itself, is never tried: it's what
 * collided in the first place). Returns null when no level separates every entry,
 * either because two paths are identical all the way up or because a shorter path
 * runs out of segments before the others do — in both cases inventing a prefix
 * would either do nothing or apply to only some of the rows.
 */
/**
 * The closest ancestor level whose segment tells THIS path apart from every other in
 * the group, or null when no level does.
 *
 * Per entry rather than one level for the whole group, because the group often cannot
 * agree on one. Three checkouts of `jdl` in three WSL distros record the identical
 * `/home/jdl`, and only the canonical path carries the distro — so one of them may have
 * a distinguishing ancestor while another, recorded as a bare POSIX path, has none. The
 * ones that can be named unambiguously should be, rather than all of them staying
 * ambiguous because one cannot.
 */
function separatingLevel(segs: string[], others: string[][]): number | null {
  for (let level = 1; level < segs.length; level++) {
    const mine = segs[segs.length - 1 - level]
    if (mine === undefined) break
    const clash = others.some((o) => o[o.length - 1 - level] === mine)
    if (!clash) return level
  }
  return null
}

/** A whitespace-only custom name is what the rename UI saves for "no name set". */
function customName(key: string, sources?: ProjectNameSources): string | undefined {
  const raw = sources?.custom?.[key]
  return raw !== undefined && raw.trim().length > 0 ? raw : undefined
}

function derivedName(key: string, path: string, sources?: ProjectNameSources): string {
  const repo = sources?.repos?.[key]
  if (repo?.remote) return repo.remote
  if (repo?.toplevel) return repo.toplevel
  return basename(path)
}

/**
 * The name to show for a project.
 * `key` is its projectKey; `path` is any real path for it (used only for the fallback).
 */
export function projectDisplayName(key: string, path: string, sources?: ProjectNameSources): string {
  return customName(key, sources) ?? derivedName(key, path, sources)
}

/**
 * Names for a set of projects, disambiguating collisions: when two DIFFERENT keys
 * resolve to the same display name, both keep their parent folder as a prefix
 * (`wm/api`, `wm/web`). Two spellings of the SAME key are one entry and never collide.
 */
export function projectDisplayNames(
  entries: { key: string; path: string }[],
  sources?: ProjectNameSources
): Map<string, string> {
  // Collapse repeated keys first, so re-spellings of one folder never count as a
  // collision with themselves.
  const byKey = new Map<string, { path: string; name: string; isCustom: boolean }>()
  for (const e of entries) {
    if (byKey.has(e.key)) continue
    byKey.set(e.key, {
      path: e.path,
      name: projectDisplayName(e.key, e.path, sources),
      isCustom: customName(e.key, sources) !== undefined
    })
  }

  const keysByName = new Map<string, string[]>()
  for (const [key, v] of byKey) {
    const arr = keysByName.get(v.name) ?? []
    arr.push(key)
    keysByName.set(v.name, arr)
  }

  const result = new Map<string, string>()
  for (const [key, v] of byKey) {
    const sharing = keysByName.get(v.name) ?? []
    // A custom name is a deliberate choice, so a collision under it is the user's to
    // resolve, not ours to paper over — the derived name is the one that moves.
    if (v.isCustom || sharing.length < 2) {
      result.set(key, v.name)
      continue
    }
    const derived = sharing.filter((k) => !byKey.get(k)!.isCustom)
    // The immediate parent often settles nothing — three checkouts of `jdl`,
    // each under a `home` in a different WSL distro, all become `home/jdl`, the same
    // ambiguity, now harder to read. So climb past it: find the closest ancestor level
    // that reads differently for every colliding entry, and use only that one segment
    // as the prefix (not everything in between — `Ubuntu/jdl`, not `Ubuntu/home/jdl`).
    // When no level separates them all, the plain name is the better of two ambiguous
    // answers, and the row has other things (a distro badge, a path tooltip) that do.
    const segsByKey = new Map(derived.map((k) => [k, pathSegments(byKey.get(k)!.path)]))
    const segs = segsByKey.get(key)!
    const others = derived.filter((k) => k !== key).map((k) => segsByKey.get(k)!)
    const level = separatingLevel(segs, others)
    // No ancestor of this one reads differently from the rest: the plain name is the
    // better of two ambiguous answers, and the row still has a distro badge and a path
    // tooltip that do tell them apart.
    if (level === null) {
      result.set(key, v.name)
      continue
    }
    result.set(key, `${segs[segs.length - 1 - level]}/${v.name}`)
  }
  return result
}
