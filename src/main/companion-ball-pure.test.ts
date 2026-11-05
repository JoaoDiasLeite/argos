import { describe, expect, it } from 'vitest'
import { BALL_SIZE, FLIGHT_MS, THROW_MIN_PX, THROW_PX, ballAt, fetchX, planThrow, throwDurationMs } from './companion-ball-pure'
import { PET_MARGIN, PET_SIZE, defaultPetPosition, type Rect } from './companion-window-pure'

const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const FLOOR_Y = AREA.height - PET_SIZE.height - PET_MARGIN
const pet = (x: number, y = FLOOR_Y): Rect => ({ x, y, width: PET_SIZE.width, height: PET_SIZE.height })

describe('planThrow', () => {
  it('throws the roomier way, the full distance when there is room', () => {
    const t = planThrow(pet(800), [AREA])!
    expect(t.facing).toBe('right')
    expect(t.toX - t.fromX).toBe(THROW_PX)
    expect(t.floorY).toBe(FLOOR_Y + PET_SIZE.height - BALL_SIZE)
    expect(t.fromY).toBeLessThan(t.floorY)
    expect(planThrow(pet(1500), [AREA])!.facing).toBe('left')
  })

  it('is cut at the lane end, and nothing in a corner without room', () => {
    const d = defaultPetPosition(AREA)
    const t = planThrow(pet(d.x, d.y), [AREA])!
    expect(t.facing).toBe('left')
    expect(t.fromX - t.toX).toBe(THROW_PX)
    const tight: Rect = { x: 0, y: 0, width: PET_SIZE.width + 2 * PET_MARGIN + THROW_MIN_PX - 1, height: 1040 }
    expect(planThrow(pet(PET_MARGIN), [tight])).toBeNull()
  })
})

describe('ballAt', () => {
  const t = planThrow(pet(800), [AREA])!

  it('leaves the mouth, peaks above it, lands on the floor and stops at the end', () => {
    expect(ballAt(t, 0)).toEqual({ x: t.fromX, y: t.fromY, done: false })
    expect(ballAt(t, FLIGHT_MS / 2).y).toBeLessThan(t.fromY)
    expect(ballAt(t, FLIGHT_MS).y).toBe(t.floorY)
    expect(ballAt(t, throwDurationMs())).toEqual({ x: t.toX, y: t.floorY, done: true })
  })

  it('never goes below the floor and always moves toward the landing', () => {
    let last = t.fromX
    for (let ms = 0; ms <= throwDurationMs(); ms += 16) {
      const b = ballAt(t, ms)
      expect(b.y).toBeLessThanOrEqual(t.floorY)
      expect(b.x).toBeGreaterThanOrEqual(last)
      last = b.x
    }
  })
})

describe('fetchX', () => {
  it('puts the dog beside the ball, on the side he came from', () => {
    const t = planThrow(pet(800), [AREA])!
    expect(fetchX(t, pet(800))).toBeLessThan(t.toX)
    const back = planThrow(pet(1500), [AREA])!
    expect(fetchX(back, pet(1500))).toBeGreaterThan(back.toX - PET_SIZE.width / 2)
  })
})
