import { describe, expect, it } from 'vitest'
import { WAKE_RADIUS, canDoze, cursorNearPet, shouldWake, type DozeConditions } from './companion-doze-pure'
import { PET_SIZE, dogRect, type Rect } from './companion-window-pure'

const QUIET: DozeConditions = {
  visible: true,
  petState: 'idle',
  bubbleOpen: false,
  alertsPending: false,
  dnd: false,
  cursorNear: false,
  dragging: false,
  voiceBusy: false
}

const pet: Rect = { x: 1000, y: 500, width: PET_SIZE.width, height: PET_SIZE.height }

describe('canDoze', () => {
  it('dozes when idle with nothing going on', () => {
    expect(canDoze(QUIET)).toBe(true)
  })

  it.each<[keyof DozeConditions, DozeConditions[keyof DozeConditions]]>([
    ['visible', false],
    ['petState', 'listening'],
    ['petState', 'alert'],
    ['petState', 'walking'],
    ['petState', 'shh'],
    ['bubbleOpen', true],
    ['alertsPending', true],
    ['dnd', true],
    ['cursorNear', true],
    ['dragging', true],
    ['voiceBusy', true]
  ])('stays awake while %s is %s', (key, value) => {
    expect(canDoze({ ...QUIET, [key]: value })).toBe(false)
  })
})

describe('shouldWake', () => {
  const dozing: DozeConditions = { ...QUIET, petState: 'dozing' }

  it('sleeps on while nothing happens', () => {
    expect(shouldWake(dozing)).toBe(false)
  })

  it('wakes for the cursor, a bubble, an alert, a drag or being hidden', () => {
    expect(shouldWake({ ...dozing, cursorNear: true })).toBe(true)
    expect(shouldWake({ ...dozing, bubbleOpen: true })).toBe(true)
    expect(shouldWake({ ...dozing, alertsPending: true })).toBe(true)
    expect(shouldWake({ ...dozing, dragging: true })).toBe(true)
    expect(shouldWake({ ...dozing, visible: false })).toBe(true)
  })

  it('is nothing to a dog that is not dozing', () => {
    expect(shouldWake({ ...QUIET, cursorNear: true })).toBe(false)
  })
})

describe('cursorNearPet', () => {
  const dog = dogRect(pet)

  it('is near over the dog and just beside him', () => {
    expect(cursorNearPet({ x: dog.x + 10, y: dog.y + 10 }, pet)).toBe(true)
    expect(cursorNearPet({ x: dog.x - WAKE_RADIUS + 1, y: dog.y + 10 }, pet)).toBe(true)
  })

  it('measures from the dog, not from the window', () => {
    // Just past the radius from the dog's left side, though well inside the window's reach.
    expect(cursorNearPet({ x: dog.x - WAKE_RADIUS - 1, y: dog.y + 10 }, pet)).toBe(false)
  })

  it('measures diagonally at the corners', () => {
    const r = WAKE_RADIUS / Math.SQRT2
    expect(cursorNearPet({ x: dog.x - r + 2, y: dog.y - r + 2 }, pet)).toBe(true)
    expect(cursorNearPet({ x: dog.x - r - 2, y: dog.y - r - 2 }, pet)).toBe(false)
  })
})
