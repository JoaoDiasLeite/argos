import { describe, it, expect } from 'vitest'
import {
  DOCK_ZONE,
  PET_MARGIN,
  PET_SIZE,
  bubblePlacement,
  clampBubbleSize,
  clampToArea,
  defaultPetPosition,
  dockSide,
  dogRect,
  inRoundedRect,
  petHitTest,
  petStranded,
  petWindowSize,
  restoredPetPosition,
  floorUnder,
  snapToEdge,
  type Rect
} from './companion-window-pure'

// A 1920x1080 display with a 40 px taskbar at the bottom.
const area: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
// A second display to the left, with a negative origin.
const left: Rect = { x: -1280, y: 100, width: 1280, height: 984 }

const W = PET_SIZE.width
const H = PET_SIZE.height
const pet = (x: number, y: number): Rect => ({ x, y, width: W, height: H })
/** The window's y on the floor of `area`. */
const FLOOR = 1040 - H - 12
const bubble = { width: 320, height: 120 }

describe('defaultPetPosition', () => {
  it('is the bottom-right corner, a margin in', () => {
    expect(defaultPetPosition(area)).toEqual({ x: 1920 - W - 12, y: FLOOR })
  })

  it('follows a display with a negative origin', () => {
    expect(defaultPetPosition(left)).toEqual({ x: -W - PET_MARGIN, y: 100 + 984 - H - PET_MARGIN })
  })
})

describe('snapToEdge', () => {
  it('docks to the left edge when dropped near it, keeping its height', () => {
    expect(snapToEdge({ x: 30, y: 300 }, area)).toEqual({ x: 12, y: 300 })
    expect(snapToEdge({ x: DOCK_ZONE, y: 300 }, area)).toEqual({ x: 12, y: 300 })
  })

  it('docks to the right edge when dropped near it', () => {
    expect(snapToEdge({ x: 1920 - W - 30, y: 300 }, area)).toEqual({ x: 1920 - W - 12, y: 300 })
  })

  it('falls to the floor from the middle of the screen, under where it was let go', () => {
    expect(snapToEdge({ x: 500, y: 300 }, area)).toEqual({ x: 500, y: FLOOR })
    expect(snapToEdge({ x: DOCK_ZONE + 1, y: 300 }, area)).toEqual({ x: DOCK_ZONE + 1, y: FLOOR })
  })

  it('lands a drop in the lower third on the floor, where it was let go', () => {
    expect(snapToEdge({ x: 900, y: 600 }, area)).toEqual({ x: 900, y: FLOOR })
  })

  it('tucks a drop near the bottom corners into the corner', () => {
    expect(snapToEdge({ x: 20, y: 700 }, area)).toEqual({ x: 12, y: FLOOR })
    expect(snapToEdge({ x: 1920 - W - 30, y: 1000 }, area)).toEqual({ x: 1920 - W - 12, y: FLOOR })
  })

  it('lands a drop half off the bottom-right in that corner', () => {
    expect(snapToEdge({ x: 1800, y: 1000 }, area)).toEqual({ x: 1920 - W - 12, y: FLOOR })
  })

  it('clamps a drop above the top back inside', () => {
    expect(snapToEdge({ x: 10, y: -80 }, area).y).toBe(0)
  })

  it('snaps on a display with a negative origin', () => {
    expect(snapToEdge({ x: -1260, y: 400 }, left)).toEqual({ x: -1280 + 12, y: 400 })
    expect(snapToEdge({ x: -W - 20, y: 400 }, left)).toEqual({ x: -W - 12, y: 400 })
    expect(snapToEdge({ x: -700, y: 400 }, left)).toEqual({ x: -700, y: 100 + 984 - H - 12 })
  })
})

describe('floorUnder', () => {
  it('is the floor straight under the window', () => {
    expect(floorUnder({ x: 500, y: 300 }, area)).toEqual({ x: 500, y: FLOOR })
    expect(floorUnder({ x: -700, y: 400 }, left)).toEqual({ x: -700, y: 100 + 984 - H - 12 })
  })

  it('keeps the window inside the work area', () => {
    expect(floorUnder({ x: 1900, y: 300 }, area)).toEqual({ x: 1920 - W, y: FLOOR })
  })
})

describe('dockSide', () => {
  it('is the wall a pet docked above the floor has his back to', () => {
    expect(dockSide(snapToEdge({ x: 30, y: 300 }, area), area)).toBe('left')
    expect(dockSide(snapToEdge({ x: 1920 - W - 30, y: 300 }, area), area)).toBe('right')
    expect(dockSide({ x: -1280 + 12, y: 400 }, left)).toBe('left')
  })

  it('is nothing on the floor, corners included, or out in the open', () => {
    expect(dockSide({ x: 12, y: FLOOR }, area)).toBeNull()
    expect(dockSide({ x: 1920 - W - 12, y: FLOOR }, area)).toBeNull()
    expect(dockSide({ x: 500, y: 300 }, area)).toBeNull()
  })
})

describe('clampToArea', () => {
  it('leaves a position that fits alone', () => {
    expect(clampToArea({ x: 100, y: 100 }, PET_SIZE, area)).toEqual({ x: 100, y: 100 })
  })

  it('pulls every side back inside', () => {
    expect(clampToArea({ x: -50, y: 5000 }, PET_SIZE, area)).toEqual({ x: 0, y: 1040 - H })
    expect(clampToArea({ x: 5000, y: -50 }, PET_SIZE, area)).toEqual({ x: 1920 - W, y: 0 })
  })
})

describe('restoredPetPosition', () => {
  it('uses the saved position while it is still on the display', () => {
    expect(restoredPetPosition({ x: 12, y: 400 }, area)).toEqual({ x: 12, y: 400 })
  })

  it('rejects a saved position that is now off-screen (smaller resolution)', () => {
    expect(restoredPetPosition({ x: 2400, y: 400 }, area)).toEqual(defaultPetPosition(area))
  })

  it('rejects one that only partly fits (the taskbar moved over it)', () => {
    expect(restoredPetPosition({ x: 12, y: 900 }, area)).toEqual(defaultPetPosition(area))
  })

  it('falls back to the default with nothing saved, or garbage', () => {
    expect(restoredPetPosition(undefined, area)).toEqual(defaultPetPosition(area))
    expect(restoredPetPosition({ x: NaN, y: 0 }, area)).toEqual(defaultPetPosition(area))
  })
})

describe('hit test', () => {
  const p = pet(1000, 500)

  it('puts the dog bottom-centre, 120x130', () => {
    expect(dogRect(p)).toEqual({ x: 1004, y: 522, width: 120, height: 130 })
  })

  it('scales the dog with a window of another size', () => {
    const large = petWindowSize(4 / 3)
    expect(large).toEqual({ width: 171, height: 203 })
    const d = dogRect({ x: 1000, y: 500, ...large })
    expect(d.width).toBeCloseTo(160.3, 1)
    expect(d.height).toBeCloseTo(173.6, 1)
    // Still bottom-centre: the same gaps as at 1×, scaled.
    expect(d.x - 1000).toBeCloseTo(5.3, 1)
    expect(d.y + d.height).toBeCloseTo(500 + large.height, 5)
  })

  it('takes the click over the dog', () => {
    expect(petHitTest({ x: 1060, y: 600 }, p)).toBe(true)
  })

  it('lets clicks through on the transparent part of the window', () => {
    expect(petHitTest({ x: 1010, y: 510 }, p)).toBe(false)
    expect(petHitTest({ x: 1001, y: 600 }, p)).toBe(false)
  })

  it('lets a click through at the very corner of the rounded rect', () => {
    expect(inRoundedRect({ x: 1005, y: 523 }, dogRect(p))).toBe(false)
    expect(inRoundedRect({ x: 1028, y: 523 }, dogRect(p))).toBe(true)
  })

  it('is false off the window entirely', () => {
    expect(petHitTest({ x: 0, y: 0 }, p)).toBe(false)
  })
})

describe('petStranded', () => {
  it('is fine while the dog sits inside one of the displays', () => {
    expect(petStranded(pet(1000, 500), [area, left])).toBe(false)
    expect(petStranded(pet(-600, 400), [area, left])).toBe(false)
  })

  it('is stranded when the display under him is gone', () => {
    expect(petStranded(pet(-600, 400), [area])).toBe(true)
  })

  it('is stranded when the work area shrank under the dog, but not under the window', () => {
    // The dog sits in the window's bottom 130 px: a taskbar that grew to 100 px pushes the
    // work area's bottom to 980, above the dog's paws at 1028.
    const floor = pet(900, FLOOR)
    expect(petStranded(floor, [{ ...area, height: 980 }])).toBe(true)
    // The window's top 22 px are transparent: losing them is nothing (the dog's head is at 898).
    expect(petStranded(floor, [{ ...area, y: 890, height: 150 }])).toBe(false)
  })
})

describe('bubblePlacement', () => {
  const centreOf = (p: Rect): number => {
    const dog = dogRect(p)
    return dog.x + dog.width / 2
  }

  it('sits centred straight over the dog, its tail at his centre', () => {
    const p = pet(900, FLOOR)
    const r = bubblePlacement(p, bubble, area)
    const dog = dogRect(p)
    expect(r.anchor.side).toBe('above')
    expect(r.y + bubble.height).toBe(dog.y)
    expect(r.x + bubble.width / 2).toBe(centreOf(p))
    expect(r.x + r.anchor.tailX).toBe(centreOf(p))
  })

  it('in the bottom-right corner, slides inside and keeps the tail over him', () => {
    const p = pet(1920 - W - 12, FLOOR)
    const r = bubblePlacement(p, bubble, area)
    expect(r.anchor.side).toBe('above')
    expect(r.x + bubble.width).toBe(area.x + area.width)
    expect(r.x + r.anchor.tailX).toBe(centreOf(p))
  })

  it('in the bottom-left corner, the same the other way', () => {
    const p = pet(12, FLOOR)
    const r = bubblePlacement(p, bubble, area)
    expect(r.x).toBe(area.x)
    expect(r.x + r.anchor.tailX).toBe(centreOf(p))
  })

  it('goes below him only when there is no room above', () => {
    const p = pet(900, 12)
    const r = bubblePlacement(p, bubble, area)
    const dog = dogRect(p)
    expect(r.anchor.side).toBe('below')
    expect(r.y).toBe(dog.y + dog.height)
  })

  it('with room on neither side, takes the roomier one and stays inside', () => {
    const tall = { width: 320, height: 420 }
    const short: Rect = { x: 0, y: 0, width: 1920, height: 600 }
    const r = bubblePlacement(pet(900, 200), tall, short)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.y + tall.height).toBeLessThanOrEqual(600)
  })

  it('keeps the tail clear of the corners when the dog is past the bubble edge', () => {
    // A display barely wider than the bubble, the dog at its far left.
    const narrow: Rect = { x: 0, y: 0, width: 330, height: 1040 }
    const r = bubblePlacement(pet(-60, FLOOR), bubble, narrow)
    expect(r.anchor.tailX).toBeGreaterThanOrEqual(30)
    expect(r.anchor.tailX).toBeLessThanOrEqual(bubble.width - 30)
  })

  it('always lands inside the work area', () => {
    for (const p of [pet(0, 0), pet(1920 - W, 0), pet(0, 1040 - H), pet(1920 - W, 1040 - H), pet(850, 400)]) {
      const r = bubblePlacement(p, { width: 440, height: 420 }, area)
      expect(r.x).toBeGreaterThanOrEqual(area.x)
      expect(r.y).toBeGreaterThanOrEqual(area.y)
      expect(r.x + 440).toBeLessThanOrEqual(area.x + area.width)
      expect(r.y + 420).toBeLessThanOrEqual(area.y + area.height)
    }
  })

  it('works on a display with a negative origin', () => {
    const p = pet(...(Object.values(defaultPetPosition(left)) as [number, number]))
    const r = bubblePlacement(p, bubble, left)
    expect(r.anchor.side).toBe('above')
    expect(r.x).toBeGreaterThanOrEqual(left.x)
    expect(r.x + r.anchor.tailX).toBe(centreOf(p))
  })
})

describe('clampBubbleSize', () => {
  it('keeps the bubble between 240x60 and 440x420', () => {
    expect(clampBubbleSize({ width: 10, height: 10 })).toEqual({ width: 240, height: 60 })
    expect(clampBubbleSize({ width: 9999, height: 9999 })).toEqual({ width: 440, height: 420 })
    expect(clampBubbleSize({ width: 300.4, height: 100.6 })).toEqual({ width: 300, height: 101 })
  })
})
