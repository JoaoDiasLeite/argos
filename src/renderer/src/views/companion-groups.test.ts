import { describe, it, expect } from 'vitest'
import type { CompanionTodo } from '../../../shared/companion'
import { makeT } from '../../../shared/i18n'
import {
  defaultNewReminder,
  doneToday,
  dueFromInputs,
  groupOf,
  groupTodos,
  isOverdue,
  nextUp,
  reminderLabel,
  rowTimeLabel,
  sprintRange,
  weekCounts,
  weekDays,
  withDue
} from './companion-groups'

const pt = makeT('pt-PT')
// Monday 2 Nov 2026, 10:30 local.
const now = new Date(2026, 10, 2, 10, 30).getTime()
const at = (d: number, h = 0, m = 0): number => new Date(2026, 10, d, h, m).getTime()
const MIN = 60_000

let seq = 0
function todo(over: Partial<CompanionTodo> = {}): CompanionTodo {
  seq++
  return { id: `t${seq}`, title: `todo ${seq}`, remindAt: [], done: false, createdAt: seq, source: 'text', ...over }
}

describe('grouping', () => {
  it('buckets by local calendar day', () => {
    expect(groupOf(todo({ dueAt: at(2, 18), duePrecision: 'minute' }), now)).toBe('today')
    expect(groupOf(todo({ dueAt: at(3, 9), duePrecision: 'minute' }), now)).toBe('tomorrow')
    expect(groupOf(todo({ dueAt: at(4, 9), duePrecision: 'minute' }), now)).toBe('later')
    expect(groupOf(todo({ dueAt: null }), now)).toBe('someday')
    expect(groupOf(todo({}), now)).toBe('someday')
  })

  it('puts overdue items in today, from earlier today or earlier days', () => {
    expect(groupOf(todo({ dueAt: at(2, 9), duePrecision: 'minute' }), now)).toBe('today')
    expect(groupOf(todo({ dueAt: at(1, 16), duePrecision: 'minute' }), now)).toBe('today')
    expect(groupOf(todo({ dueAt: at(28, 9) }), now)).toBe('later')
  })

  it('places day-precision items (stored at local midnight) on their day', () => {
    expect(groupOf(todo({ dueAt: at(2), duePrecision: 'day' }), now)).toBe('today')
    expect(groupOf(todo({ dueAt: at(3), duePrecision: 'day' }), now)).toBe('tomorrow')
    expect(groupOf(todo({ dueAt: at(6), duePrecision: 'day' }), now)).toBe('later')
  })

  it('splits at midnight exactly', () => {
    const lateNight = at(2, 23, 59)
    expect(groupOf(todo({ dueAt: at(3, 0, 0), duePrecision: 'minute' }), lateNight)).toBe('tomorrow')
    expect(groupOf(todo({ dueAt: at(2, 23, 59) + 59_000, duePrecision: 'minute' }), lateNight)).toBe('today')
    // One minute later the clock has crossed: tomorrow's 00:00 item is today's.
    expect(groupOf(todo({ dueAt: at(3, 0, 0), duePrecision: 'minute' }), at(3, 0, 0))).toBe('today')
    expect(groupOf(todo({ dueAt: at(4, 0, 0), duePrecision: 'minute' }), at(3, 0, 0))).toBe('tomorrow')
  })

  it('keeps done items apart in the order given, and sorts open ones by due', () => {
    const d1 = todo({ done: true, doneAt: now - MIN, dueAt: at(2, 9) })
    const d2 = todo({ done: true, doneAt: now - 2 * MIN })
    const a = todo({ dueAt: at(2, 15), duePrecision: 'minute' })
    const b = todo({ dueAt: at(2, 11), duePrecision: 'minute' })
    const c = todo({ dueAt: at(1, 9), duePrecision: 'minute' })
    const s1 = todo({})
    const s2 = todo({})
    const g = groupTodos([d1, a, s2, d2, b, s1, c], now)
    expect(g.today.map((x) => x.id)).toEqual([c.id, b.id, a.id])
    expect(g.someday.map((x) => x.id)).toEqual([s1.id, s2.id])
    expect(g.done.map((x) => x.id)).toEqual([d1.id, d2.id])
    expect(g.tomorrow).toEqual([])
    expect(g.later).toEqual([])
  })
})

describe('overdue and the time column', () => {
  it('is overdue past the minute, or past the day for day precision', () => {
    expect(isOverdue(todo({ dueAt: at(2, 9), duePrecision: 'minute' }), now)).toBe(true)
    expect(isOverdue(todo({ dueAt: at(2, 11), duePrecision: 'minute' }), now)).toBe(false)
    expect(isOverdue(todo({ dueAt: at(2), duePrecision: 'day' }), now)).toBe(false)
    expect(isOverdue(todo({ dueAt: at(1), duePrecision: 'day' }), now)).toBe(true)
    expect(isOverdue(todo({ dueAt: at(1, 9), done: true }), now)).toBe(false)
    expect(isOverdue(todo({}), now)).toBe(false)
  })

  it('shows only the time today and tomorrow, the day further out or overdue', () => {
    expect(rowTimeLabel(todo({ dueAt: at(2, 14), duePrecision: 'minute' }), now, 'pt-PT', pt)).toBe('14:00')
    expect(rowTimeLabel(todo({ dueAt: at(3, 9, 5), duePrecision: 'minute' }), now, 'pt-PT', pt)).toBe('09:05')
    expect(rowTimeLabel(todo({ dueAt: at(3), duePrecision: 'day' }), now, 'pt-PT', pt)).toBe('')
    expect(rowTimeLabel(todo({ dueAt: at(1, 16), duePrecision: 'minute' }), now, 'pt-PT', pt)).toBe('Ontem, 16:00')
    expect(rowTimeLabel(todo({ dueAt: at(5, 14), duePrecision: 'minute' }), now, 'pt-PT', pt)).toBe('Qui 5 nov, 14:00')
    expect(rowTimeLabel(todo({ dueAt: at(5), duePrecision: 'day' }), now, 'pt-PT', pt)).toBe('Qui 5 nov')
    expect(rowTimeLabel(todo({}), now, 'pt-PT', pt)).toBe('')
  })

  it('says how far a reminder is before the due', () => {
    const t1 = todo({ dueAt: at(2, 14), duePrecision: 'minute' })
    expect(reminderLabel(at(2, 13, 50), t1, now, 'pt-PT', pt)).toBe('13:50 · 10 min antes')
    expect(reminderLabel(at(2, 14), t1, now, 'pt-PT', pt)).toBe('14:00 · na hora')
    const t2 = todo({ dueAt: at(3), duePrecision: 'day' })
    expect(reminderLabel(at(3, 9), t2, now, 'pt-PT', pt)).toBe('amanhã, 09:00')
  })
})

describe('date and time fields', () => {
  it('reads a date alone as day precision at local midnight', () => {
    expect(dueFromInputs('2026-11-05', '', now)).toEqual({ dueAt: at(5), duePrecision: 'day' })
  })
  it('reads both as a minute', () => {
    expect(dueFromInputs('2026-11-05', '14:30', now)).toEqual({ dueAt: at(5, 14, 30), duePrecision: 'minute' })
  })
  it('takes a time alone as today, and nothing as no date', () => {
    expect(dueFromInputs('', '16:00', now)).toEqual({ dueAt: at(2, 16), duePrecision: 'minute' })
    expect(dueFromInputs('', '', now)).toEqual({ dueAt: null })
    expect(dueFromInputs('5/11', '', now)).toBeUndefined()
  })
})

describe('the reminder moves with the due time', () => {
  const rules = { leadMinutes: 10, morningHour: 9, now }

  it('moves the single lead reminder when the time changes', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 13, 50)] })
    const next = withDue(t1, { dueAt: at(3, 16), duePrecision: 'minute' }, rules)
    expect(next.dueAt).toBe(at(3, 16))
    expect(next.remindAt).toEqual([at(3, 15, 50)])
  })

  it('moves a reminder at the due time itself, keeping it at the due', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 14)] })
    expect(withDue(t1, { dueAt: at(4, 11), duePrecision: 'minute' }, rules).remindAt).toEqual([at(4, 11)])
  })

  it('leaves a reminder set by hand alone', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 12)] })
    expect(withDue(t1, { dueAt: at(3, 16), duePrecision: 'minute' }, rules).remindAt).toEqual([at(3, 12)])
  })

  it('leaves several reminders alone', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 9), at(3, 13, 50)] })
    expect(withDue(t1, { dueAt: at(3, 16), duePrecision: 'minute' }, rules).remindAt).toEqual([at(3, 9), at(3, 13, 50)])
  })

  it('ignores reminders that already fired when counting, and keeps them', () => {
    const t1 = todo({
      dueAt: at(2, 14),
      duePrecision: 'minute',
      remindAt: [at(2, 10), at(2, 13, 50)],
      firedAt: [at(2, 10)]
    })
    expect(withDue(t1, { dueAt: at(2, 15), duePrecision: 'minute' }, rules).remindAt).toEqual([at(2, 10), at(2, 14, 50)])
  })

  it('does not move a lone reminder that already fired', () => {
    const t1 = todo({ dueAt: at(2, 14), duePrecision: 'minute', remindAt: [at(2, 10)], firedAt: [at(2, 10)] })
    expect(withDue(t1, { dueAt: at(2, 15), duePrecision: 'minute' }, rules).remindAt).toEqual([at(2, 10)])
  })

  it('moves the morning reminder of a day-precision todo to the new day', () => {
    const t1 = todo({ dueAt: at(3), duePrecision: 'day', remindAt: [at(3, 9)] })
    expect(withDue(t1, { dueAt: at(5), duePrecision: 'day' }, rules).remindAt).toEqual([at(5, 9)])
  })

  it('turns the morning reminder into a lead reminder when a time is set', () => {
    const t1 = todo({ dueAt: at(3), duePrecision: 'day', remindAt: [at(3, 9)] })
    const next = withDue(t1, { dueAt: at(3, 14), duePrecision: 'minute' }, rules)
    expect(next.duePrecision).toBe('minute')
    expect(next.remindAt).toEqual([at(3, 13, 50)])
  })

  it('falls back to the due time when due − lead is already past, and drops it when the due is past', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 13, 50)] })
    expect(withDue(t1, { dueAt: at(2, 10, 35), duePrecision: 'minute' }, rules).remindAt).toEqual([at(2, 10, 35)])
    expect(withDue(t1, { dueAt: at(2, 10), duePrecision: 'minute' }, rules).remindAt).toEqual([])
  })

  it('drops the tied reminder when the date is cleared', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 13, 50)] })
    const next = withDue(t1, { dueAt: null }, rules)
    expect(next.dueAt).toBeNull()
    expect(next.duePrecision).toBeUndefined()
    expect(next.remindAt).toEqual([])
  })

  it('adds nothing to a todo that had no date', () => {
    const t1 = todo({ dueAt: null, remindAt: [] })
    const next = withDue(t1, { dueAt: at(3, 14), duePrecision: 'minute' }, rules)
    expect(next.remindAt).toEqual([])
    expect(next.duePrecision).toBe('minute')
  })

  it('uses the lead the user has set', () => {
    const t1 = todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 13, 30)] })
    const next = withDue(t1, { dueAt: at(3, 15), duePrecision: 'minute' }, { ...rules, leadMinutes: 30 })
    expect(next.remindAt).toEqual([at(3, 14, 30)])
  })
})

describe('a new reminder', () => {
  const rules = { leadMinutes: 10, morningHour: 9, now }
  it('starts at the lead before a timed due', () => {
    expect(defaultNewReminder(todo({ dueAt: at(3, 14), duePrecision: 'minute' }), rules)).toBe(at(3, 13, 50))
  })
  it('starts at the morning of a day-precision due', () => {
    expect(defaultNewReminder(todo({ dueAt: at(4), duePrecision: 'day' }), rules)).toBe(at(4, 9))
  })
  it('falls back to the next round hour when that one exists or is past', () => {
    expect(defaultNewReminder(todo({ dueAt: at(3, 14), duePrecision: 'minute', remindAt: [at(3, 13, 50)] }), rules)).toBe(at(2, 12))
    expect(defaultNewReminder(todo({}), rules)).toBe(at(2, 12))
  })
})

describe('sprintRange', () => {
  it('reads day and short month at each end', () => {
    expect(sprintRange('2026-10-28', '2026-11-08', 'pt-PT')).toBe('28 out – 8 nov')
    expect(sprintRange('2026-10-28', '2026-11-08', 'en-GB')).toBe('28 Oct – 8 Nov')
  })
})

describe('the status strip', () => {
  it('lists the week Monday first, whatever day it is', () => {
    const days = weekDays(now).map((d) => new Date(d).getDate())
    expect(days).toEqual([2, 3, 4, 5, 6, 7, 8])
    // Sunday 8 Nov belongs to the same week.
    expect(weekDays(at(8, 23, 59)).map((d) => new Date(d).getDate())).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(weekDays(now).every((d) => new Date(d).getHours() === 0)).toBe(true)
  })

  it('counts open todos per day and flags a late one', () => {
    const todos = [
      todo({ dueAt: at(2, 9), duePrecision: 'minute' }),
      todo({ dueAt: at(2, 18), duePrecision: 'minute' }),
      todo({ dueAt: at(4, 9), duePrecision: 'minute' }),
      todo({ dueAt: at(4, 9), duePrecision: 'minute', done: true }),
      todo({ dueAt: at(12, 9), duePrecision: 'minute' }),
      todo({})
    ]
    const week = weekCounts(todos, now)
    expect(week.map((d) => d.open)).toEqual([2, 0, 1, 0, 0, 0, 0])
    expect(week.map((d) => d.late)).toEqual([true, false, false, false, false, false, false])
    expect(week.map((d) => d.today)).toEqual([true, false, false, false, false, false, false])
  })

  it('picks the earliest open todo still ahead as next up', () => {
    const past = todo({ dueAt: at(2, 9), duePrecision: 'minute' })
    const soon = todo({ dueAt: at(2, 14), duePrecision: 'minute' })
    const later = todo({ dueAt: at(3, 9), duePrecision: 'minute' })
    const done = todo({ dueAt: at(2, 11), duePrecision: 'minute', done: true })
    expect(nextUp([later, done, soon, past], now)?.id).toBe(soon.id)
    expect(nextUp([past, done], now)).toBeNull()
    // A day-precision todo is next all its day long.
    const day = todo({ dueAt: at(2), duePrecision: 'day' })
    expect(nextUp([soon, day], now)?.id).toBe(day.id)
  })

  it('counts what was ticked today', () => {
    const todos = [
      todo({ done: true, doneAt: at(2, 8) }),
      todo({ done: true, doneAt: at(1, 20) }),
      todo({ done: true }),
      todo({})
    ]
    expect(doneToday(todos, now)).toBe(1)
  })
})
