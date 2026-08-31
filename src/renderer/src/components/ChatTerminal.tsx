import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ProviderId } from '../types'
import { TERMINAL_THEME } from './terminal-theme'
import TerminalContextMenu, { terminalMenuItems } from './TerminalContextMenu'
import './ChatTerminal.css'

interface Props {
  /** Stable PTY id for this chat (e.g. `chatterm_<sessionId>`). */
  terminalId: string
  /** Working dir — the chat's project folder (falls back to home in main). */
  cwd?: string
  /** Provider account this terminal runs under. */
  accountId?: string
  /** If the chat runs in WSL, the distro name — the terminal opens inside it. */
  wslDistro?: string
  /** If the chat runs on a remote SSH host, its host id — the terminal connects to it. */
  remoteHostId?: string
  /** Which CLI to launch — the chat's provider. */
  provider: ProviderId
  /** The chat's Claude Code session id — resumed when launching claude. */
  resumeSessionId?: string
  /** Whether to auto-launch the provider CLI once the PTY is up (default true). Set false
   *  for a plain-shell session (e.g. Remote Session's terminal pane) — the PTY is still
   *  created and the loader still gates on real output, but nothing is typed into it. */
  autoLaunchCli?: boolean
  /** True while this terminal's pane is the one visible. Used only to re-fit on show (see
   *  the effect below) — a `display: none` pane has zero size, so a backgrounded session's
   *  terminal (e.g. a Remote Session tab that isn't the active one) needs an explicit refit
   *  when it's shown again. Does NOT remount the terminal — that would kill its live PTY
   *  and scrollback, defeating the whole point of keeping it mounted in the background. */
  active?: boolean
  onClose: () => void
  /** Fired once the PTY has actually launched, so the host can mark this chat as having
   *  real activity (see Session.hasTerminalActivity) even though no `messages` exist. */
  onActive?: () => void
}

// The embedded terminal's palette lives in terminal-theme.ts, shared with
// RemoteTerminal. See that module for why it's fixed rather than following the app theme, and
// for the .chat-terminal-loading background in ChatTerminal.css it has to stay in sync with.

const FONT_SIZE_KEY = 'chatterm-font-size'
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 22

// How long the loading overlay is shown at most, regardless of what the CLI does — a
// backstop so a non-TUI CLI or unexpected output never leaves the loader stuck forever.
const STARTING_BACKSTOP_MS = 8000

// claude, codex, and Antigravity all render inline (no alt screen), so there's no single
// escape sequence that means "the CLI took over". Instead we reveal as soon as the terminal
// has painted any real content — not when output goes quiet: codex streams continuously
// while its model loads and never settles, so a quiet-based reveal would leave the loader up
// for seconds over an already-usable CLI. A tiny grace after the first visible glyph lets
// xterm paint that frame under the overlay so the reveal doesn't flash a blank frame first.
const REVEAL_PAINT_GRACE_MS = 120

// Whether the terminal's current viewport has any real (non-whitespace) glyphs painted.
// Escape-only output — cursor hide/show, screen clear, colour resets — leaves every line's
// rendered text empty, so this stays false until the CLI has actually drawn something. Used
// to gate reveal on real content, not just "output has gone quiet" (a quiet gap can land
// before the CLI paints, e.g. during its cold start).
function hasVisibleContent(term: Terminal): boolean {
  const buf = term.buffer.active
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i)
    if (line && line.translateToString(true).trim().length > 0) return true
  }
  return false
}

/**
 * Whether a local pty on this platform swallows bracketed-paste markers instead of
 * consuming them. True on Windows, where a local terminal is ConPTY.
 *
 * WSL and SSH terminals are not local in this sense — they reach a real pty — so the
 * decision is per-terminal, not per-platform alone. See `pasteText`.
 */
const LOCAL_PTY_EATS_BRACKETS_PLATFORM = navigator.userAgent.includes('Windows')

function loadFontSize(): number {
  const saved = Number(localStorage.getItem(FONT_SIZE_KEY))
  return saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE ? saved : 13
}

export default function ChatTerminal({ terminalId, cwd, accountId, wslDistro, remoteHostId, provider, resumeSessionId, autoLaunchCli = true, active, onClose, onActive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef(terminalId)
  // Keep the latest resume id available to the auto-launch timer below.
  const resumeRef = useRef(resumeSessionId)
  resumeRef.current = resumeSessionId
  // Auto-launch claude when the terminal opens; skipped for an explicit "Restart".
  const autoStartRef = useRef(true)
  const [exited, setExited] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fontSize, setFontSize] = useState(loadFontSize)
  // Hides the raw shell (banner + echoed launch command + a failed --resume bouncing back
  // to the prompt) until the CLI settles in and is idle waiting for input. Revealed by the
  // quiet-timer logic in onTerminalData below, once launched output stops streaming.
  const [starting, setStarting] = useState(true)
  // Where the Shift+right-click menu is open, in viewport coords; null when closed.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  // True from the moment we've typed the launch command until the terminal is revealed —
  // gates the quiet timer so it only arms for output produced by that launch, not for
  // whatever the shell happened to print beforehand.
  const awaitingRevealRef = useRef(false)
  // Debounced "output went quiet" timer, (re)armed by every data chunk while awaiting
  // reveal; fires setStarting(false) once REVEAL_QUIET_MS passes with no further output.
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // A pty outlives this component (see the effect cleanup below), so remounting reattaches to
  // a live one and replays its buffered scrollback. Live chunks that land before that replay
  // is written have to wait in `queuedData`, or they'd paint ahead of the history they follow.
  const replayedRef = useRef(false)
  const queuedDataRef = useRef<string[]>([])
  // Read from the terminal's one-shot setup effect, which can't close over a prop.
  const onActiveRef = useRef(onActive)
  onActiveRef.current = onActive
  // The Shift+right-click menu renders outside the setup effect, so it reaches the
  // effect's `pasteText` through a ref rather than a second copy of the same decision.
  const pasteRef = useRef<(text: string) => void>(() => {})

  // Create the xterm instance once for this component's lifetime.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "Cascadia Code", "DejaVu Sans Mono", monospace',
      fontSize: loadFontSize(),
      scrollback: 5000,
      theme: TERMINAL_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const localPtyEatsBrackets = LOCAL_PTY_EATS_BRACKETS_PLATFORM && !wslDistro && !remoteHostId

    /**
     * Deliver pasted text to the pty.
     *
     * `term.paste` wraps the text in bracketed-paste markers (`\x1b[200~` … `\x1b[201~`)
     * whenever xterm believes that mode is on. On the far end of a local pty that is
     * Windows ConPTY, which does not consume them — the markers came back out as input
     * and every paste arrived twice. WSL and SSH terminals reach a real pty running
     * bash, which handles them correctly and needs them: they are what stops a
     * multi-line paste being executed line by line.
     *
     * Measured, not guessed: a 57-character paste produced a 69-byte write, the twelve
     * extra bytes being exactly the two markers, and the text appeared twice on Windows
     * and once in WSL.
     */
    const pasteText = (text: string) => {
      if (localPtyEatsBrackets) window.electronAPI.terminalWrite(idRef.current, text)
      else term.paste(text)
    }
    pasteRef.current = pasteText

    /** Alt+V, the CLI's own key for attaching the clipboard image. */
    const ALT_V = '\x1bv'

    /**
     * Put the clipboard's image in front of the CLI.
     *
     * Two ways, and which one is right depends on whether the CLI can reach the
     * clipboard itself:
     *
     * - **Locally it can**, so the gesture is translated into its own Alt+V and it
     *   attaches the image properly — the transcript shows `[Image #1]`. Handing it a
     *   file path instead worked, in the sense that the path was correct, and was
     *   plainly worse to use.
     * - **In a distro it often cannot** — `appendWindowsPath = false` leaves it with no
     *   powershell.exe to read the Windows clipboard through — so Argos writes the
     *   image into the distro's own /tmp and types that path.
     *
     * SSH gets neither: the file would be here and the shell is there.
     */
    const pasteImage = () => {
      if (!wslDistro && !remoteHostId) {
        window.electronAPI.terminalWrite(idRef.current, ALT_V)
        return
      }
      void window.electronAPI.clipboardImageToFile(wslDistro, remoteHostId).then((r) => {
        if (r.ok) pasteText(r.path)
      })
    }

    term.onData((d) => {
      // Typing into the terminal is what makes a chat "used". Reporting it when the pty
      // merely started marked every chat opened on the Terminal pane as used the instant
      // it appeared, so blank drafts were kept in the sidebar and could never be reused.
      onActiveRef.current?.()
      window.electronAPI.terminalWrite(idRef.current, d)
    })

    // Copy-on-select (like most native terminals), plus explicit Ctrl/Cmd+C when there's a
    // selection — xterm only forwards raw keystrokes as PTY input by default.
    //
    // Ctrl/Cmd+V IS handled below, and the history is worth keeping, because both of the
    // obvious answers are wrong. xterm's native paste ignores this handler's return value
    // (it never calls preventDefault), so merely reading the clipboard here as well made
    // every paste land twice — once raw from us, once bracketed (\x1b[200~…) from xterm,
    // which garbles input rather than merely duplicating it. But the application menu omits
    // the Edit roles (see src/main/index.ts), and without them Chromium's paste event never
    // fires, so leaving it to xterm meant nothing pasted at all. The branch below calls
    // preventDefault, which is what makes it the single path in either world.
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    })
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        return false
      }
      // Alt+V is the CLI's own "paste an image" key, and inside a WSL distro it cannot
      // work on its own: the CLI would have to reach the Windows clipboard through
      // interop, which a distro with `appendWindowsPath = false` in its wsl.conf does
      // not offer — the CLI then answers "no image in clipboard found", correctly, and
      // there is nothing it can do about it.
      //
      // Argos is on the Windows side of that boundary and can see the clipboard, so it
      // writes the image into the distro's own /tmp over the UNC share and types the
      // path instead. That path works regardless of interop, which is the point.
      //
      // With no image on the clipboard the keystroke is forwarded on as ESC-v, so the
      // CLI still gets its own Alt+V and can say whatever it would have said.
      if (wslDistro && e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'v') {
        window.electronAPI.clipboardImageToFile(wslDistro, remoteHostId).then((res) => {
          if (res.ok) pasteText(res.path)
          // Nothing usable on the clipboard: hand the keystroke on so the CLI answers
          // for itself.
          else window.electronAPI.terminalWrite(idRef.current, ALT_V)
        })
        return false
      }

      // Ctrl/Cmd+V. This one has been wrong in both directions, so the reasoning:
      //
      // xterm's own paste comes from Chromium's paste event, NOT from this handler's
      // return value — returning false does not stop it. That is why an earlier
      // version that only added a read here pasted everything twice, once raw and
      // once bracketed. But the application menu carries no Edit roles (see
      // src/main/index.ts), and without them that paste event never fires at all, so
      // removing the read left the terminal unable to paste anything whatsoever.
      //
      // preventDefault settles it: it kills the native path outright, whether or not
      // it would have fired, leaving exactly one paste — this one.
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        window.electronAPI.clipboardRead().then((res) => {
          if (res.text) {
            pasteText(res.text)
            return
          }
          if (res.image) pasteImage()
        })
        return false
      }

      return true
    })

    // Right-click behaves like a terminal, not like a browser: plain right-click is
    // copy-if-selection / paste-otherwise (the PuTTY/Windows Terminal reflex), and Shift
    // opens the explicit menu for anyone who wants the actions spelled out. Paste goes
    // through term.paste so it takes the exact same single, bracketed-paste-aware code path
    // as Ctrl+V.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      // preventDefault above is the whole signal: the app's own right-click menu
      // (TextContextMenu) steps aside for any event already handled, so this stays
      // the only answer to the gesture.
      if (e.shiftKey) {
        setMenuPos({ x: e.clientX, y: e.clientY })
        return
      }
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        return
      }
      // Read through the main process rather than navigator.clipboard: that one
      // needs a read permission this app has no way to grant, so it failed silently
      // here for exactly as long as nobody tried right-clicking to paste.
      window.electronAPI.clipboardRead().then((res) => {
        if (res.text) {
          pasteText(res.text)
          return
        }
        // An image gets the same treatment Alt+V gives it: written where the CLI can
        // open it, and its path typed. Without this, right-clicking with a screenshot
        // on the clipboard did nothing at all, because the read only ever looked at
        // text.
        if (res.image) pasteImage()
      })
    }
    /**
     * Keep a right-click away from the CLI.
     *
     * The CLIs turn on mouse tracking, so xterm forwards every button press to the pty
     * as an escape sequence — visible in a trace as `\x1b[<2;x;yM`. Claude Code answers
     * a right-click by pasting the clipboard itself. Together with our own paste below,
     * that is two pastes per click, and it was invisible in every reading of our code
     * because our half is provably correct: one event, one write.
     *
     * It only showed on Windows because a WSL distro with `appendWindowsPath = false`
     * leaves the CLI unable to reach the Windows clipboard at all — its paste failed
     * silently there and only ours landed, which read as "WSL works".
     *
     * Captured on the host, so it never reaches xterm's own listeners. The `contextmenu`
     * event still fires on the way up, so the terminal's own copy/paste behaviour is
     * untouched — that one is deliberately ours to answer.
     */
    const swallowRightButton = (e: MouseEvent) => {
      if (e.button === 2) e.stopPropagation()
    }
    host.addEventListener('mousedown', swallowRightButton, true)
    host.addEventListener('mouseup', swallowRightButton, true)

    host.addEventListener('contextmenu', onContextMenu)

    termRef.current = term
    fitRef.current = fit

    const doFit = () => {
      try {
        fit.fit()
        if (idRef.current) window.electronAPI.terminalResize(idRef.current, term.cols, term.rows)
      } catch {
        // container mid-layout / zero-sized — ignore
      }
    }
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)
    // A single rAF can still land before the panel's own layout (flex/display
    // swap) has settled, sizing the terminal off the stale hidden-state rect —
    // chain a second frame so fit() runs against the final visible layout.
    requestAnimationFrame(() => requestAnimationFrame(doFit))

    return () => {
      ro.disconnect()
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('mousedown', swallowRightButton, true)
      host.removeEventListener('mouseup', swallowRightButton, true)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Push font-size changes onto the live terminal and re-fit/resize the PTY.
  useEffect(() => {
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize))
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    try {
      fit.fit()
      if (idRef.current) window.electronAPI.terminalResize(idRef.current, term.cols, term.rows)
    } catch {
      // ignore
    }
  }, [fontSize])

  // Re-fit when this pane goes from hidden to visible (e.g. switching back to a Remote
  // Session tab). A `display: none` pane has zero size, so a backgrounded terminal is
  // stale/zero-sized until shown again — the ResizeObserver above never fires for a display
  // toggle (the element doesn't actually resize while hidden), so this explicit refit on
  // `active` flipping true is the reliable trigger. Deliberately does NOT touch `reloadKey` /
  // depend on anything that would respawn the PTY — only fit() + a resize message.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      if (idRef.current) window.electronAPI.terminalResize(idRef.current, term.cols, term.rows)
    } catch {
      // container mid-layout — ignore, the ResizeObserver will catch up
    }
  }, [active])

  // (Re)spawn the PTY when the id, cwd, account, or an explicit restart changes.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    idRef.current = terminalId
    setExited(false)
    // Only cover the terminal with the loader when we're about to auto-launch the CLI. An
    // explicit Restart (autoStartRef false) intentionally drops to a bare shell, which
    // never enters the alt screen — showing the loader over it would just stall on the
    // backstop timeout.
    setStarting(autoStartRef.current)
    term.reset()

    let cols = term.cols
    let rows = term.rows
    try {
      fit.fit()
      cols = term.cols
      rows = term.rows
    } catch {
      // ignore
    }

    // Backstop: reveal unconditionally after a while, even if output never goes quiet (a
    // chatty CLI, or one that never starts producing output at all) so the loader can
    // never get stuck hiding a perfectly usable terminal.
    const backstopTimer = setTimeout(reveal, STARTING_BACKSTOP_MS)

    // Reveal the terminal, clearing both timers — called once the CLI has painted content
    // (see onTerminalData), or by the backstop above as an absolute fallback. Focus is
    // deferred to here (rather than right after create) on purpose: focusing xterm activates
    // its hidden input textarea, whose NATIVE blinking caret is drawn by the compositor
    // above our overlay (ignoring z-index), showing a stray caret at 0,0 while loading.
    function reveal(): void {
      setStarting(false)
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      termRef.current?.focus()
    }

    const writeChunk = (data: string): void => {
      term.write(data)
      // Reveal as soon as the CLI has actually drawn something. `awaitingRevealRef` is a
      // one-shot gate (flipped off here the moment content first appears) so a CLI that keeps
      // streaming — codex spinning on "model: Loading" — reveals immediately instead of the
      // loader lingering. Gating on visible content (not just "output arrived") avoids
      // revealing a blank screen during a cold-start gap; the short grace lets xterm paint
      // that first frame under the overlay so there's no blank flash on reveal. The backstop
      // above still fires if a CLI never paints anything, so the loader can't wedge.
      if (awaitingRevealRef.current && hasVisibleContent(term)) {
        awaitingRevealRef.current = false
        clearTimeout(quietTimerRef.current)
        quietTimerRef.current = setTimeout(reveal, REVEAL_PAINT_GRACE_MS)
      }
    }

    replayedRef.current = false
    queuedDataRef.current = []

    const offData = window.electronAPI.onTerminalData((e) => {
      if (e.id !== terminalId) return
      if (!replayedRef.current) {
        queuedDataRef.current.push(e.data)
        return
      }
      writeChunk(e.data)
    })
    const offExit = window.electronAPI.onTerminalExit((e) => {
      if (e.id !== terminalId) return
      // STATUS_CONTROL_C_EXIT (0xC000013A) — the pty was torn down by us (a kill), not a
      // real program error. It only ever fires when we already know the terminal is gone,
      // so surfacing it as an "exited" state is just noise (and can race a live reuse).
      if (e.exitCode === -1073741510 || e.exitCode === 3221225786) return
      setExited(true)
      term.write(`\r\n\x1b[2m[process exited${e.exitCode ? ` · code ${e.exitCode}` : ''}]\x1b[0m\r\n`)
    })

    let autoStartTimer: ReturnType<typeof setTimeout> | undefined
    let redrawTimer: ReturnType<typeof setTimeout> | undefined
    window.electronAPI
      .terminalCreate(terminalId, {
        cwd,
        accountId,
        wslDistro,
        remoteHostId,
        provider,
        resumeSessionId: resumeRef.current,
        cols,
        rows
      })
      .then((res) => {
        if (!res.ok) {
          replayedRef.current = true
          term.write('\r\n\x1b[31mFailed to start terminal.\x1b[0m\r\n')
          setStarting(false)
          return
        }
        // Repaint what the pty emitted while we were unmounted, then release the chunks that
        // arrived in the meantime so everything lands in the order the pty produced it.
        if (res.buffer) term.write(res.buffer)
        replayedRef.current = true
        for (const chunk of queuedDataRef.current) writeChunk(chunk)
        queuedDataRef.current = []
        if (res.reused) {
          // Reattached to a pty that kept running while this component was unmounted. Its
          // scrollback is already on screen and whatever CLI it was running is still there, so
          // there's nothing to launch and no first output to wait for — show it right away
          // rather than sitting behind the loader until the backstop fires.
          reveal()
          // Cursor visibility and layout live in the byte stream we just replayed, and a
          // full-screen CLI hides the caret constantly while it draws — so replaying can leave
          // the terminal with no visible caret even though the CLI is sitting at a prompt.
          // Nudging the pty size makes the CLI redraw from scratch (the trick tmux uses on
          // reattach), which restores both authoritatively instead of us guessing at the state.
          window.electronAPI.terminalResize(terminalId, Math.max(cols - 1, 2), rows)
          redrawTimer = setTimeout(() => {
            window.electronAPI.terminalResize(terminalId, cols, rows)
            termRef.current?.focus()
          }, 60)
          autoStartRef.current = true
          return
        }
        // Note: focus is NOT taken here — it's deferred to reveal() so the loader isn't
        // marred by xterm's native input caret (see reveal). The one exception is the
        // bare-shell case below, which shows no loader and so should focus immediately.
        if (res.cliLaunched) {
          // Local shell: main already spawned the provider CLI directly (non-interactive,
          // no banner/echo) as part of createTerminal — there's nothing left to type in, so
          // just arm the reveal gate. The CLI's own first output starts the quiet timer above.
          // Restart also goes through this path (autoStartRef doesn't gate it), so make sure
          // the loader is up for it too — it was only pre-armed for the auto-start case.
          setStarting(true)
          awaitingRevealRef.current = true
        } else if (!autoLaunchCli) {
          // Plain-shell session (autoLaunchCli=false, e.g. Remote Session's terminal
          // pane): the PTY is up but nothing gets typed into it — just arm the reveal
          // gate so the loader lifts once the shell paints its own prompt.
          setStarting(true)
          awaitingRevealRef.current = true
        } else if (autoStartRef.current) {
          // wsl/ssh (or anything else that didn't already launch the CLI): auto-launch by
          // typing the launch command into the interactive remote shell, resuming this
          // chat's session (claude only). A short delay lets the shell print its prompt first.
          autoStartTimer = setTimeout(() => {
            // Arm the reveal gate right as we launch — the very next data chunk (the
            // launch command's own shell echo) starts the quiet timer above.
            awaitingRevealRef.current = true
            window.electronAPI.terminalStartCli(terminalId, provider, resumeRef.current)
          }, 600)
        } else {
          // Bare shell (an explicit Restart on wsl/ssh): no loader is shown, so focus now
          // instead of waiting for a reveal that only the 8s backstop would ever trigger.
          term.focus()
        }
        autoStartRef.current = true
      })

    return () => {
      if (autoStartTimer) clearTimeout(autoStartTimer)
      if (redrawTimer) clearTimeout(redrawTimer)
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      offData()
      offExit()
      // The pty is deliberately left running. Unmounting happens for reasons that have nothing
      // to do with wanting the work to stop — switching chats, closing the terminal pane,
      // navigating to another view — and a CLI mid-task shouldn't die because you looked away.
      // Remounting reattaches and replays the buffered output (see the create call above).
      // A pty is only torn down explicitly: Restart (terminalKill), deleting the chat, or app
      // quit (killAllTerminals).
    }
  }, [terminalId, cwd, accountId, wslDistro, remoteHostId, provider, autoLaunchCli, reloadKey])

  const providerLabel = provider === 'codex' ? 'Codex' : provider === 'gemini' ? 'Antigravity' : 'Claude'

  return (
    <div className="chat-terminal">
      <div className="chat-terminal-bar">
        <span className="chat-terminal-label">
          Terminal
          {cwd && <span className="chat-terminal-cwd" title={cwd}>{cwd.split(/[\\/]/).filter(Boolean).pop()}</span>}
        </span>
        <div className="chat-terminal-actions">
          <div className="chat-terminal-fontsize">
            <button
              className="chat-terminal-btn icon"
              onClick={() => setFontSize((s) => Math.max(MIN_FONT_SIZE, s - 1))}
              title="Decrease font size"
              aria-label="Decrease terminal font size"
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              −
            </button>
            <span className="chat-terminal-fontsize-value">{fontSize}</span>
            <button
              className="chat-terminal-btn icon"
              onClick={() => setFontSize((s) => Math.min(MAX_FONT_SIZE, s + 1))}
              title="Increase font size"
              aria-label="Increase terminal font size"
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              +
            </button>
          </div>
          <button
            className="chat-terminal-btn"
            onClick={() => {
              autoStartRef.current = false
              // Immediate, not deferred: Restart must force a genuinely fresh pty, not
              // reuse the live one.
              window.electronAPI.terminalKill(terminalId)
              setReloadKey((k) => k + 1)
            }}
            title="Restart the terminal (relaunch the CLI)"
          >
            Restart
          </button>
          <button className="chat-terminal-btn icon" onClick={onClose} title="Close terminal" aria-label="Close terminal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="chat-terminal-host-wrap">
        <div ref={hostRef} className="chat-terminal-host" />
        {starting && !exited && (
          <div className="chat-terminal-loading">
            <div className="chat-terminal-spinner" />
            <div className="chat-terminal-loading-text">{autoLaunchCli ? `Starting ${providerLabel}…` : 'Connecting…'}</div>
          </div>
        )}
        {exited && (
          <button
            className="chat-terminal-restart"
            onClick={() => {
              window.electronAPI.terminalKill(terminalId)
              setReloadKey((k) => k + 1)
            }}
          >
            Restart terminal
          </button>
        )}
        {menuPos && (
          <TerminalContextMenu
            x={menuPos.x}
            y={menuPos.y}
            onClose={() => setMenuPos(null)}
            items={terminalMenuItems(termRef.current, pasteRef.current)}
          />
        )}
      </div>
    </div>
  )
}
