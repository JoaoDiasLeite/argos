/**
 * The few Win32 calls the companion needs (docs/COMPANION_PLAN.md §13.3, R and V):
 * which window is in front and where it is, so Argos can perch on it; and whether
 * Windows is in Focus Assist, a full-screen app or a presentation, so he keeps quiet.
 *
 * Through koffi (N-API, so the same binary runs under Electron), loaded on first use
 * and only on Windows; anywhere it cannot load, every call answers null and the
 * features stay off. Rects come back in DIPs of the virtual screen, like the rest.
 */
import { screen } from 'electron'
import type { CompanionRect } from './companion-types'

/** SHQueryUserNotificationState's answers. */
export const QUNS = {
  NOT_PRESENT: 1,
  BUSY: 2,
  RUNNING_D3D_FULL_SCREEN: 3,
  PRESENTATION_MODE: 4,
  ACCEPTS_NOTIFICATIONS: 5,
  QUIET_TIME: 6,
  APP: 7
} as const

/** DWMWA_EXTENDED_FRAME_BOUNDS: the window as drawn, without the invisible resize border. */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
/**
 * DWMWA_CLOAKED: non-zero for a window that has WS_VISIBLE but is not drawn. Windows
 * keeps a few of these about (the touch keyboard host, Game Bar, apps on another
 * virtual desktop), and they can be the foreground window: dropped "on" one, Argos sat
 * in mid-air where its invisible top edge was.
 */
const DWMWA_CLOAKED = 14

interface Win32 {
  GetForegroundWindow: () => unknown
  IsWindow: (hwnd: unknown) => boolean
  IsWindowVisible: (hwnd: unknown) => boolean
  IsIconic: (hwnd: unknown) => boolean
  IsZoomed: (hwnd: unknown) => boolean
  GetWindowThreadProcessId: (hwnd: unknown, pid: [number]) => number
  DwmGetWindowAttribute: (hwnd: unknown, attr: number, rect: Record<string, number>, cb: number) => number
  DwmGetWindowCloaked: (hwnd: unknown, attr: number, cloaked: [number], cb: number) => number
  SHQueryUserNotificationState: (state: [number]) => number
}

let win32: Win32 | null | undefined

function load(): Win32 | null {
  if (win32 !== undefined) return win32
  win32 = null
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const shell32 = koffi.load('shell32.dll')
    koffi.struct('ARGOS_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    win32 = {
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(void *hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
      DwmGetWindowAttribute: dwmapi.func('int __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ ARGOS_RECT *rect, uint32_t cb)'),
      DwmGetWindowCloaked: dwmapi.func('DwmGetWindowAttribute', 'int', ['void *', 'uint32_t', '_Out_ uint32_t *', 'uint32_t']),
      SHQueryUserNotificationState: shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *state)')
    }
  } catch (e) {
    console.warn('[companion] win32 calls unavailable:', e)
    win32 = null
  }
  return win32
}

/** The window's drawn bounds in DIPs, or null when it is gone, hidden, cloaked or minimised. */
export function windowBounds(hwnd: unknown): CompanionRect | null {
  const w = load()
  if (!w || !hwnd) return null
  try {
    if (!w.IsWindow(hwnd) || !w.IsWindowVisible(hwnd) || w.IsIconic(hwnd)) return null
    const cloaked: [number] = [0]
    if (w.DwmGetWindowCloaked(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return null
    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    if (w.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) return null
    if (rect.right <= rect.left || rect.bottom <= rect.top) return null
    return screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top })
  } catch {
    return null
  }
}

/**
 * The window in front, unless it is one of Argos's own, maximised (nothing to perch on
 * above the screen's top) or minimised: its handle and bounds.
 */
export function foregroundWindow(): { hwnd: unknown; bounds: CompanionRect } | null {
  const w = load()
  if (!w) return null
  try {
    const hwnd = w.GetForegroundWindow()
    if (!hwnd) return null
    const pid: [number] = [0]
    w.GetWindowThreadProcessId(hwnd, pid)
    if (pid[0] === process.pid || w.IsZoomed(hwnd)) return null
    const bounds = windowBounds(hwnd)
    return bounds ? { hwnd, bounds } : null
  } catch {
    return null
  }
}

/** Windows' word on notifications (QUNS), or null where it cannot be asked. */
export function userNotificationState(): number | null {
  const w = load()
  if (!w) return null
  try {
    const state: [number] = [0]
    return w.SHQueryUserNotificationState(state) === 0 ? state[0] : null
  } catch {
    return null
  }
}
