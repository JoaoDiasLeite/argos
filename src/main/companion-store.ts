/**
 * The companion's files on disk (docs/COMPANION_PLAN.md §6): `todos.json`, `notes.json`
 * and `state.json` in one folder, `userData/companion` in the app.
 *
 * Reads never throw: a missing, unreadable or corrupt file is an empty list (or an
 * empty state), because a pet that crashes on a bad file is worse than one that starts
 * fresh. Writes go through writeJsonFileAtomic, so a crash mid-save leaves the old file.
 * Older shapes are normalised on the way in — a todo saved before `remindAt` existed
 * reads back with `remindAt: []`.
 *
 * `createCompanionStore(dir)` is what the tests use, on a temp folder; the app goes
 * through `companionStore()`, which only asks Electron for userData on first use.
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { POSITIONS_VERSION, type CompanionNote, type CompanionState, type CompanionTodo } from './companion-types'
import { cleanRepeat } from './companion-repeat-pure'
import { migrateLegacyPosition } from './companion-window-pure'

export interface CompanionStore {
  listTodos(): CompanionTodo[]
  /** Insert, or replace the todo with the same id in place. */
  saveTodo(todo: CompanionTodo): void
  /** False when there was no such todo. */
  deleteTodo(id: string): boolean
  listNotes(): CompanionNote[]
  saveNote(note: CompanionNote): void
  deleteNote(id: string): boolean
  getState(): CompanionState
  /** Merges into the stored state; a key set to undefined is dropped. */
  setState(patch: Partial<CompanionState>): CompanionState
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter(isNumber) : [])

/** A todo as stored by any version, or null for something that isn't one. */
export function normalizeTodo(raw: unknown): CompanionTodo | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  const source = raw.source === 'voice' || raw.source === 'argos' ? raw.source : 'text'
  const todo: CompanionTodo = {
    ...(raw as Partial<CompanionTodo>),
    id: raw.id,
    title: raw.title,
    remindAt: numbers(raw.remindAt),
    ...(Array.isArray(raw.firedAt) ? { firedAt: numbers(raw.firedAt) } : {}),
    done: raw.done === true,
    createdAt: isNumber(raw.createdAt) ? raw.createdAt : 0,
    source
  }
  // Only with a date to step from; anything malformed is simply no repeat.
  const repeat = isNumber(raw.dueAt) ? cleanRepeat(raw.repeat) : null
  if (repeat) todo.repeat = repeat
  else delete todo.repeat
  if (typeof raw.repeatNextId !== 'string') delete todo.repeatNextId
  return todo
}

export function normalizeNote(raw: unknown): CompanionNote | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null
  return {
    ...(raw as Partial<CompanionNote>),
    id: raw.id,
    text: raw.text,
    createdAt: isNumber(raw.createdAt) ? raw.createdAt : 0,
    source: raw.source === 'voice' ? 'voice' : 'text',
    ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((t): t is string => typeof t === 'string') } : {})
  }
}

function normalizeState(raw: unknown): CompanionState {
  if (!isObject(raw)) return {}
  const state: CompanionState = {}
  if (isNumber(raw.dndUntil) || raw.dndUntil === null) state.dndUntil = raw.dndUntil
  if (isNumber(raw.lastCatchUpAt) || raw.lastCatchUpAt === null) state.lastCatchUpAt = raw.lastCatchUpAt
  if (isNumber(raw.lastWeekSummaryAt) || raw.lastWeekSummaryAt === null) state.lastWeekSummaryAt = raw.lastWeekSummaryAt
  if (isObject(raw.positions)) {
    // Saved for the old 220×220 window: shifted so the dog comes back where he sat.
    const legacy = raw.positionsVersion !== POSITIONS_VERSION
    const positions: Record<string, { x: number; y: number }> = {}
    for (const [k, v] of Object.entries(raw.positions)) {
      if (isObject(v) && isNumber(v.x) && isNumber(v.y)) positions[k] = legacy ? migrateLegacyPosition({ x: v.x, y: v.y }) : { x: v.x, y: v.y }
    }
    state.positions = positions
    // Current once read: the next write carries it, so the shift happens once.
    state.positionsVersion = POSITIONS_VERSION
  }
  return state
}

export function createCompanionStore(dir: string): CompanionStore {
  const file = (name: string): string => path.join(dir, name)

  function readList<T>(name: string, normalize: (raw: unknown) => T | null): T[] {
    try {
      const raw = readJsonFile<unknown>(file(name))
      if (!Array.isArray(raw)) return []
      return raw.map(normalize).filter((x): x is T => x !== null)
    } catch {
      return []
    }
  }

  /**
   * readList for a read-modify-write. A file that exists but won't parse is renamed to
   * `<name>.corrupt-<ms>` first, so the save that follows doesn't bury the only copy of
   * whatever was in it under a one-item list.
   */
  function readListForWrite<T>(name: string, normalize: (raw: unknown) => T | null): T[] {
    const p = file(name)
    try {
      const raw = readJsonFile<unknown>(p)
      if (Array.isArray(raw)) return raw.map(normalize).filter((x): x is T => x !== null)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    }
    try {
      fs.renameSync(p, `${p}.corrupt-${Date.now()}`)
    } catch {
      // Gone or locked: the save below still goes ahead.
    }
    return []
  }

  function write(name: string, value: unknown): void {
    fs.mkdirSync(dir, { recursive: true })
    writeJsonFileAtomic(file(name), value)
  }

  function upsert<T extends { id: string }>(list: T[], item: T): T[] {
    const i = list.findIndex((x) => x.id === item.id)
    if (i === -1) return [...list, item]
    const next = [...list]
    next[i] = item
    return next
  }

  function remove<T extends { id: string }>(name: string, list: T[], id: string): boolean {
    const next = list.filter((x) => x.id !== id)
    if (next.length === list.length) return false
    write(name, next)
    return true
  }

  const getState = (): CompanionState => {
    try {
      return normalizeState(readJsonFile<unknown>(file('state.json')))
    } catch {
      return {}
    }
  }

  return {
    listTodos: () => readList('todos.json', normalizeTodo),
    saveTodo: (todo) => write('todos.json', upsert(readListForWrite('todos.json', normalizeTodo), todo)),
    deleteTodo: (id) => remove('todos.json', readListForWrite('todos.json', normalizeTodo), id),
    listNotes: () => readList('notes.json', normalizeNote),
    saveNote: (note) => write('notes.json', upsert(readListForWrite('notes.json', normalizeNote), note)),
    deleteNote: (id) => remove('notes.json', readListForWrite('notes.json', normalizeNote), id),
    getState,
    setState: (patch) => {
      const next: CompanionState = { ...getState(), ...patch }
      for (const k of Object.keys(next) as (keyof CompanionState)[]) {
        if (next[k] === undefined) delete next[k]
      }
      write('state.json', next)
      return next
    }
  }
}

let store: CompanionStore | null = null

/** The app's store, under userData/companion. Resolved on first call, after app ready. */
export function companionStore(): CompanionStore {
  return (store ??= createCompanionStore(path.join(app.getPath('userData'), 'companion')))
}
