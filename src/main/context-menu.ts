import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron'

/**
 * The right-click menu for text in the app's own fields.
 *
 * Electron ships no context menu at all — a right-click in a textarea does nothing
 * unless the app builds one. Argos never did, so cut/copy/paste were reachable only
 * by keyboard, and a right-click looked like a dead input rather than a missing
 * feature.
 *
 * **Why clipboard roles are safe here and not in the application menu.**
 * `installApplicationMenu` in index.ts deliberately carries no Edit roles, because a
 * `role: 'paste'` there binds CmdOrCtrl+V to `webContents.paste()` — which fired a
 * second paste on top of xterm's own handling of the same keystroke and delivered
 * pasted text twice, once raw and once bracketed. A context menu binds no
 * accelerator: its items run only when clicked. The hazard was the global shortcut,
 * not the role.
 *
 * The terminals keep their own menu, but NOT because `preventDefault()` hides them
 * from this. That was the assumption, and it was wrong: a right-click on a terminal
 * pasted (its PuTTY-style reflex) and then got this menu on top, so clicking Paste
 * pasted a second time. They now say so explicitly — see `claimContextMenu`.
 */
/**
 * When a renderer last said it was handling a right-click itself.
 *
 * The terminals answer a plain right-click the way PuTTY does — copy if there is a
 * selection, paste otherwise — and offer their own menu on Shift. A native menu on
 * top of that is a second answer to one gesture: the terminal pastes on the click,
 * the menu appears anyway, and clicking its Paste pastes again.
 *
 * `preventDefault` in the renderer is not enough to rely on here, so the terminal
 * says so explicitly and this window ignores the very next context-menu request. The
 * two happen within the same gesture, milliseconds apart; the margin is generous
 * enough to be reliable and short enough that a later, unrelated right-click is
 * never swallowed.
 */
let claimedAt = 0
const CLAIM_MS = 400

export function claimContextMenu(): void {
  claimedAt = Date.now()
}

export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    if (Date.now() - claimedAt < CLAIM_MS) return
    const { isEditable, editFlags, selectionText } = params
    const hasSelection = selectionText.trim().length > 0

    // Only two shapes are worth a menu: an editable field, and selected text
    // anywhere else (a transcript, a message) that someone wants to copy. A
    // right-click on empty chrome gets nothing rather than a menu of dead items.
    if (!isEditable && !hasSelection) return

    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push({ role: 'undo', enabled: editFlags.canUndo })
      items.push({ role: 'redo', enabled: editFlags.canRedo })
      items.push({ type: 'separator' })
      items.push({ role: 'cut', enabled: editFlags.canCut })
    }
    items.push({ role: 'copy', enabled: editFlags.canCopy })
    if (isEditable) {
      // `paste` here pastes text. An image on the clipboard is a different path
      // entirely — it reaches the renderer as a paste event the composer reads —
      // and no menu role can stand in for it.
      items.push({ role: 'paste', enabled: editFlags.canPaste })
      items.push({ type: 'separator' })
      items.push({ role: 'selectAll' })
    }

    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
