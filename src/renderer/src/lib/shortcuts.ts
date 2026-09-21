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
  action: string
  /** When it applies, where that isn't obvious from the group. */
  note?: string
}

export interface ShortcutGroup {
  title: string
  /** Where the binding actually lives, so this file can be checked against it. */
  where: string
  items: Shortcut[]
}

/** `id` is the placeholder the quick launcher's real accelerator is substituted into. */
export const OVERLAY_CHORD = '\u0000overlay'

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    where: 'App.tsx — window keydown',
    items: [
      { keys: [MOD, 'K'], action: 'Command palette' },
      { keys: [MOD, 'N'], action: 'New chat' },
      { keys: [MOD, '/'], action: 'Show this list' },
      { keys: [MOD, '1'], action: 'Focus the first pane', note: '…2, 3 for the rest' },
      { keys: [MOD, 'Shift', 'W'], action: 'Close the focused pane', note: 'the chat itself is untouched' }
    ]
  },
  {
    title: 'Quick launcher',
    where: 'main/overlay.ts, overlay/Overlay.tsx',
    items: [
      { keys: [OVERLAY_CHORD], action: 'Show or hide the launcher', note: 'works with Argos in the background' },
      { keys: ['Enter'], action: 'Start a new chat' },
      { keys: [MOD, 'Enter'], action: 'Start a quick chat', note: 'cheapest model' },
      { keys: ['Esc'], action: 'Dismiss' }
    ]
  },
  {
    title: 'Command palette',
    where: 'components/CommandPalette.tsx',
    items: [
      { keys: ['↑'], action: 'Previous result' },
      { keys: ['↓'], action: 'Next result' },
      { keys: ['Enter'], action: 'Run the highlighted result' },
      { keys: ['Esc'], action: 'Close' }
    ]
  },
  {
    title: 'Writing a message',
    where: 'components/Chat.tsx — composer',
    items: [
      { keys: ['Enter'], action: 'Send' },
      { keys: ['Shift', 'Enter'], action: 'New line' },
      { keys: ['@'], action: 'Mention a file or agent', note: 'opens the picker' },
      { keys: ['↑'], action: 'Previous item', note: 'while the picker is open' },
      { keys: ['↓'], action: 'Next item', note: 'while the picker is open' },
      { keys: ['Tab'], action: 'Accept the highlighted item', note: 'Enter does the same' },
      { keys: ['Esc'], action: 'Close the picker' }
    ]
  },
  {
    title: 'Editing a sent message',
    where: 'components/MessageBubble.tsx',
    items: [
      { keys: [MOD, 'Enter'], action: 'Save and resend' },
      { keys: ['Esc'], action: 'Cancel the edit' }
    ]
  },
  {
    title: 'Terminal',
    where: 'components/ChatTerminal.tsx',
    items: [
      { keys: [MOD, 'C'], action: 'Copy the selection', note: 'selecting already copies' },
      { keys: [MOD, 'V'], action: 'Paste' },
      { keys: ['Alt', 'V'], action: 'Paste an image', note: 'the CLI\u2019s own key' },
      { keys: ['Shift', 'right-click'], action: 'Terminal menu', note: 'select all, clear, paste' }
    ]
  },
  {
    title: 'Approving a tool call',
    where: 'components/ApprovalModal.tsx',
    items: [
      { keys: [MOD, 'Enter'], action: 'Allow once' },
      { keys: ['Esc'], action: 'Deny' }
    ]
  },
  {
    title: 'File editor',
    where: 'components/FileEditor.tsx',
    items: [
      { keys: [MOD, 'S'], action: 'Save' },
      { keys: [MOD, 'F'], action: 'Find' },
      { keys: [MOD, 'H'], action: 'Find and replace' },
      { keys: ['Enter'], action: 'Next match', note: 'in the find bar; Shift+Enter for the previous' },
      { keys: ['Tab'], action: 'Indent', note: 'Shift+Tab outdents' },
      { keys: ['Esc'], action: 'Close' }
    ]
  },
  {
    title: 'Any dialog',
    where: 'hooks/useModalA11y.ts',
    items: [
      { keys: ['Esc'], action: 'Close' },
      { keys: ['Tab'], action: 'Next control', note: 'focus stays inside the dialog' }
    ]
  }
]
