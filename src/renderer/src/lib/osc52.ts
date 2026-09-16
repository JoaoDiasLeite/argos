import type { Terminal } from '@xterm/xterm'

/**
 * OSC 52 — "terminal, put this on your clipboard".
 *
 * The one way a program on the far side of a pty can reach the clipboard when it has no
 * local access to one. Claude Code inside `Ubuntu-DevOps` is exactly that case: the distro
 * has `appendWindowsPath = false`, so there is no `clip.exe`/`powershell.exe` to shell out
 * to, and no `wl-copy`/`xclip` either. It emits `\x1b]52;c;<base64>\x07` and reports the
 * text as copied — correctly, from where it stands. xterm.js has no built-in handler for
 * the sequence, so until this existed it was parsed and dropped, and nothing ever reached
 * Windows. Locally the same CLI writes the clipboard itself, which is why it only ever
 * failed in a distro.
 *
 * Reads (`Pd` = `?`) are deliberately NOT answered: that direction lets anything printing
 * to the terminal — a `cat` of a hostile file, output from a remote host — exfiltrate
 * whatever is on the clipboard into the pty. Copy in, nothing out.
 */

/**
 * The text an OSC 52 payload asks us to copy, or null when there is nothing to copy —
 * a query, a clear, or a payload that isn't valid base64.
 *
 * `data` is everything after `52;`: `Pc;Pd`, where Pc names the selection (`c`, `p`, `s`,
 * `0`-`7`, possibly several, possibly empty) and Pd is base64 — or `?` to ask what is on
 * the clipboard.
 */
export function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(';')
  if (semi === -1) return null
  const payload = data.slice(semi + 1)
  if (payload === '' || payload === '?') return null
  try {
    // atob yields one char per byte; the CLI copies UTF-8, so accented text and emoji
    // only survive the round trip through a decoder.
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * Honour OSC 52 copies on `term`. Returns the parser registration to dispose with it.
 *
 * The write goes through the main process for the same reason `clipboardRead` does: the
 * renderer's `navigator.clipboard` wants a permission (and a user gesture) this app has no
 * way to grant, and a sequence arriving from the pty is by definition not a gesture.
 */
export function registerOsc52Copy(term: Terminal) {
  return term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data)
    if (text !== null) void window.electronAPI.clipboardWrite(text)
    // Handled either way — an unanswered query should stay unanswered, not fall through.
    return true
  })
}
