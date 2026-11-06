/**
 * When and where Argos goes for a little walk (docs/COMPANION_PLAN.md §11, batch L; §13.1
 * for other screens), kept apart from companion-window.ts so it can be tested without
 * Electron. Coordinates are DIPs of the virtual screen, like companion-window-pure.ts.
 *
 * Argos is a dog on the floor: he walks horizontally along the bottom of the work area,
 * and on into a neighbouring display whose floor lines up with his. Where the neighbour's
 * floor is lower he walks to the edge and drops onto it; where it is higher, or there is
 * no neighbour, he turns around. snapToEdge() keeps the height a drop left him at, so he
 * can also be docked half way up a side edge; there he does not walk (planWalk() answers
 * null) rather than float along the wall or slide down it.
 */
import type { CompanionPetState } from './companion-types'
import { PET_MARGIN, PET_SIZE, sideBleed, type Rect } from './companion-window-pure'

/** A walk starts this long after the last one, or the last interaction, at random. */
export const WALK_MIN_DELAY_MS = 60_000
export const WALK_MAX_DELAY_MS = 3 * 60_000

/** How far one walk goes, at random within this range, unless a corner comes first. */
export const WALK_MIN_PX = 150
export const WALK_MAX_PX = 400

/**
 * Pixels per second. 40 keeps the feet roughly on the ground: six frames at 8 fps make
 * a stride of 30 px, where 60 had him skating.
 */
export const WALK_SPEED = 40

/** Running (plan §13.1): three and a half times the walk, 1920 px in about 14 s. */
export const RUN_SPEED = 140

export type Gait = 'walk' | 'run'

export const speedOf = (gait: Gait): number => (gait === 'run' ? RUN_SPEED : WALK_SPEED)

/** A lap of joy after a "done" (plan §13.1): this far, one time in four. */
export const LAP_PX = 200
export const LAP_CHANCE = 0.25

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
const WALKABLE_STATES: readonly CompanionPetState[] = ['idle', 'dozing', 'standing', 'walking', 'running']

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

/**
 * The x range the window may occupy while walking: PET_MARGIN in from both sides, the
 * window hanging past them by its transparent strip (sideBleed) so the dog reaches them.
 */
export function walkLane(workArea: Rect, width = PET_SIZE.width, margin = PET_MARGIN): { minX: number; maxX: number } {
  const bleed = sideBleed({ width })
  const minX = workArea.x + margin - bleed
  return { minX, maxX: Math.max(minX, workArea.x + workArea.width - width - margin + bleed) }
}

// ─── Across displays (plan §13.1) ──────────────────────────────────────────────

/** Two displays count as side by side when one starts where the other ends, within this. */
export const ADJACENT_TOLERANCE = 2

/** The window's y when it sits on the floor of this work area. */
export function floorY(area: Rect, height: number, margin = PET_MARGIN): number {
  return area.y + area.height - height - margin
}

/** The work area under the window's centre, else the nearest to it; null with none at all. */
export function areaOf(pet: Rect, areas: Rect[]): Rect | null {
  const cx = pet.x + pet.width / 2
  const cy = pet.y + pet.height / 2
  let best: Rect | null = null
  let bestD = Infinity
  for (const a of areas) {
    if (cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) return a
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width))
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height))
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

/** The display touching `area` on that side and overlapping it vertically, if any. */
export function neighbourArea(area: Rect, areas: Rect[], side: Facing): Rect | null {
  const edge = side === 'right' ? area.x + area.width : area.x
  for (const b of areas) {
    if (b === area) continue
    const bEdge = side === 'right' ? b.x : b.x + b.width
    if (Math.abs(bEdge - edge) > ADJACENT_TOLERANCE) continue
    const overlap = Math.min(area.y + area.height, b.y + b.height) - Math.max(area.y, b.y)
    if (overlap > 0) return b
  }
  return null
}

/** Where a lane ends at a lower neighbour: he walks on until his centre is over the edge, then falls. */
export interface Drop {
  /** The window's x with its centre on the boundary. */
  atX: number
  /** The window's y on the floor he lands on. */
  toY: number
}

export interface Lane {
  minX: number
  maxX: number
  leftDrop: Drop | null
  rightDrop: Drop | null
}

/**
 * The lane from the pet's display out to each side, over every neighbour whose floor is
 * within FLOOR_TOLERANCE of his. A neighbour with a lower floor ends the lane with a drop;
 * a higher one, or none, is a wall. Null when no display is under him.
 */
export function walkLaneAcross(pet: Rect, areas: Rect[], margin = PET_MARGIN): Lane | null {
  const home = areaOf(pet, areas)
  if (!home) return null
  const floor = floorY(home, pet.height, margin)
  const reach = (side: Facing): { end: Rect; drop: Drop | null } => {
    const seen = new Set<Rect>([home])
    let cur = home
    for (;;) {
      const next = neighbourArea(cur, areas, side)
      if (!next || seen.has(next)) return { end: cur, drop: null }
      const diff = floorY(next, pet.height, margin) - floor
      if (Math.abs(diff) <= FLOOR_TOLERANCE) {
        seen.add(next)
        cur = next
        continue
      }
      if (diff > 0) {
        const boundary = side === 'right' ? cur.x + cur.width : cur.x
        return { end: cur, drop: { atX: Math.round(boundary - pet.width / 2), toY: floorY(next, pet.height, margin) } }
      }
      return { end: cur, drop: null }
    }
  }
  const l = reach('left')
  const r = reach('right')
  // The window hangs past the ends (sideBleed) so the dog reaches them.
  const bleed = sideBleed(pet)
  const minX = l.end.x + margin - bleed
  return { minX, maxX: Math.max(minX, r.end.x + r.end.width - pet.width - margin + bleed), leftDrop: l.drop, rightDrop: r.drop }
}

export interface WalkPlan {
  fromX: number
  toX: number
  facing: Facing
  /** Walking unless said otherwise. */
  gait?: Gait
  /** Set when the walk ends over the edge of a lower neighbour: the window's y to fall to. */
  dropTo?: number
}

/**
 * A run toward an x along the lane: as far as the lane goes that way, or over the edge of
 * a lower neighbour when the target lies beyond it. Null when he is not on the floor,
 * has nowhere to go, or is there already.
 */
export function planRunTo(pet: Rect, areas: Rect[], targetX: number): WalkPlan | null {
  const home = areaOf(pet, areas)
  if (!home || !onFloor(pet, home)) return null
  const lane = walkLaneAcross(pet, areas)
  if (!lane) return null
  const fromX = Math.round(pet.x)
  const facing: Facing = targetX < fromX ? 'left' : 'right'
  const drop = facing === 'left' ? lane.leftDrop : lane.rightDrop
  if (drop && (facing === 'left' ? targetX < lane.minX : targetX > lane.maxX)) {
    return { fromX, toX: drop.atX, facing, gait: 'run', dropTo: drop.toY }
  }
  const toX = Math.round(Math.min(lane.maxX, Math.max(lane.minX, targetX)))
  if (Math.abs(toX - fromX) < 1) return null
  return { fromX, toX, facing, gait: 'run' }
}

/** A lap after a "done": LAP_PX the way with more room, at a run; null without the room for half of it. */
export function planLap(pet: Rect, areas: Rect[], rng: () => number = Math.random): WalkPlan | null {
  if (rng() >= LAP_CHANCE) return null
  const home = areaOf(pet, areas)
  if (!home || !onFloor(pet, home)) return null
  const lane = walkLaneAcross(pet, areas)
  if (!lane) return null
  const fromX = Math.round(pet.x)
  const roomLeft = Math.max(0, fromX - lane.minX)
  const roomRight = Math.max(0, lane.maxX - fromX)
  const facing: Facing = roomRight >= roomLeft ? 'right' : 'left'
  const step = Math.min(LAP_PX, facing === 'right' ? roomRight : roomLeft)
  if (step < LAP_PX / 2) return null
  return { fromX, toX: facing === 'right' ? fromX + step : fromX - step, facing, gait: 'run' }
}

/**
 * One walk from where the pet is: 150–400 px, left or right at random, along the lane
 * across the displays whose floors line up. A direction without the room goes the other
 * way when that has more (so at a wall he turns around), unless that way ends over a lower
 * display: then he walks to the edge and drops. The distance is cut at the wall either
 * way, so the window never leaves the lane. Null when he is not on the floor or has
 * nowhere to go.
 */
export function planWalk(pet: Rect, areas: Rect | Rect[], rng: () => number = Math.random): WalkPlan | null {
  const list = Array.isArray(areas) ? areas : [areas]
  const home = areaOf(pet, list)
  if (!home || !onFloor(pet, home)) return null
  const lane = walkLaneAcross(pet, list)
  if (!lane) return null
  const fromX = Math.round(pet.x)
  const roomLeft = Math.max(0, fromX - lane.minX)
  const roomRight = Math.max(0, lane.maxX - fromX)
  const distance = Math.round(WALK_MIN_PX + rng() * (WALK_MAX_PX - WALK_MIN_PX))
  let facing: Facing = rng() < 0.5 ? 'left' : 'right'
  const room = (f: Facing): number => (f === 'left' ? roomLeft : roomRight)
  const drop = (f: Facing): Drop | null => (f === 'left' ? lane.leftDrop : lane.rightDrop)
  if (room(facing) < distance) {
    const d = drop(facing)
    if (d) return { fromX, toX: d.atX, facing, dropTo: d.toY }
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
