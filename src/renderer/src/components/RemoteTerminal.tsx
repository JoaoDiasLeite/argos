import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_THEME } from './terminal-theme'
import TerminalContextMenu, { terminalMenuItems } from './TerminalContextMenu'
import { registerOsc52Copy } from '../lib/osc52'
import { registerCwdReports } from '../lib/terminal-cwd'
import { registerTerminalLinks } from '../lib/terminal-links'
import { useT } from '../i18n'
import { useLabs } from '../hooks/useLabs'
import type { RemoteContainerTarget, RemoteShellSecretHintEvent, SshHostPublic } from '../types'
import './ChatTerminal.css'

/** Only flags: the renderer never holds a host's secrets. */
type SecretFlags = Pick<SshHostPublic, 'hasPassword' | 'hasPassphrase' | 'hasElevation' | 'elevateCommand'>

interface Props {
  /** Stable id for this shell channel (e.g. `remoteterm_<hostId>`). */
  terminalId: string
  /** The SSH host id to connect to — the interactive shell rides the SAME ssh2 connection
   *  SFTP already has open for this host (see remote-shell.ts / sftp.ts getRemoteClient).
   *  Null for a container on this computer, which runs on a local pty (needs `container`). */
  hostId: string | null
  /** True while this terminal's pane is the one visible. The session (and this component)
   *  stays mounted in the background regardless — a `display: none` pane has zero size, so
   *  a re-fit is needed when it becomes visible again or xterm renders stale/blank. */
  active?: boolean
  /** Hidden when the host owns this pane outright (a remote session's terminal column):
   *  the session's tab is what closes it, so a close here would only mislead. */
  closable?: boolean
  onClose?: () => void
  /** The shell's working directory, as its prompt reports it (lib/terminal-cwd.ts) — the
   *  path may still start with `~`. Lets the file pane beside it follow a `cd`. */
  onCwdChange?: (path: string) => void
  /** A container tab: the channel runs that container's shell instead of the login shell. */
  container?: RemoteContainerTarget
  /** The host's saved-secret flags, for the "Send password" and "Elevate" actions. Main
   *  picks and types the secret itself; these only decide which buttons show. */
  secrets?: SecretFlags | null
}

/**
 * The Remote Session ("Connect") view's SSH terminal — an ssh2 interactive shell channel,
 * not a node-pty process. Copied down from ChatTerminal.tsx (xterm setup, copy-on-select,
 * Ctrl/Cmd-C, right-click copy/paste + menu, font-size controls, resize/fit,
 * reveal-on-content gate) — keep the clipboard/theme bits in step with it — but with all
 * provider/resume/CLI-launch logic stripped: the remote login shell IS the whole point —
 * there's nothing to type into it on our behalf.
 */

// The palette (and the reason it's fixed rather than themed) lives in terminal-theme.ts,
// shared with ChatTerminal so the two can't drift.

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

export default function RemoteTerminal({ terminalId, hostId, active, closable = true, onClose, onCwdChange, container, secrets }: Props) {
  const t = useT()
  const labs = useLabs()
  // Read from the one-shot setup effect, which cannot close over a prop.
  const onCwdRef = useRef(onCwdChange)
  onCwdRef.current = onCwdChange
  // The shell effect writes translated notes into the terminal; it must not re-run (and
  // reconnect) when the language changes, so it reads the translator through a ref.
  const tRef = useRef(t)
  tRef.current = t
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef(terminalId)
  // Fixed for the tab's life; read by the create effect without making it a dependency.
  const containerRef = useRef(container)
  const [exited, setExited] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fontSize, setFontSize] = useState(loadFontSize)
  const [starting, setStarting] = useState(true)
  // Where the Shift+right-click menu is open, in viewport coords; null when closed.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const awaitingRevealRef = useRef(false)
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Main's hint that the shell sits at a password prompt: it only lights the key button up.
  const [secretHint, setSecretHint] = useState<RemoteShellSecretHintEvent['kind']>(null)
  // The "send anyway?" confirmation after a no-prompt answer, or a short note on a refusal.
  const [secretPanel, setSecretPanel] = useState<'confirm' | { note: string } | null>(null)

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
    term.onData((d) => window.electronAPI.remoteShellWrite(idRef.current, d))

    // A CLI with no local clipboard of its own (Claude Code in a WSL distro without
    // Windows interop, or anything over SSH) asks the terminal to copy for it. See
    // lib/osc52.ts.
    registerOsc52Copy(term)
    registerCwdReports(term, (p) => onCwdRef.current?.(p))
    registerTerminalLinks(term)

    // Copy-on-select (like most native terminals), plus explicit Ctrl/Cmd+C when there's a
    // selection — xterm only forwards raw keystrokes as shell input by default.
    //
    // Ctrl/Cmd+V IS handled below — see the long note in ChatTerminal.tsx. Short version:
    // xterm's native paste ignores this handler's return value, so reading the clipboard
    // here as well pasted twice; but the application menu omits the Edit roles, so
    // Chromium's paste event never fires and leaving it to xterm pasted nothing. The
    // branch below calls preventDefault, which makes it the single path either way.
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
      // Ctrl/Cmd+V — see the long note in ChatTerminal.tsx for why this reads the
      // clipboard itself and calls preventDefault: xterm's native paste comes from
      // Chromium's paste event, which does not fire in this app, and returning false
      // alone does not stop it when it does.
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        window.electronAPI.clipboardRead().then((res) => {
          // Text only. An image would have to be written on this machine while the
          // shell looks for it on another — refused, see clipboard:image-to-file.
          if (res.text) term.paste(res.text)
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
          term.paste(res.text)
          return
        }
        // Nothing to do for an image here. The file would be written on this machine
        // while the shell looks for it on another, so the main process refuses a
        // remote target outright rather than typing a path that points at nothing.
        // See clipboard:image-to-file.
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
      // A hidden pane has no size, and the fit addon measures computed style rather than
      // the box, so fitting it shrank the shell to a handful of rows and grew it back on
      // return — a resize round trip that cost the scrollback (see ChatTerminal's doFit).
      // Left alone; the `active` effect refits once the pane is shown.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        if (idRef.current) window.electronAPI.remoteShellResize(idRef.current, term.cols, term.rows)
      } catch {
        // container mid-layout — ignore
      }
    }
    // Debounced, and skipped while a divider is dragged (the session's pane handle sets
    // paneDrag, as PaneSplitter does): every fit sends a window change over SSH, and a drag
    // would send one per frame. The drag gets one fit when it ends (panedragend).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (document.body.dataset.paneDrag === '1') return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, 70)
    })
    ro.observe(host)
    requestAnimationFrame(() => requestAnimationFrame(doFit))
    window.addEventListener('panedragend', doFit)

    return () => {
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      window.removeEventListener('panedragend', doFit)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('mousedown', swallowRightButton, true)
      host.removeEventListener('mouseup', swallowRightButton, true)
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
    setSecretHint(null)
    setSecretPanel(null)
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
      // Checked once xterm has parsed the chunk: write() is async, so checking straight
      // after it missed a prompt that came in one piece (a container's `exec` shell) and
      // left the loader up until the backstop.
      term.write(e.data, () => {
        if (awaitingRevealRef.current && hasVisibleContent(term)) {
          awaitingRevealRef.current = false
          clearTimeout(quietTimerRef.current)
          quietTimerRef.current = setTimeout(reveal, REVEAL_PAINT_GRACE_MS)
        }
      })
    })
    const offExit = window.electronAPI.onRemoteShellExit((e) => {
      if (e.id !== terminalId) return
      setExited(true)
      setSecretHint(null)
      setSecretPanel(null)
      term.write(
        `\r\n\x1b[2m[${e.code ? tRef.current('remote.terminal.closedCode', { code: e.code }) : tRef.current('remote.terminal.closed')}]\x1b[0m\r\n`
      )
    })

    const offHint = window.electronAPI.onRemoteShellSecretHint((e) => {
      if (e.id === terminalId) setSecretHint(e.kind)
    })

    // Set by the cleanup: a create still connecting when the effect tears down is killed in
    // main and resolves as a failure — that's not an error to paint into the terminal.
    let disposed = false
    window.electronAPI.remoteShellCreate(terminalId, hostId, cols, rows, containerRef.current).then((res) => {
      if (disposed) return
      if (!res.ok) {
        term.write(
          `\r\n\x1b[31m${res.error ? tRef.current('remote.terminal.startFailedWhy', { error: res.error }) : tRef.current('remote.terminal.startFailed')}\x1b[0m\r\n`
        )
        setStarting(false)
        return
      }
      // The PTY is up but nothing gets typed into it — just arm the reveal gate so the
      // loader lifts once the remote shell paints its own prompt.
      awaitingRevealRef.current = true
    })

    return () => {
      disposed = true
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      offData()
      offExit()
      offHint()
      window.electronAPI.remoteShellKill(terminalId)
    }
  }, [terminalId, hostId, reloadKey])

  // A refusal note clears itself; the confirmation waits for an answer.
  useEffect(() => {
    if (!secretPanel || secretPanel === 'confirm') return
    const timer = setTimeout(() => setSecretPanel(null), 4000)
    return () => clearTimeout(timer)
  }, [secretPanel])

  // Local container ptys have no host, so no secret to send.
  // Both are experimental features: hidden with them off (main refuses them too).
  const canSendSecret = labs && hostId !== null && !!secrets && (secrets.hasPassword || secrets.hasPassphrase || secrets.hasElevation)
  const canElevate = labs && hostId !== null && !!secrets?.hasElevation
  // Shown as main will type it (elevateCommandFor falls back to the same default).
  const elevateCommand = secrets?.elevateCommand ?? 'sudo -i'

  const secretNote = (reason: string): string =>
    reason === 'no-secret'
      ? t('remote.terminal.secretNone')
      : reason === 'rate-limited'
        ? t('remote.terminal.secretRateLimited')
        : t('remote.terminal.secretFailed')

  // Main checks the prompt and picks the secret; a no-prompt answer asks before a forced send
  // (which goes without Enter). Nothing is ever sent without this click.
  const sendSecret = async (force: boolean): Promise<void> => {
    setSecretPanel(null)
    const res = await window.electronAPI.remoteShellSendSecret(terminalId, force ? { force: true } : undefined)
    if (!res.ok && res.reason === 'no-prompt' && !force) {
      setSecretPanel('confirm')
      return
    }
    if (res.ok) setSecretHint(null)
    else setSecretPanel({ note: secretNote(res.reason) })
    termRef.current?.focus()
  }

  const elevate = async (): Promise<void> => {
    setSecretPanel(null)
    const res = await window.electronAPI.remoteShellElevate(terminalId)
    if (!res.ok) setSecretPanel({ note: secretNote(res.reason) })
    termRef.current?.focus()
  }

  return (
    <div className="chat-terminal">
      <div className="chat-terminal-bar">
        <span className="chat-terminal-label">{t('remote.terminal.label')}</span>
        <div className="chat-terminal-actions">
          {canElevate && (
            <button
              className="btn-ghost small"
              onClick={() => void elevate()}
              // At a password prompt the command would be typed in as a wrong password.
              disabled={exited || !!secretHint}
              title={t('remote.terminal.elevateTitle', { command: elevateCommand })}
            >
              {t('remote.terminal.elevate', { command: elevateCommand })}
            </button>
          )}
          {canSendSecret && (
            <button
              className={`chat-terminal-btn${secretHint ? ' is-prompting' : ''}`}
              onClick={() => void sendSecret(false)}
              disabled={exited}
              title={secretHint ? t('remote.terminal.sendSecretPrompt') : t('remote.terminal.sendSecret')}
              aria-label={t('remote.terminal.sendSecret')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="7.5" cy="15.5" r="5.5" />
                <path d="m21 2-9.6 9.6" />
                <path d="m15.5 7.5 3 3L22 7l-3-3" />
              </svg>
            </button>
          )}
          <div className="chat-terminal-fontsize">
            <button
              className="chat-terminal-btn"
              onClick={() => setFontSize((s) => Math.max(MIN_FONT_SIZE, s - 1))}
              title={t('remote.terminal.smaller')}
              aria-label={t('remote.terminal.smaller')}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <span className="chat-terminal-fontsize-value">{fontSize}</span>
            <button
              className="chat-terminal-btn"
              onClick={() => setFontSize((s) => Math.min(MAX_FONT_SIZE, s + 1))}
              title={t('remote.terminal.larger')}
              aria-label={t('remote.terminal.larger')}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <button
            className="btn-ghost small"
            onClick={() => {
              window.electronAPI.remoteShellKill(terminalId)
              setReloadKey((k) => k + 1)
            }}
            title={t('remote.terminal.restartTitle')}
          >
            {t('remote.terminal.restart')}
          </button>
          {closable && (
            <button className="chat-terminal-btn" onClick={onClose} title={t('remote.terminal.close')} aria-label={t('remote.terminal.close')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="chat-terminal-host-wrap">
        <div ref={hostRef} className="chat-terminal-host" />
        {secretPanel === 'confirm' && (
          <div className="chat-terminal-secret-pop" role="alertdialog" aria-label={t('remote.terminal.sendSecret')}>
            <p>{t('remote.terminal.secretNoPrompt')}</p>
            <div className="chat-terminal-secret-pop-actions">
              <button
                className="btn-ghost small"
                autoFocus
                onClick={() => {
                  setSecretPanel(null)
                  termRef.current?.focus()
                }}
              >
                {t('remote.terminal.secretCancel')}
              </button>
              <button className="btn-primary small" onClick={() => void sendSecret(true)}>
                {t('remote.terminal.secretSendAnyway')}
              </button>
            </div>
          </div>
        )}
        {secretPanel && secretPanel !== 'confirm' && (
          <div className="chat-terminal-secret-pop" role="status">
            <p>{secretPanel.note}</p>
          </div>
        )}
        {starting && !exited && (
          <div className="chat-terminal-loading">
            <div className="chat-terminal-spinner" />
            <div className="chat-terminal-loading-text">{t('remote.terminal.connecting')}</div>
          </div>
        )}
        {exited && (
          <div className="block chat-terminal-exited" role="status">
            <span className="help">{t('remote.terminal.exited')}</span>
            <button className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
              {t('remote.terminal.reconnect')}
            </button>
          </div>
        )}
        {/* Paste goes through term.paste unconditionally here: an SSH terminal reaches a
            real pty running a real shell, which consumes bracketed-paste markers correctly
            and needs them — they are what stops a multi-line paste being executed line by
            line. Only a local Windows pty (ConPTY) mishandles them; see ChatTerminal. */}
        {menuPos && (
          <TerminalContextMenu
            x={menuPos.x}
            y={menuPos.y}
            onClose={() => setMenuPos(null)}
            items={terminalMenuItems(termRef.current, (t) => termRef.current?.paste(t))}
          />
        )}
      </div>
    </div>
  )
}
