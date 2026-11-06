/**
 * Perching (docs/COMPANION_PLAN.md §13.3, R): let go over the title bar of the window in
 * front, Argos sits on its top edge, moves with it, and falls to the floor when it goes.
 * Let go higher up, he falls until the top edge of a window below catches him
 * (landingBelow), or the floor does. The geometry is pure; companion-win32.ts says where
 * the windows are. DIPs throughout.
 */
import { PET_SIZE, dogRect, type Rect, type Size } from './companion-window-pure'

/** The dog's paws this far above or below the window's top edge count as a drop on it. */
export const PERCH_ABOVE = 48
export const PERCH_BELOW = 56

/** He may hang this far past either side of the window. */
export const PERCH_OVERHANG = 24

/**
 * How far the paws sink into the window's top edge, at 1× (scaled with the window). Paws
 * exactly on the edge read as hovering over it; a few pixels down, he sits on it.
 */
export const PERCH_SINK = 10

/** The pet window's y sat on a window whose top edge is at `top`: paws PERCH_SINK into it. */
export function perchY(top: number, size: Pick<Size, 'height'>): number {
  return Math.round(top - size.height + (PERCH_SINK * size.height) / PET_SIZE.height)
}

/** How often a perched pet checks on its window. */
export const PERCH_POLL_MS = 100

/** Whether a pet window let go at these bounds landed on the window's title bar. */
export function isOverTitleBar(pet: Rect, win: Rect): boolean {
  const dog = dogRect(pet)
  const paws = dog.y + dog.height
  if (paws < win.y - PERCH_ABOVE || paws > win.y + PERCH_BELOW) return false
  const centre = dog.x + dog.width / 2
  return centre >= win.x - PERCH_OVERHANG && centre <= win.x + win.width + PERCH_OVERHANG
}

/**
 * The pet window's position sat on the window's top edge: paws just into it (PERCH_SINK),
 * where he was let go horizontally, kept within the overhang of either side.
 */
export function perchPosition(pet: Rect, win: Rect, size: Size): { x: number; y: number } {
  const minX = win.x - PERCH_OVERHANG - (pet.width - dogRect(pet).width) / 2
  const maxX = win.x + win.width + PERCH_OVERHANG - size.width + (pet.width - dogRect(pet).width) / 2
  const x = Math.round(Math.min(Math.max(pet.x, minX), Math.max(minX, maxX)))
  return { x, y: perchY(win.y, size) }
}

/**
 * Whether a pet window at these bounds shows the dog: the top of his head, at its
 * centre, inside one of the work areas. Sat on a window whose top edge is the top of the
 * screen (a maximised one) he would be drawn above it, out of sight, so he does not
 * perch there.
 */
export function perchOnScreen(pet: Rect, areas: readonly Rect[]): boolean {
  const dog = dogRect(pet)
  const x = dog.x + dog.width / 2
  return areas.some((a) => x >= a.x && x < a.x + a.width && dog.y >= a.y && dog.y < a.y + a.height)
}

/** The window moved: the pet keeps its place on the edge. */
export function perchFollow(pos: { x: number; y: number }, from: Rect, to: Rect): { x: number; y: number } {
  return { x: pos.x + (to.x - from.x), y: pos.y + (to.y - from.y) }
}

/** Where a fall ends on a window: which one (an index into the list given) and the pet window's y there. */
export interface Landing {
  index: number
  y: number
}

/**
 * The first top edge under a falling pet: among `windows` (front to back, as the screen
 * stacks them) those whose top edge lies below his paws, less PERCH_ABOVE, and above the
 * floor he would otherwise reach (`floorY` is the pet window's y there), and that span
 * his centre within the overhang. The highest edge wins, unless a window in front of it
 * covers that spot, in which case he falls past it to the next. Given the work areas, an
 * edge he would sit on out of sight (perchOnScreen) does not catch him either. Null when
 * nothing catches him before the floor.
 */
export function landingBelow(pet: Rect, windows: Rect[], floorY: number, areas?: readonly Rect[]): Landing | null {
  const dog = dogRect(pet)
  const paws = dog.y + dog.height
  const centre = dog.x + dog.width / 2
  let best: Landing | null = null
  windows.forEach((win, index) => {
    if (win.y < paws - PERCH_ABOVE) return
    if (centre < win.x - PERCH_OVERHANG || centre > win.x + win.width + PERCH_OVERHANG) return
    const y = perchY(win.y, pet)
    if (y >= floorY) return
    if (best && y >= best.y) return
    if (areas && !perchOnScreen({ ...pet, y }, areas)) return
    const spotX = Math.min(Math.max(centre, win.x), win.x + win.width - 1)
    for (let i = 0; i < index; i++) {
      const w = windows[i]
      if (spotX >= w.x && spotX < w.x + w.width && win.y >= w.y && win.y < w.y + w.height) return
    }
    best = { index, y }
  })
  return best
}
