import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { readJsonFile, writeJsonFileAtomic } from './json-file'

// A chat popped out of the main window into a window of its own, so it can sit on another
// monitor. The window shows only the chat's terminal, attached to the same pty the pane had:
// ptys are keyed by terminal id in main and outlive any view, so the pop-out reattaches and
// replays the scrollback like a pane that remounts. The main window drops the pane while
// the chat is out and puts it back when this window closes. Approvals stay in the main
// window. Bounds are remembered per chat, across launches.

/** Everything the pop-out's terminal needs, worked out by the main window's pane. */
export interface ChatPopoutSpec {
  sessionId: string
  name: string
  terminalId: string
  provider: 'claude' | 'codex' | 'gemini'
  cwd?: string
  accountId?: string
  wslDistro?: string
  remoteHostId?: string
  resumeSessionId?: string
  pinSessionId?: string
}

/** What the window's title shows besides the name: a run in progress, or the CLI asking for you. */
interface PopoutStatus {
  busy: boolean
  waiting: boolean
}

const windows = new Map<string, { win: BrowserWindow; spec: ChatPopoutSpec; status: PopoutStatus }>()

/** The window's title: the chat's name, prefixed `! ` while it waits on you, else `● ` while it runs. */
function popoutTitle(spec: ChatPopoutSpec, status: PopoutStatus): string {
  const prefix = status.waiting ? '! ' : status.busy ? '● ' : ''
  return prefix + (spec.name || 'Chat')
}

function boundsPath(): string {
  return join(app.getPath('userData'), 'popout-bounds.json')
}

function loadBounds(): Record<string, Rectangle> {
  try {
    const p = boundsPath()
    if (!fs.existsSync(p)) return {}
    const raw = readJsonFile<Record<string, Rectangle>>(p)
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** Drops a chat's remembered bounds, for a chat that is gone for good. */
function forgetBounds(sessionId: string): void {
  try {
    const all = loadBounds()
    if (!(sessionId in all)) return
    delete all[sessionId]
    writeJsonFileAtomic(boundsPath(), all)
  } catch {
    // A stale entry only costs a few bytes in the file.
  }
}

function saveBounds(sessionId: string, bounds: Rectangle): void {
  try {
    const all = loadBounds()
    all[sessionId] = bounds
    writeJsonFileAtomic(boundsPath(), all)
  } catch {
    // A position we can't remember just opens at the default size next time.
  }
}

/** Saved bounds, only when they still land on a connected display (a monitor unplugged
 *  since would otherwise open the window off screen). */
function restoredBounds(sessionId: string): Rectangle | undefined {
  const b = loadBounds()[sessionId]
  if (!b || ![b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })
  return onScreen ? b : undefined
}

/**
 * Opens the chat in its own window, or brings its existing window forward. `onClosed`
 * runs when the user closes it, so the main window can take the pane back.
 */
export function openChatPopout(
  spec: ChatPopoutSpec,
  backgroundColor: string,
  onClosed: (sessionId: string) => void,
  status: PopoutStatus = { busy: false, waiting: false }
): void {
  const open = windows.get(spec.sessionId)
  if (open && !open.win.isDestroyed()) {
    if (open.win.isMinimized()) open.win.restore()
    open.win.focus()
    return
  }
  const bounds = restoredBounds(spec.sessionId)
  const win = new BrowserWindow({
    ...(bounds ?? { width: 960, height: 680 }),
    minWidth: 420,
    minHeight: 300,
    title: popoutTitle(spec, status),
    autoHideMenuBar: true,
    backgroundColor,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  windows.set(spec.sessionId, { win, spec, status: { ...status } })
  hardenWebContents(win)
  win.once('ready-to-show', () => win.show())
  // The page title would otherwise replace the chat's name with the HTML one.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('close', () => {
    if (!win.isMinimized() && !win.isMaximized()) saveBounds(spec.sessionId, win.getBounds())
  })
  win.on('closed', () => {
    // A reopened pop-out of the same chat is a new entry; only drop this window's own.
    if (windows.get(spec.sessionId)?.win === win) windows.delete(spec.sessionId)
    onClosed(spec.sessionId)
  })

  const query = `?sessionId=${encodeURIComponent(spec.sessionId)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/popout.html${query}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/popout.html'), { search: query })
  }
}

/** What the pop-out renderer asks for on load. */
export function chatPopoutSpec(sessionId: string): ChatPopoutSpec | null {
  return windows.get(sessionId)?.spec ?? null
}

export function focusChatPopout(sessionId: string): boolean {
  const open = windows.get(sessionId)
  if (!open || open.win.isDestroyed()) return false
  if (open.win.isMinimized()) open.win.restore()
  open.win.focus()
  return true
}

/**
 * Closes a chat's pop-out because the chat itself was deleted, and forgets its bounds.
 * `destroy` rather than `close`: no 'close' event, so the bounds are not saved again on the
 * way out. 'closed' still fires and reports the chat to the main window like a manual close,
 * which knows the chat is gone and does not bring a pane back for it. False when the chat
 * had no pop-out (its bounds are dropped all the same).
 */
export function closeChatPopout(sessionId: string): boolean {
  const open = windows.get(sessionId)
  forgetBounds(sessionId)
  if (!open || open.win.isDestroyed()) return false
  open.win.destroy()
  return true
}

/**
 * A popped-out chat was renamed in the main window: keep its spec, its window title and its
 * terminal header in step. False when the chat is not out.
 */
export function updateChatPopout(sessionId: string, patch: Partial<Pick<ChatPopoutSpec, 'name'>>): boolean {
  const open = windows.get(sessionId)
  if (!open || open.win.isDestroyed()) return false
  open.spec = { ...open.spec, ...patch }
  open.win.setTitle(popoutTitle(open.spec, open.status))
  open.win.webContents.send('popout:spec-changed', open.spec)
  return true
}

/** The pop-out showing a terminal, or null when that terminal is not popped out. */
export function chatPopoutForTerminal(terminalId: string): BrowserWindow | null {
  for (const o of windows.values()) if (o.spec.terminalId === terminalId && !o.win.isDestroyed()) return o.win
  return null
}

/** True when that terminal's pop-out is on screen and has focus: you are looking at the chat. */
export function chatPopoutInView(terminalId: string): boolean {
  const win = chatPopoutForTerminal(terminalId)
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused()
}

/**
 * A terminal's run state changed: if it is popped out, its window title follows (`● `
 * running, `! ` waiting on you). A no-op for a terminal that is not out.
 */
export function refreshPopoutTitle(terminalId: string, patch: Partial<PopoutStatus>): void {
  for (const o of windows.values()) {
    if (o.spec.terminalId !== terminalId || o.win.isDestroyed()) continue
    o.status = { ...o.status, ...patch }
    o.win.setTitle(popoutTitle(o.spec, o.status))
  }
}

/** The chats currently out, for a main window that reloads and has to learn them again. */
export function openChatPopouts(): string[] {
  return [...windows.keys()]
}

/** Every live pop-out window, for broadcasting terminal output to them. */
export function chatPopoutWindows(): BrowserWindow[] {
  return [...windows.values()].map((o) => o.win).filter((w) => !w.isDestroyed())
}

