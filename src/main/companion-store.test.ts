import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { CompanionNote, CompanionTodo } from './companion-types'

// companion-store.ts asks Electron for userData only in companionStore(); these tests
// use the factory on a temp folder, so the mock just keeps the import loadable.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { createCompanionStore } from './companion-store'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-companion-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const TODO: CompanionTodo = {
  id: 't1',
  title: 'Ligar à câmara',
  dueAt: new Date(2026, 10, 3, 14, 0).getTime(),
  duePrecision: 'minute',
  remindAt: [new Date(2026, 10, 3, 13, 50).getTime()],
  done: false,
  createdAt: 1,
  source: 'text'
}

const NOTE: CompanionNote = { id: 'n1', text: 'Cliente prefere email', createdAt: 2, source: 'voice', tags: ['leiria'] }

describe('createCompanionStore', () => {
  it('starts empty when the folder does not exist yet', () => {
    const store = createCompanionStore(path.join(dir, 'companion'))
    expect(store.listTodos()).toEqual([])
    expect(store.listNotes()).toEqual([])
    expect(store.getState()).toEqual({})
  })

  it('round-trips todos, notes and state, creating the folder', () => {
    const sub = path.join(dir, 'companion')
    const store = createCompanionStore(sub)
    store.saveTodo(TODO)
    store.saveNote(NOTE)
    store.setState({ dndUntil: 5, positions: { '1': { x: 10, y: 20 } }, positionsVersion: 2 })

    // A fresh store over the same folder reads it all back from disk.
    const again = createCompanionStore(sub)
    expect(again.listTodos()).toEqual([TODO])
    expect(again.listNotes()).toEqual([NOTE])
    expect(again.getState()).toEqual({ dndUntil: 5, positions: { '1': { x: 10, y: 20 } }, positionsVersion: 2 })
  })

  it('shifts positions saved for the old 220×220 window so the dog stays put', () => {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ positions: { '1': { x: 100, y: 200 } } }))
    const store = createCompanionStore(dir)
    // The dog sat at (150, 290) in the old window; the new one puts him there from (146, 268).
    expect(store.getState()).toEqual({ positions: { '1': { x: 146, y: 268 } }, positionsVersion: 2 })
    // Saved again, it carries the version and is not shifted twice.
    store.setState({ dndUntil: 1 })
    expect(createCompanionStore(dir).getState().positions).toEqual({ '1': { x: 146, y: 268 } })
  })

  it('upserts by id, keeping the order', () => {
    const store = createCompanionStore(dir)
    store.saveTodo(TODO)
    store.saveTodo({ ...TODO, id: 't2', title: 'Outro' })
    store.saveTodo({ ...TODO, done: true, doneAt: 9 })
    const todos = store.listTodos()
    expect(todos.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(todos[0].done).toBe(true)
    expect(todos[0].doneAt).toBe(9)

    store.saveNote(NOTE)
    store.saveNote({ ...NOTE, text: 'Editada' })
    expect(store.listNotes()).toEqual([{ ...NOTE, text: 'Editada' }])
  })

  it('deletes by id, and says when there was nothing to delete', () => {
    const store = createCompanionStore(dir)
    store.saveTodo(TODO)
    store.saveNote(NOTE)
    expect(store.deleteTodo('t1')).toBe(true)
    expect(store.deleteTodo('t1')).toBe(false)
    expect(store.listTodos()).toEqual([])
    expect(store.deleteNote('n1')).toBe(true)
    expect(store.listNotes()).toEqual([])
  })

  it('reads a corrupt file as empty rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'todos.json'), '[{"id": "t1", "tit')
    fs.writeFileSync(path.join(dir, 'notes.json'), '{"not": "a list"}')
    fs.writeFileSync(path.join(dir, 'state.json'), 'garbage')
    const store = createCompanionStore(dir)
    expect(store.listTodos()).toEqual([])
    expect(store.listNotes()).toEqual([])
    expect(store.getState()).toEqual({})
    // And it can still save, after setting the unreadable file aside rather than over it.
    store.saveTodo(TODO)
    expect(store.listTodos()).toEqual([TODO])
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('todos.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf-8')).toBe('[{"id": "t1", "tit')
  })

  it('abandons a save when the list cannot be read, instead of replacing it', () => {
    // A directory where todos.json should be: readFileSync fails with EISDIR (not ENOENT,
    // not a parse error), the same class as an EBUSY/EPERM lock.
    fs.mkdirSync(path.join(dir, 'todos.json'))
    const store = createCompanionStore(dir)
    expect(() => store.saveTodo(TODO)).toThrow()
    expect(() => store.deleteTodo('t1')).toThrow()
    expect(fs.readdirSync(dir).filter((f) => f.includes('corrupt'))).toEqual([])
    expect(fs.statSync(path.join(dir, 'todos.json')).isDirectory()).toBe(true)
  })

  it('reads a file with a UTF-8 BOM', () => {
    fs.writeFileSync(path.join(dir, 'todos.json'), '﻿' + JSON.stringify([TODO]), 'utf-8')
    expect(createCompanionStore(dir).listTodos()).toEqual([TODO])
  })

  it('normalises older shapes and drops entries that are not todos', () => {
    fs.writeFileSync(
      path.join(dir, 'todos.json'),
      JSON.stringify([{ id: 'old', title: 'Antigo', createdAt: 3 }, { title: 'sem id' }, 42, null])
    )
    expect(createCompanionStore(dir).listTodos()).toEqual([
      { id: 'old', title: 'Antigo', createdAt: 3, remindAt: [], done: false, source: 'text' }
    ])
  })

  it('merges state patches and drops keys set to undefined', () => {
    const store = createCompanionStore(dir)
    store.setState({ dndUntil: 5, lastCatchUpAt: 7 })
    expect(store.setState({ dndUntil: undefined })).toEqual({ lastCatchUpAt: 7 })
    expect(store.getState()).toEqual({ lastCatchUpAt: 7 })
  })
})
