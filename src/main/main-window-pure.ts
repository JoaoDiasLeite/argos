/**
 * Decisions about the main window that differ by platform, kept free of Electron so
 * they can be tested on any machine (macOS especially, which CI never runs).
 */

/**
 * Height of the renderer's custom title bar, in CSS px. Mirrors `.titlebar { height }`
 * in renderer/src/components/TitleBar.css; change both together.
 */
export const TITLE_BAR_HEIGHT = 36

/** The traffic-light cluster's height on macOS (the buttons' frame, not the 12px circles). */
const TRAFFIC_LIGHT_HEIGHT = 14

/**
 * Where macOS draws the close/minimize/zoom buttons under titleBarStyle 'hiddenInset':
 * vertically centred on the title bar, with the system's usual left inset. The renderer
 * leaves room for them (TitleBar.css, `.titlebar.mac`).
 */
export function trafficLightPosition(titleBarHeight = TITLE_BAR_HEIGHT): { x: number; y: number } {
  return { x: 14, y: Math.max(0, Math.round((titleBarHeight - TRAFFIC_LIGHT_HEIGHT) / 2)) }
}

/**
 * Whether the main window should skip its first show(). `--hidden` is what the Windows
 * and Linux login entries pass; macOS ignores login-item args, so there the launch
 * itself says it came from the login item. The "start minimized" preference does not
 * apply to a dev instance (its config is a copy of prod's).
 */
export function shouldStartHidden(opts: {
  argv: readonly string[]
  openedAtLogin: boolean
  startMinimized: boolean
  isDev: boolean
}): boolean {
  return opts.argv.includes('--hidden') || opts.openedAtLogin || (!opts.isDev && opts.startMinimized)
}

/**
 * What closing the main window does.
 * - 'proceed': let it close (a quit is already under way).
 * - 'quit': let it close and end the app.
 * - 'hide': keep it alive out of sight, so the terminals keep running.
 *
 * macOS follows its own convention: closing hides the window, the Dock icon stays and
 * Cmd+Q is the way out, whatever the tray preference. Elsewhere it hides to the tray
 * only when a tray exists and the user kept close-to-tray on. Dev quits on close
 * everywhere, so closing the window ends `npm run dev`.
 */
export type CloseAction = 'proceed' | 'quit' | 'hide'

export function mainWindowCloseAction(opts: {
  platform: NodeJS.Platform
  isQuitting: boolean
  hasTray: boolean
  isDev: boolean
  closeToTray: boolean
}): CloseAction {
  if (opts.isQuitting) return 'proceed'
  if (opts.isDev) return 'quit'
  if (opts.platform === 'darwin') return 'hide'
  if (!opts.hasTray || !opts.closeToTray) return 'quit'
  return 'hide'
}

export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'unsupported'

/**
 * Map systemPreferences.getMediaAccessStatus('microphone') to what the renderer gets.
 * 'not-determined' is not final (the caller asks first), so it returns null there.
 */
export function microphoneAccessFromStatus(status: string): MicrophoneAccess | null {
  if (status === 'granted' || status === 'denied' || status === 'restricted') return status
  if (status === 'not-determined') return null
  return 'unsupported'
}

/** The OS page where the user grants the microphone, or null where there is none to open. */
export function microphoneSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  if (platform === 'win32') return 'ms-settings:privacy-microphone'
  return null
}
