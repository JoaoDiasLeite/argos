import { useLayoutEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { useModalA11y } from '../hooks/useModalA11y'
import './Menu.css'
import './TerminalContextMenu.css'

export interface TerminalMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
}

interface Props {
  /** Where the right-click landed, in viewport coords (an event's clientX/clientY). */
  x: number
  y: number
  items: TerminalMenuItem[]
  onClose: () => void
}

/** Breathing room kept between the menu and the edge it would otherwise touch. */
const EDGE_MARGIN = 6

/**
 * The standard item set, shared by ChatTerminal and RemoteTerminal so the two menus stay
 * identical (they're near-verbatim clones of each other and have drifted before). Evaluated
 * at render time, which is the moment the menu opens — so Copy's disabled state reflects the
 * selection as it was when the user right-clicked.
 *
 * Paste goes through the caller's `paste`, which is the same path Ctrl+V and
 * right-click take in that terminal — including its decision about bracketed-paste
 * markers, which are wrong for some ends of a pty and right for others.
 */
export function terminalMenuItems(
  term: Terminal | null,
  /**
   * How to deliver pasted text. Supplied by the terminal because whether
   * bracketed-paste markers may be sent depends on what is on the other end of the
   * pty — see `pasteText` in ChatTerminal.
   */
  paste: (text: string) => void
): TerminalMenuItem[] {
  return [
    {
      label: 'Copy',
      disabled: !term?.hasSelection(),
      onClick: () => {
        const sel = term?.getSelection()
        if (sel) navigator.clipboard.writeText(sel).catch(() => {})
      }
    },
    {
      label: 'Paste',
      onClick: () => {
        // Read through the main process, not navigator.clipboard: reading needs a
        // permission this app has no way to grant, so that path failed silently
        // behind its own catch for as long as nobody tried this menu item.
        void window.electronAPI.clipboardRead().then((res) => {
          if (res.text) paste(res.text)
        })
      }
    },
    { label: 'Select all', onClick: () => term?.selectAll() },
    { label: 'Clear', onClick: () => term?.clear() }
  ]
}

/**
 * The terminals' Shift+right-click menu (Copy / Paste / Select all / Clear).
 *
 * Deliberately `position: absolute`, not fixed: the terminals live inside panes that scroll
 * and get swapped with `display: none`, and a fixed-position child of a hidden pane is the
 * classic way to end up with a menu stranded in the top-left corner of the window. Absolute
 * keeps it glued to the terminal it belongs to.
 *
 * The cost of absolute is that the incoming viewport coords have to be rebased onto the
 * offset parent, which is also where clamping happens — see the layout effect below.
 *
 * Visuals come from Menu.css (the app's menu primitive) so this looks like every other menu;
 * only the positioning shell is local.
 */
export default function TerminalContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Null until measured. Rendered hidden for that one frame so the pre-clamp position never
  // flashes at the wrong spot (the menu's own size is only knowable once it's in the DOM).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = el.offsetParent as HTMLElement | null
    const box = parent
      ? parent.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight)

    // Clamp inside the intersection of the offset parent's box and the viewport. The viewport
    // alone isn't enough: the terminal host wrap clips its overflow, so a menu that merely
    // fits on screen could still be cut in half by its own container.
    const minX = Math.max(box.left, 0) + EDGE_MARGIN
    const maxX = Math.min(box.right, window.innerWidth) - EDGE_MARGIN - el.offsetWidth
    const minY = Math.max(box.top, 0) + EDGE_MARGIN
    const maxY = Math.min(box.bottom, window.innerHeight) - EDGE_MARGIN - el.offsetHeight
    // max before min: on a container smaller than the menu, staying visible beats staying inside.
    const clampedX = Math.max(minX, Math.min(x, maxX))
    const clampedY = Math.max(minY, Math.min(y, maxY))

    setPos({ left: clampedX - box.left, top: clampedY - box.top })
  }, [x, y])

  // Escape to close, focus into the menu, focus back to the terminal on unmount.
  useModalA11y(ref, onClose)

  // Click-outside, same mousedown approach as Menu.tsx.
  useLayoutEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="terminal-ctx-menu"
      role="menu"
      aria-label="Terminal actions"
      tabIndex={-1}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="ui-menu-item"
          disabled={it.disabled}
          onClick={() => {
            // Close first: every item either reads or writes the clipboard, and the menu
            // stealing focus is exactly what we don't want while that happens.
            onClose()
            it.onClick()
          }}
        >
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  )
}
