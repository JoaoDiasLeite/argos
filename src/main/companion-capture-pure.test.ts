import { describe, it, expect } from 'vitest'
import { DONE_VISIBLE_MS, listForView, planCapture, todosInRange } from './companion-capture-pure'
import { parseCapture } from './companion-nlu-pure'
import type { CompanionNote, CompanionTodo } from './companion-types'

// Wednesday 2 November 2026, 10:00 local.
const now = new Date(2026, 10, 2, 10, 0).getTime()
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime()

let n = 0
const newId = (): string => `id-${++n}`

const todo = (over: Partial<CompanionTodo>): CompanionTodo => ({
  id: over.id ?? newId(),
  title: 'x',
  remindAt: [],
  done: false,
  createdAt: 0,
  source: 'text',
  ...over
})

const plan = (text: string, todos: CompanionTodo[] = [], source: 'text' | 'voice' = 'text') =>
  planCapture({ text, source, parsed: parseCapture(text, { now, leadMinutes: 10, morningHour: 9 }), todos, now, newId })

describe('planCapture', () => {
  it('saves a timed todo with its due time and the reminder ten minutes before', () => {
    const r = plan('ligar à Câmara amanhã às 14h')
    expect(r.kind).toBe('todo')
    if (r.kind !== 'todo') return
    expect(r.todo.title).toMatch(/ligar à Câmara/i)
    expect(r.todo.dueAt).toBe(at(3, 14))
    expect(r.todo.duePrecision).toBe('minute')
    expect(r.todo.remindAt).toEqual([at(3, 13, 50)])
    expect(r.todo.done).toBe(false)
    expect(r.todo.createdAt).toBe(now)
    expect(r.todo.source).toBe('text')
  })

  it('saves an undated todo with no due time and no reminders', () => {
    const r = plan('comprar café', [], 'voice')
    expect(r.kind).toBe('todo')
    if (r.kind !== 'todo') return
    expect(r.todo.dueAt).toBeNull()
    expect(r.todo.duePrecision).toBeUndefined()
    expect(r.todo.remindAt).toEqual([])
    expect(r.todo.source).toBe('voice')
  })

  it('asks what to do for a date with nothing to do, saving nothing', () => {
    const r = plan('amanhã às 14h')
    expect(r.kind).toBe('needs-title')
    expect(r.parsed.when?.at).toBe(at(3, 14))
  })

  it('saves a note with the prefix stripped', () => {
    const r = plan('nota: o servidor de Vila Real usa a porta 8443')
    expect(r.kind).toBe('note')
    if (r.kind !== 'note') return
    expect(r.note.text).toMatch(/servidor de Vila Real/)
    expect(r.note.createdAt).toBe(now)
  })

  it('answers a query from the todos in its range, without saving', () => {
    const tomorrow = todo({ title: 'amanhã', dueAt: at(3, 14) })
    const later = todo({ title: 'depois', dueAt: at(5, 9) })
    const doneTomorrow = todo({ title: 'feito', dueAt: at(3, 9), done: true })
    const r = plan('o que tenho amanhã?', [later, tomorrow, doneTomorrow])
    expect(r.kind).toBe('query')
    if (r.kind !== 'query') return
    expect(r.results.map((t) => t.title)).toEqual(['amanhã'])
  })
})

describe('todosInRange', () => {
  it('uses the first reminder when there is no due time, and sorts soonest first', () => {
    const a = todo({ title: 'a', dueAt: at(3, 15) })
    const b = todo({ title: 'b', remindAt: [at(3, 9)] })
    const c = todo({ title: 'c' })
    expect(todosInRange([a, b, c], at(3, 0), at(4, 0)).map((t) => t.title)).toEqual(['b', 'a'])
  })
})

describe('listForView', () => {
  it('puts open todos first by due time, undated last, then recent done ones', () => {
    const undatedOld = todo({ title: 'undated old', createdAt: 1 })
    const undatedNew = todo({ title: 'undated new', createdAt: 2 })
    const soon = todo({ title: 'soon', dueAt: at(2, 12) })
    const later = todo({ title: 'later', dueAt: at(4, 12) })
    const doneRecent = todo({ title: 'done recent', done: true, doneAt: now - 60_000 })
    const doneOlder = todo({ title: 'done older', done: true, doneAt: now - 3 * 24 * 3600_000 })
    const doneStale = todo({ title: 'done stale', done: true, doneAt: now - DONE_VISIBLE_MS - 1 })
    const { todos } = listForView([doneOlder, undatedNew, later, doneStale, soon, undatedOld, doneRecent], [], now)
    expect(todos.map((t) => t.title)).toEqual(['soon', 'later', 'undated old', 'undated new', 'done recent', 'done older'])
  })

  it('lists notes newest first', () => {
    const notes: CompanionNote[] = [
      { id: 'a', text: 'a', createdAt: 1, source: 'text' },
      { id: 'b', text: 'b', createdAt: 3, source: 'text' },
      { id: 'c', text: 'c', createdAt: 2, source: 'text' }
    ]
    expect(listForView([], notes, now).notes.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })
})
