import type { MouseEvent } from 'react'

/**
 * Props for a modal's backdrop that close it on a click outside the dialog. Only a click
 * that both starts and ends on the backdrop itself counts: a text selection dragged out of
 * the dialog and released over the backdrop must not throw the dialog away.
 */
export function backdropClose(onClose: () => void): {
  onMouseDown: (e: MouseEvent) => void
  onClick: (e: MouseEvent) => void
} {
  let downOnBackdrop = false
  return {
    onMouseDown: (e) => {
      downOnBackdrop = e.target === e.currentTarget
    },
    onClick: (e) => {
      if (downOnBackdrop && e.target === e.currentTarget) onClose()
      downOnBackdrop = false
    }
  }
}
