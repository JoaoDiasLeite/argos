import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ModelInfo } from '../types'
import './ModelPicker.css'

interface Props {
  models: ModelInfo[]
  value: string
  onChange: (modelId: string) => void
  compact?: boolean
  disabled?: boolean
}

// Where the (portaled) menu should sit, in viewport coordinates. Anchored to the
// button's right edge; opens upward when there isn't enough room below.
interface MenuPos {
  top?: number
  bottom?: number
  right: number
  maxHeight: number
}

export default function ModelPicker({ models, value, onChange, compact, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // The menu renders in a portal with position: fixed so it can never be clipped
  // by a scrollable ancestor (e.g. the settings modal's scrolling body, which
  // truncated the old absolutely-positioned menu at the modal edge).
  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const anchor = ref.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - 12
    const openUp = spaceBelow < 200 && r.top > spaceBelow
    setMenuPos({
      right: Math.max(8, window.innerWidth - r.right),
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: Math.max(160, (openUp ? r.top : spaceBelow) - 8)
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      // The menu lives outside `ref` (portal) — check both before dismissing,
      // otherwise mousedown on an item closes the menu before its click lands.
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    // The fixed-position menu doesn't follow its anchor: close on any outside
    // scroll or resize instead of drifting away from the button.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const current = models.find((m) => value.startsWith(m.id)) ?? models[0]

  return (
    <div className={`model-picker ${compact ? 'compact' : ''}`} ref={ref}>
      <button className="model-picker-btn" onClick={toggle} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}>
        <span className="model-picker-label">{current?.label ?? value}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && menuPos &&
        createPortal(
          <div
            className="model-picker-menu"
            ref={menuRef}
            role="listbox"
            style={{
              position: 'fixed',
              top: menuPos.top,
              bottom: menuPos.bottom,
              right: menuPos.right,
              maxHeight: menuPos.maxHeight,
              overflowY: 'auto'
            }}
          >
            {models.map((m) => (
              <button
                key={m.id}
                className={`model-picker-item ${m.id === current?.id ? 'selected' : ''}`}
                onClick={() => {
                  onChange(m.id)
                  setOpen(false)
                }}
              >
                <div className="model-picker-item-main">
                  <span className="model-picker-item-name-group">
                    <span className="model-picker-item-name">{m.label}</span>
                    {m.discovered && (
                      <span className="model-picker-item-badge" title="Detected via live discovery — not yet in the bundled catalog">
                        new
                      </span>
                    )}
                  </span>
                  {m.id === current?.id && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
                <div className="model-picker-item-meta">
                  {m.discovered
                    ? `${m.context !== '?' ? `${m.context} · ` : ''}new — pricing not catalogued yet`
                    : m.inputPrice === 0 && m.outputPrice === 0
                      ? 'Coming soon'
                      : `${m.context} · $${m.inputPrice}/$${m.outputPrice} per Mtok`}
                </div>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
