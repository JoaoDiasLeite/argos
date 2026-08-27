import { CCSessionMeta } from '../types'

/**
 * Ordering and date-grouping for the sessions list. Pure, so the boundaries can be
 * tested against fixed clocks instead of "whatever today happens to be".
 */

export type SortMode = 'date' | 'title' | 'size'

export const SORT_LABELS: Record<SortMode, string> = {
  date: 'Newest first',
  title: 'Title',
  size: 'Longest first'
}

export function sortSessions(sessions: CCSessionMeta[], mode: SortMode): CCSessionMeta[] {
  const out = [...sessions]
  switch (mode) {
    case 'title':
      // localeCompare so accented titles sort where a reader expects, not after Z.
      return out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    case 'size':
      return out.sort((a, b) => b.messageCount - a.messageCount || b.updatedAt - a.updatedAt)
    default:
      return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

export interface SessionGroup {
  label: string
  sessions: CCSessionMeta[]
}

/** Midnight at the start of the day `ts` falls in, in local time. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY = 86_400_000

/**
 * Split a date-ordered list into age bands.
 *
 * Boundaries are calendar days, not rolling 24-hour windows: something from 23:00
 * last night is "Yesterday" to a reader at 09:00, and calling it "Today" because it
 * is ten hours old would be wrong in the way that makes people distrust a label.
 *
 * Only meaningful for the date ordering — a date header over a title-sorted list
 * describes nothing, so the caller skips grouping there.
 */
export function groupByAge(sessions: CCSessionMeta[], now: number = Date.now()): SessionGroup[] {
  const today = startOfDay(now)
  const bands: { label: string; from: number }[] = [
    { label: 'Today', from: today },
    { label: 'Yesterday', from: today - DAY },
    { label: 'Last 7 days', from: today - 7 * DAY },
    { label: 'Last 30 days', from: today - 30 * DAY },
    { label: 'Older', from: -Infinity }
  ]

  const groups: SessionGroup[] = []
  for (const s of sessions) {
    const band = bands.find((b) => s.updatedAt >= b.from) ?? bands[bands.length - 1]
    const last = groups[groups.length - 1]
    // Appending to the last group rather than bucketing by label keeps the input
    // order intact and drops empty bands for free.
    if (last && last.label === band.label) last.sessions.push(s)
    else groups.push({ label: band.label, sessions: [s] })
  }
  return groups
}
