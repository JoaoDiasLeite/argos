import { describe, expect, it } from 'vitest'
import {
  FLOOR_TOLERANCE,
  WALK_MAX_DELAY_MS,
  WALK_MAX_PX,
  WALK_MIN_DELAY_MS,
  WALK_MIN_PX,
  canWalk,
  nextWalkDelay,
  onFloor,
  planWalk,
  stepToward,
  walkLane,
  type WalkConditions
} from './companion-walk-pure'
import { PET_MARGIN, PET_SIZE, defaultPetPosition, snapToEdge, type Rect } from './companion-window-pure'

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const FLOOR_Y = AREA.height - PET_SIZE - PET_MARGIN
const pet = (x: number, y = FLOOR_Y): Rect => ({ x, y, width: PET_SIZE, height: PET_SIZE })

/** An rng that returns the given values in turn (then repeats the last). */
const seq =
  (...values: number[]) =>
  (): number =>
    values.length > 1 ? (values.shift() as number) : values[0]

const FREE: WalkConditions = {
  stayOnScreen: true,
  walkPref: true,
  visible: true,
  petState: 'idle',
  bubbleOpen: false,
  alertsPending: false,
  dnd: false,
  cursorOverPet: false,
  dragging: false,
  voiceBusy: false,
  reducedMotion: false
}

describe('canWalk', () => {
  it('walks when idle, dozing or already walking and nothing says sit', () => {
    expect(canWalk(FREE)).toBe(true)
    expect(canWalk({ ...FREE, petState: 'dozing' })).toBe(true)
    expect(canWalk({ ...FREE, petState: 'walking' })).toBe(true)
  })

  it.each<[string, Partial<WalkConditions>]>([
    ['stay on screen is off', { stayOnScreen: false }],
    ['the walk pref is off', { walkPref: false }],
    ['the pet is hidden', { visible: false }],
    ['the bubble is open', { bubbleOpen: true }],
    ['an alert is queued', { alertsPending: true }],
    ['do not disturb is on', { dnd: true }],
    ['the cursor is over the pet', { cursorOverPet: true }],
    ['a drag is under way', { dragging: true }],
    ['dictation is busy', { voiceBusy: true }],
    ['reduced motion is set', { reducedMotion: true }]
  ])('never when %s', (_, change) => {
    expect(canWalk({ ...FREE, ...change })).toBe(false)
  })

  it.each(['listening', 'thinking', 'talking', 'alert', 'happy', 'shh'] as const)('never while %s', (petState) => {
    expect(canWalk({ ...FREE, petState })).toBe(false)
  })
})

describe('nextWalkDelay', () => {
  it('is 3 to 8 minutes, set by the rng', () => {
    expect(nextWalkDelay(() => 0)).toBe(WALK_MIN_DELAY_MS)
    expect(nextWalkDelay(() => 0.999999)).toBeLessThanOrEqual(WALK_MAX_DELAY_MS)
    expect(nextWalkDelay(() => 0.5)).toBe((WALK_MIN_DELAY_MS + WALK_MAX_DELAY_MS) / 2)
    for (let i = 0; i < 200; i++) {
      const d = nextWalkDelay()
      expect(d).toBeGreaterThanOrEqual(WALK_MIN_DELAY_MS)
      expect(d).toBeLessThanOrEqual(WALK_MAX_DELAY_MS)
    }
  })
})

describe('onFloor', () => {
  it('is the default corner and anything within the tolerance of the bottom', () => {
    const d = defaultPetPosition(AREA)
    expect(onFloor(pet(d.x, d.y), AREA)).toBe(true)
    expect(onFloor(pet(0, AREA.height - PET_SIZE - FLOOR_TOLERANCE), AREA)).toBe(true)
    expect(onFloor(pet(0, AREA.height - PET_SIZE - FLOOR_TOLERANCE - 1), AREA)).toBe(false)
  })

  it('is not a pet docked half way up a side edge', () => {
    const docked = snapToEdge({ x: 30, y: 300 }, AREA)
    expect(onFloor(pet(docked.x, docked.y), AREA)).toBe(false)
    expect(planWalk(pet(docked.x, docked.y), AREA, () => 0.5)).toBeNull()
  })

  it('works on a display that is not at the origin', () => {
    const area: Rect = { x: 1920, y: -200, width: 1280, height: 984 }
    const d = defaultPetPosition(area)
    expect(onFloor(pet(d.x, d.y), area)).toBe(true)
  })
})

describe('planWalk', () => {
  const { minX, maxX } = walkLane(AREA)

  it('is deterministic for an injected rng', () => {
    const a = planWalk(pet(800), AREA, seq(0.3, 0.7))
    const b = planWalk(pet(800), AREA, seq(0.3, 0.7))
    expect(a).toEqual(b)
    expect(a).toEqual({ fromX: 800, toX: 800 + 225, facing: 'right' })
  })

  it('walks 150 to 400 px when there is room, in the direction the rng picks', () => {
    expect(planWalk(pet(800), AREA, seq(0, 0.2))).toEqual({ fromX: 800, toX: 800 - WALK_MIN_PX, facing: 'left' })
    expect(planWalk(pet(800), AREA, seq(0.999999, 0.8))).toEqual({ fromX: 800, toX: 800 + WALK_MAX_PX, facing: 'right' })
    for (let i = 0; i < 300; i++) {
      const p = planWalk(pet(800), AREA)!
      const d = Math.abs(p.toX - p.fromX)
      expect(d).toBeGreaterThanOrEqual(WALK_MIN_PX)
      expect(d).toBeLessThanOrEqual(WALK_MAX_PX)
    }
  })

  it('faces the way it goes', () => {
    for (let i = 0; i < 100; i++) {
      const p = planWalk(pet(900), AREA)!
      expect(p.facing).toBe(p.toX < p.fromX ? 'left' : 'right')
    }
  })

  it('turns around at the right corner', () => {
    const d = defaultPetPosition(AREA)
    expect(d.x).toBe(maxX)
    // The rng asks for right; there is no room, so he goes left.
    expect(planWalk(pet(d.x, d.y), AREA, seq(0.5, 0.9))).toEqual({ fromX: maxX, toX: maxX - 275, facing: 'left' })
  })

  it('turns around at the left corner', () => {
    expect(planWalk(pet(minX), AREA, seq(0.5, 0.1))).toEqual({ fromX: minX, toX: minX + 275, facing: 'right' })
  })

  it('stops at the corner when the room is shorter than the walk but more than the other way', () => {
    // 100 px from the right corner, 1588 px from the left: asked right for 400, it goes left.
    const p = planWalk(pet(maxX - 100), AREA, seq(0.999999, 0.9))!
    expect(p.facing).toBe('left')
    // On a narrow display both sides are short: the longer one, cut at the corner.
    const narrow: Rect = { x: 0, y: 0, width: 600, height: 800 }
    const lane = walkLane(narrow)
    const y = narrow.height - PET_SIZE - PET_MARGIN
    // 100 px of room on the left, 256 on the right.
    expect(planWalk(pet(lane.minX + 100, y), narrow, seq(0.999999, 0.9))).toEqual({
      fromX: lane.minX + 100,
      toX: lane.maxX,
      facing: 'right'
    })
    // Asked left for 400 with only 100 there: the 256 on the right instead.
    expect(planWalk(pet(lane.minX + 100, y), narrow, seq(0.999999, 0.1))).toEqual({
      fromX: lane.minX + 100,
      toX: lane.maxX,
      facing: 'right'
    })
  })

  it('never leaves the work area', () => {
    for (const area of [AREA, { x: -1280, y: 0, width: 1280, height: 1024 }, { x: 0, y: 0, width: 520, height: 700 }]) {
      const lane = walkLane(area)
      for (let i = 0; i < 300; i++) {
        const x = lane.minX + Math.round(Math.random() * (lane.maxX - lane.minX))
        const p = planWalk(pet(x, area.y + area.height - PET_SIZE - PET_MARGIN), area)
        if (!p) continue
        expect(p.toX).toBeGreaterThanOrEqual(area.x)
        expect(p.toX + PET_SIZE).toBeLessThanOrEqual(area.x + area.width)
        expect(p.toX).toBeGreaterThanOrEqual(lane.minX)
        expect(p.toX).toBeLessThanOrEqual(lane.maxX)
      }
    }
  })

  it('has nowhere to go on a display only as wide as the pet', () => {
    const tiny: Rect = { x: 0, y: 0, width: PET_SIZE + 2 * PET_MARGIN, height: 600 }
    expect(planWalk(pet(PET_MARGIN, 600 - PET_SIZE - PET_MARGIN), tiny, () => 0.5)).toBeNull()
  })
})

describe('stepToward', () => {
  it('moves 40 px/s in either direction', () => {
    expect(stepToward(100, 400, 1000)).toBe(140)
    expect(stepToward(100, 0, 500)).toBe(80)
    expect(stepToward(100, 400, 33)).toBeCloseTo(101.32)
  })

  it('never goes past the target and stays there', () => {
    expect(stepToward(395, 400, 1000)).toBe(400)
    expect(stepToward(5, 0, 1000)).toBe(0)
    expect(stepToward(400, 400, 1000)).toBe(400)
  })

  it('ignores a negative time step', () => {
    expect(stepToward(100, 400, -50)).toBe(100)
  })
})
