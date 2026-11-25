import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'

// Quick-launcher overlay: a hidden, always-on-top acrylic window summoned with a
// global shortcut from anywhere in the OS. It dismisses on blur/Esc like a native
// flyout and hands prompts off to the main window (see overlay:* IPC in index.ts).

const OVERLAY_WIDTH = 660
const OVERLAY_HEIGHT = 440
const isMac = process.platform === 'darwin'

let overlayWindow: BrowserWindow | null = null
let registeredShortcut = ''

/** The accelerator that actually got registered ('' if none was available). */
export function overlayShortcut(): string {
  return registeredShortcut
}

export function createOverlayWindow(): BrowserWindow {
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Acrylic is Windows-only. On macOS a transparent window lets the CSS shell's
    // rounded corners show; a non-activating panel takes keyboard focus without
    // activating the app, so the main window doesn't jump forward (or switch Space)
    // and the app the user was in stays active when the launcher hides.
    ...(isMac
      ? { type: 'panel', transparent: true, hasShadow: true }
      : { backgroundMaterial: 'acrylic' as const }),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  if (isMac) {
    // On every Space and over full-screen apps; skipTransformProcessType keeps the
    // Dock icon (without it Electron turns the app into a UI element). Set before the
    // level, which this call can reset.
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu')
  } else {
    // 'screen-saver' level floats above fullscreen apps, not just normal windows.
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }

  // Dismiss like a native flyout when focus moves elsewhere. Skipped while devtools
  // are open, since opening them blurs the window and would instantly hide it.
  overlayWindow.on('blur', () => {
    if (!overlayWindow || overlayWindow.webContents.isDevToolsOpened()) return
    overlayWindow.hide()
  })
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  hardenWebContents(overlayWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
  return overlayWindow
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
  }
}

export function toggleOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
  const win = overlayWindow!
  if (win.isVisible()) {
    win.hide()
    return
  }
  // Launcher placement: horizontally centered in the upper third of whichever
  // display the cursor is on (multi-monitor friendly).
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  win.setPosition(
    Math.round(x + (width - OVERLAY_WIDTH) / 2),
    Math.round(y + height * 0.18)
  )
  if (isMac) {
    // show() activates the app even for a panel; showInactive() + focus() makes the
    // panel key without activating (Electron skips activation for panels in focus()).
    win.showInactive()
    win.focus()
    // The shadow of a transparent window follows its painted pixels; recompute it.
    win.invalidateShadow()
  } else {
    win.show()
    win.focus()
  }
  // Tells the overlay renderer to reset + refocus its input and refresh data.
  win.webContents.send('overlay:shown')
}

/**
 * Register the quick-launcher global shortcut. When `preferred` is a non-empty
 * accelerator (from user settings), try it FIRST; otherwise (and as a fallback
 * if the preferred one can't be registered) fall through the built-in defaults.
 * Alt+Space is the natural launcher key, but another launcher (e.g. PowerToys
 * Run) may already own it — fall through to a less contested chord.
 */
export function registerOverlayShortcut(preferred?: string): string {
  const candidates = [preferred, 'Alt+Space', 'Ctrl+Shift+Space'].filter(
    (a, i, arr): a is string => !!a && arr.indexOf(a) === i
  )
  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, toggleOverlay)) {
        registeredShortcut = accelerator
        return accelerator
      }
    } catch {
      // invalid/blocked accelerator — try the next one
    }
  }
  registeredShortcut = ''
  return ''
}

/**
 * Re-register the overlay shortcut with a new preferred accelerator: unregister
 * whatever is currently bound (only that one accelerator, so we never clobber
 * shortcuts owned by other parts of the app), then run registration again.
 */
export function reregisterOverlayShortcut(preferred?: string): string {
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      // ignore — best effort
    }
    registeredShortcut = ''
  }
  return registerOverlayShortcut(preferred)
}
