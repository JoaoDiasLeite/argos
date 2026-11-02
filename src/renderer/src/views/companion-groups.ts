// The companion panel's list logic (docs/COMPANION_PLAN.md §12 item 7), pure so it is
// tested without a window: which section a todo sits in, what its time column says, and
// how a due-time edit carries the reminder tied to it.
import type { CompanionTodo } from '../../../shared/companion'
import type { TFunction } from '../../../shared/i18n'
import { dayOffset, dayWord, defaultPickTime, formatShortDate, formatTime } from '../companion/format'

const MINUTE = 60_000

export type CompanionGroupKey = 'today' | 'tomorrow' | 'later' | 'someday'

export const GROUP_ORDER: CompanionGroupKey[] = ['today', 'tomorrow', 'later', 'someday']

export interface CompanionGroups {
  today: CompanionTodo[]
  tomorrow: CompanionTodo[]
  later: CompanionTodo[]
  someday: CompanionTodo[]
  /** Ticked ones, in the order the list came in (most recent first from `companion:list`). */
  done: CompanionTodo[]
}

/** Which section an open todo belongs in. Anything overdue is today's business. */
export function groupOf(todo: CompanionTodo, now: number): CompanionGroupKey {
  if (todo.dueAt == null) return 'someday'
  const d = dayOffset(todo.dueAt, now)
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : 'later'
}

/** By due time, then by when it was captured; undated by capture. */
function byDue(a: CompanionTodo, b: CompanionTodo): number {
  const da = a.dueAt ?? Infinity
  const db = b.dueAt ?? Infinity
  if (da !== db) return da < db ? -1 : 1
  return a.createdAt - b.createdAt
}

export function groupTodos(todos: CompanionTodo[], now: number): CompanionGroups {
  const groups: CompanionGroups = { today: [], tomorrow: [], later: [], someday: [], done: [] }
  for (const todo of todos) {
    if (todo.done) groups.done.push(todo)
    else groups[groupOf(todo, now)].push(todo)
  }
  for (const key of GROUP_ORDER) groups[key].sort(byDue)
  return groups
}

/**
 * Past its due and not done. A day-precision todo is late only once its day is over:
 * "sexta" is not overdue at 09:01 on Friday.
 */
export function isOverdue(todo: CompanionTodo, now: number): boolean {
  if (todo.done || todo.dueAt == null) return false
  if (todo.duePrecision === 'day') return dayOffset(todo.dueAt, now) < 0
  return todo.dueAt < now
}

/**
 * The row's right-hand column. Today and tomorrow are already said by the section, so a
 * row there shows only its time ("14:00", or nothing for a day-precision todo); further
 * out, or overdue from an earlier day, the day comes first: "Qui 5 nov, 14:00", "Ontem".
 */
export function rowTimeLabel(todo: CompanionTodo, now: number, locale: string | undefined, t: TFunction): string {
  if (todo.dueAt == null) return ''
  const d = dayOffset(todo.dueAt, now)
  const timed = todo.duePrecision !== 'day'
  if (d === 0 || d === 1) return timed ? formatTime(todo.dueAt, locale) : ''
  const day = dayWord(todo.dueAt, now, locale, t)
  return timed ? t('companion.when.dayTime', { day, time: formatTime(todo.dueAt, locale) }) : day
}

/** A reminder chip: "13:50 · 10 min antes", "amanhã, 13:50", "Qui 5 nov, 09:00". */
export function reminderLabel(
  at: number,
  todo: CompanionTodo,
  now: number,
  locale: string | undefined,
  t: TFunction
): string {
  const time = formatTime(at, locale)
  const d = dayOffset(at, now)
  const when =
    d === 0
      ? time
      : t('companion.when.dayTime', {
          day: d === 1 ? t('companion.dayInline.tomorrow') : d === -1 ? t('companion.dayInline.yesterday') : formatShortDate(at, locale),
          time
        })
  if (todo.dueAt == null || todo.duePrecision === 'day') return when
  const before = Math.round((todo.dueAt - at) / MINUTE)
  if (before === 0) return `${when} · ${t('companion.panel.reminder.atDue')}`
  if (before > 0 && before <= 24 * 60) return `${when} · ${t('companion.panel.reminder.before', { n: before })}`
  return when
}

/** Local midnight of `at`'s day. */
export function startOfLocalDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `<input type="date">` value, local. */
export function toDateInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `<input type="time">` value, local. */
export function toTimeInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The due instant from the two fields: a date alone is the day at local midnight with
 * 'day' precision (as the parser stores "sexta"); a time alone means today. Neither: no
 * date. Returns undefined when a field holds something unreadable.
 */
export function dueFromInputs(
  date: string,
  time: string,
  now: number
): { dueAt: number | null; duePrecision?: 'day' | 'minute' } | undefined {
  if (!date && !time) return { dueAt: null }
  let y: number, mo: number, d: number
  if (date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!m) return undefined
    ;[y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  } else {
    const n = new Date(now)
    ;[y, mo, d] = [n.getFullYear(), n.getMonth(), n.getDate()]
  }
  if (!time) return { dueAt: new Date(y, mo, d).getTime(), duePrecision: 'day' }
  const tm = /^(\d{2}):(\d{2})$/.exec(time)
  if (!tm) return undefined
  return { dueAt: new Date(y, mo, d, Number(tm[1]), Number(tm[2])).getTime(), duePrecision: 'minute' }
}

export interface ReminderRules {
  leadMinutes: number
  morningHour: number
  now: number
}

/**
 * A new due date or time, carrying the reminder that belongs to it.
 *
 * Nothing is recomputed behind the user's back, except this one case: when the todo has
 * exactly one reminder still to go off, and that reminder is the one the due time
 * implies (due − lead, the due time itself, or the morning of a day-precision due), it
 * moves with the due. A reminder the user set by hand, or a todo with several, is left
 * alone. A moved reminder that would land in the past falls back to the due time, or is
 * dropped if the due itself is past: an edit should not set off an instant "late" pop.
 */
export function withDue(
  todo: CompanionTodo,
  next: { dueAt: number | null; duePrecision?: 'day' | 'minute' },
  rules: ReminderRules
): CompanionTodo {
  const updated: CompanionTodo = { ...todo, dueAt: next.dueAt }
  if (next.dueAt != null && next.duePrecision) updated.duePrecision = next.duePrecision
  else delete updated.duePrecision

  const oldDue = todo.dueAt
  if (oldDue == null) return updated
  const fired = new Set(todo.firedAt ?? [])
  const unfired = todo.remindAt.filter((r) => !fired.has(r))
  if (unfired.length !== 1) return updated
  const r = unfired[0]
  const oldDay = todo.duePrecision === 'day'
  const morningOf = (at: number): number => startOfLocalDay(at) + rules.morningHour * 60 * MINUTE
  const tied = oldDay ? r === morningOf(oldDue) : r === oldDue - rules.leadMinutes * MINUTE || r === oldDue
  if (!tied) return updated

  let moved: number | null = null
  if (next.dueAt != null) {
    const newDay = next.duePrecision === 'day'
    if (newDay) moved = morningOf(next.dueAt)
    else if (!oldDay) moved = r + (next.dueAt - oldDue)
    else moved = next.dueAt - rules.leadMinutes * MINUTE
    if (moved <= rules.now) moved = !newDay && next.dueAt > rules.now ? next.dueAt : null
  }
  const rest = todo.remindAt.filter((x) => x !== r)
  updated.remindAt = (moved != null ? [...rest, moved] : rest).sort((a, b) => a - b)
  return updated
}

/** The "+ Aviso" field's starting value: lead minutes before a timed due still ahead, else the next round hour. */
export function defaultNewReminder(todo: CompanionTodo, rules: ReminderRules): number {
  if (todo.dueAt != null && todo.duePrecision !== 'day') {
    const lead = todo.dueAt - rules.leadMinutes * MINUTE
    if (lead > rules.now && !todo.remindAt.includes(lead)) return lead
  }
  if (todo.dueAt != null && todo.duePrecision === 'day') {
    const morning = startOfLocalDay(todo.dueAt) + rules.morningHour * 60 * MINUTE
    if (morning > rules.now && !todo.remindAt.includes(morning)) return morning
  }
  return defaultPickTime(rules.now)
}
