import { Fragment, useMemo, useRef, useState, type CSSProperties } from 'react'
import ChatPane from './ChatPane'
import PaneSplitter from './PaneSplitter'
import { capacity, type LayoutId, type Pane, type PaneState } from '../lib/panes'
import type { SessionPaneApi } from '../hooks/useSessionPane'
import './PaneGrid.css'

/**
 * The visible half of the pane model: turns `PaneState` into a CSS grid of `<ChatPane>`s.
 *
 * It owns no state. Every interaction (focus, close, layout change, add) is reported up to
 * the App, which feeds it back through `usePanes` — the same one-way flow `lib/panes.ts` was
 * written for. In particular the grid never decides that a session is open twice: it renders
 * the pane list it is given, and the lib guarantees that list holds each session at most once
 * (two `<ChatTerminal>`s on one pty would fight over `fit()` forever).
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
  // Not offered by the layout picker yet, but `openInNewPane` can auto-grow into `grid-2x2`,
  // so these must still render something sane rather than an undefined template: full-height
  // columns, which is what the other layouts do. Replace with the real shapes when that batch
  // lands (`grid-2x2`: two columns × two rows; `main-side`: a wide pane plus a side column).
  'grid-2x2': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` }),
  'main-side': (n) => ({ gridTemplateColumns: `repeat(${n}, 1fr)` })
}

function equalFractions(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

export default function PaneGrid({
  panes,
  layout,
  focused,
  sizes,
  api,
  onFocus,
  onClose,
  onSetLayout,
  onSetSizes,
  onAddPane,
  canAddPane
}: {
  panes: Pane[]
  layout: LayoutId
  focused: string
  /** Persisted column/row fractions — see `lib/panes.ts`. Absent/mismatched means equal panes. */
  sizes: PaneState['sizes']
  api: SessionPaneApi
  /** A pane took DOM focus — make it the focused pane. Never the other way around. */
  onFocus: (sessionId: string) => void
  /** Drop the pane from the layout. Does NOT end the session or its pty. */
  onClose: (sessionId: string) => void
  onSetLayout: (layout: LayoutId) => void
  /** A splitter was dragged and released — persist the resulting fractions. */
  onSetSizes: (sizes: { cols?: number[]; rows?: number[] }) => void
  onAddPane: () => void
  /** Whether there is a chat left to put in a new pane — only the App can know. */
  canAddPane: boolean
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

  // The `+` needs either room in the current layout or a wider layout to grow into. The
  // ladder stops at the widest layout this component draws, so the button can never push
  // the state into a layout the grid would have to guess at.
  const widest = COLUMN_LAYOUTS[COLUMN_LAYOUTS.length - 1]
  // Room to grow AND something to put there: without the second half the button lit up
  // with every chat already on screen and then did nothing when pressed.
  const canAdd = canAddPane && (panes.length < capacity(layout) || capacity(layout) < capacity(widest))

  // One pane is the app as it has always been: no per-pane chrome at all, so nothing shifts
  // by a pixel for someone who never splits. Neither the header nor the focus ring means
  // anything until there are two panes and "which one am I looking at" becomes a question.
  const showHeads = panes.length > 1

  return (
    <>
      <div className="pane-bar">
        <div className="view-subnav-group">
          {COLUMN_LAYOUTS.map((id, i) => (
            <button
              key={id}
              className={`view-subnav-btn ${layout === id ? 'active' : ''}`}
              onClick={() => onSetLayout(id)}
              aria-pressed={layout === id}
              title={i === 0 ? 'One pane' : `${i + 1} columns`}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <button
          className="view-subnav-btn pane-bar-add"
          onClick={onAddPane}
          disabled={!canAdd}
          title={
            canAdd
              ? 'Open another chat in a new pane'
              : canAddPane
                ? 'No room for another pane'
                : 'Every chat is already on screen'
          }
          aria-label="Add pane"
        >
          +
        </button>
      </div>

      <div
        className={`pane-grid ${showHeads ? 'split' : ''} ${isColumnLayout ? 'pane-grid-dividers' : ''}`}
        style={style}
        ref={gridRef}
      >
        {panes.slice(0, visible).map((pane, i) => {
          const isFocused = pane.sessionId === focused
          const name = api.sessions.find((s) => s.id === pane.sessionId)?.name ?? 'Chat'
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
                <ChatPane sessionId={pane.sessionId} api={api} />
              </div>
            </Fragment>
          )
        })}
      </div>
    </>
  )
}
