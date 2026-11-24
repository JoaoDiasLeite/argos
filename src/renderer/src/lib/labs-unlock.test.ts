import { describe, expect, it } from 'vitest'
import { HINT_FROM, NO_TAPS, UNLOCK_TAPS, UNLOCK_WINDOW_MS, tapVersion, type TapResult } from './labs-unlock'

/** Taps at the given times, one after the other; the result of each. */
function tapAt(times: number[]): TapResult[] {
  let state = NO_TAPS
  return times.map((now) => {
    const r = tapVersion(state, now)
    state = r.state
    return r
  })
}

describe('tapVersion', () => {
  it('unlocks on the seventh tap inside the window', () => {
    const results = tapAt([0, 100, 200, 300, 400, 500, 600])
    expect(results.slice(0, 6).every((r) => !r.unlocked)).toBe(true)
    expect(results[6].unlocked).toBe(true)
    expect(UNLOCK_TAPS).toBe(7)
  })

  it('says how many are left from the fourth tap on', () => {
    const results = tapAt([0, 100, 200, 300, 400, 500])
    expect(results.map((r) => r.remaining)).toEqual([null, null, null, 3, 2, 1])
    expect(HINT_FROM).toBe(4)
  })

  it('forgets taps older than the window', () => {
    const late = 500 + UNLOCK_WINDOW_MS
    const results = tapAt([0, 100, 200, 300, 400, 500, late])
    // Measured against the last tap, 0..500 are all older than the window by then.
    expect(results[6].unlocked).toBe(false)
    expect(results[6].remaining).toBeNull()
  })

  it('keeps the taps that are still inside the window', () => {
    const results = tapAt([0, 1000, 1100, 1200, 1300, 1400, UNLOCK_WINDOW_MS + 500])
    // The tap at 0 has expired, the other five still count, so this is the sixth.
    expect(results[6].unlocked).toBe(false)
    expect(results[6].remaining).toBe(1)
  })

  it('starts again after unlocking', () => {
    const results = tapAt([0, 1, 2, 3, 4, 5, 6, 7])
    expect(results[6].unlocked).toBe(true)
    expect(results[7].unlocked).toBe(false)
    expect(results[7].state.taps).toEqual([7])
  })
})
