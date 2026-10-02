import { useId, useRef, type ReactNode } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import './Sheet.css'

interface Props {
  /** Defaults to true; a closed sheet renders nothing. */
  open?: boolean
  title: ReactNode
  /** Width in px, clamped to 440–720 and never wider than the window. Default 520. */
  width?: number
  onClose: () => void
  /** Controls to the right of the title, before the close button. */
  headerExtra?: ReactNode
  /** Pinned under the scrolling body, above a top border. */
  footer?: ReactNode
  /** Defaults to the title when it is a string; otherwise the title labels the dialog. */
  ariaLabel?: string
  children: ReactNode
}

/**
 * A document or a decision that needs room, as a sheet from the right over the content
 * (SYSTEM-DESIGN.md §2). It has its own close control and Esc closes it; clicking the
 * scrim does not, so a stray click beside it never throws away what was being read or
 * typed. Focus moves into the sheet on open, stays there, and goes back on close.
 */
export default function Sheet({ open = true, title, width = 520, onClose, headerExtra, footer, ariaLabel, children }: Props) {
  if (!open) return null
  return (
    <SheetPanel title={title} width={width} onClose={onClose} headerExtra={headerExtra} footer={footer} ariaLabel={ariaLabel}>
      {children}
    </SheetPanel>
  )
}

function SheetPanel({ title, width, onClose, headerExtra, footer, ariaLabel, children }: Omit<Props, 'open'> & { width: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // useModalA11y binds its handler once; read the latest onClose through a ref.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useModalA11y(ref, () => closeRef.current())

  const label = ariaLabel ?? (typeof title === 'string' ? title : undefined)
  const px = Math.min(720, Math.max(440, width))

  return (
    <div className="sheet-scrim">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label ? undefined : titleId}
        tabIndex={-1}
        ref={ref}
        style={{ width: `min(${px}px, 100vw)` }}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          {headerExtra}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  )
}
