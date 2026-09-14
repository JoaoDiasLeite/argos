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

/** The basename of a path's *parent* folder, or '' when there isn't one. */
function parentBasename(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return ''
  const parent = p.slice(0, idx)
  const pIdx = parent.lastIndexOf('/')
  return pIdx >= 0 ? parent.slice(pIdx + 1) : parent
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
    // Only prefix when the prefix actually separates them. Three checkouts of `jdl`,
    // each under a `home` in a different distro, all become `home/jdl` — the same
    // ambiguity, now harder to read. Where the parent settles nothing, the plain name
    // is the better of two ambiguous answers, and the row has other things (a distro
    // badge, a path tooltip) that do tell them apart.
    const candidates = derived.map((k) => {
      const e = byKey.get(k)!
      const parent = parentBasename(e.path)
      return parent ? `${parent}/${e.name}` : e.name
    })
    if (new Set(candidates).size !== candidates.length) {
      result.set(key, v.name)
      continue
    }
    const parent = parentBasename(v.path)
    result.set(key, parent ? `${parent}/${v.name}` : v.name)
  }
  return result
}
