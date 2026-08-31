import { useEffect, useState } from 'react'
import TerminalContextMenu, { TerminalMenuItem } from './TerminalContextMenu'
import { insertText, isTextField } from '../lib/clipboard-paste'

/**
 * The right-click menu for the app's own text fields, decided in the renderer.
 *
 * It was a native Electron menu first, built in the main process from the
 * `context-menu` event. That could not tell a terminal from a settings field, so it
 * opened over a terminal that had *already* pasted on the same click — the
 * PuTTY-style reflex — and clicking its Paste pasted a second time. Two attempts to
 * have the terminal warn the main process failed: `send` lost the race against
 * Chromium's own request, and even `sendSync` did not settle it.
 *
 * Deciding here removes the race instead of narrowing it. The terminals call
 * `preventDefault()` on the DOM event, this listener runs on the way up and steps
 * aside for anything already handled — one flag, read in the same event, with no
 * process boundary in the middle. The information and the decision are finally in
 * the same place.
 */

/** The item set for a field or a selection. Evaluated when the menu opens. */
function itemsFor(field: HTMLInputElement | HTMLTextAreaElement | null, selection: string): TerminalMenuItem[] {
  const items: TerminalMenuItem[] = []
  const hasSelection = selection.trim().length > 0

  if (field) {
    items.push({
      label: 'Cut',
      disabled: !hasSelection,
      onClick: () => {
        const start = field.selectionStart ?? 0
        const end = field.selectionEnd ?? 0
        if (start === end) return
        void navigator.clipboard.writeText(field.value.slice(start, end)).catch(() => {})
        field.focus()
        field.setSelectionRange(start, end)
        // Inserting nothing over the selection deletes it *through* the field's own
        // undo stack, which setting `.value` would throw away.
        insertText('')
      }
    })
  }

  items.push({
    label: 'Copy',
    disabled: !hasSelection,
    onClick: () => {
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {})
    }
  })

  if (field) {
    items.push({
      label: 'Paste',
      onClick: () => {
        // Focus first: the menu took it when it opened, and insertText writes wherever
        // the caret actually is.
        field.focus()
        void window.electronAPI.clipboardRead().then((res) => {
          if (res.text) insertText(res.text)
        })
      }
    })
    items.push({
      label: 'Select all',
      onClick: () => {
        field.focus()
        field.select()
      }
    })
  }

  return items
}

interface Open {
  x: number
  y: number
  field: HTMLInputElement | HTMLTextAreaElement | null
  selection: string
}

export default function TextContextMenu() {
  const [open, setOpen] = useState<Open | null>(null)

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // Someone closer to the click already answered it — the terminals do exactly
      // this. Their menu and their paste stay the only ones there.
      if (e.defaultPrevented) return

      const target = e.target as Element | null
      const field = isTextField(target) ? target : null
      const selection = window.getSelection()?.toString() ?? ''

      // A right-click on empty chrome gets nothing, rather than a menu of dead items.
      if (!field && !selection.trim()) return

      e.preventDefault()
      setOpen({ x: e.clientX, y: e.clientY, field, selection })
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  if (!open) return null
  return (
    <TerminalContextMenu
      x={open.x}
      y={open.y}
      items={itemsFor(open.field, open.selection)}
      onClose={() => setOpen(null)}
    />
  )
}
