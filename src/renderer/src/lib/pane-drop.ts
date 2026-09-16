// Where a conversation dragged from the sidebar is going to land.
//
// Kept out of the handlers on purpose, and without React/DOM, for the same reason as
// `lib/panes.ts`: "left third of pane 1 with three panes open" is a rule that
// has to be testable without mounting a grid or simulating a drag.
// The handlers keep only what only they can do — read the mouse and the rect.

/**
 * The MIME type of the drag. Custom on purpose: `Chat` accepts files
 * dropped on the composer and tells them apart by `dataTransfer.types` containing
 * 'Files'. With a type of our own, a conversation drag never gets confused with a
 * file one — not even while it's passing over the composer on its way to the pane.
 */
export const SESSION_DRAG_TYPE = 'application/x-argos-session'

/** Which third of the pane the cursor is in. 'center' = replace the pane's session. */
export type DropKind = 'left' | 'center' | 'right'

/**
 * What the drop means for pane state. Deliberately described
 * in terms of the `lib/panes.ts` model (pane indices), not in terms of the
 * gesture: whoever applies this composes the lib's functions, and from this point
 * on it no longer matters which third it came from.
 */
export type DropPlan =
  /** Already in this pane: do nothing. */
  | { type: 'none' }
  /** Already in another pane: just move focus. Never duplicate (two terminals on one pty). */
  | { type: 'focus'; sessionId: string }
  /** "Open here": swaps the session of pane `index`. */
  | { type: 'replace'; index: number }
  /** "Open in split view": new pane at position `index`. */
  | { type: 'insert'; index: number }

/** Width of each side zone, as a fraction of the pane. The center takes the rest. */
const SIDE_FRACTION = 1 / 3

/**
 * Which zone of the pane `clientX` falls into.
 *
 * `canSplit` false (no more capacity for panes) collapses everything into the
 * center: better a whole pane lit up saying "Open here" than side zones that
 * light up and then don't deliver on what they promised.
 */
export function dropKindAt(
  clientX: number,
  rect: { left: number; width: number },
  canSplit: boolean
): DropKind {
  if (!canSplit || rect.width <= 0) return 'center'
  // Compared in pixels, not fractions: `1 - 1/3` is not `2/3` in floating point, and the
  // right edge of a 300px pane was landing on the wrong side by a 1e-16 error.
  const side = rect.width * SIDE_FRACTION
  if (clientX < rect.left + side) return 'left'
  if (clientX >= rect.left + rect.width - side) return 'right'
  return 'center'
}

/**
 * The area the highlight has to cover, as fractions of the pane (0..1).
 *
 * It's not the hit zone, it's the destination: the left third opens a new pane
 * that will end up with half the space, so the highlight takes half. Showing just
 * the third would misrepresent the size of what's about to appear.
 */
export function highlightRect(kind: DropKind): { left: number; width: number } {
  if (kind === 'left') return { left: 0, width: 0.5 }
  if (kind === 'right') return { left: 0.5, width: 0.5 }
  return { left: 0, width: 1 }
}

export function dropLabel(kind: DropKind): string {
  return kind === 'center' ? 'Open here' : 'Open in split view'
}

/**
 * The whole rule: given what's open, where it was dropped and in which zone, what to do.
 *
 * `maxPanes` is the capacity of the widest layout `PaneGrid` knows how to draw,
 * not the current layout's — `openInNewPane` is the one that steps up a level on its
 * own. A side drop with no room falls back to 'replace' instead of getting lost: the UI
 * no longer offers it (see `dropKindAt`), but the rule can't depend on the UI getting it right.
 */
export function planDrop(args: {
  /** The panes' sessions, in on-screen order. */
  paneIds: string[]
  /** The index of the pane it was dropped on. */
  targetIndex: number
  /** The dragged session. */
  sessionId: string
  kind: DropKind
  maxPanes: number
}): DropPlan {
  const { paneIds, targetIndex, sessionId, kind, maxPanes } = args

  if (paneIds.length === 0) {
    // Empty state (welcome pane): nothing to replace and no side to speak of.
    return { type: 'insert', index: 0 }
  }

  const openIndex = paneIds.indexOf(sessionId)
  if (openIndex !== -1) {
    // Hard invariant: a session lives in at most one pane. Dropping it again
    // is a request for attention, not a copy.
    return openIndex === targetIndex ? { type: 'none' } : { type: 'focus', sessionId }
  }

  if (kind === 'center' || paneIds.length >= maxPanes) {
    return { type: 'replace', index: targetIndex }
  }

  return { type: 'insert', index: kind === 'left' ? targetIndex : targetIndex + 1 }
}
