/**
 * The week in one line (docs/COMPANION_PLAN.md §13.3, T1): on Friday from WEEK_HOUR on,
 * once a week, Argos says how the week went, with Copy for the standup. Pure, so the
 * counts and the "is it time" rule are tested without Electron.
 */
import type { CompanionTodo, CompanionWeekSummary } from './companion-types'

/** Friday at this hour, local time. */
export const WEEK_DAY = 5
export const WEEK_HOUR = 17

export type WeekSummary = CompanionWeekSummary

function startOfDay(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Local midnight of the Monday of `now`'s week. */
export function weekStart(now: number): number {
  const d = new Date(startOfDay(now))
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime()
}

/** A day-precision todo is late once its day is over; a timed one past its minute. */
function isLate(todo: CompanionTodo, now: number): boolean {
  if (todo.done || todo.dueAt == null) return false
  if (todo.duePrecision === 'day') return startOfDay(todo.dueAt) < startOfDay(now)
  return todo.dueAt < now
}

export function weekSummary(todos: CompanionTodo[], now: number): WeekSummary {
  const from = weekStart(now)
  const d = new Date(from)
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime()
  let done = 0
  let late = 0
  let open = 0
  for (const todo of todos) {
    if (todo.done) {
      if (todo.doneAt != null && todo.doneAt >= from && todo.doneAt < to) done++
      continue
    }
    if (isLate(todo, now)) late++
    else if (todo.dueAt != null && todo.dueAt < to) open++
  }
  return { from, to, done, late, open }
}

/** Friday from WEEK_HOUR on, and not yet said this week. */
export function weekSummaryDue(now: number, lastAt: number | null | undefined): boolean {
  const d = new Date(now)
  if (d.getDay() !== WEEK_DAY || d.getHours() < WEEK_HOUR) return false
  return lastAt == null || lastAt < weekStart(now)
}
