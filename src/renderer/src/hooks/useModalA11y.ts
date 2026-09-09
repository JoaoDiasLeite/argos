import { useEffect, RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

function getFocusable(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (n) => !n.closest('[hidden]') && n.offsetParent !== null
  )
}

interface Options {
  enabled?: boolean
  /** When true the hook will call onClose on Escape. Defaults to true. */
  escapeToClose?: boolean
}

export function useModalA11y(
  ref: RefObject<HTMLElement | null>,
  onClose: (() => void) | null,
  { escapeToClose = true, enabled = true }: Options = {}
) {
  useEffect(() => {
    const dialog = ref.current
    if (!dialog || !enabled) return

    // Remember what was focused before the modal opened.
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Move focus into the dialog.
    const focusables = getFocusable(dialog)
    if (focusables.length > 0) {
      focusables[0].focus()
    } else {
      dialog.focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeToClose && onClose) {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'Tab') {
        const focusableNow = getFocusable(dialog)
        if (focusableNow.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusableNow[0]
        const last = focusableNow[focusableNow.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first || !dialog.contains(document.activeElement)) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last || !dialog.contains(document.activeElement)) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the element that was focused before the modal opened.
      previouslyFocused?.focus()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
}
