import type { Terminal } from '@xterm/xterm'

/**
 * Where the shell on the far side of a terminal is — read off what it already reports,
 * so the file pane beside a remote session can follow a `cd` with nothing installed on
 * the host.
 *
 * Two sources, both emitted by stock shells:
 *
 * - **OSC 7** (`\x1b]7;file://host/path\x07`): the explicit "my cwd is" report. zsh on
 *   macOS and some bashrc setups send it. Precise, but rare on a server.
 * - **The window title** (OSC 0/2): Ubuntu's default `.bashrc` and Red Hat's
 *   `/etc/bashrc` both set it to `user@host: /path` (Debian) or `user@host:/path` (RHEL)
 *   on every prompt, with `~` for the home. That is nearly every box this app reaches.
 *
 * A title set by a program instead of the prompt ("file (~/dir) - VIM", Claude Code's
 * "✳ …") has no `user@host:` in front and is ignored, so it can never move the pane.
 */

const TITLE_CWD = /^(?:\([^)]*\)\s*)?[^@\s()]+@[^:\s]+:\s?(\S.*)$/

/** The cwd a prompt-set title names, or null for a title that is not one. */
export function cwdFromTitle(title: string): string | null {
  const m = TITLE_CWD.exec(title.trim())
  if (!m) return null
  const path = m[1].trim()
  return path.startsWith('/') || path === '~' || path.startsWith('~/') ? path : null
}

/** The cwd an OSC 7 payload (`file://host/path`) names, or null when it isn't one. */
export function cwdFromOsc7(data: string): string | null {
  if (!data.startsWith('file://')) return null
  const rest = data.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  try {
    return decodeURIComponent(rest.slice(slash)) || null
  } catch {
    return null
  }
}

/** `~` and `~/x` made absolute against `home`; null when that needs a home we lack. */
export function expandHome(path: string, home: string | null): string | null {
  if (!path.startsWith('~')) return path
  if (!home) return null
  if (path === '~') return home
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : null
}

/**
 * Report the shell's cwd whenever it tells us. Returns a disposer. OSC 7 is consumed;
 * the title is only listened to, so xterm still keeps it as the terminal's title.
 */
export function registerCwdReports(term: Terminal, onCwd: (path: string) => void): () => void {
  const osc7 = term.parser.registerOscHandler(7, (data) => {
    const path = cwdFromOsc7(data)
    if (path) onCwd(path)
    return true
  })
  const title = term.onTitleChange((t) => {
    const path = cwdFromTitle(t)
    if (path) onCwd(path)
  })
  return () => {
    osc7.dispose()
    title.dispose()
  }
}
