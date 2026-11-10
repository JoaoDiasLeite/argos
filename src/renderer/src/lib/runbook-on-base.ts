/**
 * "Somar à base" (docs/BASE_INTERVENTION_PLAN.md §4), remembered per runbook folder in
 * this window's localStorage: on unless the operator turned it off for that runbook. The
 * start screen and the hand-over dialog share it, so a choice made in one holds in both.
 */

const KEY = 'ops.runbookOnBase'

const pathKey = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

function readAll(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/** Whether the runbook at `dir` runs added to the base; true when never chosen. */
export function readOnBase(dir: string): boolean {
  return readAll()[pathKey(dir)] !== false
}

export function writeOnBase(dir: string, on: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [pathKey(dir)]: on }))
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}
