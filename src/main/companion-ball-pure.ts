/**
 * Fetch (docs/COMPANION_PLAN.md §13.3, P2): a ball thrown along the floor, Argos running
 * after it and bringing it back. The ball's flight and where the game goes are pure;
 * companion-window.ts moves the two windows along them each poll. DIPs throughout.
 */
import { areaOf, walkLaneAcross } from './companion-walk-pure'
import type { Rect } from './companion-window-pure'

/** The ball window: a circle this big, drawn by the companion page's '#ball'. */
export const BALL_SIZE = 20

/** How far the ball goes along the floor, at most; cut at the lane's end. */
export const THROW_PX = 320
/** Shorter than this is not worth a throw. */
export const THROW_MIN_PX = 80

/** Flight time to the first touchdown, then two smaller bounces. */
export const FLIGHT_MS = 700
export const BOUNCE_MS = 260
/** The throw's peak, above the floor, and the bounces' as fractions of it. */
export const ARC_PX = 110
const BOUNCES = [0.35, 0.12]

export interface Throw {
  /** Where the ball leaves the dog (its window's top-left) and where it comes to rest. */
  fromX: number
  fromY: number
  toX: number
  /** The ball window's y on the floor. */
  floorY: number
  facing: 'left' | 'right'
}

/**
 * A throw from where the pet is: the way with more lane, THROW_PX or what the lane has.
 * The ball leaves at the dog's mouth height and lands on the floor. Null without the
 * room, or with the pet off the floor.
 */
export function planThrow(pet: Rect, areas: Rect[]): Throw | null {
  const home = areaOf(pet, areas)
  if (!home) return null
  const lane = walkLaneAcross(pet, areas)
  if (!lane) return null
  const fromX = Math.round(pet.x + pet.width / 2 - BALL_SIZE / 2)
  const roomLeft = Math.max(0, pet.x - lane.minX)
  const roomRight = Math.max(0, lane.maxX - pet.x)
  const facing = roomRight >= roomLeft ? 'right' : 'left'
  const room = facing === 'right' ? roomRight : roomLeft
  const distance = Math.min(THROW_PX, room)
  if (distance < THROW_MIN_PX) return null
  const floorY = Math.round(pet.y + pet.height - BALL_SIZE)
  return {
    fromX,
    fromY: Math.round(pet.y + pet.height * 0.45),
    toX: facing === 'right' ? fromX + distance : fromX - distance,
    floorY,
    facing
  }
}

/** The whole flight, bounces included. */
export function throwDurationMs(): number {
  return FLIGHT_MS + BOUNCES.length * BOUNCE_MS
}

/**
 * The ball's window position this long after the throw: an arc to the floor over
 * FLIGHT_MS covering most of the distance, then two bounces rolling the rest, then still.
 */
export function ballAt(t: Throw, elapsedMs: number): { x: number; y: number; done: boolean } {
  const total = throwDurationMs()
  const ms = Math.max(0, elapsedMs)
  if (ms >= total) return { x: t.toX, y: t.floorY, done: true }
  // The distance is covered at a steady pace all the way, so the bounces roll on.
  const x = t.fromX + (t.toX - t.fromX) * (ms / total)
  let y: number
  if (ms < FLIGHT_MS) {
    const p = ms / FLIGHT_MS
    // Up from the mouth, over the peak, down to the floor: a parabola through the three.
    const drop = t.floorY - t.fromY
    y = t.fromY + drop * p - ARC_PX * 4 * p * (1 - p)
  } else {
    const i = Math.floor((ms - FLIGHT_MS) / BOUNCE_MS)
    const p = ((ms - FLIGHT_MS) % BOUNCE_MS) / BOUNCE_MS
    y = t.floorY - ARC_PX * BOUNCES[i] * 4 * p * (1 - p)
  }
  return { x: Math.round(x), y: Math.round(y), done: false }
}

/** Where the pet window stands to pick the ball up: the ball under his mouth. */
export function fetchX(t: Throw, pet: Rect): number {
  return Math.round(t.facing === 'right' ? t.toX + BALL_SIZE / 2 - pet.width * 0.7 : t.toX + BALL_SIZE / 2 - pet.width * 0.3)
}
