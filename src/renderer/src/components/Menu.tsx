import { useEffect, useRef, useState } from 'react'
import './Menu.css'

export interface MenuItem {
  label: string
  icon?: JSX.Element
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Renders the item highlighted (e.g. the current selection in a picker). */
  active?: boolean
  /** Optional section label — rendered once above the first item of each run. */
  group?: string
}

interface MenuProps {
  /** Class(es) for the trigger button — style it however the caller needs. */
  triggerClass: string
  triggerContent: JSX.Element
  triggerTitle?: string
  items: MenuItem[]
  /** Which edge the popover aligns to. Default 'right'. */
  align?: 'left' | 'right'
}

/**
 * A small click-outside dropdown menu — a trigger button plus a popover list of
 * actions. Used for header overflow menus, split-button carets and pickers across
 * views. Native <select> popups don't render in this frameless/transparent window,
 * so this is the app's standard menu primitive.
 */
export default function Menu({ triggerClass, triggerContent, triggerTitle, items, align = 'right' }: MenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  return (
    <div className="ui-menu" ref={ref}>
      <button className={triggerClass} title={triggerTitle} onClick={() => setOpen((v) => !v)}>
        {triggerContent}
      </button>
      {open && (
        <div className={`ui-menu-pop ${align}`}>
          {items.map((it, i) => (
            <div key={i} className="ui-menu-row">
              {it.group && it.group !== items[i - 1]?.group && (
                <span className="ui-menu-group">{it.group}</span>
              )}
              <button
                className={`ui-menu-item ${it.danger ? 'danger' : ''} ${it.active ? 'active' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.icon}
                <span>{it.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

export function CaretDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
