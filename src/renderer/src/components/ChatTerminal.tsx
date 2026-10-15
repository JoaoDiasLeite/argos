import { useContext, useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ProviderId } from '../types'
import { useT } from '../i18n'
import { TERMINAL_THEME } from './terminal-theme'
import TerminalContextMenu, { terminalMenuItems } from './TerminalContextMenu'
import { TerminalAccelContext } from './terminal-accel'
import { registerOsc52Copy } from '../lib/osc52'
import { registerCwdReports } from '../lib/terminal-cwd'
import { imagePasteRoute } from '../lib/terminal-image-paste'
import { registerTerminalLinks } from '../lib/terminal-links'
import { terminalPathsText } from '../lib/terminal-file-paths'
import { isTerminalReport } from '../lib/terminal-reports'
import type { OpsTerminalLaunch } from '../lib/ops-terminal'
import ChatHead from './ChatHead'
import Menu, { type MenuItem } from './Menu'
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
  /** The chat's Claude Code session id, when a conversation already exists under it —
   *  launching claude resumes it. */
  resumeSessionId?: string
  /** The id this chat reserved before its first conversation. Launching claude creates
   *  under it. Kept apart from resumeSessionId because the two ask the CLI for opposite
   *  things, and guessing wrong prints an error into the terminal before recovering. */
  pinSessionId?: string
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
  /** Hidden when the host owns this pane outright (terminal mode) — there is nothing
   *  to close back to, so a close button would only strand the user. */
  closable?: boolean
  onClose?: () => void
  /** The header's name — the chat's, wherever there is one. Falls back to "Terminal". */
  title?: string
  /** Spread on the header: a split pane makes it the handle that drags the pane. */
  headProps?: HTMLAttributes<HTMLDivElement>
  /** Given only in a split: the header's × then closes the pane (the CLI keeps running),
   *  and closing the terminal itself moves into the ⋯ menu. */
  onClosePane?: () => void
  /** Shows a menu item that opens this chat in its own window (see src/main/chat-popout.ts). */
  onPopOut?: () => void
  /** The inverse, shown inside a pop-out window: hand the chat back to the main window's
   *  panes. Closing the window does the same; this is the discoverable way. */
  onPopIn?: () => void
  /** Typed into the CLI, with Enter, once it is up. Sent at most once per mount (see
   *  sentPromptRef) so a Restart doesn't silently re-run the task. */
  initialPrompt?: string
  onInitialPromptSent?: () => void
  /** Fired once the PTY has actually launched, so the host can mark this chat as having
   *  real activity (see Session.hasTerminalActivity) even though no `messages` exist. */
  onActive?: () => void
  /** Render this terminal on the GPU (xterm's WebGL renderer) instead of in the DOM.
   *
   *  Default `false`, and deliberately so: Chromium caps the number of live WebGL contexts
   *  per renderer process (~16), and a view that mounted one terminal per running pty
   *  would exhaust them and have terminals lose their context in a
   *  cascade. Only a bounded set of terminals — the at-most-four workspace panes, which are
   *  also the ones streaming output at the same time — asks for it.
   *
   *  Left undefined, the answer comes from `TerminalAccelContext` (PaneGrid provides it),
   *  which is how the workspace panes get it without `ChatPane`/`Chat` having to forward a
   *  prop they have no opinion about.
   *
   *  Read once, when the terminal is created — flipping it later does not move a live
   *  terminal between renderers. */
  accelerated?: boolean
  /** An ops terminal (Ops workspace): the relay token env and MCP config main issued for
   *  this launch, forwarded into `terminalCreate` as-is. Read when the pty is created, like
   *  everything else here; a new launch is a remount. */
  ops?: OpsTerminalLaunch
  /** The shell's working directory, as its prompt reports it (lib/terminal-cwd.ts) — the
   *  path may still start with `~`. Lets the file pane beside a session follow a `cd`. */
  onCwdChange?: (path: string) => void
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

// An erase-display sequence: ESC [ 2 J (the screen) or ESC [ 3 J (the scrollback too) —
// what `clear` emits on the shells a wsl/ssh launch is typed into. See awaitingClearRef.
const CLEAR_SCREEN_RE = /\x1b\[[23]J/

// How long after the reveal a seeded prompt waits before being typed. The CLI has painted
// by then, but claude and codex both bind their input a frame or two later, and anything
// sent before that is swallowed with no trace.
const INITIAL_PROMPT_DELAY_MS = 500
// Between the prompt's text and its Enter. Sent in one write, the CLI reads the burst as a
// paste and the trailing \r lands in the input box instead of submitting, which left an
// intervention's first message sitting there unsent.
const PROMPT_SUBMIT_DELAY_MS = 200

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

// The folder-trust question Claude Code ("Yes, I trust this folder") and Codex ("Do you
// trust the files in this folder?") ask on a folder they have not seen. A seeded prompt
// typed into it is lost, and its Enter answers the question with the default — "No,
// exit" — so a run in a fresh runbook folder died with code 1 before the user saw why.
const TRUST_PROMPT_RE = /trust this folder|trust the files in this folder/i

function viewportShows(term: Terminal, re: RegExp): boolean {
  const buf = term.buffer.active
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i)
    if (line && re.test(line.translateToString(true))) return true
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

export default function ChatTerminal({ terminalId, cwd, accountId, wslDistro, remoteHostId, provider, resumeSessionId, pinSessionId, autoLaunchCli = true, active, closable = true, onClose, onClosePane, title, headProps, onPopOut, onPopIn, onActive, initialPrompt, onInitialPromptSent, accelerated, ops, onCwdChange }: Props) {
  const t = useT()
  // Read from the one-shot setup effect, which cannot close over a prop.
  const onCwdRef = useRef(onCwdChange)
  onCwdRef.current = onCwdChange
  // Read from inside the long-lived terminal effects, which must not restart on a language change.
  const tRef = useRef(t)
  tRef.current = t
  // An explicit prop wins; otherwise the surrounding view decides (false by default).
  const accelFromContext = useContext(TerminalAccelContext)
  // The setup effect below runs once and cannot close over a prop that changes later, and
  // the renderer is chosen when the terminal is created anyway — so latch the answer in a
  // ref rather than pretending the effect could react to it.
  const acceleratedRef = useRef(accelerated ?? accelFromContext)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef(terminalId)
  // Keep the latest resume id available to the auto-launch timer below.
  const resumeRef = useRef(resumeSessionId)
  resumeRef.current = resumeSessionId
  const pinRef = useRef(pinSessionId)
  pinRef.current = pinSessionId
  const opsRef = useRef(ops)
  opsRef.current = ops
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
  // True while a launch typed into an interactive shell (wsl/ssh) has not yet cleared the
  // screen. The shell echoes the launch line itself — `clear; claude --resume …` — and
  // that echo is "visible content" as far as the reveal gate is concerned, so without
  // this the shell, the echoed command and whatever a failed --resume printed all showed
  // through until the CLI's own paint caught up. The `clear` in front of every launch
  // command (see claudeLaunchCommand in main) is the signal: nothing painted before it
  // counts, the first thing painted after it is the CLI.
  const awaitingClearRef = useRef(false)
  // Debounced "output went quiet" timer, (re)armed by every data chunk while awaiting
  // reveal; fires setStarting(false) once REVEAL_QUIET_MS passes with no further output.
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // The seeded prompt and its one-shot latch. Refs, not props read directly: the terminal's
  // setup effect runs once per mount and cannot close over a prop that arrives later.
  const promptRef = useRef(initialPrompt)
  promptRef.current = initialPrompt
  const onPromptSentRef = useRef(onInitialPromptSent)
  onPromptSentRef.current = onInitialPromptSent
  const sentPromptRef = useRef(false)
  const promptTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // The seeded prompt is waiting for a folder-trust question to be answered (TRUST_PROMPT_RE).
  const holdingPromptRef = useRef(false)
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

  // Whether the CLI over in the distro can read the Windows clipboard itself — null until
  // the probe answers. A ref, not state: the only reader is the paste handler inside the
  // setup effect below, which runs once and would never see a new value anyway.
  const distroReadsClipboardRef = useRef<boolean | null>(null)

  // Ask once, when the terminal appears, rather than when something is pasted into it:
  // the probe starts the distro if it is cold, and a paste that waited seconds for an
  // answer would be worse than either of the answers.
  useEffect(() => {
    if (!wslDistro) return
    let live = true
    void window.electronAPI.wslClipboardImageCapable(wslDistro).then((ok) => {
      if (live) distroReadsClipboardRef.current = ok
    })
    return () => {
      live = false
    }
  }, [wslDistro])

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

    /**
     * The GPU renderer, when this terminal was allowed one. Null means "DOM renderer", which
     * is a fully working terminal — just one that repaints ~25 000 cells of DOM when three or
     * four CLIs stream at once, which is the whole reason the option exists.
     *
     * Everything here is best-effort by design. Acceleration is a speed-up, never a
     * correctness requirement, so no failure in it may be allowed to take the terminal down
     * with it:
     *
     * - **Creation can throw** — no WebGL at all, a blacklisted driver, software rendering,
     *   or the process having already handed out its last context. Caught: we stay on the
     *   DOM renderer and the rest of the mount proceeds untouched.
     * - **A live context can be taken away** — driver reset, a laptop switching GPUs, or
     *   Chromium evicting the oldest context once too many are alive. xterm keeps the
     *   buffer, the selection and the pty binding either way; only the painter dies. So
     *   `onContextLoss` disposes the addon, which drops the terminal back to the DOM
     *   renderer with its scrollback and its pty intact. Without this the terminal would
     *   stay blank while still being very much alive, which is far worse than never having
     *   accelerated it.
     *
     * Loaded after `term.open`, because the addon needs the terminal's element to exist
     * before it can make a canvas for it.
     */
    let webgl: WebglAddon | null = null
    if (acceleratedRef.current) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          // Deliberately not re-created: whatever took the context away is likely to take
          // the next one too, and a terminal that flickers between renderers is worse than
          // one that quietly settles on the slower, always-available path.
          addon.dispose()
          if (webgl === addon) webgl = null
        })
        // `loadAddon` is where the context is actually created, so it has to be inside the
        // try as well — not just the constructor.
        term.loadAddon(addon)
        webgl = addon
      } catch {
        webgl = null
      }
    }

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
     * Put the clipboard's image in front of the CLI — as its own Alt+V where the CLI
     * can read the clipboard, as a written-out file and a typed path where it cannot.
     * Which is which is decided in lib/terminal-image-paste.ts.
     *
     * A distro used to be assumed unable to reach the Windows clipboard, and so always
     * got the path. Most can: Claude Code there falls back to powershell over interop,
     * and a picture pasted into a WSL chat now arrives as `[Image #1]` like it
     * does locally, instead of as /tmp/argos-paste-….png at the prompt.
     */
    const pasteImage = () => {
      const route = imagePasteRoute({
        wslDistro,
        remoteHostId,
        provider,
        cliRunning: autoLaunchCli,
        distroReadsClipboard: distroReadsClipboardRef.current
      })
      if (route === 'refuse') return
      if (route === 'cli-clipboard') {
        window.electronAPI.terminalWrite(idRef.current, ALT_V)
        return
      }
      void window.electronAPI.clipboardImageToFile(wslDistro, remoteHostId).then((r) => {
        if (r.ok) pasteText(r.path)
      })
    }

    /** Files — copied in Explorer, or dropped — typed out as paths the CLI can open. */
    const pastePaths = async (paths: string[]) => {
      // A distro names Windows paths its own way; ask it rather than assume /mnt.
      const linux =
        wslDistro && !remoteHostId ? await window.electronAPI.wslToLinuxPaths(wslDistro, paths) : undefined
      const text = terminalPathsText(paths, { wslDistro, remoteHostId }, linux)
      if (text) pasteText(text)
    }

    term.onData((d) => {
      // Typing into the terminal is what makes a chat "used". Reporting it when the pty
      // merely started marked every chat opened on the Terminal pane as used the instant
      // it appeared, so blank drafts were kept in the sidebar and could never be reused.
      // Reports xterm sends on its own (focus, the pointer moving under Claude Code's mouse
      // tracking, answers to the CLI's queries) are the same mistake by another route:
      // focusing a chat, or passing the mouse over it, is not using it.
      if (!isTerminalReport(d)) onActiveRef.current?.()
      window.electronAPI.terminalWrite(idRef.current, d)
    })

    // A CLI with no local clipboard of its own (Claude Code in a WSL distro without
    // Windows interop, or anything over SSH) asks the terminal to copy for it. See
    // lib/osc52.ts.
    registerOsc52Copy(term)
    registerTerminalLinks(term)
    registerCwdReports(term, (p) => onCwdRef.current?.(p))

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
      // Shift+Enter is a newline in the prompt, not a submit. xterm sends a bare \r for
      // Enter whatever the modifiers, so the CLI never learns Shift was held and submits.
      // Ctrl+J (\n) is the newline key all three CLIs accept in any terminal, so that is
      // what gets sent. A plain shell has no multi-line prompt, so it keeps Enter as is.
      // The keypress is swallowed too: preventDefault alone left xterm's own keypress
      // path free to send the \r on top.
      const shiftEnter = e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
      if (shiftEnter && autoLaunchCli && !e.isComposing) {
        if (e.type === 'keydown') {
          e.preventDefault()
          onActiveRef.current?.()
          window.electronAPI.terminalWrite(idRef.current, '\n')
        }
        return false
      }
      // Ctrl+Z is undo in the prompt, not job control: the CLI reads it as "suspend", which
      // on Windows leaves a zombified CLI with no `fg` to bring it back. Ctrl+_ (\x1f) is the
      // CLI's own undo key, so that is what gets sent. A plain shell keeps Ctrl+Z as is.
      const ctrlZ = e.key.toLowerCase() === 'z' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
      if (ctrlZ && autoLaunchCli) {
        if (e.type === 'keydown') {
          e.preventDefault()
          window.electronAPI.terminalWrite(idRef.current, '\x1f')
        }
        return false
      }
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
          else if (res.files) pastePaths(res.files)
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
        else if (res.files) pastePaths(res.files)
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

    // A file dragged in from Explorer is typed as its path, as Windows Terminal does.
    // Only a drag carrying files is claimed: a chat dragged from the sidebar onto this
    // pane is the pane grid's to answer, and has to reach it.
    const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer!.files)
        .map((f) => window.electronAPI.pathForFile(f))
        .filter(Boolean)
      if (!paths.length) return
      void pastePaths(paths)
      term.focus()
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    termRef.current = term
    fitRef.current = fit

    const doFit = () => {
      // A hidden pane (a backgrounded session, `display: none` up the tree) has no size,
      // and the observer below does fire for that collapse. The fit addon does not read
      // the box; it reads computed style, and on the hidden element that gave a 6-row
      // terminal. Shrinking the pty to that and growing it back on return goes through
      // ConPTY, which repaints the screen on every resize and drops the scrollback with
      // it — so a hidden terminal is left exactly as it was. The `active` effect refits
      // it once it is shown again.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        if (idRef.current) window.electronAPI.terminalResize(idRef.current, term.cols, term.rows)
      } catch {
        // container mid-layout — ignore
      }
    }
    // Debounced trailing, and ONLY for this observer callback — with 2-3 terminals on
    // screen and a pane splitter being dragged, the container resizes several times a
    // frame, and each one is a SIGWINCH that makes a full-screen TUI (Claude Code) reflow
    // its whole transcript. This must never wrap the explicit resize(cols-1)→resize(cols)
    // pair below (the reattach redraw nudge): that one is deliberately two calls ~60ms
    // apart, not noise to be coalesced, and it doesn't go through `doFit`/this observer at
    // all — swallowing it here would leave a reattached terminal blank until it next
    // resizes for an unrelated reason.
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      // While a pane splitter is being dragged, PaneSplitter sets this flag and skips
      // straight to a single `doFit()` on mouseup (see the `panedragend` listener below) —
      // firing here too would just be more of the same flood this debounce exists to avoid.
      if (document.body.dataset.paneDrag === '1') return
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      resizeDebounceTimer = setTimeout(doFit, 70)
    })
    ro.observe(host)
    // A single rAF can still land before the panel's own layout (flex/display
    // swap) has settled, sizing the terminal off the stale hidden-state rect —
    // chain a second frame so fit() runs against the final visible layout.
    requestAnimationFrame(() => requestAnimationFrame(doFit))

    // The one fit() a pane-splitter drag gets, once the boundary has actually settled
    // (see PaneSplitter's `onCommit`, which dispatches this after clearing `paneDrag`).
    const onPaneDragEnd = () => doFit()
    window.addEventListener('panedragend', onPaneDragEnd)

    return () => {
      ro.disconnect()
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      window.removeEventListener('panedragend', onPaneDragEnd)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('mousedown', swallowRightButton, true)
      host.removeEventListener('mouseup', swallowRightButton, true)
      // Before term.dispose(): the addon has to give its WebGL context back explicitly, and
      // the contexts are the scarce resource here — leaking one per unmount would walk a
      // long-running window into the per-process cap. Guarded because onContextLoss may
      // already have disposed it, and disposing twice throws.
      webgl?.dispose()
      webgl = null
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
  // Session tab). A `display: none` pane has zero size, and `doFit` above deliberately
  // leaves a sizeless terminal alone, so a backgrounded terminal keeps its last real size
  // until shown again — this explicit refit on `active` flipping true is what catches it
  // up. Deliberately does NOT touch `reloadKey` / depend on anything that would respawn
  // the PTY — only fit() + a resize message.
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
    // Cover the terminal until whatever is about to run in it has painted — the CLI on a
    // first open and on a Restart alike (a Restart relaunches the CLI the same way the
    // first open did), or the shell itself when nothing is auto-launched.
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
      awaitingClearRef.current = false
      termRef.current?.focus()
      sendInitialPrompt()
    }

    // The prompt Home handed over, typed into the CLI as if you had typed it. Deliberately
    // after reveal and after a further beat: reveal means "the CLI has painted", not "its
    // input is listening", and a TUI that is still mounting drops what it is sent. One shot
    // per mount, and only once — a Restart relaunches the CLI, and re-running the task
    // behind the user's back is not what restarting a terminal means.
    function sendInitialPrompt(): void {
      const text = promptRef.current
      if (!text || sentPromptRef.current) return
      sentPromptRef.current = true
      promptTimerRef.current = setTimeout(typeInitialPrompt, INITIAL_PROMPT_DELAY_MS)
    }

    // A trust question on screen holds the prompt until the user has answered it; writeChunk
    // re-arms this once the question is gone. Answered "No", the CLI exits and nothing is sent.
    function typeInitialPrompt(): void {
      const text = promptRef.current
      if (!text) return
      if (termRef.current && viewportShows(termRef.current, TRUST_PROMPT_RE)) {
        holdingPromptRef.current = true
        return
      }
      holdingPromptRef.current = false
      window.electronAPI.terminalWrite(terminalId, text)
      promptTimerRef.current = setTimeout(() => {
        window.electronAPI.terminalWrite(terminalId, '\r')
        onPromptSentRef.current?.()
      }, PROMPT_SUBMIT_DELAY_MS)
    }

    const writeChunk = (data: string): void => {
      // A typed launch starts with `clear`: until its erase-display sequence has gone by,
      // what is on screen is the shell and the echo of the command, not the CLI.
      if (awaitingClearRef.current && CLEAR_SCREEN_RE.test(data)) awaitingClearRef.current = false
      // Reveal as soon as the CLI has actually drawn something. `awaitingRevealRef` is a
      // one-shot gate (flipped off here the moment content first appears) so a CLI that keeps
      // streaming — codex spinning on "model: Loading" — reveals immediately instead of the
      // loader lingering. Gating on visible content (not just "output arrived") avoids
      // revealing a blank screen during a cold-start gap; the short grace lets xterm paint
      // that first frame under the overlay so there's no blank flash on reveal. The backstop
      // above still fires if a CLI never paints anything, so the loader can't wedge.
      // Checked once xterm has parsed the chunk (its write is asynchronous), so the buffer
      // the check reads is the one this chunk produced.
      term.write(data, () => {
        if (awaitingRevealRef.current && !awaitingClearRef.current && hasVisibleContent(term)) {
          awaitingRevealRef.current = false
          clearTimeout(quietTimerRef.current)
          quietTimerRef.current = setTimeout(reveal, REVEAL_PAINT_GRACE_MS)
        }
        // The trust question has been answered: give the CLI that follows it the same beat
        // to bind its input as a first launch gets.
        if (holdingPromptRef.current && !viewportShows(term, TRUST_PROMPT_RE)) {
          holdingPromptRef.current = false
          clearTimeout(promptTimerRef.current)
          promptTimerRef.current = setTimeout(typeInitialPrompt, INITIAL_PROMPT_DELAY_MS)
        }
      })
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
      holdingPromptRef.current = false
      const note = e.exitCode
        ? tRef.current('chat.terminal.processExitedCode', { code: e.exitCode })
        : tRef.current('chat.terminal.processExited')
      term.write(`\r\n\x1b[2m[${note}]\x1b[0m\r\n`)
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
        pinSessionId: pinRef.current,
        ...(opsRef.current ? { ops: opsRef.current } : {}),
        cols,
        rows
      })
      .then((res) => {
        if (!res.ok) {
          replayedRef.current = true
          term.write(
            `\r\n\x1b[31m${res.error ? tRef.current('remote.terminal.startFailedWhy', { error: res.error }) : tRef.current('remote.terminal.startFailed')}\x1b[0m\r\n`
          )
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
          return
        }
        // Note: focus is NOT taken here — it is deferred to reveal() so the loader is not
        // marred by xterm's native input caret (see reveal).
        if (res.cliLaunched) {
          // Local shell: main already spawned the provider CLI directly (non-interactive,
          // no banner/echo) as part of createTerminal — there's nothing left to type in, so
          // just arm the reveal gate. The CLI's own first output starts the quiet timer above.
          // Restart also goes through this path, so make sure the loader is up for it too.
          setStarting(true)
          awaitingRevealRef.current = true
        } else if (!autoLaunchCli) {
          // Plain-shell session (autoLaunchCli=false, e.g. Remote Session's terminal
          // pane): the PTY is up but nothing gets typed into it — just arm the reveal
          // gate so the loader lifts once the shell paints its own prompt.
          setStarting(true)
          awaitingRevealRef.current = true
        } else {
          // wsl/ssh (or anything else that didn't already launch the CLI): auto-launch by
          // typing the launch command into the interactive remote shell, resuming this
          // chat's session (claude only). A short delay lets the shell print its prompt
          // first. A Restart comes through here too — it is the first open all over again.
          autoStartTimer = setTimeout(() => {
            // Arm the reveal gate right as we launch — and hold it until the launch's
            // own `clear` has wiped the shell and the echoed command off the screen.
            awaitingClearRef.current = true
            awaitingRevealRef.current = true
            window.electronAPI.terminalStartCli(
              terminalId,
              provider,
              resumeRef.current,
              pinRef.current
            )
          }, 600)
        }
      })

    return () => {
      if (autoStartTimer) clearTimeout(autoStartTimer)
      if (redrawTimer) clearTimeout(redrawTimer)
      clearTimeout(promptTimerRef.current)
      clearTimeout(backstopTimer)
      clearTimeout(quietTimerRef.current)
      awaitingRevealRef.current = false
      awaitingClearRef.current = false
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

  const restart = () => {
    // Immediate, not deferred: Restart must force a genuinely fresh pty, not
    // reuse the live one.
    window.electronAPI.terminalKill(terminalId)
    setReloadKey((k) => k + 1)
  }

  const menuItems: MenuItem[] = [
    {
      label: t('chat.terminal.restart'),
      icon: (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
        </svg>
      ),
      onClick: restart
    },
    {
      // One row, VS Code style: the size is something you nudge a few times while
      // watching the terminal, so the menu has to stay open across the clicks.
      label: t('chat.terminal.textSize'),
      onClick: () => {},
      custom: (
        <>
          <span>{t('chat.terminal.textSize')}</span>
          <span className="ui-menu-stepper">
            <button
              type="button"
              className="ui-menu-stepper-btn"
              onClick={() => setFontSize((s) => Math.max(MIN_FONT_SIZE, s - 1))}
              disabled={fontSize <= MIN_FONT_SIZE}
              title={t('chat.terminal.smaller')}
              aria-label={t('chat.terminal.smaller')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <span className="ui-menu-stepper-value">{fontSize}</span>
            <button
              type="button"
              className="ui-menu-stepper-btn"
              onClick={() => setFontSize((s) => Math.min(MAX_FONT_SIZE, s + 1))}
              disabled={fontSize >= MAX_FONT_SIZE}
              title={t('chat.terminal.larger')}
              aria-label={t('chat.terminal.larger')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </span>
        </>
      )
    },
    ...(onPopOut
      ? [{
          label: t('chat.terminal.popOut'),
          icon: (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
            </svg>
          ),
          onClick: onPopOut
        }]
      : []),
    ...(onPopIn
      ? [{
          label: t('chat.terminal.popIn'),
          icon: (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 10h-6V4M14 10l9-9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
            </svg>
          ),
          onClick: onPopIn
        }]
      : []),
    // In a split the header's × closes the pane, which leaves the CLI running; ending the
    // terminal is the more destructive act, so it moves in here rather than vanishing.
    ...(onClosePane && closable && onClose
      ? [{
          label: t('chat.terminal.close'),
          icon: <CloseIcon />,
          danger: true,
          onClick: onClose
        }]
      : [])
  ]

  // One × per header: a pane close when the pane grid asked for one, otherwise the
  // terminal's own close where the host lets it be closed at all.
  const closeButton = onClosePane ? (
    <button
      className="chat-head-btn"
      onClick={onClosePane}
      title={t('chat.pane.close')}
      aria-label={t('chat.pane.closeAria', { name: title ?? t('chat.terminal.label') })}
    >
      <CloseIcon />
    </button>
  ) : closable ? (
    <button className="chat-head-btn" onClick={onClose} title={t('chat.terminal.close')} aria-label={t('chat.terminal.close')}>
      <CloseIcon />
    </button>
  ) : null

  return (
    <div className="chat-terminal">
      <ChatHead
        title={title ?? t('chat.terminal.label')}
        cwd={cwd}
        dragProps={headProps}
        actions={
          <>
            <Menu
              triggerClass="chat-head-btn"
              triggerContent={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
                </svg>
              }
              triggerTitle={t('chat.terminal.menu')}
              ariaLabel={t('chat.terminal.menu')}
              items={menuItems}
            />
            {closeButton}
          </>
        }
      />
      <div className="chat-terminal-host-wrap">
        <div ref={hostRef} className="chat-terminal-host" />
        {starting && !exited && (
          <div className="chat-terminal-loading">
            <div className="chat-terminal-spinner" />
            <div className="chat-terminal-loading-text">{autoLaunchCli ? t('chat.terminal.starting', { provider: providerLabel }) : t('chat.terminal.connecting')}</div>
          </div>
        )}
        {exited && (
          <div className="block chat-terminal-exited" role="status">
            <span className="help">{t('chat.terminal.exited')}</span>
            <button
              className="btn-ghost"
              onClick={() => {
                window.electronAPI.terminalKill(terminalId)
                setReloadKey((k) => k + 1)
              }}
            >
              {t('chat.terminal.reconnect')}
            </button>
          </div>
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
