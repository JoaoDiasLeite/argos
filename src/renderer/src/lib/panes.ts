// Pane state model (split/grid) and the pure functions that manipulate it.
//
// Deliberately kept without React, DOM, or localStorage: whoever persists it and
// wires it to the UI lives in another file (the `usePanes` hook, still to be
// written), so this module can be tested and reasoned about without mounting anything.

export type LayoutId = 'single' | 'cols-2' | 'cols-3' | 'grid-2x2' | 'main-side'

export interface Pane {
  sessionId: string
  /** Reserved: per-pane mode override. Not used yet — exists so we don't have to
   *  migrate the persisted key once we want a chat next to a terminal. */
  mode?: 'chat' | 'terminal'
}

export interface PaneState {
  v: 1
  layout: LayoutId
  /** Invariant: sessionId unique across all panes; length <= capacity(layout). */
  panes: Pane[]
  /** sessionId of the focused pane; '' when there are no panes. */
  focused: string
  /** Fractions per axis, normalized to sum to 1. Absent = equal panes. */
  sizes?: { cols?: number[]; rows?: number[] }
}

// Layout "step up" order used by openInNewPane — not plain capacity order
// (grid-2x2 and main-side tie at 4/3... actually main-side is left out
// because it isn't an automatic step, it's an explicit user choice).
//
// `main-side` pane order (the UI depends on this and so does `insertPane`):
// index 0 is the BIG pane — it owns a full-height column of its own — and indices
// 1 and 2 stack inside the side column, top to bottom. Index 0 was chosen because
// it is the one every other operation already privileges: `normalize` truncates
// from the end, `closePane` falls back towards the front, and a dropped-at-the-start
// insert lands there, so "first in the array" and "the one you are working in"
// already coincide.
//
// `grid-2x2` is row-major: 0 1 / 2 3.
const CAPACITY: Record<LayoutId, number> = {
  single: 1,
  'cols-2': 2,
  'cols-3': 3,
  'grid-2x2': 4,
  'main-side': 3
}

// Steps openInNewPane climbs on its own when it runs out of space. main-side is
// not among them: it also fits 3 panes like cols-3, but it's a layout with a shape
// of its own (one big pane + a side column) that only makes sense as an explicit choice.
const AUTO_GROW: LayoutId[] = ['single', 'cols-2', 'cols-3', 'grid-2x2']

export function capacity(layout: LayoutId): number {
  return CAPACITY[layout]
}

export function emptyState(): PaneState {
  return { v: 1, layout: 'single', panes: [], focused: '' }
}

export function openInFocused(state: PaneState, sessionId: string): PaneState {
  // Rule 1: an empty sessionId is the signal to "close everything", not a real session.
  if (sessionId === '') {
    return { ...state, panes: [], focused: '' }
  }

  const existingIndex = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (existingIndex !== -1) {
    // Rule 2: already open in another pane — don't duplicate, just focus it.
    return { ...state, focused: sessionId }
  }

  if (state.panes.length === 0) {
    // Rule 3: no panes, this is the first one.
    return { ...state, panes: [{ sessionId }], focused: sessionId }
  }

  // Rule 4: replace the focused pane's session, preserving its position.
  const focusedIndex = state.panes.findIndex((p) => p.sessionId === state.focused)
  const targetIndex = focusedIndex === -1 ? 0 : focusedIndex
  const panes = state.panes.map((p, i) => (i === targetIndex ? { ...p, sessionId } : p))
  return { ...state, panes, focused: sessionId }
}

export function openInNewPane(state: PaneState, sessionId: string): PaneState {
  const existingIndex = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (existingIndex !== -1) {
    // Same non-duplication rule as openInFocused: moving the focus is enough.
    return { ...state, focused: sessionId }
  }

  const before = shape(state)
  const cap = capacity(state.layout)
  if (state.panes.length < cap) {
    // The pane count changes: the stored fractions no longer describe this
    // layout, so there's no point trying to rescale them (see comment on dropStaleSizes).
    return dropStaleSizes(before, {
      ...state,
      panes: [...state.panes, { sessionId }],
      focused: sessionId
    })
  }

  // No room in the current layout: try climbing a step instead of sacrificing an
  // existing pane — that's what the user expects from "open in a new pane".
  const step = AUTO_GROW.indexOf(state.layout)
  const nextLayout = step !== -1 && step + 1 < AUTO_GROW.length ? AUTO_GROW[step + 1] : null
  if (nextLayout) {
    return dropStaleSizes(before, {
      ...state,
      layout: nextLayout,
      panes: [...state.panes, { sessionId }],
      focused: sessionId
    })
  }

  // Already at the max (or in a layout with no next step, like main-side): there's
  // nowhere to grow, so fall back to the same behavior as openInFocused.
  return openInFocused(state, sessionId)
}

/**
 * Opens `sessionId` in a brand-new pane at `index`, under the layout the caller
 * asks for.
 *
 * This is the drag-and-drop sibling of `openInNewPane`. The difference is who
 * decides the shape: `openInNewPane` appends at the end and climbs the AUTO_GROW
 * ladder on its own, because "open in a new pane" says nothing about where or how.
 * A drop does say it — which edge of which pane was aimed at — so the gesture
 * brings its own position and its own target layout (see `planDrop` in
 * `lib/pane-drop.ts`), and this function only applies them. That is the only way
 * `main-side` and `grid-2x2` are reachable: they are deliberately off the ladder.
 *
 * Invariants of the module are kept: a session never lives in two panes (an
 * already-open one is merely focused), and `sizes` is discarded on the axes the
 * new shape invalidates.
 */
export function insertPane(
  state: PaneState,
  sessionId: string,
  index: number,
  layout: LayoutId
): PaneState {
  const existingIndex = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (existingIndex !== -1) {
    // Same non-duplication rule as openInFocused/openInNewPane: focus is enough.
    return { ...state, focused: sessionId }
  }

  const before = shape(state)

  if (state.panes.length >= capacity(layout)) {
    // The caller asked for a layout that cannot hold one more pane. `planDrop`
    // already turns that case into a 'replace', so this is a guard and not a path
    // the gesture takes: replace in place rather than silently dropping the
    // request or growing past a capacity the grid cannot draw. The pane count does
    // not change, so the layout is left alone too — and `sizes` survives.
    // panes.length is at least 1 here: every layout has a capacity of 1 or more.
    const at = Math.min(Math.max(index, 0), state.panes.length - 1)
    const panes = state.panes.map((p, i) => (i === at ? { ...p, sessionId } : p))
    return { ...state, panes, focused: sessionId }
  }

  const at = Math.min(Math.max(index, 0), state.panes.length)
  const panes = [...state.panes.slice(0, at), { sessionId }, ...state.panes.slice(at)]
  return dropStaleSizes(before, { ...state, layout, panes, focused: sessionId })
}

export function closePane(state: PaneState, sessionId: string): PaneState {
  const index = state.panes.findIndex((p) => p.sessionId === sessionId)
  if (index === -1) {
    return state
  }

  const before = shape(state)
  const panes = state.panes.filter((_, i) => i !== index)

  if (panes.length === 0) {
    // Back to single: no panes left to justify a bigger layout.
    return dropStaleSizes(before, { ...state, panes, focused: '', layout: 'single' })
  }

  if (state.focused !== sessionId) {
    // The focus wasn't here, so there's nothing to recompute — but the pane count
    // still changed, and with it the number of tracks on both axes.
    return dropStaleSizes(before, { ...state, panes })
  }

  // The adjacent pane is the one before the removed one, or the first if it was index 0.
  const adjacentIndex = index === 0 ? 0 : index - 1
  return dropStaleSizes(before, { ...state, panes, focused: panes[adjacentIndex].sessionId })
}

export function setFocus(state: PaneState, sessionId: string): PaneState {
  const isOpen = state.panes.some((p) => p.sessionId === sessionId)
  if (!isOpen) {
    return state
  }
  return { ...state, focused: sessionId }
}

export function setLayout(state: PaneState, layout: LayoutId): PaneState {
  const before = shape(state)
  const cap = capacity(layout)
  if (state.panes.length <= cap) {
    // The number of visible panes doesn't change (only the layout around them can
    // grow), but the *shape* can: cols-3 → main-side keeps the three panes and
    // goes from one row to two. dropStaleSizes is the one that decides that, which
    // is why this is no longer a direct return.
    return dropStaleSizes(before, { ...state, layout })
  }

  const focusedIndex = state.panes.findIndex((p) => p.sessionId === state.focused)
  let panes: Pane[]
  if (focusedIndex !== -1 && focusedIndex >= cap) {
    // A plain truncation would leave the focused pane out — swap it with the last
    // pane that survives the truncation so it stays visible.
    panes = state.panes.slice(0, cap)
    panes[cap - 1] = state.panes[focusedIndex]
  } else {
    panes = state.panes.slice(0, cap)
  }

  const focused = panes.some((p) => p.sessionId === state.focused)
    ? state.focused
    : panes[0].sessionId

  // Here the pane count does change (truncation): the old fractions no longer
  // correspond to the new layout's number of tracks.
  return dropStaleSizes(before, { ...state, layout, panes, focused })
}

type Axis = keyof NonNullable<PaneState['sizes']>

const AXES: Axis[] = ['cols', 'rows']

/** The (layout, pane count) pair the grid's shape depends on. */
function shape(state: PaneState): { layout: LayoutId; paneCount: number } {
  return { layout: state.layout, paneCount: state.panes.length }
}

/**
 * How many tracks a layout has on each axis, for a given pane count.
 *
 * Column layouts are one column per pane and a single row; the grid family folds
 * the panes into two columns and grows downwards. This exists only to answer
 * "did this transition change the number of tracks on this axis?" — nothing is
 * drawn from it.
 */
function tracks(layout: LayoutId, paneCount: number): Record<Axis, number> {
  if (paneCount <= 0) return { cols: 0, rows: 0 }
  if (layout === 'grid-2x2') {
    // Row-major, so the third pane is the one that opens the second row.
    return { cols: Math.min(paneCount, 2), rows: Math.ceil(paneCount / 2) }
  }
  if (layout === 'main-side') {
    // Pane 0 owns a full-height column; every other pane stacks in the second one.
    return { cols: Math.min(paneCount, 2), rows: Math.max(1, paneCount - 1) }
  }
  return { cols: paneCount, rows: 1 }
}

/**
 * Discards, immutably, the axes of `sizes` a transition has invalidated.
 *
 * Two independent reasons to discard, either one enough:
 *  - the pane count changed — `normalize` only accepts an axis whose length
 *    matches the pane count, so a kept axis would be dropped on the next reload
 *    anyway, and until then the live state would disagree with the persisted one;
 *  - the number of tracks on that axis changed although the pane count did not,
 *    which is what the grid family introduced: cols-3 → main-side keeps the three
 *    panes but goes from three columns and one row to two columns and two rows.
 *
 * Discarding means "back to equal panes", never rescaling: rescaled fractions are
 * sizes nobody ever chose.
 */
function dropStaleSizes(
  before: { layout: LayoutId; paneCount: number },
  next: PaneState
): PaneState {
  if (!next.sizes) return next
  const from = tracks(before.layout, before.paneCount)
  const to = tracks(next.layout, next.panes.length)
  const countChanged = before.paneCount !== next.panes.length
  return dropAxes(
    next,
    AXES.filter((axis) => countChanged || from[axis] !== to[axis])
  )
}

function dropAxes(state: PaneState, axes: Axis[]): PaneState {
  if (!state.sizes || axes.length === 0) return state
  const rest = { ...state.sizes }
  let changed = false
  for (const axis of axes) {
    if (axis in rest) {
      delete rest[axis]
      changed = true
    }
  }
  if (!changed) return state
  if (Object.keys(rest).length === 0) {
    const { sizes: _sizes, ...withoutSizes } = state
    return withoutSizes
  }
  return { ...state, sizes: rest }
}

/** A valid axis: only finite numbers, all > 0, with the right length. */
function isValidAxis(value: unknown, expectedLength: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
  )
}

/** Normalizes an axis's sum to 1, preserving relative proportions. */
function normalizeAxis(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  return values.map((n) => n / sum)
}

/**
 * Pure and immutable: sets/replaces the fractions of one or both axes. Each
 * axis passed in is renormalized to sum to 1; an empty or absent axis is
 * removed instead of stored as `[]`, so that `normalize` doesn't have to
 * distinguish "no axis" from "empty axis" when restoring.
 */
export function setSizes(
  state: PaneState,
  sizes: { cols?: number[]; rows?: number[] }
): PaneState {
  const cols = sizes.cols && sizes.cols.length > 0 ? normalizeAxis(sizes.cols) : undefined
  const rows = sizes.rows && sizes.rows.length > 0 ? normalizeAxis(sizes.rows) : undefined
  const next: NonNullable<PaneState['sizes']> = {
    ...(cols ? { cols } : {}),
    ...(rows ? { rows } : {})
  }
  if (Object.keys(next).length === 0) {
    const { sizes: _sizes, ...withoutSizes } = state
    return withoutSizes
  }
  return { ...state, sizes: next }
}

export function normalize(state: unknown, knownSessionIds: string[]): PaneState {
  // Comes from localStorage: treat everything as potentially hostile and never throw.
  if (typeof state !== 'object' || state === null) {
    return emptyState()
  }

  const raw = state as Partial<PaneState>
  const layout: LayoutId = CAPACITY[raw.layout as LayoutId] ? (raw.layout as LayoutId) : 'single'
  const known = new Set(knownSessionIds)

  const rawPanes = Array.isArray(raw.panes) ? raw.panes : []
  const seen = new Set<string>()
  const panes: Pane[] = []
  for (const entry of rawPanes) {
    const sessionId = (entry as Partial<Pane> | null)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (!known.has(sessionId)) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    panes.push({ sessionId })
    if (panes.length >= capacity(layout)) break
  }

  if (panes.length === 0) {
    return emptyState()
  }

  const focused =
    typeof raw.focused === 'string' && panes.some((p) => p.sessionId === raw.focused)
      ? raw.focused
      : panes[0].sessionId

  // The axis is only accepted if it matches the pane count *after* the sanitizing
  // above (dedup, unknown sessions, capacity truncation) — validating against the
  // original `raw.panes.length` would let a misaligned axis through whenever the
  // sanitizing had dropped an entry. When it doesn't match, the axis is discarded
  // instead of guessed at: back to equal panes, the safe default behavior.
  const rawSizes = raw.sizes as Partial<{ cols: unknown; rows: unknown }> | null | undefined
  let sizes: PaneState['sizes'] | undefined
  if (rawSizes && typeof rawSizes === 'object') {
    // Against the TRACK count, not the pane count: in a grid four panes share two
    // columns, so validating against panes.length threw away every fraction a grid
    // layout had saved, and the splitters silently reset to equal on every restart.
    const trackCount = tracks(layout, panes.length)
    const cols = isValidAxis(rawSizes.cols, trackCount.cols)
      ? normalizeAxis(rawSizes.cols)
      : undefined
    const rows = isValidAxis(rawSizes.rows, trackCount.rows)
      ? normalizeAxis(rawSizes.rows)
      : undefined
    if (cols || rows) {
      sizes = { ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) }
    }
  }

  return sizes ? { v: 1, layout, panes, focused, sizes } : { v: 1, layout, panes, focused }
}
