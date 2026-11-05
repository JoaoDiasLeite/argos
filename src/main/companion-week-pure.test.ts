import { describe, expect, it } from 'vitest'
import type { CompanionTodo } from './companion-types'
import { weekStart, weekSummary, weekSummaryDue } from './companion-week-pure'

// Friday 6 Nov 2026, 17:30 local.
const friday = new Date(2026, 10, 6, 17, 30).getTime()
const at = (d: number, h = 0, m = 0): number => new Date(2026, 10, d, h, m).getTime()

let seq = 0
function todo(over: Partial<CompanionTodo> = {}): CompanionTodo {
  seq++
  return { id: `t${seq}`, title: `todo ${seq}`, remindAt: [], done: false, createdAt: 0, source: 'text', ...over }
}

describe('weekStart', () => {
  it('is the Monday of the week, at midnight', () => {
    expect(weekStart(friday)).toBe(at(2))
    expect(weekStart(at(8, 23, 59))).toBe(at(2))
    expect(weekStart(at(9, 0, 1))).toBe(at(9))
  })
})

describe('weekSummary', () => {
  it('counts the week: done this week, late, and still to come before Monday', () => {
    const todos = [
      todo({ done: true, doneAt: at(3, 10) }),
      todo({ done: true, doneAt: at(6, 9) }),
      todo({ done: true, doneAt: at(1, 9) }), // last week
      todo({ done: true }), // no doneAt
      todo({ dueAt: at(5, 10), duePrecision: 'minute' }), // late
      todo({ dueAt: at(5), duePrecision: 'day' }), // late (day over)
      todo({ dueAt: at(6), duePrecision: 'day' }), // today, not late yet
      todo({ dueAt: at(7, 11), duePrecision: 'minute' }), // Saturday
      todo({ dueAt: at(9, 9), duePrecision: 'minute' }), // next week
      todo({})
    ]
    expect(weekSummary(todos, friday)).toEqual({ from: at(2), to: at(9), done: 2, late: 2, open: 2 })
  })
})

describe('weekSummaryDue', () => {
  it('is Friday from five on, once', () => {
    expect(weekSummaryDue(friday, null)).toBe(true)
    expect(weekSummaryDue(friday, at(1, 18))).toBe(true)
    expect(weekSummaryDue(friday, at(6, 17, 5))).toBe(false)
    expect(weekSummaryDue(at(6, 16, 59), null)).toBe(false)
    expect(weekSummaryDue(at(5, 18), null)).toBe(false)
    expect(weekSummaryDue(at(6, 23, 59), null)).toBe(true)
  })
})
