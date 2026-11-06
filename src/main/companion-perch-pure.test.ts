import { describe, expect, it } from 'vitest'
import { PERCH_ABOVE, PERCH_BELOW, PERCH_OVERHANG, isOverTitleBar, landingBelow, perchFollow, perchPosition } from './companion-perch-pure'
import { PET_SIZE, dogRect, type Rect } from './companion-window-pure'

const win: Rect = { x: 400, y: 300, width: 800, height: 600 }
const pet = (x: number, y: number): Rect => ({ x, y, width: PET_SIZE.width, height: PET_SIZE.height })
/** A pet window whose paws are this far below the window's top. */
const pawsAt = (x: number, dy: number): Rect => pet(x, win.y + dy - PET_SIZE.height)

describe('isOverTitleBar', () => {
  it('is a drop with the paws near the top edge, over the window', () => {
    expect(isOverTitleBar(pawsAt(600, 0), win)).toBe(true)
    expect(isOverTitleBar(pawsAt(600, -PERCH_ABOVE), win)).toBe(true)
    expect(isOverTitleBar(pawsAt(600, PERCH_BELOW), win)).toBe(true)
    expect(isOverTitleBar(pawsAt(600, -PERCH_ABOVE - 1), win)).toBe(false)
    expect(isOverTitleBar(pawsAt(600, PERCH_BELOW + 1), win)).toBe(false)
  })

  it('allows the overhang at the sides and no more', () => {
    const dog = dogRect(pet(0, 0))
    const centreOffset = dog.x + dog.width / 2
    expect(isOverTitleBar(pawsAt(win.x - PERCH_OVERHANG - centreOffset, 0), win)).toBe(true)
    expect(isOverTitleBar(pawsAt(win.x - PERCH_OVERHANG - centreOffset - 1, 0), win)).toBe(false)
    expect(isOverTitleBar(pawsAt(win.x + win.width + PERCH_OVERHANG - centreOffset, 0), win)).toBe(true)
    expect(isOverTitleBar(pawsAt(win.x + win.width + PERCH_OVERHANG - centreOffset + 1, 0), win)).toBe(false)
  })
})

describe('perchPosition', () => {
  it('puts the paws on the edge where he was let go', () => {
    const p = perchPosition(pawsAt(600, 20), win, PET_SIZE)
    expect(p).toEqual({ x: 600, y: win.y - PET_SIZE.height })
    const dog = dogRect({ ...p, width: PET_SIZE.width, height: PET_SIZE.height })
    expect(dog.y + dog.height).toBe(win.y)
  })

  it('keeps him within the overhang of either side', () => {
    const left = perchPosition(pawsAt(-500, 0), win, PET_SIZE)
    const right = perchPosition(pawsAt(5000, 0), win, PET_SIZE)
    expect(dogRect({ ...left, ...PET_SIZE }).x).toBe(win.x - PERCH_OVERHANG)
    expect(dogRect({ ...right, ...PET_SIZE }).x + dogRect({ ...right, ...PET_SIZE }).width).toBe(win.x + win.width + PERCH_OVERHANG)
  })
})

describe('perchFollow', () => {
  it('moves with the window', () => {
    expect(perchFollow({ x: 600, y: 148 }, win, { ...win, x: 450, y: 320 })).toEqual({ x: 650, y: 168 })
  })
})

describe('landingBelow', () => {
  const FLOOR = 1040 - PET_SIZE.height - 12
  const low: Rect = { x: 300, y: 700, width: 900, height: 300 }

  it('lands on the highest top edge under the paws, above the floor', () => {
    expect(landingBelow(pet(600, 50), [low, win], FLOOR)).toEqual({ index: 1, y: win.y - PET_SIZE.height })
    expect(landingBelow(pet(600, 50), [low], FLOOR)).toEqual({ index: 0, y: low.y - PET_SIZE.height })
  })

  it('answers null with nothing under him, or only the floor', () => {
    expect(landingBelow(pet(600, 50), [], FLOOR)).toBeNull()
    expect(landingBelow(pet(1500, 50), [win], FLOOR)).toBeNull()
    expect(landingBelow(pet(600, 50), [{ x: 0, y: 1030, width: 1920, height: 200 }], FLOOR)).toBeNull()
  })

  it('ignores a window whose top edge is above the paws, beyond the catch', () => {
    expect(landingBelow(pawsAt(600, PERCH_ABOVE), [win], FLOOR)).toEqual({ index: 0, y: win.y - PET_SIZE.height })
    expect(landingBelow(pawsAt(600, PERCH_ABOVE + 1), [win], FLOOR)).toBeNull()
  })

  it('falls past an edge covered by a window in front of it', () => {
    const front: Rect = { x: 500, y: 100, width: 300, height: 400 }
    expect(landingBelow(pet(600, -100), [front, win], FLOOR)).toEqual({ index: 0, y: front.y - PET_SIZE.height })
    // Paws already past the front window's top: its edge is behind him, and it covers the big one's.
    const cover: Rect = { x: 500, y: 200, width: 300, height: 200 }
    expect(landingBelow(pet(600, 200), [cover, low], FLOOR)).toEqual({ index: 1, y: low.y - PET_SIZE.height })
    // The big window in front covers the low one's edge there too: on to the floor.
    expect(landingBelow(pet(600, 200), [cover, win, low], FLOOR)).toBeNull()
  })

  it('allows the overhang at the sides', () => {
    const dog = dogRect(pet(0, 0))
    const centreOffset = dog.x + dog.width / 2
    expect(landingBelow(pet(win.x - PERCH_OVERHANG - centreOffset, 50), [win], FLOOR)).not.toBeNull()
    expect(landingBelow(pet(win.x - PERCH_OVERHANG - centreOffset - 1, 50), [win], FLOOR)).toBeNull()
  })
})
