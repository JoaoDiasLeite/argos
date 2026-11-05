/**
 * A routine for the day (docs/COMPANION_PLAN.md §13.3, U2): a stretch when the morning
 * hour comes round, a yawn at six, and from ten at night until the morning hour he lies
 * down to sleep instead of dozing. Pure: the clock rules, tested without Electron.
 */

/** The yawn, and when the night starts; the night ends at the companion's morning hour. */
export const YAWN_HOUR = 18
export const NIGHT_HOUR = 22

/** A moment lasts this long after the hour: idle at any point in it, and he does the thing. */
export const ROUTINE_WINDOW_MS = 5 * 60_000

/** How long the stretch or the yawn is held before he sits back down. */
export const ROUTINE_POSE_MS = 3000

export type RoutineMoment = 'stretch' | 'yawn'

/** From NIGHT_HOUR until the morning hour: he sleeps rather than dozes. */
export function isNight(now: number, morningHour: number): boolean {
  const h = new Date(now).getHours()
  return h >= NIGHT_HOUR || h < morningHour
}

/** The stretch in the five minutes after the morning hour, the yawn after six; else nothing. */
export function routineMoment(now: number, morningHour: number): RoutineMoment | null {
  const d = new Date(now)
  const sinceHour = (d.getMinutes() * 60 + d.getSeconds()) * 1000 + d.getMilliseconds()
  if (sinceHour >= ROUTINE_WINDOW_MS) return null
  if (d.getHours() === morningHour) return 'stretch'
  if (d.getHours() === YAWN_HOUR) return 'yawn'
  return null
}

/** The local day, to do each moment once a day. */
export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
