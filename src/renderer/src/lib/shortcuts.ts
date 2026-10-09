import type { MessageKey } from '../../../shared/i18n'

/**
 * The app's keyboard shortcuts, written down once so the cheat sheet can show them.
 *
 * This is a description of bindings that live elsewhere — the window-level handler in
 * App.tsx, xterm's key handler in ChatTerminal, each modal's own `onKeyDown` — not the
 * bindings themselves. Nothing here is wired to anything, so a key changed at its source
 * and not changed here goes quietly stale. Keep the two together: the entries carry a
 * `where` naming the file that actually owns each group.
 *
 * The quick launcher's chord is the exception — it is negotiated with the OS at startup
 * (see main/overlay.ts: Alt+Space if free, otherwise a fallback, otherwise nothing at
 * all), so it is left blank here and filled in at render time from the main process.
 */

/** Mac reports itself in the UA string; Electron gives us nothing better in the renderer. */
export const IS_MAC = navigator.userAgent.includes('Mac')

/** What to call the Ctrl/Cmd key on this platform. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'

/** A chord for display: `modLabel('K')` → "Ctrl+K" or "⌘K". */
export function modLabel(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`
}

export interface Shortcut {
  /** The chord, already split into keys — rendered one <kbd> per entry. */
  keys: string[]
  /** What it does, in the imperative. */
  action: MessageKey
  /** When it applies, where that isn't obvious from the group. */
  note?: MessageKey
}

export interface ShortcutGroup {
  title: MessageKey
  /** Where the binding actually lives, so this file can be checked against it. */
  where: string
  items: Shortcut[]
}

/** `id` is the placeholder the quick launcher's real accelerator is substituted into. */
export const OVERLAY_CHORD = '\u0000overlay'

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'shortcuts.group.anywhere',
    where: 'App.tsx — window keydown',
    items: [
      { keys: [MOD, 'K'], action: 'shortcuts.action.palette' },
      { keys: [MOD, 'N'], action: 'shortcuts.action.newTerminal' },
      { keys: [MOD, '/'], action: 'shortcuts.action.showList' },
      { keys: [MOD, '1'], action: 'shortcuts.action.focusPane', note: 'shortcuts.note.restPanes' },
      { keys: [MOD, 'Shift', 'W'], action: 'shortcuts.action.closePane', note: 'shortcuts.note.chatUntouched' }
    ]
  },
  {
    title: 'shortcuts.group.launcher',
    where: 'main/overlay.ts, overlay/Overlay.tsx',
    items: [
      { keys: [OVERLAY_CHORD], action: 'shortcuts.action.toggleLauncher', note: 'shortcuts.note.background' },
      { keys: ['Enter'], action: 'shortcuts.action.startTerminal' },
      { keys: ['Esc'], action: 'shortcuts.action.dismiss' }
    ]
  },
  {
    title: 'shortcuts.group.palette',
    where: 'components/CommandPalette.tsx',
    items: [
      { keys: ['↑'], action: 'shortcuts.action.prevResult' },
      { keys: ['↓'], action: 'shortcuts.action.nextResult' },
      { keys: ['Enter'], action: 'shortcuts.action.runResult' },
      { keys: ['Esc'], action: 'shortcuts.action.close' }
    ]
  },
  {
    title: 'shortcuts.group.terminal',
    where: 'components/ChatTerminal.tsx',
    items: [
      { keys: [MOD, 'C'], action: 'shortcuts.action.copy', note: 'shortcuts.note.selectCopies' },
      { keys: [MOD, 'V'], action: 'shortcuts.action.paste' },
      { keys: ['Alt', 'V'], action: 'shortcuts.action.pasteImage', note: 'shortcuts.note.cliKey' },
      { keys: ['Shift', 'right-click'], action: 'shortcuts.action.terminalMenu', note: 'shortcuts.note.terminalMenu' }
    ]
  },
  {
    title: 'shortcuts.group.approval',
    where: 'components/ApprovalModal.tsx',
    items: [
      { keys: [MOD, 'Enter'], action: 'shortcuts.action.allowOnce' },
      { keys: ['Esc'], action: 'shortcuts.action.deny' }
    ]
  },
  {
    title: 'shortcuts.group.editor',
    where: 'components/FileEditor.tsx',
    items: [
      { keys: [MOD, 'S'], action: 'shortcuts.action.save' },
      { keys: [MOD, 'F'], action: 'shortcuts.action.find' },
      { keys: [MOD, 'H'], action: 'shortcuts.action.replace' },
      { keys: ['Enter'], action: 'shortcuts.action.nextMatch', note: 'shortcuts.note.findBar' },
      { keys: ['Tab'], action: 'shortcuts.action.indent', note: 'shortcuts.note.outdent' },
      { keys: ['Esc'], action: 'shortcuts.action.close' }
    ]
  },
  {
    title: 'shortcuts.group.dialog',
    where: 'hooks/useModalA11y.ts',
    items: [
      { keys: ['Esc'], action: 'shortcuts.action.close' },
      { keys: ['Tab'], action: 'shortcuts.action.nextControl', note: 'shortcuts.note.focusInside' }
    ]
  }
]
