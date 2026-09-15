/**
 * When a plan window deserves a limit notification, and when it has already had one.
 *
 * Kept out of plan-usage.ts so the rule can be tested without Electron. The earlier
 * version latched each threshold separately and re-armed on any change to the
 * `resets_at` string, which misfired twice over: the string differs between fetches
 * for the same window, so every 10-minute refresh re-armed everything, and a window
 * past both thresholds then fired one notification per threshold, identical text.
 */

export const THRESHOLDS = [85, 95] as const

/**
 * Resets closer than this belong to the same window. The shortest window is five
 * hours, so a real rollover moves the reset by hours; anything within half an hour
 * is the same reset reported slightly differently.
 */
export const SAME_WINDOW_TOLERANCE_MS = 30 * 60_000

/** Utilization has to fall this far below a threshold before it can notify again. */
export const HYSTERESIS = 5

export interface AlertState {
  /** Highest threshold already notified in this window; 0 for none. */
  notified: number
  resetsAt?: string
}

export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
  return Math.abs(ta - tb) < SAME_WINDOW_TOLERANCE_MS
}

/**
 * The threshold to notify for now (or null), and the state to keep.
 *
 * At most one notification per call, for the highest threshold crossed — jumping
 * from 80% to 100% says "95%" once rather than "85%" and "95%" together.
 */
export function nextAlert(
  prev: AlertState | undefined,
  utilization: number,
  resetsAt: string | undefined
): { notify: number | null; state: AlertState } {
  let notified = prev && sameWindow(prev.resetsAt, resetsAt) ? prev.notified : 0
  // Falling back well below what was notified lets that threshold fire again on the
  // next climb, without forgetting a lower one it is still above.
  while (notified > 0 && utilization < notified - HYSTERESIS) {
    notified = [...THRESHOLDS].reverse().find((t) => t < notified) ?? 0
  }
  const crossed = [...THRESHOLDS].reverse().find((t) => utilization >= t) ?? 0
  // Keep the first resetsAt seen for the window, so a slow drift in the reported
  // value cannot walk out of the tolerance one fetch at a time.
  const keptReset = prev && sameWindow(prev.resetsAt, resetsAt) ? prev.resetsAt : resetsAt
  if (crossed > notified) {
    return { notify: crossed, state: { notified: crossed, resetsAt: keptReset } }
  }
  return { notify: null, state: { notified, resetsAt: keptReset } }
}
