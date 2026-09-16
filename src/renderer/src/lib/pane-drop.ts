// Where a conversation dragged from the sidebar is going to land.
//
// Kept out of the handlers on purpose, and without React/DOM, for the same reason as
// `lib/panes.ts`: "left third of pane 1 with three panes open" is a rule that
// has to be testable without mounting a grid or simulating a drag.
// The handlers keep only what only they can do — read the mouse and the rect.

import type { LayoutId } from './panes'

/**
 * The MIME type of the drag. Custom on purpose: `Chat` accepts files
 * dropped on the composer and tells them apart by `dataTransfer.types` containing
 * 'Files'. With a type of our own, a conversation drag never gets confused with a
 * file one — not even while it's passing over the composer on its way to the pane.
 */
export const SESSION_DRAG_TYPE = 'application/x-argos-session'

/**
 * Which zone of the pane the cursor is in. 'center' = replace the pane's session;
 * 'left'/'right' add a column; 'top'/'bottom' stack, which is what makes the grid
 * layouts reachable by dragging.
 */
export type DropKind = 'left' | 'center' | 'right' | 'top' | 'bottom'

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
  /**
   * "Open in split view": new pane at position `index`, in `layout`.
   *
   * The layout travels with the plan because the gesture is what chooses it — a
   * side zone means columns and a vertical one means the grid family, and neither
   * can be inferred afterwards from the pane count alone (three panes are either
   * `cols-3` or `main-side`). `insertPane` in `lib/panes.ts` applies both.
   */
  | { type: 'insert'; index: number; layout: LayoutId }

/** Width of each side zone, as a fraction of the pane. The center takes the rest. */
const SIDE_FRACTION = 1 / 3

/**
 * Height of the top and bottom zones, as a fraction of the pane — but only inside
 * the central band, never across the full width (see `dropKindAt`).
 */
const STACK_FRACTION = 1 / 3

/** Column layouts by resulting pane count: 1 -> single, 2 -> cols-2, 3 -> cols-3. */
const COLUMN_LAYOUTS: LayoutId[] = ['single', 'cols-2', 'cols-3']

/**
 * The widest column layout there is. A fourth pane has no column shape to go into,
 * so a side drop onto three panes has nowhere to insert and falls back to a
 * replacement — the grid is reached through the vertical zones, on purpose.
 */
const MAX_COLUMN_PANES = COLUMN_LAYOUTS.length

/**
 * Which zone of the pane the cursor falls into.
 *
 * The split, and why it is asymmetric:
 *
 *     ┌────────┬────────┬────────┐
 *     │        │  top   │        │   columns: outer thirds, full height
 *     │  left  ├────────┤ right  │   stack:   middle third only, outer thirds of it
 *     │        │ center │        │
 *     │        ├────────┤        │
 *     │        │ bottom │        │
 *     └────────┴────────┴────────┘
 *
 * The vertical zones live *inside* the central band instead of spanning the pane,
 * so the side zones keep exactly the hit area they always had. Columns are the
 * common case and have to stay easy to hit with a moving cursor; the grid costs
 * height, which is the scarce resource (a quadrant of a 1080p screen leaves the
 * CLI's TUI about 27 lines), so it should be somewhere you aim at and never
 * somewhere you land by accident. That also keeps the centre — "replace" — from
 * shrinking to a sliver: it still owns the middle of the middle.
 *
 * `clientY` is optional because a caller that only deals in columns can leave it
 * out and never see a vertical zone; without it (or without a height) the pane is
 * read as one horizontal band, exactly as before.
 *
 * `canSplit` false (no more capacity for panes) collapses everything into the
 * center — vertical zones included: better a whole pane lit up saying "Open here"
 * than zones that light up and then don't deliver on what they promised.
 */
export function dropKindAt(
  clientX: number,
  rect: { left: number; width: number; top?: number; height?: number },
  canSplit: boolean,
  clientY?: number
): DropKind {
  if (!canSplit || rect.width <= 0) return 'center'
  // Compared in pixels, not fractions: `1 - 1/3` is not `2/3` in floating point, and the
  // right edge of a 300px pane was landing on the wrong side by a 1e-16 error.
  const side = rect.width * SIDE_FRACTION
  if (clientX < rect.left + side) return 'left'
  if (clientX >= rect.left + rect.width - side) return 'right'

  const height = rect.height ?? 0
  if (clientY === undefined || height <= 0) return 'center'
  // Same pixel comparison as above, for the same reason.
  const band = height * STACK_FRACTION
  const top = rect.top ?? 0
  if (clientY < top + band) return 'top'
  if (clientY >= top + height - band) return 'bottom'
  return 'center'
}

/**
 * The area the highlight has to cover, as fractions of the pane (0..1), on both
 * axes now that a drop can halve the pane horizontally.
 *
 * It's not the hit zone, it's the destination: the left third opens a new pane
 * that will end up with half the space, so the highlight takes the left half — and
 * a top drop takes the top half, even though it was aimed at a third of the middle
 * band. Showing just the zone would misrepresent the size of what's about to
 * appear. The halves are an honest approximation rather than a promise: in
 * `main-side` the new pane may end up with a quarter or with a full column,
 * depending on where it lands, and drawing that exactly would mean teaching this
 * function the whole geometry of every layout.
 */
export function highlightRect(kind: DropKind): {
  left: number
  width: number
  top: number
  height: number
} {
  if (kind === 'left') return { left: 0, width: 0.5, top: 0, height: 1 }
  if (kind === 'right') return { left: 0.5, width: 0.5, top: 0, height: 1 }
  if (kind === 'top') return { left: 0, width: 1, top: 0, height: 0.5 }
  if (kind === 'bottom') return { left: 0, width: 1, top: 0.5, height: 0.5 }
  return { left: 0, width: 1, top: 0, height: 1 }
}

export function dropLabel(kind: DropKind): string {
  if (kind === 'center') return 'Open here'
  // The vertical zones get a label of their own: the grid is the layout that
  // spends height, so it is worth naming before the drop instead of after it.
  if (kind === 'top' || kind === 'bottom') return 'Open in grid'
  return 'Open in split view'
}

/**
 * Which layout an insert produces, from the zone it came from and the number of
 * panes that will be on screen afterwards.
 *
 * Sides always mean columns. Vertical zones mean the grid family, whose shape is
 * decided by how many panes are left over: three is `main-side` (one big pane plus
 * two stacked beside it), four is `grid-2x2`. Below three there is no vertical
 * shape to give — a two-pane stack is not a layout this app draws — so the gesture
 * degrades to the pair of columns rather than refusing the drop and losing it. It
 * is the benign direction of the two: you aim at the grid and get a split, never
 * the reverse, and the rationale for the split (the grid is never fallen into by
 * accident) is preserved.
 */
function insertLayout(kind: DropKind, nextCount: number): LayoutId {
  if ((kind === 'top' || kind === 'bottom') && nextCount >= 3) {
    return nextCount >= 4 ? 'grid-2x2' : 'main-side'
  }
  return COLUMN_LAYOUTS[Math.min(nextCount, MAX_COLUMN_PANES) - 1]
}

/**
 * The whole rule: given what's open, where it was dropped and in which zone, what to do.
 *
 * `maxPanes` is the capacity of the widest layout `PaneGrid` knows how to draw,
 * not the current layout's — `openInNewPane` is the one that steps up a level on its
 * own. A drop with no room falls back to 'replace' instead of getting lost: the UI
 * no longer offers it (see `dropKindAt`), but the rule can't depend on the UI getting it right.
 * A side drop onto three panes falls back the same way even when `maxPanes` is 4,
 * because a fourth column is not a layout that exists.
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
    // Empty state (welcome pane): nothing to replace, and no zone to speak of.
    return { type: 'insert', index: 0, layout: 'single' }
  }

  const openIndex = paneIds.indexOf(sessionId)
  if (openIndex !== -1) {
    // Hard invariant: a session lives in at most one pane. Dropping it again
    // is a request for attention, not a copy.
    return openIndex === targetIndex ? { type: 'none' } : { type: 'focus', sessionId }
  }

  const vertical = kind === 'top' || kind === 'bottom'
  const ceiling = vertical ? maxPanes : Math.min(maxPanes, MAX_COLUMN_PANES)
  if (kind === 'center' || paneIds.length >= ceiling) {
    return { type: 'replace', index: targetIndex }
  }

  // 'top' and 'left' both mean "before this pane", 'bottom' and 'right' "after it".
  // In the grid layouts that reads as the pane order being row-major, which is the
  // convention `lib/panes.ts` documents for `grid-2x2` and `main-side`.
  const index = kind === 'left' || kind === 'top' ? targetIndex : targetIndex + 1
  return { type: 'insert', index, layout: insertLayout(kind, paneIds.length + 1) }
}
