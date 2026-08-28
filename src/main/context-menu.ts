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
 * The terminals keep their own menu regardless. They call `preventDefault()` on the
 * DOM `contextmenu` event, and Electron only emits `context-menu` for events the
 * renderer did not cancel — so a right-click on a terminal never reaches this at all,
 * and its bracketed-paste-aware path stays the only one there.
 */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
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
