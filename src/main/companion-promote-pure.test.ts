import { describe, it, expect } from 'vitest'
import type { CompanionTodo } from './companion-types'
import type { Sprint } from './sprints'
import {
  activeSprint,
  buildSprintItem,
  promote,
  promotedStatus,
  sprintLinks,
  unlink,
  withSprintDone
} from './companion-promote-pure'

const NOW = new Date(2026, 10, 2, 10, 0).getTime()

const sprint = (over: Partial<Sprint> = {}): Sprint => ({
  id: 's44',
  name: 'Sprint 44',
  startDate: '2026-10-28',
  endDate: '2026-11-08',
  status: 'active',
  items: [],
  standups: [],
  createdAt: 1,
  updatedAt: 10,
  ...over
})

const TODO: CompanionTodo = {
  id: 't1',
  title: 'Ligar à Câmara de Vila Real ',
  notes: 'Pedir o ofício do SAML',
  dueAt: new Date(2026, 10, 3, 14, 0).getTime(),
  duePrecision: 'minute',
  remindAt: [new Date(2026, 10, 3, 13, 50).getTime()],
  done: false,
  createdAt: 1,
  source: 'text'
}

let n = 0
const newId = (): string => `item-${++n}`

describe('activeSprint', () => {
  it('is null with no active sprint', () => {
    expect(activeSprint([sprint({ status: 'planning' }), sprint({ id: 'x', status: 'completed' })], NOW)).toBeNull()
    expect(activeSprint([], NOW)).toBeNull()
  })
  it('prefers the active one whose range holds today', () => {
    const old = sprint({ id: 'old', startDate: '2026-10-01', endDate: '2026-10-14', updatedAt: 99 })
    const cur = sprint({ id: 'cur', updatedAt: 5 })
    expect(activeSprint([old, cur], NOW)?.id).toBe('cur')
  })
  it('falls back to the most recently updated active one', () => {
    const a = sprint({ id: 'a', startDate: '2026-09-01', endDate: '2026-09-14', updatedAt: 3 })
    const b = sprint({ id: 'b', startDate: '2026-09-15', endDate: '2026-09-28', updatedAt: 7 })
    expect(activeSprint([a, b], NOW)?.id).toBe('b')
  })
  it('counts the end date as inclusive', () => {
    const s = sprint({ startDate: '2026-10-20', endDate: '2026-11-02', updatedAt: 1 })
    const other = sprint({ id: 'o', startDate: '2026-11-03', endDate: '2026-11-16', updatedAt: 9 })
    expect(activeSprint([s, other], NOW)?.id).toBe('s44')
  })
})

describe('buildSprintItem', () => {
  it('carries title, notes and the due line, unestimated in To do', () => {
    const item = buildSprintItem(TODO, NOW, () => 'i1', { dueLabel: 'Prazo' })
    expect(item).toEqual({
      id: 'i1',
      title: 'Ligar à Câmara de Vila Real',
      notes: 'Pedir o ofício do SAML\nPrazo: 2026-11-03 14:00',
      status: 'todo',
      points: null,
      createdAt: NOW,
      completedAt: null
    })
  })
  it('writes only the date for a day-precision due, and no notes when there is nothing', () => {
    const day = { ...TODO, notes: null, dueAt: new Date(2026, 10, 6).getTime(), duePrecision: 'day' as const }
    expect(buildSprintItem(day, NOW, () => 'i').notes).toBe('Due: 2026-11-06')
    expect(buildSprintItem({ ...TODO, notes: '  ', dueAt: null }, NOW, () => 'i').notes).toBeNull()
  })
})

describe('promote', () => {
  it('appends one item and links the todo to it', () => {
    const r = promote(TODO, sprint(), NOW, newId)
    expect(r.changed).toBe(true)
    expect(r.sprint.items).toHaveLength(1)
    expect(r.todo.sprintId).toBe('s44')
    expect(r.todo.sprintItemId).toBe(r.sprint.items[0].id)
  })
  it('does not duplicate: promoting the promoted todo again changes nothing', () => {
    const first = promote(TODO, sprint(), NOW, newId)
    const again = promote(first.todo, first.sprint, NOW + 1000, newId)
    expect(again.changed).toBe(false)
    expect(again.sprint).toBe(first.sprint)
    expect(again.todo).toBe(first.todo)
    expect(again.sprint.items).toHaveLength(1)
  })
  it('keeps the items already in the sprint', () => {
    const s = sprint({ items: [{ id: 'x', title: 'Existing', status: 'in-progress', createdAt: 1 }] })
    const r = promote(TODO, s, NOW, newId)
    expect(r.sprint.items.map((i) => i.id)).toEqual(['x', r.todo.sprintItemId])
  })
})

describe('promotedStatus and links', () => {
  const { sprint: s, todo } = promote(TODO, sprint(), NOW, newId)
  it('reads the linked item status, null when never promoted', () => {
    expect(promotedStatus(TODO, [s])).toBeNull()
    expect(promotedStatus(todo, [s])).toBe('todo')
    const moved = { ...s, items: s.items.map((i) => ({ ...i, status: 'in-progress' as const })) }
    expect(promotedStatus(todo, [moved])).toBe('in-progress')
  })
  it("is 'missing' once the item or the sprint is gone", () => {
    expect(promotedStatus(todo, [{ ...s, items: [] }])).toBe('missing')
    expect(promotedStatus(todo, [])).toBe('missing')
    expect(sprintLinks([todo, TODO], [])).toEqual({ t1: { sprintId: 's44', sprintName: '', status: 'missing' } })
  })
  it('gives the sprint name per promoted todo', () => {
    expect(sprintLinks([todo], [s])).toEqual({ t1: { sprintId: 's44', sprintName: 'Sprint 44', status: 'todo' } })
  })
  it('reads done through from the sprint item', () => {
    const done = { ...s, items: s.items.map((i) => ({ ...i, status: 'done' as const, completedAt: 555 })) }
    const [view] = withSprintDone([todo], [done], NOW)
    expect(view.done).toBe(true)
    expect(view.doneAt).toBe(555)
    expect(withSprintDone([todo], [s], NOW)[0]).toBe(todo)
  })
})

describe('unlink', () => {
  it('clears the link and marks reminders that came round as fired', () => {
    const { todo } = promote(TODO, sprint(), NOW, newId)
    const later = new Date(2026, 10, 4).getTime()
    const r = unlink({ ...todo, remindAt: [...todo.remindAt, later + 1] }, later)
    expect(r.sprintId).toBeNull()
    expect(r.sprintItemId).toBeNull()
    expect(r.firedAt).toEqual([TODO.remindAt[0]])
  })
})
