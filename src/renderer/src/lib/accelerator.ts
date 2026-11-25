/**
 * An Electron accelerator ("Ctrl+Alt+A", "CommandOrControl+Shift+K") as the user should
 * read it on this platform.
 *
 * The stored value never changes — it is what main hands to globalShortcut — only how it
 * is shown. Off macOS the string comes back as written (with the CommandOrControl family
 * folded to "Ctrl", which is what it means there). On macOS the modifiers become the
 * system's own symbols in the system's own order, ⌃⌥⇧⌘, glued to the key with no "+":
 * "Ctrl+Alt+A" reads "⌃⌥A", exactly as the menu bar would print it.
 *
 * Pure on purpose: the platform is a parameter, so it is testable without a window.
 */

type Mod = 'ctrl' | 'alt' | 'shift' | 'cmd'

/** macOS's canonical modifier order and glyphs. */
const MAC_ORDER: readonly Mod[] = ['ctrl', 'alt', 'shift', 'cmd']
const MAC_GLYPH: Record<Mod, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' }

/** A modifier token as macOS reads it (CommandOrControl is ⌘ there). */
function modOf(token: string): Mod | null {
  switch (token.toLowerCase()) {
    case 'control':
    case 'ctrl':
      return 'ctrl'
    case 'alt':
    case 'option':
    case 'altgr':
      return 'alt'
    case 'shift':
      return 'shift'
    case 'command':
    case 'cmd':
    case 'super':
    case 'meta':
    case 'commandorcontrol':
    case 'cmdorctrl':
      return 'cmd'
    default:
      return null
  }
}

/** Keys macOS prints as a symbol rather than a word. */
const MAC_KEY: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: '↩',
  return: '↩',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  escape: '⎋',
  esc: '⎋',
  plus: '+'
}

/**
 * The accelerator split into the keys a cheat sheet draws one <kbd> each for: as written
 * off macOS ("Ctrl", "Alt", "A"), in macOS's glyphs and order on it ("⌃", "⌥", "A").
 */
export function acceleratorKeys(accelerator: string, platform: string): string[] {
  if (!accelerator) return []
  if (platform !== 'darwin') return foldCmdOrCtrl(accelerator).split('+').filter(Boolean)

  const mods = new Set<Mod>()
  const keys: string[] = []
  for (const token of accelerator.split('+')) {
    if (!token) continue
    const mod = modOf(token)
    if (mod) mods.add(mod)
    else keys.push(MAC_KEY[token.toLowerCase()] ?? (token.length === 1 ? token.toUpperCase() : token))
  }
  return [...MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_GLYPH[m]), ...keys]
}

function foldCmdOrCtrl(accelerator: string): string {
  return accelerator
    .split('+')
    .map((k) => (/^(commandorcontrol|cmdorctrl)$/i.test(k) ? 'Ctrl' : k))
    .join('+')
}

/** The accelerator as one string: "Ctrl+Alt+A" off macOS, "⌃⌥A" on it. */
export function formatAccelerator(accelerator: string, platform: string): string {
  if (!accelerator) return accelerator
  if (platform !== 'darwin') return foldCmdOrCtrl(accelerator)
  return acceleratorKeys(accelerator, platform).join('')
}

/**
 * What each global shortcut's "Auto" setting asks for first. These mirror the first
 * candidate in main (overlay.ts, companion-window.ts) and only label the Settings option;
 * the accelerator actually registered is always read back from main.
 */
export const AUTO_LAUNCHER_SHORTCUT = 'Alt+Space'
export const AUTO_COMPANION_SHORTCUT = 'Ctrl+Alt+A'
export const AUTO_DICTATION_SHORTCUT = 'Ctrl+Alt+S'
