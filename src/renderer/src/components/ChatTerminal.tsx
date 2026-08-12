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
    // There is deliberately NO Ctrl/Cmd+V branch here: xterm owns paste. Its native paste
    // path ignores this handler's return value (it never calls preventDefault), so Chromium's
    // own paste event reached xterm's internal paste() regardless and the pasted text landed
    // twice — once raw from us, once bracketed (\x1b[200~…) from xterm, which garbles input
    // rather than merely duplicating it. Letting xterm handle it means one write, and
    // bracketed-paste mode is honoured. See also the application menu in src/main/index.ts,
    // which omits the Edit roles for the same reason.
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
      return true
    })

    // Right-click behaves like a terminal, not like a browser: plain right-click is
    // copy-if-selection / paste-otherwise (the PuTTY/Windows Terminal reflex), and Shift
    // opens the explicit menu for anyone who wants the actions spelled out. Paste goes
    // through term.paste so it takes the exact same single, bracketed-paste-aware code path
    // as Ctrl+V.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (e.shiftKey) {
        setMenuPos({ x: e.clientX, y: e.clientY })
        return
      }
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        return
      }
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text)
        })
        .catch(() => {})
    }
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
            items={terminalMenuItems(termRef.current)}
          />
        )}
      </div>
    </div>
  )
}
