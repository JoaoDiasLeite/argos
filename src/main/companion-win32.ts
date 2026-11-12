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

/** GetWindow's next window down the z-order; GetWindowLongPtrW's extended style; a tool window's bit in it. */
const GW_HWNDNEXT = 2
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x80

/** The desktop and the taskbars: on screen and visible, but nothing he can stand on or be hidden by. */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])

/** At most this many windows are read per call, front to back: a drop needs the ones in front, not all. */
const MAX_WINDOWS = 64

interface Win32 {
  GetForegroundWindow: () => unknown
  GetTopWindow: (hwnd: unknown) => unknown
  GetWindow: (hwnd: unknown, cmd: number) => unknown
  GetWindowLongPtrW: (hwnd: unknown, index: number) => number | bigint
  GetWindowTextLengthW: (hwnd: unknown) => number
  GetClassNameW: (hwnd: unknown, buf: Buffer, max: number) => number
  /** The handle as a number, to compare with BrowserWindow.getNativeWindowHandle(). */
  address: (hwnd: unknown) => number | bigint
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
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const shell32 = koffi.load('shell32.dll')
    koffi.struct('ARGOS_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    win32 = {
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetTopWindow: user32.func('void * __stdcall GetTopWindow(void *hwnd)'),
      GetWindow: user32.func('void * __stdcall GetWindow(void *hwnd, uint32_t cmd)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *buf, int max)'),
      address: (hwnd: unknown) => koffi.address(hwnd),
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

/**
 * The windows on screen, front to back, that a falling Argos could land on or be hidden
 * behind: visible, drawn (not cloaked), not minimised, with a title, not a tool window
 * (tooltips, menus, the touch keyboard), not the desktop or a taskbar, and not one of
 * `skip` (the companion's own windows, by native handle; Argos's main window counts).
 * Maximised windows stay in: they hide every edge behind them. Empty where the calls are
 * unavailable.
 */
export function windowsOnScreen(skip: readonly bigint[] = []): { hwnd: unknown; bounds: CompanionRect }[] {
  const w = load()
  if (!w) return []
  const out: { hwnd: unknown; bounds: CompanionRect }[] = []
  try {
    const name = Buffer.alloc(512)
    let hwnd = w.GetTopWindow(null)
    for (let seen = 0; hwnd && seen < 1000 && out.length < MAX_WINDOWS; seen++, hwnd = w.GetWindow(hwnd, GW_HWNDNEXT)) {
      if (!w.IsWindowVisible(hwnd) || w.IsIconic(hwnd)) continue
      if (Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) continue
      if (w.GetWindowTextLengthW(hwnd) <= 0) continue
      const n = w.GetClassNameW(hwnd, name, 256)
      if (SHELL_CLASSES.has(name.toString('utf16le', 0, n * 2))) continue
      if (skip.includes(BigInt(w.address(hwnd)))) continue
      const bounds = windowBounds(hwnd)
      if (bounds) out.push({ hwnd, bounds })
    }
  } catch {
    return out
  }
  return out
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
