import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile } from './json-file'
import { projectNameKey } from './project-move-pure'

/**
 * A tiny JSON-backed key/value store for cached values and persisted user choices
 * (hidden distros, usage cache, …). Kept separate from config.json so volatile cache
 * data doesn't churn the user's settings file.
 */
const storePath = path.join(app.getPath('userData'), 'store.json')

let data: Record<string, unknown> = {}
let loaded = false

function ensureLoaded(): void {
  if (loaded) return
  try {
    if (fs.existsSync(storePath)) data = readJsonFile<Record<string, unknown>>(storePath)
  } catch {
    data = {}
  }
  loaded = true
}

function persist(): void {
  try {
    fs.writeFileSync(storePath, JSON.stringify(data))
  } catch {
    // best-effort
  }
}

export function storeGet<T>(key: string, fallback: T): T {
  ensureLoaded()
  return key in data ? (data[key] as T) : fallback
}

/** Forget what was read, so the next access reads store.json again. */
export function reloadStore(): void {
  data = {}
  loaded = false
}

export function storeSet(key: string, value: unknown): void {
  ensureLoaded()
  data[key] = value
  persist()
}

// ─── Hidden distros ───────────────────────────────────────────────────────────

export function getHiddenDistros(): string[] {
  return storeGet<string[]>('hiddenDistros', [])
}

export function setDistroHidden(distro: string, hidden: boolean): string[] {
  const set = new Set(getHiddenDistros())
  if (hidden) set.add(distro)
  else set.delete(distro)
  const next = [...set]
  storeSet('hiddenDistros', next)
  return next
}

// ─── Rooms layout (room order + custom names) ─────────────────────────────────

export interface RoomsLayout {
  /** Room keys (project path, or '__unassigned__') in the user's preferred order. */
  order: string[]
  /** Room key -> custom display name, overriding the default folder-name label. */
  names: Record<string, string>
}

const DEFAULT_ROOMS_LAYOUT: RoomsLayout = { order: [], names: {} }

export function getRoomsLayout(): RoomsLayout {
  const raw = storeGet<Partial<RoomsLayout>>('rooms-layout', DEFAULT_ROOMS_LAYOUT)
  return {
    order: Array.isArray(raw?.order) ? raw.order.filter((k): k is string => typeof k === 'string') : [],
    names:
      raw && typeof raw.names === 'object' && raw.names !== null
        ? Object.fromEntries(
            Object.entries(raw.names).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          )
        : {}
  }
}

export function setRoomsLayout(layout: RoomsLayout): void {
  storeSet('rooms-layout', layout)
}

// ─── Project names (sidebar custom display names) ─────────────────────────────

/**
 * User-set display names for chat-sidebar project groups, keyed by the renderer's
 * `projectKey()` (case-folded, separator-normalised path) rather than the raw path —
 * the same folder can reach the sidebar spelled two different ways, and a name set
 * against one spelling has to still apply when a session shows up with the other.
 *
 * A user preference, safe to lose.
 */
export function getProjectNames(): Record<string, string> {
  const raw = storeGet<unknown>('project-names', {})
  return raw && typeof raw === 'object'
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {}
}

export function setProjectName(key: string, name: string): void {
  const names = getProjectNames()
  const trimmed = name.trim()
  // An empty name means "go back to the folder's own name", not "call it nothing".
  if (trimmed) names[key] = trimmed
  else delete names[key]
  storeSet('project-names', names)
}

/** Replace the whole map — for the move, which re-keys it rather than setting one name. */
export function setProjectNames(names: Record<string, string>): void {
  storeSet('project-names', names)
}

// ─── Favourite projects ───────────────────────────────────────────────────────

/**
 * Pinned projects, keyed `<sourceId>:<encodedDir>` — the same pair that addresses a
 * project everywhere else, so a project moving between sources is a different key
 * rather than a silently wrong one.
 *
 * A user preference, safe to lose: the worst case is the pins reset.
 */
const FAVOURITES_KEY = 'favoriteProjects'

export function projectKey(sourceId: string, encodedDir: string): string {
  return `${sourceId}:${encodedDir}`
}

export function getFavoriteProjects(): string[] {
  const raw = storeGet<unknown>(FAVOURITES_KEY, [])
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
}

/** Replace the whole list — for the move, which re-keys it rather than toggling one. */
export function setFavoriteProjects(keys: string[]): void {
  storeSet(FAVOURITES_KEY, keys)
}

export function setProjectFavorite(sourceId: string, encodedDir: string, on: boolean): string[] {
  const key = projectKey(sourceId, encodedDir)
  const cur = getFavoriteProjects().filter((k) => k !== key)
  const next = on ? [...cur, key] : cur
  storeSet(FAVOURITES_KEY, next)
  return next
}

// ─── Archived projects ────────────────────────────────────────────────────────

/**
 * Projects filed away by the user, keyed `<sourceId>:<encodedDir>` exactly as the
 * favourites are.
 *
 * Archiving a *project* is organisation and nothing else: no file moves, and the
 * conversations inside stay where they are. That is what separates it from archiving
 * a *session*, which is the file sitting in `archived/`. A preference, safe to lose.
 */
const ARCHIVED_KEY = 'archivedProjects'

export function getArchivedProjects(): string[] {
  const raw = storeGet<unknown>(ARCHIVED_KEY, [])
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
}

/** Replace the whole list — same reason as `setFavoriteProjects`. */
export function setArchivedProjects(keys: string[]): void {
  storeSet(ARCHIVED_KEY, keys)
}

export function setProjectArchived(sourceId: string, encodedDir: string, on: boolean): string[] {
  const key = projectKey(sourceId, encodedDir)
  const cur = getArchivedProjects().filter((k) => k !== key)
  const next = on ? [...cur, key] : cur
  storeSet(ARCHIVED_KEY, next)
  return next
}

/**
 * Drop every preference held against a project that no longer exists.
 *
 * **Any new project preference must be added to both the forget-project and the
 * move-project paths.** One that lands only in forget survives a delete and vanishes
 * on a move — and a pin left behind by a delete resurrects a ghost row the next time
 * a directory with that name appears.
 */
export function forgetProjectPrefs(sourceId: string, encodedDir: string, realPath?: string): void {
  const key = projectKey(sourceId, encodedDir)
  const favourites = getFavoriteProjects().filter((k) => k !== key)
  storeSet(FAVOURITES_KEY, favourites)
  const archived = getArchivedProjects().filter((k) => k !== key)
  storeSet(ARCHIVED_KEY, archived)
  // `rooms-layout` is keyed by the project's real path rather than by
  // `<sourceId>:<encodedDir>`, so it is cleared only when the caller could resolve
  // one. See `rekeyProjectPrefs` in project-prefs.ts for the full inventory of what
  // names a project; these two lists plus this layout are what *filing* means, and
  // filing for a directory that is gone is nothing but a ghost row waiting to
  // reappear.
  if (realPath) {
    const layout = getRoomsLayout()
    const gone = realPath.replace(/[\\/]+$/, '').toLowerCase()
    const matches = (k: string): boolean => k.replace(/[\\/]+$/, '').toLowerCase() === gone
    setRoomsLayout({
      order: layout.order.filter((k) => !matches(k)),
      names: Object.fromEntries(Object.entries(layout.names).filter(([k]) => !matches(k)))
    })
    // `project-names` is keyed by the renderer's projectKey() (separators unified to
    // `/` as well as case-folded), so the match has to normalise the same way rather
    // than reusing `matches` above, which only strips a trailing separator.
    const goneNameKey = projectNameKey(realPath)
    const projectNames = getProjectNames()
    setProjectNames(Object.fromEntries(Object.entries(projectNames).filter(([k]) => k !== goneNameKey)))
  }
  // Deliberately NOT cleared: the `projectPath` on the records under
  // `<userData>/sessions`, `scheduler` and `sprints`. Those point at *work*, not at
  // filing — deleting an empty project must not delete a scheduled run or a sprint
  // that happened to name the same folder. The move re-keys them, because the work
  // is still there and its folder simply moved; the delete leaves them alone,
  // because the work outlives the project row.
}
