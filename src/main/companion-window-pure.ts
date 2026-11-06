/**
 * The geometry behind the pet and its bubble (docs/COMPANION_PLAN.md §2.4, §9.1), kept
 * apart from companion-window.ts so it can be tested without Electron. Everything is in
 * DIPs of the virtual screen, which is what BrowserWindow bounds, display work areas and
 * screen.getCursorScreenPoint() all speak.
 */
import type { CompanionBubbleAnchor, CompanionRect } from './companion-types'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export type Rect = CompanionRect

/**
 * The pet window is just big enough for the dog (plan §13.1): his 120×116 hit rect at
 * the bottom centre, the 9 px hop, and the badges over his head. The 96×96 sprite sits
 * on the window's bottom edge, so his paws are where the window ends.
 */
export const PET_SIZE: Size = { width: 128, height: 152 }

/** The 220×220 window before 3.1.0, whose saved positions are shifted once (see below). */
export const LEGACY_PET_SIZE: Size = { width: 220, height: 220 }

/**
 * Gap between the dog and the edge of the work area: none, so he stands on the taskbar
 * and leans on the screen's sides.
 */
export const PET_MARGIN = 0

/** The hit rect inside the pet window: bottom-centre, this big. */
export const DOG_SIZE: Size = { width: 120, height: 116 }

/** The sprite inside the window: bottom-centre, its paws on the window's bottom edge. */
export const SPRITE_SIZE: Size = { width: 96, height: 96 }

/**
 * How far the window may hang past a side of the work area: the transparent strip beside
 * the sprite, scaled with the window. That way the dog, not his window, touches the edge.
 */
export function sideBleed(size: Pick<Size, 'width'>): number {
  return Math.round(((PET_SIZE.width - SPRITE_SIZE.width) / 2) * (size.width / PET_SIZE.width))
}

/** The area the pet window may occupy: the work area, widened by sideBleed on both sides. */
export function petArea(workArea: Rect, size: Pick<Size, 'width'>): Rect {
  const bleed = sideBleed(size)
  return { x: workArea.x - bleed, y: workArea.y, width: workArea.width + 2 * bleed, height: workArea.height }
}

/** The hit area is a generous rounded rect, not a per-pixel test (plan §9.1). */
export const HIT_RADIUS = 24

/** The tail stays this far from the bubble window's sides, clear of the card's corners. */
const TAIL_INSET = 30

export const BUBBLE_MIN: Size = { width: 240, height: 60 }
export const BUBBLE_MAX: Size = { width: 440, height: 420 }

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), Math.max(min, max))

/** Bottom-right of the work area, PET_MARGIN in. */
export function defaultPetPosition(workArea: Rect, size = PET_SIZE, margin = PET_MARGIN): Point {
  workArea = petArea(workArea, size)
  return {
    x: Math.round(workArea.x + workArea.width - size.width - margin),
    y: Math.round(workArea.y + workArea.height - size.height - margin)
  }
}

/** The window at `pos` moved the least it takes to sit wholly inside the work area. */
export function clampToArea(pos: Point, size: Size, workArea: Rect): Point {
  return {
    x: Math.round(clamp(pos.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(pos.y, workArea.y, workArea.y + workArea.height - size.height))
  }
}

/** True when the whole window at `pos` is inside the work area. */
export function isInsideArea(pos: Point, size: Size, workArea: Rect): boolean {
  return (
    pos.x >= workArea.x &&
    pos.y >= workArea.y &&
    pos.x + size.width <= workArea.x + workArea.width &&
    pos.y + size.height <= workArea.y + workArea.height
  )
}

/**
 * A position saved for the 220×220 window, moved so the dog stays where he was: the
 * dog's offset inside the window changed from (50, 90) to (4, 22), so the window's
 * top-left moves by the difference.
 */
export function migrateLegacyPosition(pos: Point): Point {
  const dx = (LEGACY_PET_SIZE.width - DOG_SIZE.width) / 2 - (PET_SIZE.width - DOG_SIZE.width) / 2
  const dy = LEGACY_PET_SIZE.height - DOG_SIZE.height - (PET_SIZE.height - DOG_SIZE.height)
  return { x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) }
}

/** A drop with the window within this of a side edge docks there (plan §13.3, M4). */
export const DOCK_ZONE = 48

/**
 * Where a dropped pet comes to rest, short of a window to land on. Let go within
 * DOCK_ZONE of a side edge, above the lower third of the work area, he docks against that
 * edge, PET_MARGIN in, keeping his height (clamped inside): docked, not free-floating, and
 * not walking. Anywhere else he ends on the floor under where he was let go, PET_MARGIN
 * up from the bottom, so he can walk from there; companion-window.ts drops him there
 * along companion-fall-pure's curve, unless a window's top edge catches him on the way
 * (companion-perch-pure's landingBelow).
 */
export function snapToEdge(pos: Point, workArea: Rect, size = PET_SIZE, margin = PET_MARGIN): Point {
  workArea = petArea(workArea, size)
  const bottom = workArea.y + workArea.height
  const right = workArea.x + workArea.width
  const nearLeft = pos.x - workArea.x <= DOCK_ZONE
  const nearRight = right - (pos.x + size.width) <= DOCK_ZONE
  const sideX = nearLeft ? workArea.x + margin : right - size.width - margin
  if (pos.y + size.height >= bottom - workArea.height / 3) {
    // The floor; near a side he tucks into the corner (plan §13.1, leaning).
    return clampToArea({ x: nearLeft || nearRight ? sideX : pos.x, y: bottom - size.height - margin }, size, workArea)
  }
  if (!nearLeft && !nearRight) return clampToArea({ x: pos.x, y: bottom - size.height - margin }, size, workArea)
  return clampToArea({ x: sideX, y: pos.y }, size, workArea)
}

/** The floor of the work area straight under `pos`: where he lands when the window he sat on went. */
export function floorUnder(pos: Point, workArea: Rect, size = PET_SIZE, margin = PET_MARGIN): Point {
  workArea = petArea(workArea, size)
  return clampToArea({ x: pos.x, y: workArea.y + workArea.height - size.height - margin }, size, workArea)
}

export type DockSide = 'left' | 'right'

/**
 * Which wall a resting pet has his back to (plan §13.1, leaning): docked against a side
 * edge above the floor. On the floor, corner or not, he sits as usual.
 */
export function dockSide(pos: Point, workArea: Rect, size = PET_SIZE, margin = PET_MARGIN, floorTolerance = 40): DockSide | null {
  workArea = petArea(workArea, size)
  const bottom = workArea.y + workArea.height
  if (bottom - (pos.y + size.height) <= floorTolerance) return null
  if (pos.x <= workArea.x + margin) return 'left'
  if (pos.x + size.width >= workArea.x + workArea.width - margin) return 'right'
  return null
}

/** A saved position this close above the floor was the floor, under an older margin. */
const FLOOR_SNAP = 40

/**
 * Where to show the pet: the position saved for this display while it is still wholly
 * inside the work area (a resolution change or a moved taskbar can strand it), else the
 * default corner. A position just above the floor goes down onto it: it was saved when
 * the dog stood a margin up from the taskbar.
 */
export function restoredPetPosition(saved: Point | undefined, workArea: Rect, size = PET_SIZE): Point {
  const area = petArea(workArea, size)
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && isInsideArea(saved, size, area)) {
    const floor = area.y + area.height - size.height
    return { x: saved.x, y: floor - saved.y <= FLOOR_SNAP ? floor : saved.y }
  }
  return defaultPetPosition(workArea, size)
}

/** The window for a size setting (plan §13.3, N2): PET_SIZE scaled, whole pixels. */
export function petWindowSize(scale: number): Size {
  return { width: Math.round(PET_SIZE.width * scale), height: Math.round(PET_SIZE.height * scale) }
}

/**
 * The dog's rect on screen, for a pet window with these bounds. In proportion to the
 * window, so a scaled window (petWindowSize) carries its own hit area: at 1× the dog is
 * DOG_SIZE at the bottom centre.
 */
export function dogRect(pet: Rect): Rect {
  const sx = pet.width / PET_SIZE.width
  const sy = pet.height / PET_SIZE.height
  return {
    x: pet.x + ((PET_SIZE.width - DOG_SIZE.width) / 2) * sx,
    y: pet.y + (PET_SIZE.height - DOG_SIZE.height) * sy,
    width: DOG_SIZE.width * sx,
    height: DOG_SIZE.height * sy
  }
}

/** The sprite's rect on screen, for a pet window with these bounds (scaled like dogRect). */
export function spriteRect(pet: Rect): Rect {
  const sx = pet.width / PET_SIZE.width
  const sy = pet.height / PET_SIZE.height
  return {
    x: pet.x + ((PET_SIZE.width - SPRITE_SIZE.width) / 2) * sx,
    y: pet.y + (PET_SIZE.height - SPRITE_SIZE.height) * sy,
    width: SPRITE_SIZE.width * sx,
    height: SPRITE_SIZE.height * sy
  }
}

/**
 * True when the dog is wholly inside none of these work areas: the display under him
 * went away, shrank or moved (plan §13.3, M3), so he has to be placed again. The sprite,
 * not the window or the hit rect: the window hangs past the sides by design (sideBleed),
 * and a taskbar moving under its transparent part is not a reason to move him.
 */
export function petStranded(pet: Rect, workAreas: Rect[]): boolean {
  const dog = spriteRect(pet)
  return !workAreas.some(
    (a) => dog.x >= a.x && dog.y >= a.y && dog.x + dog.width <= a.x + a.width && dog.y + dog.height <= a.y + a.height
  )
}

/** Inside a rect whose corners are rounded by `radius`. */
export function inRoundedRect(p: Point, r: Rect, radius = HIT_RADIUS): boolean {
  if (p.x < r.x || p.y < r.y || p.x > r.x + r.width || p.y > r.y + r.height) return false
  const rad = Math.min(radius, r.width / 2, r.height / 2)
  // Distance to the nearest corner's circle centre, only when in a corner square.
  const cx = p.x < r.x + rad ? r.x + rad : p.x > r.x + r.width - rad ? r.x + r.width - rad : p.x
  const cy = p.y < r.y + rad ? r.y + rad : p.y > r.y + r.height - rad ? r.y + r.height - rad : p.y
  return (p.x - cx) ** 2 + (p.y - cy) ** 2 <= rad * rad
}

/**
 * Whether the cursor is over the dog, which takes the click. Anywhere else the window
 * lets clicks through to what is behind it.
 */
export function petHitTest(cursor: Point, pet: Rect): boolean {
  return inRoundedRect(cursor, dogRect(pet))
}

export function clampBubbleSize(size: Size): Size {
  return {
    width: Math.round(clamp(size.width, BUBBLE_MIN.width, BUBBLE_MAX.width)),
    height: Math.round(clamp(size.height, BUBBLE_MIN.height, BUBBLE_MAX.height))
  }
}

/**
 * Where the bubble goes: centred straight over the dog, its tail pointing down at him.
 * Below him only when there is no room above (a pet docked at the top); with room on
 * neither side, the side with more. Near a screen edge the bubble slides inside the work
 * area and the tail stays over the dog's centre, short of the card's corners.
 */
export function bubblePlacement(
  pet: Rect,
  bubble: Size,
  workArea: Rect
): { x: number; y: number; anchor: CompanionBubbleAnchor } {
  const dog = dogRect(pet)
  const areaBottom = workArea.y + workArea.height
  const areaRight = workArea.x + workArea.width

  const aboveY = dog.y - bubble.height
  const belowY = dog.y + dog.height
  const fitsAbove = aboveY >= workArea.y
  const fitsBelow = belowY + bubble.height <= areaBottom
  let above = fitsAbove || !fitsBelow
  // Neither fits (a tall bubble on a short screen): the side with more room.
  if (!fitsAbove && !fitsBelow) above = dog.y - workArea.y >= areaBottom - belowY

  const centre = dog.x + dog.width / 2
  const x = Math.round(clamp(centre - bubble.width / 2, workArea.x, areaRight - bubble.width))
  const y = Math.round(clamp(above ? aboveY : belowY, workArea.y, areaBottom - bubble.height))
  const tailX = Math.round(clamp(centre - x, TAIL_INSET, bubble.width - TAIL_INSET))
  return { x, y, anchor: { side: above ? 'above' : 'below', tailX } }
}
