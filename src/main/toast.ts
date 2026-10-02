import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'

// Approval toast: a small, always-on-top acrylic flyout shown in the bottom-right
// corner when an agent run needs tool approval while the main window is hidden or
// unfocused (the app lives in the tray). Unlike the quick-launcher overlay it is
// NON-focusable — it must never steal keyboard focus from whatever the user is
// doing — and it does NOT dismiss on blur: it persists until the request is
// answered. Mouse clicks still work on a non-focusable window.

const TOAST_WIDTH = 420
const TOAST_HEIGHT = 160
const MARGIN = 12

let toastWindow: BrowserWindow | null = null

export function createToastWindow(): BrowserWindow {
  toastWindow = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never grab focus: the user may be typing elsewhere when a run stalls on approval.
    focusable: false,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // Float above fullscreen apps like a native notification, not just normal windows.
  toastWindow.setAlwaysOnTop(true, 'screen-saver')

  toastWindow.on('closed', () => {
    toastWindow = null
  })

  hardenWebContents(toastWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    toastWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toast.html`)
  } else {
    toastWindow.loadFile(join(__dirname, '../renderer/toast.html'))
  }
  return toastWindow
}

/** Deliver an event to the toast renderer, if the window is alive. */
export function sendToToast(channel: string, payload?: unknown): void {
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.webContents.send(channel, payload)
  }
}

/** Position bottom-right of the primary display's work area and show WITHOUT stealing focus. */
export function showToast(): void {
  if (!toastWindow || toastWindow.isDestroyed()) createToastWindow()
  const win = toastWindow!
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  win.setPosition(
    Math.round(x + width - TOAST_WIDTH - MARGIN),
    Math.round(y + height - TOAST_HEIGHT - MARGIN)
  )
  // showInactive keeps focus on whatever window the user was using.
  win.showInactive()
}

export function hideToast(): void {
  if (toastWindow && !toastWindow.isDestroyed() && toastWindow.isVisible()) {
    toastWindow.hide()
  }
}
