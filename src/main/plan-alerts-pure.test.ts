import { describe, it, expect } from 'vitest'
import { nextAlert, sameWindow, type AlertState } from './plan-alerts-pure'

const RESET = '2026-09-15T19:10:00.000000+00:00'
// The same reset as a later fetch reports it.
const RESET_JITTER = '2026-09-15T19:09:59.614221+00:00'
const NEXT_WINDOW = '2026-09-16T00:10:00.000000+00:00'

/** Feed a sequence of fetches through, collecting what would have been notified. */
function run(steps: [number, string | undefined][]): (number | null)[] {
  let state: AlertState | undefined
  return steps.map(([u, r]) => {
    const { notify, state: next } = nextAlert(state, u, r)
    state = next
    return notify
  })
}

describe('nextAlert', () => {
  it('notifies a window at 100% once, not once per refresh', () => {
    // The reported case: 89%, then 100% on every 10-minute refresh after it.
    expect(
      run([
        [89, RESET],
        [100, RESET_JITTER],
        [100, RESET],
        [100, RESET_JITTER]
      ])
    ).toEqual([85, 95, null, null])
  })

  it('sends one notification for the highest threshold crossed at once', () => {
    expect(run([[100, RESET]])).toEqual([95])
    expect(run([[70, RESET], [97, RESET], [99, RESET]])).toEqual([null, 95, null])
  })

  it('notifies again in the next window', () => {
    expect(run([[100, RESET], [100, RESET], [90, NEXT_WINDOW]])).toEqual([95, null, 85])
  })

  it('re-arms a threshold only after falling clearly below it', () => {
    expect(run([[96, RESET], [92, RESET], [96, RESET]])).toEqual([95, null, null])
    expect(run([[96, RESET], [88, RESET], [96, RESET]])).toEqual([95, null, 95])
  })

  it('does not re-notify a lower threshold it is still above', () => {
    expect(run([[96, RESET], [88, RESET], [89, RESET]])).toEqual([95, null, null])
  })

  it('does not drift out of the window one small change at a time', () => {
    const minutes = (m: number) => new Date(Date.parse(RESET) + m * 60_000).toISOString()
    expect(run([[100, RESET], [100, minutes(20)], [100, minutes(40)], [100, minutes(60)]])).toEqual([
      95,
      null,
      95,
      null
    ])
  })
})

describe('sameWindow', () => {
  it('treats a few seconds of difference as the same reset', () => {
    expect(sameWindow(RESET, RESET_JITTER)).toBe(true)
  })
  it('treats a rollover as a new window', () => {
    expect(sameWindow(RESET, NEXT_WINDOW)).toBe(false)
  })
  it('handles missing and unparseable values', () => {
    expect(sameWindow(undefined, undefined)).toBe(true)
    expect(sameWindow(RESET, undefined)).toBe(false)
    expect(sameWindow('garbage', RESET)).toBe(false)
  })
})
