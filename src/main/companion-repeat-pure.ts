/**
 * Repeating todos: "todos os dias às 9h", "todas as segundas", "todos os meses dia 1".
 *
 * A repeating todo is one occurrence at a time. Ticking it done keeps it in the list as
 * done (the week's record, what a standup draft reads) and adds the next occurrence as a
 * new todo; un-ticking it takes that one back. Nothing is generated ahead of time, so a
 * repeat never fills the list, and missed occurrences are not stacked up: the next one
 * is the first after now.
 *
 * Parsing lives here rather than in companion-nlu-pure.ts because it is a pre-pass: the
 * phrase is found, masked out of the line (same length, so the grammar's spans still
 * index the original text) and, for "todas as segundas", replaced by the weekday the
 * grammar already reads. The date comes from the grammar as usual and is then aligned.
 */
import type { CompanionRepeat, CompanionRepeatEvery, CompanionTodo, ParsedCapture } from './companion-types'

const B = String.raw`(?<![\p{L}\p{N}])`
const E = String.raw`(?![\p{L}\p{N}])`

const WD_PT = String.raw`segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo`
const WD_EN = String.raw`monday|tuesday|wednesday|thursday|friday|saturday|sunday`

interface Pattern {
  every: CompanionRepeatEvery
  re: RegExp
}

/**
 * Longest and most specific first: "de segunda a sexta" before any weekday, a weekday
 * before "todas as semanas". Bare "daily" / "weekly" / "monthly" are left out on purpose:
 * "daily às 10h" is the stand-up meeting, not a repeat.
 */
const PATTERNS: readonly Pattern[] = [
  {
    every: 'weekday',
    re: new RegExp(
      String.raw`${B}(?:(?:tod[oa]s\s+os|nos|aos)\s+)?dias\s+[úu]teis${E}|${B}de\s+segunda\s+a\s+sexta(?:[-\s]feira)?${E}|${B}(?:every\s+(?:weekday|working\s+day|work\s+day)|on\s+weekdays)${E}`,
      'iu'
    )
  },
  {
    every: 'week',
    re: new RegExp(
      String.raw`${B}(?:tod[oa]s\s+(?:as|os)|cada)\s+(?<wd>${WD_PT})s?(?:[-\s]feiras?)?${E}|${B}(?:every|each)\s+(?<wd2>${WD_EN})${E}|${B}on\s+(?<wd3>${WD_EN})s${E}`,
      'iu'
    )
  },
  {
    every: 'day',
    re: new RegExp(String.raw`${B}(?:todos\s+os\s+dias|diariamente|cada\s+dia|every\s+day|each\s+day)${E}`, 'iu')
  },
  {
    every: 'week',
    re: new RegExp(String.raw`${B}(?:todas\s+as\s+semanas|semanalmente|cada\s+semana|every\s+week|each\s+week)${E}`, 'iu')
  },
  {
    every: 'month',
    re: new RegExp(String.raw`${B}(?:todos\s+os\s+meses|mensalmente|cada\s+m[êe]s|every\s+month|each\s+month)${E}`, 'iu')
  }
]

export interface RepeatMatch {
  every: CompanionRepeatEvery
  /** The weekday named in "todas as segundas" / "every monday", lower-case and singular. */
  weekday: string | null
  start: number
  end: number
}

/** The first repeat phrase in the line, if any. */
export function findRepeat(text: string): RepeatMatch | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(text)
    if (!m) continue
    const wd = m.groups?.wd ?? m.groups?.wd2 ?? m.groups?.wd3 ?? null
    return { every: p.every, weekday: wd ? wd.toLowerCase() : null, start: m.index, end: m.index + m[0].length }
  }
  return null
}

/**
 * The line with the repeat phrase blanked out, same length: the weekday it named stays
 * (at the end of the span, so a time after it still reads "segunda às 9h"), the rest
 * becomes spaces.
 */
export function maskRepeat(text: string, m: RepeatMatch): string {
  const len = m.end - m.start
  const keep = m.weekday && m.weekday.length <= len ? m.weekday : ''
  return text.slice(0, m.start) + ' '.repeat(len - keep.length) + keep + text.slice(m.end)
}

function startOfDay(at: number): Date {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6

function shiftDays(at: number, days: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes()).getTime()
}

/** Same wall time in another month, on `day` or that month's last day if it is shorter. */
function inMonth(at: number, monthsAhead: number, day: number): number {
  const d = new Date(at)
  const last = new Date(d.getFullYear(), d.getMonth() + monthsAhead + 1, 0).getDate()
  return new Date(d.getFullYear(), d.getMonth() + monthsAhead, Math.min(day, last), d.getHours(), d.getMinutes()).getTime()
}

/**
 * The first occurrence of a repeat captured now. With no date, today (a day, no time).
 * Workday repeats move off a weekend. "todas as segundas" said on a Monday is today when
 * today's time is still ahead: the grammar reads a bare weekday as the next one, which
 * for a repeat would skip the first.
 */
export function firstOccurrence(
  m: RepeatMatch,
  when: ParsedCapture['when'],
  now: number
): { when: NonNullable<ParsedCapture['when']>; repeat: CompanionRepeat } {
  let w: NonNullable<ParsedCapture['when']> = when ?? { at: startOfDay(now).getTime(), precision: 'day' }
  if (m.every === 'week' && m.weekday) {
    const earlier = shiftDays(w.at, -7)
    const today = startOfDay(now).getTime()
    if (earlier >= today && (w.precision === 'day' || earlier > now)) w = { ...w, at: earlier }
  }
  if (m.every === 'weekday') {
    while (isWeekend(new Date(w.at))) w = { ...w, at: shiftDays(w.at, 1) }
  }
  const repeat: CompanionRepeat =
    m.every === 'month' ? { every: 'month', monthDay: new Date(w.at).getDate() } : { every: m.every }
  return { when: w, repeat }
}

/** One step of the rule from `at`. */
function step(at: number, repeat: CompanionRepeat): number {
  switch (repeat.every) {
    case 'day':
      return shiftDays(at, 1)
    case 'weekday': {
      let next = shiftDays(at, 1)
      while (isWeekend(new Date(next))) next = shiftDays(next, 1)
      return next
    }
    case 'week':
      return shiftDays(at, 7)
    case 'month':
      return inMonth(at, 1, repeat.monthDay ?? new Date(at).getDate())
  }
}

/**
 * When the occurrence after this one falls: at least one step past its due time, and
 * then past now, so occurrences missed while it sat undone are skipped, not stacked. A
 * day-precision occurrence counts as past once its day has started.
 */
export function nextOccurrence(todo: CompanionTodo, now: number): number | null {
  if (!todo.repeat || todo.dueAt == null) return null
  let at = step(todo.dueAt, todo.repeat)
  // A month is the longest step, so this is bounded by the gap since dueAt.
  for (let i = 0; at <= now && i < 10_000; i++) at = step(at, todo.repeat)
  return at
}

/**
 * The next occurrence as a todo, given its reminders (the caller applies the reminder
 * rule with the current prefs). Same title, notes, precision and repeat; a fresh todo
 * otherwise. Not linked to the sprint: a promoted occurrence is promoted on its own.
 */
export function nextTodo(
  todo: CompanionTodo,
  now: number,
  id: string,
  remindersFor: (when: NonNullable<ParsedCapture['when']>, explicit: boolean) => number[]
): CompanionTodo | null {
  const at = nextOccurrence(todo, now)
  if (at === null || !todo.repeat) return null
  const precision = todo.duePrecision ?? 'minute'
  // "lembra-me às 9h" reminds at the time itself; the rest lead it by the prefs' minutes.
  const explicit = precision === 'minute' && todo.remindAt[0] === todo.dueAt
  return {
    id,
    title: todo.title,
    ...(todo.notes ? { notes: todo.notes } : {}),
    dueAt: at,
    duePrecision: precision,
    remindAt: remindersFor({ at, precision }, explicit),
    done: false,
    createdAt: now,
    source: todo.source,
    repeat: { ...todo.repeat },
    ...(todo.projectPath ? { projectPath: todo.projectPath } : {})
  }
}

const EVERY: readonly CompanionRepeatEvery[] = ['day', 'weekday', 'week', 'month']

/** A repeat read from disk or IPC, or null. */
export function cleanRepeat(raw: unknown): CompanionRepeat | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { every?: unknown; monthDay?: unknown }
  if (!EVERY.includes(r.every as CompanionRepeatEvery)) return null
  const every = r.every as CompanionRepeatEvery
  if (every !== 'month') return { every }
  const day = typeof r.monthDay === 'number' && Number.isInteger(r.monthDay) && r.monthDay >= 1 && r.monthDay <= 31 ? r.monthDay : undefined
  return day ? { every, monthDay: day } : { every }
}
