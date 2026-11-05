/**
 * How Argos lands when he is let go above the floor (docs/COMPANION_PLAN.md §13.3, M4):
 * he drops under gravity, bounces once and sits. Pure, so companion-window.ts only has
 * to move the window along the curve each poll. Pixels are DIPs, like the rest.
 */

/** px/s². A 600 px drop takes half a second. */
export const FALL_GRAVITY = 4800

/** The bounce on landing: this high, this long. */
export const BOUNCE_PX = 6
export const BOUNCE_MS = 140

/** A drop shorter than this is not worth a fall: he is just put down. */
export const FALL_MIN_PX = 24

export interface Fall {
  /** The window's y when let go, and where it lands (toY > fromY). */
  fromY: number
  toY: number
}

/** Whether a landing this far below where he was let go is a fall. */
export function isFall(fromY: number, toY: number): boolean {
  return toY - fromY >= FALL_MIN_PX
}

/** Milliseconds from letting go to touching the floor. */
export function fallLandingMs(fall: Fall): number {
  const drop = Math.max(0, fall.toY - fall.fromY)
  return Math.sqrt((2 * drop) / FALL_GRAVITY) * 1000
}

/** The whole thing, bounce included. */
export function fallDurationMs(fall: Fall): number {
  return fallLandingMs(fall) + BOUNCE_MS
}

/**
 * The window's y this long after letting go: down the parabola until the floor, then a
 * short bounce up and back. `done` once he is still on the floor.
 */
export function fallY(fall: Fall, elapsedMs: number): { y: number; done: boolean } {
  const t = Math.max(0, elapsedMs) / 1000
  const y = fall.fromY + 0.5 * FALL_GRAVITY * t * t
  if (y < fall.toY) return { y: Math.round(y), done: false }
  const since = elapsedMs - fallLandingMs(fall)
  if (since >= BOUNCE_MS) return { y: fall.toY, done: true }
  return { y: Math.round(fall.toY - BOUNCE_PX * Math.sin((Math.PI * since) / BOUNCE_MS)), done: false }
}
