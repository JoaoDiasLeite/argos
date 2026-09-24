import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'

/**
 * Ctrl+click (Cmd+click on macOS) on a URL in a terminal opens it in the browser.
 *
 * Two kinds of link reach a terminal, and xterm handles neither usefully on its own:
 *
 * - **Plain text that looks like a URL** — most of them. xterm does not detect these at
 *   all; the web-links addon does.
 * - **OSC 8 hyperlinks**, which Claude Code prints for some links. xterm detects these,
 *   but its default answer to a click is a `confirm()` dialog followed by `window.open`
 *   — and a native dialog blocks the whole renderer.
 *
 * The modifier is required, as in VS Code and Windows Terminal: the CLIs turn on mouse
 * tracking and a plain click belongs to them.
 *
 * `window.open` rather than an IPC of our own: the main process already routes it to
 * the default browser for http(s) and mailto, and refuses every other scheme (see
 * main/window-security.ts), which is exactly the check a link printed by a model needs.
 */
export function registerTerminalLinks(term: Terminal): void {
  const open = (e: MouseEvent, uri: string): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    window.open(uri)
  }
  term.loadAddon(new WebLinksAddon(open))
  term.options.linkHandler = { activate: open }
}
