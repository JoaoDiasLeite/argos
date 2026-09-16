import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import ChatPane from './ChatPane'
import PaneSplitter from './PaneSplitter'
import { capacity, type LayoutId, type Pane, type PaneState } from '../lib/panes'
import {
  dropKindAt,
  dropLabel,
  highlightRect,
  planDrop,
  SESSION_DRAG_TYPE,
  type DropKind,
  type DropPlan
} from '../lib/pane-drop'
import type { SessionPaneApi } from '../hooks/useSessionPane'
import './PaneGrid.css'

/**
 * The visible half of the pane model: turns `PaneState` into a CSS grid of `<ChatPane>`s.
 *
 * It owns no state. Every interaction (focus, close, drop) is reported up to the App, which
 * feeds it back through `usePanes` — the same one-way flow `lib/panes.ts` was written for. In
 * particular the grid never decides that a session is open twice: it renders the pane list it
 * is given, and the lib guarantees that list holds each session at most once (two
 * `<ChatTerminal>`s on one pty would fight over `fit()` forever).
 *
 * The one piece of state it does own is the drop preview, which is pure UI: it lives and dies
 * inside a single drag and never means anything to anyone else.
 */

/** Width of a divider track, in px. Kept here because the templates are built from it. */
const SPLITTER_PX = 5

type Axis = 'cols' | 'rows'

/**
 * How many tracks each axis has *on screen*, per layout.
 *
 * Deliberately a function of how many panes are really visible and not of
 * `capacity(layout)`: closing a pane keeps the layout (see `closePane`), so a single pane
 * under `cols-2` is a normal state, and a template built from the capacity would hand half
 * the window to nothing.
 *
 * This mirrors the private `tracks()` in `lib/panes.ts` — it has to, because that is what
 * decides whether a stored axis survives a layout change. Drifting from it would mean the
 * lib keeps fractions this component then draws against a different number of tracks.
 */
function trackCounts(layout: LayoutId, visible: number): Record<Axis, number> {
  if (visible <= 0) return { cols: 0, rows: 0 }
  if (layout === 'grid-2x2') {
    // Row-major, so the third pane is the one that opens the second row.
    return { cols: Math.min(visible, 2), rows: Math.ceil(visible / 2) }
  }
  if (layout === 'main-side') {
    // Pane 0 owns a full-height column; every other pane stacks in the second one.
    return { cols: Math.min(visible, 2), rows: Math.max(1, visible - 1) }
  }
  return { cols: visible, rows: 1 }
}

/**
 * The CSS grid line where pane track `t` (1-based) starts.
 *
 * Dividers are real grid items on tracks of their own — a 5px track between every pair of
 * pane tracks — rather than a gap the background shows through, so pane track `t` sits on
 * the odd line `2t - 1` and the divider before it on the even line `2t - 2`.
 */
function line(t: number): number {
  return 2 * t - 1
}

/** Where pane `i` sits, in explicit grid lines. */
function panePlacement(layout: LayoutId, visible: number, i: number): CSSProperties {
  if (layout === 'grid-2x2') {
    const col = (i % 2) + 1
    const row = Math.floor(i / 2) + 1
    // Three panes in a 2×2 would leave a hole beside the last one. Letting it span the
    // whole bottom row keeps the grid full without inventing a layout: it collapses back
    // into its quadrant the moment a fourth pane arrives.
    const spansRow = visible === 3 && i === 2
    return {
      gridColumn: spansRow ? `${line(1)} / -1` : `${line(col)} / span 1`,
      gridRow: `${line(row)} / span 1`
    }
  }
  if (layout === 'main-side') {
    // Index 0 is the big pane — see the pane-order note in `lib/panes.ts`. It only claims
    // the full height once something is actually stacked beside it; with two panes the
    // layout is just two columns, and a `1 / -1` span there would be a lie about the shape.
    if (i === 0) {
      return {
        gridColumn: `${line(1)} / span 1`,
        gridRow: visible >= 3 ? `${line(1)} / -1` : `${line(1)} / span 1`
      }
    }
    return { gridColumn: `${line(2)} / span 1`, gridRow: `${line(i)} / span 1` }
  }
  return { gridColumn: `${line(i + 1)} / span 1`, gridRow: `${line(1)} / span 1` }
}

/** A divider: which axis it redistributes, which boundary of it, and where it is drawn. */
interface SplitterSpec {
  axis: Axis
  /** Between fractions `index` and `index + 1` of that axis. */
  index: number
  style: CSSProperties
}

function splitterSpecs(layout: LayoutId, visible: number): SplitterSpec[] {
  const { cols, rows } = trackCounts(layout, visible)
  const specs: SplitterSpec[] = []

  if (layout === 'grid-2x2' || layout === 'main-side') {
    // The grid family has at most one boundary per axis (both are 2×2 at the widest), so
    // each axis gets one divider rather than a loop.
    if (cols >= 2) {
      // In a three-pane 2×2 the bottom row is one full-width pane, so the column divider
      // has to stop above it instead of cutting it in half.
      const stopsShort = layout === 'grid-2x2' && visible === 3
      specs.push({
        axis: 'cols',
        index: 0,
        style: {
          gridColumn: `${line(1) + 1} / span 1`,
          gridRow: stopsShort ? `${line(1)} / ${line(2)}` : '1 / -1'
        }
      })
    }
    if (rows >= 2) {
      // In `main-side` only the side column is stacked — the big pane owns the full
      // height — so the row divider lives inside that column and nowhere else.
      specs.push({
        axis: 'rows',
        index: 0,
        style: {
          gridRow: `${line(1) + 1} / span 1`,
          gridColumn: layout === 'main-side' ? `${line(2)} / -1` : '1 / -1'
        }
      })
    }
    return specs
  }

  for (let i = 1; i < cols; i++) {
    specs.push({
      axis: 'cols',
      index: i - 1,
      style: { gridColumn: `${line(i) + 1} / span 1`, gridRow: '1 / -1' }
    })
  }
  return specs
}

function equalFractions(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

/** `f1 5px f2 5px f3` — the fractions with a divider track between each pair. */
function template(fractions: number[]): string {
  return fractions.map((f) => `${f}fr`).join(` ${SPLITTER_PX}px `)
}

/** Is this a chat being dragged out of the sidebar? See `SESSION_DRAG_TYPE`. */
function isSessionDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)
}

export default function PaneGrid({
  panes,
  layout,
  focused,
  sizes,
  api,
  draggingSessionId,
  onFocus,
  onClose,
  onSetSizes,
  onDropSession
}: {
  panes: Pane[]
  layout: LayoutId
  focused: string
  /** Persisted column/row fractions — see `lib/panes.ts`. Absent/mismatched means equal panes. */
  sizes: PaneState['sizes']
  api: SessionPaneApi
  /** The chat currently being dragged out of the sidebar, if any. */
  draggingSessionId: string | null
  /** A pane took DOM focus — make it the focused pane. Never the other way around. */
  onFocus: (sessionId: string) => void
  /** Drop the pane from the layout. Does NOT end the session or its pty. */
  onClose: (sessionId: string) => void
  /** A splitter was dragged and released — persist the resulting fractions. */
  onSetSizes: (sizes: { cols?: number[]; rows?: number[] }) => void
  /** A chat was dropped on a pane. The plan is already resolved — just apply it. */
  onDropSession: (plan: DropPlan, sessionId: string) => void
}) {
  const visible = Math.min(capacity(layout), panes.length)

  const gridRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(() => trackCounts(layout, Math.max(visible, 1)), [layout, visible])
  const splitters = useMemo(
    () => splitterSpecs(layout, Math.max(visible, 1)),
    [layout, visible]
  )

  // The committed fractions per axis: the persisted ones when they match the number of
  // tracks that axis actually has on screen, equal fractions otherwise (first run, or a
  // layout/pane-count change that made the lib drop the axis — see `dropStaleSizes`).
  //
  // Matched against the *track* count, not the pane count: in the grid layouts four panes
  // share two columns. Worth knowing: `normalize` in `lib/panes.ts` validates a restored
  // axis against the pane count instead, so a grid layout's fractions are dropped on
  // reload — the dividers work for the session and then come back equal. Fixing that is a
  // one-line change in the lib (validate against tracks), not something this file can do.
  const committed = useMemo(
    () => ({
      cols:
        sizes?.cols?.length === counts.cols ? sizes.cols : equalFractions(Math.max(counts.cols, 1)),
      rows:
        sizes?.rows?.length === counts.rows ? sizes.rows : equalFractions(Math.max(counts.rows, 1))
    }),
    [counts, sizes]
  )

  // Live drag preview: while a splitter is held, this overrides `committed` for rendering
  // only — `usePanes`/localStorage never see an intermediate value, just the fractions from
  // the moment the mouse is released (see `PaneSplitter`'s `onCommit`). One axis at a time,
  // because one divider is dragged at a time.
  const [live, setLive] = useState<{ axis: Axis; values: number[] } | null>(null)
  const display: Record<Axis, number[]> = {
    cols:
      live?.axis === 'cols' && live.values.length === committed.cols.length
        ? live.values
        : committed.cols,
    rows:
      live?.axis === 'rows' && live.values.length === committed.rows.length
        ? live.values
        : committed.rows
  }

  const style: CSSProperties = {
    gridTemplateColumns: template(display.cols),
    gridTemplateRows: template(display.rows)
  }

  // `setSizes` in the lib replaces the whole `sizes` object, so a commit has to carry both
  // axes or dragging a column would silently wipe the rows the user had already set. An
  // axis with a single track has nothing to say and is left out — the lib drops empty axes
  // anyway, and storing `[1]` would only be noise.
  const commitAxis = (axis: Axis, values: number[]) => {
    setLive(null)
    const next = { ...display, [axis]: values }
    onSetSizes({
      ...(next.cols.length > 1 ? { cols: next.cols } : {}),
      ...(next.rows.length > 1 ? { rows: next.rows } : {})
    })
  }

  // One pane is the app as it has always been: no per-pane chrome at all, so nothing shifts
  // by a pixel for someone who never splits. Neither the header nor the focus ring means
  // anything until there are two panes and "which one am I looking at" becomes a question.
  const showHeads = panes.length > 1

  // ── Dropping a chat from the sidebar ───────────────────────────────────────
  // A new pane may only be born into a layout this component can draw. That used to cap the
  // ceiling at three (the widest column layout) because the grid family was still drawn as
  // columns; now that it is drawn properly, the ceiling is the widest layout there is.
  // `planDrop` still refuses a *side* drop onto three panes on its own — a fourth column is
  // not a layout that exists — so this only opens the fourth pane to the vertical zones.
  const maxPanes = capacity('grid-2x2')
  const canSplit = panes.length < maxPanes
  const paneIds = panes.slice(0, visible).map((p) => p.sessionId)

  // Which pane is under the cursor, and where inside it. Only the hovered pane lights up:
  // the highlight answers "where does *this* drop land", and every pane shouting at once
  // would answer nothing.
  const [over, setOver] = useState<{ index: number; kind: DropKind } | null>(null)

  // `dragenter`/`dragleave` fire for every child the cursor crosses (the chat, the composer,
  // the terminal), so a plain `dragleave` handler would blink the highlight off dozens of
  // times inside one pane. Counting enters against leaves per pane — the same trick `Chat`
  // uses for its file drop — means the highlight only clears when the count really returns
  // to zero, i.e. when the cursor has left the pane itself.
  const dragDepth = useRef(new Map<number, number>())
  const resetDrag = () => {
    dragDepth.current.clear()
    setOver(null)
  }

  // A chat already on screen cannot be opened twice (see `planDrop`), so instead of lying with
  // a zone preview we point at the pane where it already lives.
  const alreadyOpenIndex = draggingSessionId ? paneIds.indexOf(draggingSessionId) : -1

  // `clientY` — and with it the whole vertical axis of `dropKindAt` — is withheld while a
  // single pane is open, on purpose. The rule in `planDrop` degrades a vertical drop on one
  // pane to `cols-2`, so that a misaimed drag is never simply lost; but the zone would have
  // said "Open in grid" and then handed over a side-by-side split. Promising one thing and
  // delivering another is worse than not offering it, so with one pane the gesture stays
  // exactly what it has always been: left third, right third, centre.
  const kindAt = (e: DragEvent, el: HTMLElement): DropKind =>
    dropKindAt(
      e.clientX,
      el.getBoundingClientRect(),
      canSplit,
      panes.length >= 2 ? e.clientY : undefined
    )

  return (
    <div className={`pane-grid ${showHeads ? 'split' : ''}`} style={style} ref={gridRef}>
      {panes.slice(0, visible).map((pane, i) => {
        const isFocused = pane.sessionId === focused
        const name = api.sessions.find((s) => s.id === pane.sessionId)?.name ?? 'Chat'
        // Gated on an actual drag in flight: a `dragend` outside the grid (cancelled drag,
        // dropped on the sidebar) never reaches the pane's own handlers, so `over` can outlive
        // the drag that set it.
        const zone = !draggingSessionId
          ? null
          : alreadyOpenIndex !== -1
            ? alreadyOpenIndex === i
              ? { kind: 'center' as DropKind, label: 'Already open' }
              : null
            : over?.index === i
              ? { kind: over.kind, label: dropLabel(over.kind) }
              : null
        const box = zone ? highlightRect(zone.kind) : null
        return (
          /* Keyed by sessionId, and placed by explicit grid lines rather than by document
             order, so a pane inserted in the middle is reconciled into its new slot instead
             of being unmounted and remounted — a remount would restart its xterm. */
          <div
            key={pane.sessionId}
            style={panePlacement(layout, Math.max(visible, 1), i)}
            className={`pane ${isFocused ? 'focused' : ''}`}
            aria-current={isFocused ? 'true' : undefined}
            /* `focusin` bubbles and `focus` does not, and React's onFocus is a bubbling
               synthetic event — but the capture variant is what reliably catches xterm's
               hidden textarea taking focus from inside the terminal. */
            onFocusCapture={() => {
              if (!isFocused) onFocus(pane.sessionId)
            }}
            /* Capture phase on purpose: ChatTerminal swallows right-button mousedown on its
               host in capture with stopPropagation, so a bubble-phase handler here would
               never see a right-click — and right-clicking a terminal is exactly the moment
               the user means "this pane". */
            onMouseDownCapture={() => {
              if (!isFocused) onFocus(pane.sessionId)
            }}
            onDragEnter={(e) => {
              if (!isSessionDrag(e)) return
              e.preventDefault()
              dragDepth.current.set(i, (dragDepth.current.get(i) ?? 0) + 1)
            }}
            onDragOver={(e) => {
              if (!isSessionDrag(e)) return
              // Without this the drop never happens: the default is to refuse.
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const kind = kindAt(e, e.currentTarget)
              setOver((prev) =>
                prev && prev.index === i && prev.kind === kind ? prev : { index: i, kind }
              )
            }}
            onDragLeave={(e) => {
              if (!isSessionDrag(e)) return
              const depth = (dragDepth.current.get(i) ?? 0) - 1
              dragDepth.current.set(i, Math.max(0, depth))
              if (depth <= 0) setOver((prev) => (prev?.index === i ? null : prev))
            }}
            onDrop={(e) => {
              if (!isSessionDrag(e)) return
              e.preventDefault()
              const kind = kindAt(e, e.currentTarget)
              resetDrag()
              const sessionId = e.dataTransfer.getData(SESSION_DRAG_TYPE)
              if (!sessionId) return
              onDropSession(
                planDrop({ paneIds, targetIndex: i, sessionId, kind, maxPanes }),
                sessionId
              )
            }}
          >
            {showHeads && (
              <div className="pane-head">
                <span className="pane-head-name" title={name}>
                  {name}
                </span>
                <button
                  className="pane-head-close"
                  /* Removes the pane, nothing else: the CLI keeps running and the chat keeps
                     existing. Ending a terminal is the close button inside Chat, which is a
                     different and deliberately more destructive thing. */
                  onClick={() => onClose(pane.sessionId)}
                  title="Close pane (the chat keeps running)"
                  aria-label={`Close pane ${name}`}
                >
                  ×
                </button>
              </div>
            )}
            {/* `showHeads` is exactly "more than one pane on screen" — the same condition
                that draws `.pane-head` below, so the two never disagree about whether the
                name is already on screen once. */}
            <ChatPane sessionId={pane.sessionId} api={api} titleInHeader={showHeads} />
            {zone && box && (
              /* `pointer-events: none` is load-bearing: the overlay sits over the pane it is
                 describing, and a hit-testable overlay would steal the very `dragover` that
                 keeps it alive — the highlight would flicker itself out of existence. */
              /* Both axes now: a vertical drop halves the pane horizontally, so a
                 full-height highlight would describe the wrong thing. The halves are the
                 honest approximation `highlightRect` documents — in `main-side` the new
                 pane may end up with a quarter or with a whole column, and drawing that
                 exactly would mean overlaying the *grid* with the destination geometry
                 rather than overlaying the pane that was aimed at. */
              <div
                className="pane-drop-zone"
                style={{
                  left: `${box.left * 100}%`,
                  width: `${box.width * 100}%`,
                  top: `${box.top * 100}%`,
                  height: `${box.height * 100}%`
                }}
                aria-hidden="true"
              >
                <span className="pane-drop-label">{zone.label}</span>
              </div>
            )}
          </div>
        )
      })}
      {/* Dividers come after the panes in document order and are positioned by explicit grid
          lines, so the pane list above stays a flat, sessionId-keyed array. */}
      {splitters.map((spec) => (
        <PaneSplitter
          key={`${spec.axis}-${spec.index}`}
          gridRef={gridRef}
          axis={spec.axis}
          index={spec.index}
          sizes={display[spec.axis]}
          style={spec.style}
          onChange={(values) => setLive({ axis: spec.axis, values })}
          onCommit={(values) => commitAxis(spec.axis, values)}
        />
      ))}
    </div>
  )
}
