/**
 * When Argos dozes off (docs/COMPANION_PLAN.md §2.3; §13.3, M1): sat idle with nothing
 * going on for a while he curls up, and the cursor coming near, a bubble, an alert or a
 * drag sits him up again. Kept apart from companion-window.ts so it can be tested
 * without Electron. Coordinates are DIPs, like companion-window-pure.ts.
 */
import type { CompanionPetState } from './companion-types'
import { dogRect, type Point, type Rect } from './companion-window-pure'

/** Idle this long, with nothing else going on, and he dozes off. */
export const DOZE_AFTER_MS = 90_000

/** The cursor within this of the dog wakes him, and keeps him from dozing. */
export const WAKE_RADIUS = 150

/** Everything that keeps the dog awake. */
export interface DozeConditions {
  visible: boolean
  petState: CompanionPetState
  /** The bubble is up, in any mode. */
  bubbleOpen: boolean
  /** A reminder or catch-up is queued behind the bubble. */
  alertsPending: boolean
  /** Quiet mode: he is already curled up as `shh`, which is not dozing. */
  dnd: boolean
  cursorNear: boolean
  dragging: boolean
  /** Dictation is recording or transcribing. */
  voiceBusy: boolean
}

/** Only an idle dog with nothing happening around him dozes off. */
export function canDoze(c: DozeConditions): boolean {
  return (
    c.visible &&
    c.petState === 'idle' &&
    !c.bubbleOpen &&
    !c.alertsPending &&
    !c.dnd &&
    !c.cursorNear &&
    !c.dragging &&
    !c.voiceBusy
  )
}

/** A dozing dog sits up when something comes his way. */
export function shouldWake(c: DozeConditions): boolean {
  return c.petState === 'dozing' && (c.cursorNear || c.bubbleOpen || c.alertsPending || c.dragging || !c.visible)
}

/** Whether the cursor is within `radius` of the dog's rect (not the window's). */
export function cursorNearPet(cursor: Point, pet: Rect, radius = WAKE_RADIUS): boolean {
  const d = dogRect(pet)
  const dx = Math.max(d.x - cursor.x, 0, cursor.x - (d.x + d.width))
  const dy = Math.max(d.y - cursor.y, 0, cursor.y - (d.y + d.height))
  return dx * dx + dy * dy <= radius * radius
}
