import { useCallback, useEffect, useRef, type CSSProperties, type RefObject } from 'react'

/**
 * Drag handle for the boundary between tracks `index` and `index + 1` of one axis of
 * `<PaneGrid>` — columns (`cols`, drags horizontally) or rows (`rows`, drags vertically).
 *
 * Follows the same recipe as the sidebar/terminal-panel/projects-view resize handles
 * (mousedown → listeners on `window`, cursor/userSelect on `document.body`, clamp, persist
 * on mouseup only): see `Sidebar.tsx`'s `handleResizeMouseDown`/`handleMouseMove`/`handleMouseUp`.
 * The one addition here is `document.body.dataset.paneDrag`, which `ChatTerminal`'s
 * `ResizeObserver` checks to skip `fit()` mid-drag — see the comment there for why.
 *
 * Only the two tracks adjacent to this boundary move: dragging changes where the boundary
 * sits (as a fraction of the grid's width or height), which is equivalent to redistributing
 * exactly `sizes[index]` and `sizes[index + 1]` between themselves. Every other track keeps
 * whatever fraction it had.
 *
 * The two axes are the same arithmetic with a different pair of coordinates, so they share
 * one component rather than two that would have to be kept in step.
 */

export type SplitterAxis = 'cols' | 'rows'

const MIN_FRACTION = 0.15

export default function PaneSplitter({
  gridRef,
  axis,
  index,
  sizes,
  style,
  onChange,
  onCommit
}: {
  /** The `.pane-grid` element — its `getBoundingClientRect()` turns the mouse into a fraction. */
  gridRef: RefObject<HTMLDivElement | null>
  /** Which axis this boundary redistributes. */
  axis: SplitterAxis
  /** This splitter sits between tracks `index` and `index + 1` of that axis. */
  index: number
  /** Current fractions of that axis, normalized to sum to 1 — one entry per track. */
  sizes: number[]
  /** Explicit grid placement: a divider does not always span the whole grid (see PaneGrid). */
  style?: CSSProperties
  /** Fired on every mousemove with the full next fractions array — drives the live visual. */
  onChange: (sizes: number[]) => void
  /** Fired once on mouseup with the final fractions — this is what gets persisted. */
  onCommit: (sizes: number[]) => void
}) {
  const isRow = axis === 'rows'
  const cursor = isRow ? 'row-resize' : 'col-resize'

  const draggingRef = useRef(false)
  // The latest fractions, live during a drag — read at drag start and updated on every
  // move so the next move computes from where this one left off, not from a stale prop
  // (this component doesn't re-render on its own between mousemove events).
  const sizesRef = useRef(sizes)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current) return
      const grid = gridRef.current
      if (!grid) return
      const rect = grid.getBoundingClientRect()
      // The axis picks which side of the rect the fraction is measured against; everything
      // below is identical for both.
      const extent = isRow ? rect.height : rect.width
      if (extent <= 0) return

      const current = sizesRef.current
      const cumBefore = current.slice(0, index).reduce((a, b) => a + b, 0)
      const span = current[index] + current[index + 1]
      const cumAfter = cumBefore + span
      // Clamp so neither of the two adjacent panes shrinks past the minimum — a global
      // fraction, not a pixel one, so it clamps consistently regardless of window width.
      const min = Math.min(MIN_FRACTION, span / 2)
      const rawBoundary = (isRow ? e.clientY - rect.top : e.clientX - rect.left) / extent
      const boundary = Math.min(cumAfter - min, Math.max(cumBefore + min, rawBoundary))

      const next = current.slice()
      next[index] = boundary - cumBefore
      next[index + 1] = cumAfter - boundary
      sizesRef.current = next
      onChange(next)
    },
    [gridRef, isRow, index, onChange]
  )

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    delete document.body.dataset.paneDrag
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', handleMouseUp)
    onCommit(sizesRef.current)
    // The ResizeObserver skipped every fit() while paneDrag was set — this is the one
    // fit() the drag gets, once the boundary has actually settled.
    window.dispatchEvent(new Event('panedragend'))
  }, [handleMouseMove, onCommit])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      draggingRef.current = true
      sizesRef.current = sizes
      document.body.dataset.paneDrag = '1'
      document.body.style.userSelect = 'none'
      document.body.style.cursor = cursor
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [sizes, cursor, handleMouseMove, handleMouseUp]
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  return (
    <div
      className={`pane-splitter ${isRow ? 'pane-splitter-row' : ''}`}
      style={style}
      onMouseDown={handleMouseDown}
      role="separator"
      /* A divider between stacked panes separates them along the vertical axis, so its own
         orientation is horizontal — the ARIA sense is the opposite of the visual one. */
      aria-orientation={isRow ? 'horizontal' : 'vertical'}
      aria-label="Resize panes"
    />
  )
}
