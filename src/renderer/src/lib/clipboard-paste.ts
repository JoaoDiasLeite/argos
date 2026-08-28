/**
 * Ctrl+V, handled by the app because nothing else does it.
 *
 * The application menu carries no Edit roles on purpose: a `role: 'paste'` there
 * binds CmdOrCtrl+V to `webContents.paste()`, which fired a *second* paste on top of
 * xterm's own handling of the same keystroke and delivered text twice, once raw and
 * once bracketed. Removing them fixed the terminals and silently broke every other
 * field in the app — Ctrl+V stopped working in the composer, in settings, in every
 * filter box, and the DOM paste event never fired at all. The report that surfaced it
 * was "I can't paste images", which sounded like an image problem and was not.
 *
 * So the keystroke is handled here instead, which is also what makes pasting an image
 * work: the composer's `onPaste` never ran, because there was no paste event to run
 * on.
 *
 * Terminals are deliberately untouched. They have their own bracketed-paste-aware
 * path, and taking the keystroke away from them would reintroduce the raw double
 * paste from the other direction.
 */

/** Dispatched on `window` when an image was pasted; the composer listens for it. */
export const CLIPBOARD_IMAGE_EVENT = 'argos:clipboard-image'

export interface ClipboardImageDetail {
  mediaType: string
  /** base64, no data: prefix. */
  data: string
}

/** Is this element inside a terminal, which handles its own paste? */
function insideTerminal(el: Element | null): boolean {
  return !!el?.closest('.xterm')
}

/** Is this somewhere text can actually be typed? */
function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    // A file or checkbox input takes no text; inserting into one does nothing useful.
    const type = (el as HTMLInputElement).type
    return type !== 'file' && type !== 'checkbox' && type !== 'radio'
  }
  return (el as HTMLElement).isContentEditable
}

/**
 * Insert text at the caret through `execCommand`.
 *
 * Deprecated, and used anyway: it is the only insertion that keeps the field's native
 * undo stack intact and emits the input event React needs to see. Writing `.value`
 * directly loses both — the undo history and React's own state — and a Ctrl+V that
 * cannot be undone with Ctrl+Z is its own bug report.
 */
function insertText(text: string): void {
  document.execCommand('insertText', false, text)
}

/**
 * Start handling Ctrl+V for the app's own fields. Returns a function that stops.
 */
export function installClipboardPaste(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    if (e.key.toLowerCase() !== 'v') return

    const target = document.activeElement
    if (insideTerminal(target)) return
    if (!isTextField(target)) return

    // Claimed: from here on this keystroke is ours, and letting it through as well
    // would be the double paste this whole arrangement exists to avoid.
    e.preventDefault()

    void window.electronAPI.clipboardRead().then((res) => {
      if (res.image) {
        window.dispatchEvent(
          new CustomEvent<ClipboardImageDetail>(CLIPBOARD_IMAGE_EVENT, { detail: res.image })
        )
        return
      }
      if (res.text) insertText(res.text)
    })
  }

  // Capture, so a field's own keydown handler cannot swallow the keystroke first.
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}
