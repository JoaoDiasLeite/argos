import { describe, expect, it } from 'vitest'
import {
  MAX_WINDOWS,
  MIN_WINDOW_SIDE,
  fills,
  findWindow,
  foregroundOf,
  frontIsFullScreen,
  frontWindow,
  isOrdinary,
  mediaSourceWindowId,
  roundRect,
  windowsToLandOn,
  type MacWindow
} from './companion-darwin-pure'

const OWN = 4242
const display = { x: 0, y: 0, width: 1512, height: 982 }
const workArea = { x: 0, y: 25, width: 1512, height: 957 }
const screens = [workArea, display]

const win = (id: number, over: Partial<MacWindow> = {}): MacWindow => ({
  id,
  pid: 100 + id,
  layer: 0,
  alpha: 1,
  bounds: { x: 100, y: 100, width: 800, height: 600 },
  ...over
})

describe('isOrdinary', () => {
  it('keeps a drawn layer-0 window', () => {
    expect(isOrdinary(win(1))).toBe(true)
  })
  it('drops the Dock, the menu bar and floating panels (other layers)', () => {
    expect(isOrdinary(win(1, { layer: 20 }))).toBe(false)
    expect(isOrdinary(win(1, { layer: 25 }))).toBe(false)
    expect(isOrdinary(win(1, { layer: 3 }))).toBe(false)
  })
  it('drops a window that is up but not drawn', () => {
    expect(isOrdinary(win(1, { alpha: 0 }))).toBe(false)
  })
  it('drops tiny helper windows', () => {
    expect(isOrdinary(win(1, { bounds: { x: 0, y: 0, width: 1, height: 1 } }))).toBe(false)
    expect(isOrdinary(win(1, { bounds: { x: 0, y: 0, width: 800, height: MIN_WINDOW_SIDE - 1 } }))).toBe(false)
    expect(isOrdinary(win(1, { bounds: { x: 0, y: 0, width: MIN_WINDOW_SIDE, height: MIN_WINDOW_SIDE } }))).toBe(true)
  })
})

describe('windowsToLandOn', () => {
  it('keeps the order of the list (front to back) and drops the rest', () => {
    const list = [win(1, { layer: 25 }), win(2), win(3, { alpha: 0 }), win(4)]
    expect(windowsToLandOn(list).map((w) => w.id)).toEqual([2, 4])
  })
  it('skips the companion by CGWindowID, but keeps Argos main window', () => {
    const list = [win(1, { pid: OWN }), win(2, { pid: OWN }), win(3)]
    expect(windowsToLandOn(list, [1n]).map((w) => w.id)).toEqual([2, 3])
  })
  it('stops at MAX_WINDOWS', () => {
    const list = Array.from({ length: MAX_WINDOWS + 10 }, (_, i) => win(i + 1))
    expect(windowsToLandOn(list)).toHaveLength(MAX_WINDOWS)
  })
})

describe('fills', () => {
  it('matches a display rect within the slack', () => {
    expect(fills({ x: 0, y: 25, width: 1512, height: 957 }, screens)).toBe(true)
    expect(fills({ x: 1, y: 26, width: 1510, height: 955 }, screens)).toBe(true)
    expect(fills({ x: 0, y: 0, width: 1512, height: 982 }, screens)).toBe(true)
  })
  it('does not match an ordinary window', () => {
    expect(fills({ x: 100, y: 100, width: 800, height: 600 }, screens)).toBe(false)
  })
})

describe('frontWindow and foregroundOf', () => {
  it('takes the first ordinary window', () => {
    const list = [win(1, { layer: 25 }), win(2), win(3)]
    expect(frontWindow(list)?.id).toBe(2)
    expect(foregroundOf(list, OWN, screens)?.id).toBe(2)
  })
  it('is null when Argos main window is in front, as on Windows', () => {
    const list = [win(1, { pid: OWN }), win(2)]
    expect(foregroundOf(list, OWN, screens)).toBeNull()
  })
  it('looks past the companion windows in skip', () => {
    const list = [win(1, { pid: OWN }), win(2)]
    expect(foregroundOf(list, OWN, screens, [1n])?.id).toBe(2)
  })
  it('is null for a zoomed or full-screen window', () => {
    expect(foregroundOf([win(1, { bounds: workArea })], OWN, screens)).toBeNull()
    expect(foregroundOf([win(1, { bounds: display })], OWN, screens)).toBeNull()
  })
  it('is null for an empty list', () => {
    expect(foregroundOf([], OWN, screens)).toBeNull()
  })
})

describe('findWindow', () => {
  it('finds the window by id while it is on screen', () => {
    expect(findWindow([win(1), win(2)], 2)?.id).toBe(2)
  })
  it('is null once gone, minimised or on another Space (not in the on-screen list)', () => {
    expect(findWindow([win(1)], 2)).toBeNull()
  })
  it('is null when the window is no longer drawn', () => {
    expect(findWindow([win(2, { alpha: 0 })], 2)).toBeNull()
  })
})

describe('frontIsFullScreen', () => {
  const displays = [{ bounds: display, workArea }]
  it('is true when another app covers a display', () => {
    expect(frontIsFullScreen([win(1, { bounds: display })], OWN, displays)).toBe(true)
  })
  it('is false for a zoomed window (the menu bar shows)', () => {
    expect(frontIsFullScreen([win(1, { bounds: workArea })], OWN, displays)).toBe(false)
  })
  it('is false when it is Argos itself', () => {
    expect(frontIsFullScreen([win(1, { pid: OWN, bounds: display })], OWN, displays)).toBe(false)
  })
  it('cannot tell on a display whose menu bar and Dock hide themselves, so says no', () => {
    expect(frontIsFullScreen([win(1, { bounds: display })], OWN, [{ bounds: display, workArea: display }])).toBe(false)
  })
})

describe('roundRect', () => {
  it('rounds to whole points', () => {
    expect(roundRect({ x: 10.4, y: 20.6, width: 99.5, height: 50.2 })).toEqual({ x: 10, y: 21, width: 100, height: 50 })
  })
})

describe('mediaSourceWindowId', () => {
  it('reads the CGWindowID', () => {
    expect(mediaSourceWindowId('window:1324:0')).toBe(1324n)
  })
  it('is null for anything else', () => {
    expect(mediaSourceWindowId('screen:1:0')).toBeNull()
    expect(mediaSourceWindowId('window:0:0')).toBeNull()
    expect(mediaSourceWindowId('')).toBeNull()
  })
})
