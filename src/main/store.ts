import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile } from './json-file'

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

export function setProjectFavorite(sourceId: string, encodedDir: string, on: boolean): string[] {
  const key = projectKey(sourceId, encodedDir)
  const cur = getFavoriteProjects().filter((k) => k !== key)
  const next = on ? [...cur, key] : cur
  storeSet(FAVOURITES_KEY, next)
  return next
}
