/**
 * When and where Argos goes for a little walk (docs/COMPANION_PLAN.md §11, batch L), kept
 * apart from companion-window.ts so it can be tested without Electron. Coordinates are
 * DIPs of the virtual screen, like companion-window-pure.ts.
 *
 * Argos is a dog on the floor: he walks horizontally along the bottom of his display's
 * work area. snapToEdge() keeps the height a drop left him at, so he can also be docked
 * half way up a side edge; there he does not walk (planWalk() answers null) rather than
 * float along the wall or slide down it.
 */
import type { CompanionPetState } from './companion-types'
import { PET_MARGIN, PET_SIZE, type Rect } from './companion-window-pure'

/** A walk starts this long after the last one, or the last interaction, at random. */
export const WALK_MIN_DELAY_MS = 60_000
export const WALK_MAX_DELAY_MS = 3 * 60_000

/** How far one walk goes, at random within this range, unless a corner comes first. */
export const WALK_MIN_PX = 150
export const WALK_MAX_PX = 400

/**
 * Pixels per second. 40 keeps the feet roughly on the ground: four frames at 8 fps make
 * a stride of about 20 px, where 60 had him skating.
 */
export const WALK_SPEED = 40

/** He stands up this long before he sets off, and stands this long on arrival before sitting. */
export const WALK_STAND_MS = 400
export const WALK_ARRIVE_MS = 300

/** The window's bottom within this of the work area's bottom counts as on the floor. */
export const FLOOR_TOLERANCE = 40

export type Facing = 'left' | 'right'

/** Everything that can keep the dog sitting. Each must be "free" for a walk to start or go on. */
export interface WalkConditions {
  /** "Ficar no ecrã". */
  stayOnScreen: boolean
  /** "Passear pelo ecrã". */
  walkPref: boolean
  visible: boolean
  petState: CompanionPetState
  /** The bubble is up, in any mode. */
  bubbleOpen: boolean
  /** A reminder or catch-up is queued behind the bubble. */
  alertsPending: boolean
  dnd: boolean
  cursorOverPet: boolean
  dragging: boolean
  /** Dictation is recording or transcribing. */
  voiceBusy: boolean
  reducedMotion: boolean
}

/** Idle (or dozing: waking up for a stroll is fine), or already up for one. */
const WALKABLE_STATES: readonly CompanionPetState[] = ['idle', 'dozing', 'standing', 'walking']

export function canWalk(c: WalkConditions): boolean {
  return (
    c.stayOnScreen &&
    c.walkPref &&
    c.visible &&
    WALKABLE_STATES.includes(c.petState) &&
    !c.bubbleOpen &&
    !c.alertsPending &&
    !c.dnd &&
    !c.cursorOverPet &&
    !c.dragging &&
    !c.voiceBusy &&
    !c.reducedMotion
  )
}

/** Milliseconds to the next walk, uniformly in [1 min, 3 min]. `rng` returns [0, 1). */
export function nextWalkDelay(rng: () => number = Math.random): number {
  return Math.round(WALK_MIN_DELAY_MS + rng() * (WALK_MAX_DELAY_MS - WALK_MIN_DELAY_MS))
}

/** Whether a pet window at these bounds sits on the floor of the work area. */
export function onFloor(pet: Rect, workArea: Rect): boolean {
  const gap = workArea.y + workArea.height - (pet.y + pet.height)
  return gap >= 0 && gap <= FLOOR_TOLERANCE
}

/** The x range the window may occupy while walking: PET_MARGIN in from both sides. */
export function walkLane(workArea: Rect, size = PET_SIZE, margin = PET_MARGIN): { minX: number; maxX: number } {
  const minX = workArea.x + margin
  return { minX, maxX: Math.max(minX, workArea.x + workArea.width - size - margin) }
}

export interface WalkPlan {
  fromX: number
  toX: number
  facing: Facing
}

/**
 * One walk from where the pet is: 150–400 px, left or right at random. A direction
 * without the room goes the other way when that has more (so at a corner he turns
 * around), and the distance is cut at the corner either way, so the window never leaves
 * the lane. Null when he is not on the floor or has nowhere to go.
 */
export function planWalk(pet: Rect, workArea: Rect, rng: () => number = Math.random): WalkPlan | null {
  if (!onFloor(pet, workArea)) return null
  const { minX, maxX } = walkLane(workArea, pet.width)
  const fromX = Math.round(pet.x)
  const roomLeft = Math.max(0, fromX - minX)
  const roomRight = Math.max(0, maxX - fromX)
  const distance = Math.round(WALK_MIN_PX + rng() * (WALK_MAX_PX - WALK_MIN_PX))
  let facing: Facing = rng() < 0.5 ? 'left' : 'right'
  const room = (f: Facing): number => (f === 'left' ? roomLeft : roomRight)
  if (room(facing) < distance) {
    const other: Facing = facing === 'left' ? 'right' : 'left'
    if (room(other) > room(facing)) facing = other
  }
  const step = Math.min(distance, room(facing))
  if (step < 1) return null
  const toX = facing === 'left' ? fromX - step : fromX + step
  return { fromX, toX, facing }
}

/** `x` moved toward `target` by `speed` px/s over `dtMs`, never past it. */
export function stepToward(x: number, target: number, dtMs: number, speed = WALK_SPEED): number {
  const d = (speed * Math.max(0, dtMs)) / 1000
  if (Math.abs(target - x) <= d) return target
  return x + Math.sign(target - x) * d
}
