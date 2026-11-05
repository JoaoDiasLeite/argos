// Dates and times as the companion's bubble says them (docs/COMPANION_PLAN.md §5.4):
// "Amanhã, ter 3 nov", "amanhã às 14:00", "atrasado 1 h". Pure: every function takes
// `now`, the locale for Intl and the translator, so it is tested without a window.
import type { TFunction } from '../../../shared/i18n'
import type { CompanionRepeat } from '../../../shared/companion'

const DAY_MS = 24 * 60 * 60_000

/** "Todos os dias", "Todos os meses, dia 15": a repeating todo's rule. */
export function repeatLabel(repeat: CompanionRepeat, dueAt: number, t: TFunction): string {
  if (repeat.every === 'month') return t('companion.repeat.month', { day: repeat.monthDay ?? new Date(dueAt).getDate() })
  return t(`companion.repeat.${repeat.every}`)
}

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole local calendar days from `now`'s day to `at`'s (DST-safe: rounds the hour off). */
export function dayOffset(at: number, now: number): number {
  return Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS)
}

/** "14:00", always 24-hour and two-digit, whatever the locale prefers. */
export function formatTime(at: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

/**
 * "ter 3 nov" / "Tue 3 Nov": weekday, day, month. Each part is formatted on its own: the
 * combined pattern differs between ICU builds (pt-PT gives "terça, 3/11" in Node), and
 * pt-PT's abbreviated weekday is the full "terça", cut to the three letters people write.
 */
export function formatShortDate(at: number, locale: string | undefined): string {
  const month = new Intl.DateTimeFormat(locale, { month: 'short' }).format(at).replace(/\.$/, '')
  return `${weekdayShort(at, locale)} ${new Date(at).getDate()} ${month}`
}

/** "ter" / "Tue": the weekday as people write it, three letters in Portuguese. */
export function weekdayShort(at: number, locale: string | undefined): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at).replace(/\.$/, '')
  return locale?.startsWith('pt') ? weekday.slice(0, 3) : weekday
}

const capitalize = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1)

type Relative = 'today' | 'tomorrow' | 'yesterday'

function relative(at: number, now: number): Relative | null {
  const d = dayOffset(at, now)
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : null
}

/** "Hoje" / "Amanhã" / "Ontem", else "Ter 3 nov": the word that starts a line. */
export function dayWord(at: number, now: number, locale: string | undefined, t: TFunction): string {
  const rel = relative(at, now)
  return rel ? t(`companion.day.${rel}`) : capitalize(formatShortDate(at, locale))
}

/** The same word inside a sentence: "amanhã", "ter 3 nov". */
export function dayWordInline(at: number, now: number, locale: string | undefined, t: TFunction): string {
  const rel = relative(at, now)
  return rel ? t(`companion.dayInline.${rel}`) : formatShortDate(at, locale)
}

/** The receipt's day line: "Amanhã, ter 3 nov", or "Ter 5 nov" past tomorrow. */
export function dayLine(at: number, now: number, locale: string | undefined, t: TFunction): string {
  const rel = relative(at, now)
  const date = formatShortDate(at, locale)
  return rel ? `${t(`companion.day.${rel}`)}, ${date}` : capitalize(date)
}

/** The needs-title chip: "amanhã, 14:00", or just "amanhã" for a day-precision date. */
export function chipLabel(
  at: number,
  precision: 'day' | 'minute',
  now: number,
  locale: string | undefined,
  t: TFunction
): string {
  const day = dayWordInline(at, now, locale, t)
  return precision === 'day' ? day : t('companion.when.dayTime', { day, time: formatTime(at, locale) })
}

/** Inside the question: "amanhã às 14:00", or "amanhã". */
export function whenPhrase(
  at: number,
  precision: 'day' | 'minute',
  now: number,
  locale: string | undefined,
  t: TFunction
): string {
  const day = dayWordInline(at, now, locale, t)
  return precision === 'day' ? day : t('companion.when.dayAt', { day, time: formatTime(at, locale) })
}

/** When a mute ends: "15:30" today, else "amanhã às 09:00". */
export function untilPhrase(at: number, now: number, locale: string | undefined, t: TFunction): string {
  return dayOffset(at, now) === 0 ? formatTime(at, locale) : whenPhrase(at, 'minute', now, locale, t)
}

/** A row's time column: the time today, else the day word ("Ontem", "Ter 3 nov"). */
export function rowWhen(at: number, now: number, locale: string | undefined, t: TFunction): string {
  return dayOffset(at, now) === 0 ? formatTime(at, locale) : dayWord(at, now, locale, t)
}

/** How late, coarsely: "25 min", "1 h", "2 d". Under a minute counts as one. */
export function lateSpan(minutes: number, t: TFunction): string {
  const m = Math.max(1, Math.round(minutes))
  if (m < 60) return t('companion.span.min', { n: m })
  if (m < 24 * 60) return t('companion.span.hour', { n: Math.floor(m / 60) })
  return t('companion.span.day', { n: Math.floor(m / (24 * 60)) })
}

/** `<input type="datetime-local">`'s value for an instant, in local time. */
export function toLocalInputValue(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The next whole hour at least 30 minutes away: the "Pick…" field's starting value. */
export function defaultPickTime(now: number): number {
  const d = new Date(now + 30 * 60_000)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}
