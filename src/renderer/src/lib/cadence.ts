import { ScheduledCadence } from '../types'

/**
 * How often a routine runs, in words.
 *
 * This lives in lib/ rather than in ScheduledView, which owned it first, because Home
 * shows the same sentence for the same routine and the two must not drift — a routine
 * described as "Daily at 03:00" on one screen and "Every 24 hours" on the other reads
 * as two different routines. Importing it from the view was not an option: ScheduledView
 * is lazy-loaded, and a static import from App would pull its whole chunk into the
 * initial bundle to get one function.
 */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]

export function cadenceSummary(cadence: ScheduledCadence): string {
  if (cadence.kind === 'interval') {
    const mins = cadence.everyMinutes
    if (mins < 60) return `Every ${mins} min`
    const h = mins / 60
    return `Every ${h % 1 === 0 ? h : h.toFixed(1)} hour${h !== 1 ? 's' : ''}`
  }
  if (cadence.kind === 'daily') return `Daily at ${cadence.time}`
  if (cadence.kind === 'weekly') return `Weekly · ${DAY_NAMES[cadence.day]} at ${cadence.time}`
  return 'Unknown cadence'
}
