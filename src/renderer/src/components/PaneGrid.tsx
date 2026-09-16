import { Fragment, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
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

/** Layouts this component can actually draw. `grid-2x2`/`main-side` land in a later batch. */
const COLUMN_LAYOUTS: LayoutId[] = ['single', 'cols-2', 'cols-3']

/**
 * Grid template per layout, as a function of how many panes are *really* on screen.
 *
 * Taking the visible count rather than `capacity(layout)` is not a micro-optimisation: closing
 * a pane keeps the layout (see `closePane`), so a single pane under `cols-2` is a normal state,
 * and a template built from the capacity would hand half the window to nothing. Adding
 * `grid-2x2` or `main-side` is one more entry here, not a rewrite.
 */
const TEMPLATE: Record<LayoutId, (visible: number) => CSSProperties> = {
  single: () => ({ gridTemplateColumns: '1fr' }),
  'cols-2': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` }),
  'cols-3': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` }),
  // Not offered anywhere yet, but `openInNewPane` can auto-grow into `grid-2x2`,
  // so these must still render something sane rather than an undefined template: full-height
  // columns, which is what the other layouts do. Replace with the real shapes when that batch
  // lands (`grid-2x2`: two columns × two rows; `main-side`: a wide pane plus a side column).
  'grid-2x2': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` }),
  'main-side': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` })
}

function equalFractions(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
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
  // Only the layouts this component actually draws as real columns get draggable
  // dividers — `grid-2x2`/`main-side` still fall back to `TEMPLATE`'s `repeat(n, 1fr)`.
  const isColumnLayout = COLUMN_LAYOUTS.includes(layout)

  const gridRef = useRef<HTMLDivElement>(null)

  // The committed fractions: the persisted `sizes.cols` when it actually matches the
  // number of panes on screen, equal fractions otherwise (first run, or a layout/pane-count
  // change that made the lib drop `sizes.cols` — see `dropAxis` in `lib/panes.ts`).
  const committedCols = useMemo(() => {
    if (!isColumnLayout || visible <= 0) return null
    const stored = sizes?.cols
    return stored && stored.length === visible ? stored : equalFractions(visible)
  }, [isColumnLayout, visible, sizes])

  // Live drag preview: while a splitter is held, this overrides `committedCols` for
  // rendering only — `usePanes`/localStorage never see an intermediate value, just the
  // fractions from the moment the mouse is released (see `PaneSplitter`'s `onCommit`).
  const [liveCols, setLiveCols] = useState<number[] | null>(null)
  const displayCols =
    liveCols && committedCols && liveCols.length === committedCols.length ? liveCols : committedCols

  const style: CSSProperties =
    isColumnLayout && displayCols
      ? { gridTemplateColumns: displayCols.map((f) => `${f}fr`).join(' 5px ') }
      : TEMPLATE[layout](Math.max(visible, 1))

  // One pane is the app as it has always been: no per-pane chrome at all, so nothing shifts
  // by a pixel for someone who never splits. Neither the header nor the focus ring means
  // anything until there are two panes and "which one am I looking at" becomes a question.
  const showHeads = panes.length > 1

  // ── Dropping a chat from the sidebar ───────────────────────────────────────
  // A new pane may only be born into a layout this component can draw, so the ceiling is the
  // widest column layout, not `capacity(grid-2x2)`: `openInNewPane` would happily grow into a
  // 2×2 the grid still renders as three columns plus a guess.
  const maxPanes = capacity(COLUMN_LAYOUTS[COLUMN_LAYOUTS.length - 1])
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

  const kindAt = (e: DragEvent, el: HTMLElement): DropKind =>
    dropKindAt(e.clientX, el.getBoundingClientRect(), canSplit)

  return (
    <div
      className={`pane-grid ${showHeads ? 'split' : ''} ${isColumnLayout ? 'pane-grid-dividers' : ''}`}
      style={style}
      ref={gridRef}
    >
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
          <Fragment key={pane.sessionId}>
            {i > 0 && isColumnLayout && displayCols && (
              <PaneSplitter
                gridRef={gridRef}
                index={i - 1}
                sizes={displayCols}
                onChange={setLiveCols}
                onCommit={(next) => {
                  setLiveCols(null)
                  onSetSizes({ cols: next })
                }}
              />
            )}
            <div
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
                <div
                  className="pane-drop-zone"
                  style={{ left: `${box.left * 100}%`, width: `${box.width * 100}%` }}
                  aria-hidden="true"
                >
                  <span className="pane-drop-label">{zone.label}</span>
                </div>
              )}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
