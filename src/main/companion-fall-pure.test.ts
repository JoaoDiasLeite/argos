import { describe, expect, it } from 'vitest'
import { BOUNCE_MS, BOUNCE_PX, FALL_MIN_PX, fallDurationMs, fallLandingMs, fallY, isFall } from './companion-fall-pure'

const fall = { fromY: 200, toY: 800 }

describe('isFall', () => {
  it('is a fall from the minimum height on, and a put-down below it', () => {
    expect(isFall(100, 100 + FALL_MIN_PX)).toBe(true)
    expect(isFall(100, 100 + FALL_MIN_PX - 1)).toBe(false)
    expect(isFall(100, 50)).toBe(false)
  })
})

describe('fallY', () => {
  it('starts where he was let go', () => {
    expect(fallY(fall, 0)).toEqual({ y: 200, done: false })
  })

  it('only ever goes down until the floor', () => {
    let last = 200
    for (let ms = 0; ms < fallLandingMs(fall); ms += 16) {
      const { y, done } = fallY(fall, ms)
      expect(y).toBeGreaterThanOrEqual(last)
      expect(y).toBeLessThan(800)
      expect(done).toBe(false)
      last = y
    }
  })

  it('takes half a second to drop 600 px', () => {
    expect(fallLandingMs(fall)).toBeCloseTo(500, 0)
  })

  it('bounces up to the bounce height and never below the floor', () => {
    const land = fallLandingMs(fall)
    const top = fallY(fall, land + BOUNCE_MS / 2)
    expect(top).toEqual({ y: 800 - BOUNCE_PX, done: false })
    for (let ms = land; ms < land + BOUNCE_MS; ms += 10) expect(fallY(fall, ms).y).toBeLessThanOrEqual(800)
  })

  it('is still on the floor once the bounce is over', () => {
    expect(fallY(fall, fallDurationMs(fall))).toEqual({ y: 800, done: true })
    expect(fallY(fall, fallDurationMs(fall) + 5000)).toEqual({ y: 800, done: true })
  })

  it('lands at once from no height', () => {
    expect(fallY({ fromY: 800, toY: 800 }, BOUNCE_MS)).toEqual({ y: 800, done: true })
  })
})
