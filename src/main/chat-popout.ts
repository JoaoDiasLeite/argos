import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { readJsonFile } from './json-file'

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

const windows = new Map<string, { win: BrowserWindow; spec: ChatPopoutSpec }>()

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

function saveBounds(sessionId: string, bounds: Rectangle): void {
  try {
    const all = loadBounds()
    all[sessionId] = bounds
    fs.writeFileSync(boundsPath(), JSON.stringify(all, null, 2))
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
export function openChatPopout(spec: ChatPopoutSpec, backgroundColor: string, onClosed: (sessionId: string) => void): void {
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
    title: spec.name || 'Chat',
    autoHideMenuBar: true,
    backgroundColor,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  windows.set(spec.sessionId, { win, spec })
  hardenWebContents(win)
  win.once('ready-to-show', () => win.show())
  // The page title would otherwise replace the chat's name with the HTML one.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('close', () => {
    if (!win.isMinimized() && !win.isMaximized()) saveBounds(spec.sessionId, win.getBounds())
  })
  win.on('closed', () => {
    windows.delete(spec.sessionId)
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

/** The chats currently out, for a main window that reloads and has to learn them again. */
export function openChatPopouts(): string[] {
  return [...windows.keys()]
}

/** Every live pop-out window, for broadcasting terminal output to them. */
export function chatPopoutWindows(): BrowserWindow[] {
  return [...windows.values()].map((o) => o.win).filter((w) => !w.isDestroyed())
}

/** A pop-out on screen means the user can see a chat, whatever the main window is doing. */
export function anyChatPopoutInView(): boolean {
  return chatPopoutWindows().some((w) => w.isVisible() && !w.isMinimized())
}
