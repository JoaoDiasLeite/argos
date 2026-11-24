// The hidden way into the experimental features: tapping the version in Settings, About,
// seven times within a few seconds. Pure, so the counting can be tested on its own.

/** Taps needed to reveal the switch. */
export const UNLOCK_TAPS = 7
/** All of them within this long. */
export const UNLOCK_WINDOW_MS = 4000
/** From this many taps on, a hint says how many are left. */
export const HINT_FROM = 4

export interface TapState {
  /** When each tap still counting happened, oldest first. */
  taps: number[]
}

export interface TapResult {
  state: TapState
  /** This tap was the last one needed: show the switch. */
  unlocked: boolean
  /** Taps still needed, once the hint is due; null before that and on unlock. */
  remaining: number | null
}

export const NO_TAPS: TapState = { taps: [] }

/** One tap at `now`: taps older than the window stop counting, and the seventh unlocks
 *  (and starts the count again). */
export function tapVersion(state: TapState, now: number): TapResult {
  const taps = [...state.taps.filter((at) => now - at < UNLOCK_WINDOW_MS && at <= now), now]
  if (taps.length >= UNLOCK_TAPS) return { state: NO_TAPS, unlocked: true, remaining: null }
  return {
    state: { taps },
    unlocked: false,
    remaining: taps.length >= HINT_FROM ? UNLOCK_TAPS - taps.length : null
  }
}
