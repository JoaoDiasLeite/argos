import type { ITheme } from '@xterm/xterm'

/**
 * The one palette every embedded terminal uses — vivid ANSI colors on the app's own warm
 * near-black.
 *
 * Three reasons it's shared and fixed rather than themed:
 *
 * 1. The terminals are intentionally ALWAYS dark and do NOT follow the app's light/dark
 *    theme. The CLIs they host (claude/codex/Antigravity) emit ANSI colors tuned for a
 *    dark background, so a light bg would wash them out.
 * 2. Before this, ChatTerminal and RemoteTerminal each set only background/foreground/cursor
 *    and left the 16 ANSI slots on xterm's own defaults — which are noticeably duller than
 *    what the same output looks like in Windows Terminal / WindTerm. Spelling out all 16 is
 *    what makes remote output (build logs, `ls --color`, deprecation warnings) actually read
 *    as colored, and having exactly one copy of them means the two terminals can't drift.
 * 3. The background/foreground stay on the app's warm `#17140f` / `#e8e2d6` rather than
 *    Windows Terminal's cold `#0C0C0C` / `#CCCCCC`: the terminal sits inside cream-colored
 *    app chrome, and a pure-neutral black panel clashes with it. The 16 hues are pushed
 *    brighter/more saturated than Campbell's to compensate for the lighter backdrop.
 */
export const TERMINAL_THEME: ITheme = {
  background: '#17140f',
  foreground: '#e8e2d6',
  cursor: '#e8e2d6',
  black: '#1e1a14',
  red: '#e5484d',
  green: '#35c05a',
  yellow: '#e0a82e',
  blue: '#4a8cff',
  magenta: '#c069e8',
  cyan: '#35c6c6',
  white: '#e8e2d6',
  brightBlack: '#7c7466',
  brightRed: '#ff6b63',
  brightGreen: '#4ee06a',
  brightYellow: '#f5cf4e',
  brightBlue: '#6fb4ff',
  brightMagenta: '#de8fff',
  brightCyan: '#5ce0e0',
  brightWhite: '#fffbf0',
  selectionBackground: '#3a3327'
}

/**
 * The theme's background/foreground, pulled out for the few places that need the raw color
 * outside an xterm instance. TERMINAL_BG in particular must stay in sync with
 * `.chat-terminal-loading`'s background in ChatTerminal.css — the loader overlay sits on top
 * of the terminal and has to be the exact same color or the seam shows. That rule can't read
 * a theme token (they go near-white in light mode), so it hardcodes #17140f; change it here
 * and there together.
 */
export const TERMINAL_BG = TERMINAL_THEME.background!
export const TERMINAL_FG = TERMINAL_THEME.foreground!
