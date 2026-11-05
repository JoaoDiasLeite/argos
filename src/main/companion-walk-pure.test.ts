import { describe, expect, it } from 'vitest'
import {
  FLOOR_TOLERANCE,
  areaOf,
  neighbourArea,
  walkLaneAcross,
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
const FLOOR_Y = AREA.height - PET_SIZE.height - PET_MARGIN
const pet = (x: number, y = FLOOR_Y): Rect => ({ x, y, width: PET_SIZE.width, height: PET_SIZE.height })

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
    expect(onFloor(pet(0, AREA.height - PET_SIZE.height - FLOOR_TOLERANCE), AREA)).toBe(true)
    expect(onFloor(pet(0, AREA.height - PET_SIZE.height - FLOOR_TOLERANCE - 1), AREA)).toBe(false)
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
    const y = narrow.height - PET_SIZE.height - PET_MARGIN
    // 100 px of room on the left, 348 on the right.
    expect(planWalk(pet(lane.minX + 100, y), narrow, seq(0.999999, 0.9))).toEqual({
      fromX: lane.minX + 100,
      toX: lane.maxX,
      facing: 'right'
    })
    // Asked left for 400 with only 100 there: the 348 on the right instead.
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
        const p = planWalk(pet(x, area.y + area.height - PET_SIZE.height - PET_MARGIN), area)
        if (!p) continue
        expect(p.toX).toBeGreaterThanOrEqual(area.x)
        expect(p.toX + PET_SIZE.width).toBeLessThanOrEqual(area.x + area.width)
        expect(p.toX).toBeGreaterThanOrEqual(lane.minX)
        expect(p.toX).toBeLessThanOrEqual(lane.maxX)
      }
    }
  })

  it('has nowhere to go on a display only as wide as the pet', () => {
    const tiny: Rect = { x: 0, y: 0, width: PET_SIZE.width + 2 * PET_MARGIN, height: 600 }
    expect(planWalk(pet(PET_MARGIN, 600 - PET_SIZE.height - PET_MARGIN), tiny, () => 0.5)).toBeNull()
  })
})

describe('walking across displays', () => {
  const W = PET_SIZE.width
  const H = PET_SIZE.height
  // Beside AREA (bottom at 1040): a display whose floor lines up, one lower, one higher, and one not touching.
  const RIGHT_ALIGNED: Rect = { x: 1920, y: 56, width: 1280, height: 984 }
  const RIGHT_LOWER: Rect = { x: 1920, y: 0, width: 1280, height: 1440 }
  const RIGHT_HIGHER: Rect = { x: 1920, y: 0, width: 1280, height: 800 }
  const RIGHT_GAP: Rect = { x: 2000, y: 0, width: 1280, height: 1040 }
  const LEFT_ALIGNED: Rect = { x: -1280, y: 56, width: 1280, height: 984 }

  it('finds the display under the pet, or the nearest', () => {
    expect(areaOf(pet(800), [AREA, RIGHT_ALIGNED])).toBe(AREA)
    expect(areaOf(pet(2000), [AREA, RIGHT_ALIGNED])).toBe(RIGHT_ALIGNED)
    expect(areaOf(pet(5000), [AREA, RIGHT_ALIGNED])).toBe(RIGHT_ALIGNED)
    expect(areaOf(pet(0), [])).toBeNull()
  })

  it('knows a neighbour from a display that does not touch', () => {
    expect(neighbourArea(AREA, [AREA, RIGHT_ALIGNED], 'right')).toBe(RIGHT_ALIGNED)
    expect(neighbourArea(AREA, [AREA, RIGHT_GAP], 'right')).toBeNull()
    expect(neighbourArea(AREA, [AREA, LEFT_ALIGNED], 'left')).toBe(LEFT_ALIGNED)
    expect(neighbourArea(AREA, [AREA, LEFT_ALIGNED], 'right')).toBeNull()
  })

  it('extends the lane over neighbours whose floors line up, both ways', () => {
    const lane = walkLaneAcross(pet(800), [LEFT_ALIGNED, AREA, RIGHT_ALIGNED])!
    expect(lane).toEqual({ minX: -1280 + PET_MARGIN, maxX: 3200 - W - PET_MARGIN, leftDrop: null, rightDrop: null })
    // From AREA's own corner he walks straight on into the next display.
    const corner = walkLane(AREA).maxX
    expect(planWalk(pet(corner), [AREA, RIGHT_ALIGNED], seq(0.5, 0.9))).toEqual({ fromX: corner, toX: corner + 275, facing: 'right' })
  })

  it('walks to the edge of a lower neighbour and drops onto its floor', () => {
    const lane = walkLaneAcross(pet(800), [AREA, RIGHT_LOWER])!
    expect(lane.maxX).toBe(walkLane(AREA).maxX)
    expect(lane.rightDrop).toEqual({ atX: 1920 - W / 2, toY: 1440 - H - PET_MARGIN })
    // 80 px of lane left on the right and asked for 400 that way: over the edge he goes.
    expect(planWalk(pet(1700), [AREA, RIGHT_LOWER], seq(0.999999, 0.9))).toEqual({
      fromX: 1700,
      toX: 1920 - W / 2,
      facing: 'right',
      dropTo: 1440 - H - PET_MARGIN
    })
    // With the room, an ordinary walk that way.
    expect(planWalk(pet(800), [AREA, RIGHT_LOWER], seq(0, 0.9))).toEqual({ fromX: 800, toX: 800 + WALK_MIN_PX, facing: 'right' })
  })

  it('turns around at a higher neighbour, and at a gap', () => {
    const corner = walkLane(AREA).maxX
    for (const other of [RIGHT_HIGHER, RIGHT_GAP]) {
      expect(walkLaneAcross(pet(corner), [AREA, other])).toEqual({ minX: PET_MARGIN, maxX: corner, leftDrop: null, rightDrop: null })
      expect(planWalk(pet(corner), [AREA, other], seq(0.5, 0.9))).toEqual({ fromX: corner, toX: corner - 275, facing: 'left' })
    }
  })

  it('only walks from the floor of the display he is on', () => {
    // On RIGHT_LOWER's floor, not AREA's: the lane is RIGHT_LOWER's, and AREA is a wall above.
    const y = 1440 - H - PET_MARGIN
    const lane = walkLaneAcross(pet(2000, y), [AREA, RIGHT_LOWER])!
    expect(lane).toEqual({ minX: 1920 + PET_MARGIN, maxX: 3200 - W - PET_MARGIN, leftDrop: null, rightDrop: null })
    expect(planWalk(pet(2000, AREA.height - H - PET_MARGIN), [AREA, RIGHT_LOWER])).toBeNull()
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
