import { describe, expect, it } from 'vitest'
import { PERCH_ABOVE, PERCH_BELOW, PERCH_OVERHANG, isOverTitleBar, perchFollow, perchPosition } from './companion-perch-pure'
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
