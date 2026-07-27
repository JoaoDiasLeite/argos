import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './ChatTerminal.css'

interface Props {
  /** Stable id for this shell channel (e.g. `remoteterm_<hostId>`). */
  terminalId: string
  /** The SSH host id to connect to — the interactive shell rides the SAME ssh2 connection
   *  SFTP already has open for this host (see remote-shell.ts / sftp.ts getRemoteClient). */
  hostId: string
  /** True while this terminal's pane is the one visible. The session (and this component)
   *  stays mounted in the background regardless — a `display: none` pane has zero size, so
   *  a re-fit is needed when it becomes visible again or xterm renders stale/blank. */
  active?: boolean
  onClose: () => void
}

/**
 * The Remote Session ("Connect") view's SSH terminal — an ssh2 interactive shell channel,
 * not a node-pty process. Copied down from ChatTerminal.tsx (xterm setup, copy-on-select,
 * Ctrl/Cmd-C/V, font-size controls, resize/fit, reveal-on-content gate) but with all
 * provider/resume/CLI-launch logic stripped: the remote login shell IS the whole point —
 * there's nothing to type into it on our behalf.
 */

// Same fixed dark theme as ChatTerminal — must stay in sync with .chat-terminal-loading's
// background in ChatTerminal.css.
const TERMINAL_BG = '#17140f'
const TERMINAL_FG = '#e8e2d6'

const FONT_SIZE_KEY = 'chatterm-font-size'
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 22

// Backstop so the loader can never get stuck hiding a perfectly usable terminal.
const STARTING_BACKSTOP_MS = 8000
const REVEAL_PAINT_GRACE_MS = 120

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

export default function RemoteTerminal({ terminalId, hostId, active, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef(terminalId)
  const [exited, setExited] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fontSize, setFontSize] = useState(loadFontSize)
  const [starting, setStarting] = useState(true)
  const awaitingRevealRef = useRef(false)
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // Create the xterm instance once for this component's lifetime.
  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "Cascadia Code", "DejaVu Sans Mono", monospace',
      fontSize: loadFontSize(),
      scrollback: 5000,
      theme: { background: TERMINAL_BG, foreground: TERMINAL_FG, cursor: TERMINAL_FG }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    term.onData((d) => window.electronAPI.remoteShellWrite(idRef.current, d))

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
      if (mod && e.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((text) => {
          if (text) window.electronAPI.remoteShellWrite(idRef.current, text)
        }).catch(() => {})
        return false
      }
      return true
    })

    termRef.current = term
    fitRef.current = fit

    const doFit = () => {
      try {
        fit.fit()
        if (idRef.current) window.electronAPI.remoteShellResize(idRef.current, term.cols, term.rows)
      } catch {
        // container mid-layout / zero-sized — ignore
      }
    }
    const ro = new ResizeObserver(() => doFit())
    ro.observe(hostRef.current)
    requestAnimationFrame(() => requestAnimationFrame(doFit))

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Push font-size changes onto the live terminal and re-fit/resize the shell.
  useEffect(() => {
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize))
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    try {
      fit.fit()
      if (idRef.current) window.electronAPI.remoteShellResize(idRef.current, term.cols, term.rows)
    } catch {
      // ignore
    }
  }, [fontSize])

  // Re-fit when this pane goes from hidden to visible. A `display: none` pane has zero size,
  // so a background session's terminal is stale/zero-sized until it's shown again — the
  // ResizeObserver above doesn't fire for a display toggle (the element never actually
  // resizes while hidden), so this explicit refit on `active` flipping true is the trigger.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      if (idRef.current) window.electronAPI.remoteShellResize(idRef.current, term.cols, term.rows)
    } catch {
      // container mid-layout — ignore, the ResizeObserver will catch up
    }
  }, [active])

  // (Re)open the shell channel when the id/host changes or an explicit restart happens.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    idRef.current = terminalId
    setExited(false)
    setStarting(true)
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

    const backstopTimer = setTimeout(reveal, STARTING_BACKSTOP_MS)

    function reveal(): void {
      setStarting(false)
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      term?.focus()
    }

    const offData = window.electronAPI.onRemoteShellData((e) => {
      if (e.id !== terminalId) return
      term.write(e.data)
      if (awaitingRevealRef.current && hasVisibleContent(term)) {
        awaitingRevealRef.current = false
        clearTimeout(quietTimerRef.current)
        quietTimerRef.current = setTimeout(reveal, REVEAL_PAINT_GRACE_MS)
      }
    })
    const offExit = window.electronAPI.onRemoteShellExit((e) => {
      if (e.id !== terminalId) return
      setExited(true)
      term.write(`\r\n\x1b[2m[connection closed${e.code ? ` · code ${e.code}` : ''}]\x1b[0m\r\n`)
    })

    window.electronAPI.remoteShellCreate(terminalId, hostId, cols, rows).then((res) => {
      if (!res.ok) {
        term.write(`\r\n\x1b[31mFailed to start terminal${res.error ? `: ${res.error}` : '.'}\x1b[0m\r\n`)
        setStarting(false)
        return
      }
      // The PTY is up but nothing gets typed into it — just arm the reveal gate so the
      // loader lifts once the remote shell paints its own prompt.
      awaitingRevealRef.current = true
    })

    return () => {
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      offData()
      offExit()
      window.electronAPI.remoteShellKill(terminalId)
    }
  }, [terminalId, hostId, reloadKey])

  return (
    <div className="chat-terminal">
      <div className="chat-terminal-bar">
        <span className="chat-terminal-label">Terminal</span>
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
              window.electronAPI.remoteShellKill(terminalId)
              setReloadKey((k) => k + 1)
            }}
            title="Reconnect the shell"
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
            <div className="chat-terminal-loading-text">Connecting…</div>
          </div>
        )}
        {exited && (
          <button
            className="chat-terminal-restart"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Reconnect
          </button>
        )}
      </div>
    </div>
  )
}
