/**
 * The macOS side of companion-win32.ts's questions (docs/COMPANION_PLAN.md §13.3, R): which
 * window is in front, where the windows on screen are, and whether the front one fills a
 * display. companion-darwin.ts reads CGWindowListCopyWindowInfo into `MacWindow`s; the
 * choices made from that list are here, with no Electron and no native calls.
 *
 * Quartz lists windows front to back, in global points with the origin at the top left of
 * the main display and y going down: the same space as Electron's screen module, so the
 * bounds are used as they are. Window titles are never read (that would need the Screen
 * Recording permission), so there is no "has a title" filter as on Windows; a minimum
 * size stands in for it against the invisible helper windows some apps keep about.
 */
import type { Rect } from './companion-window-pure'

/** One entry of the window list, as read from its dictionary. */
export interface MacWindow {
  /** kCGWindowNumber: the CGWindowID, which serves as the window's handle. */
  id: number
  /** kCGWindowOwnerPID. */
  pid: number
  /** kCGWindowLayer: 0 for ordinary app windows; the Dock, menus and floating panels sit higher. */
  layer: number
  /** kCGWindowAlpha: 0 for a window that is up but not drawn. */
  alpha: number
  bounds: Rect
}

/** At most this many windows are kept, front to back: a drop needs the ones in front, not all. */
export const MAX_WINDOWS = 64
/** Narrower or shorter than this, a layer-0 window is a helper, not something to stand on. */
export const MIN_WINDOW_SIDE = 50

/** Whole points, so a window that has not moved compares equal from one poll to the next. */
export function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

/** An ordinary app window, drawn and big enough to matter. */
export function isOrdinary(w: MacWindow): boolean {
  return (
    w.layer === 0 &&
    w.alpha > 0 &&
    Number.isFinite(w.bounds.width) &&
    Number.isFinite(w.bounds.height) &&
    w.bounds.width >= MIN_WINDOW_SIDE &&
    w.bounds.height >= MIN_WINDOW_SIDE
  )
}

/**
 * The windows a falling Argos could land on or be hidden behind, front to back: ordinary
 * ones, not among `skip` (the companion's own windows, by CGWindowID). Argos's main window
 * counts, as on Windows.
 */
export function windowsToLandOn(list: readonly MacWindow[], skip: readonly bigint[] = []): MacWindow[] {
  const out: MacWindow[] = []
  for (const w of list) {
    if (out.length >= MAX_WINDOWS) break
    if (!isOrdinary(w) || skip.includes(BigInt(w.id))) continue
    out.push(w)
  }
  return out
}

/** The window fills one of `rects` (a display's work area when zoomed, its bounds when full screen). */
export function fills(bounds: Rect, rects: readonly Rect[], slack = 2): boolean {
  return rects.some(
    (r) =>
      Math.abs(bounds.x - r.x) <= slack &&
      Math.abs(bounds.y - r.y) <= slack &&
      Math.abs(bounds.x + bounds.width - (r.x + r.width)) <= slack &&
      Math.abs(bounds.y + bounds.height - (r.y + r.height)) <= slack
  )
}

/** The front ordinary window not among `skip`, whoever owns it; null when there is none. */
export function frontWindow(list: readonly MacWindow[], skip: readonly bigint[] = []): MacWindow | null {
  return windowsToLandOn(list, skip)[0] ?? null
}

/**
 * The window in front for a perch, as on Windows: null when it is one of Argos's own (the
 * main window; the companion's are above layer 0 or in `skip`), or when it fills its
 * display (zoomed or full screen: nothing to perch on above the screen's top).
 */
export function foregroundOf(
  list: readonly MacWindow[],
  ownPid: number,
  screens: readonly Rect[],
  skip: readonly bigint[] = []
): MacWindow | null {
  const front = frontWindow(list, skip)
  if (!front || front.pid === ownPid || fills(front.bounds, screens)) return null
  return front
}

/** The window with this CGWindowID in the on-screen list; null when it is gone, minimised or on another Space. */
export function findWindow(list: readonly MacWindow[], id: number): MacWindow | null {
  return list.find((w) => w.id === id && isOrdinary(w)) ?? null
}

/**
 * Some other app's window in front covers a whole display: full screen, a slideshow, a
 * video. Only displays whose work area differs from their bounds count: where the menu bar
 * and the Dock hide themselves the two are equal, and a zoomed window would read as full.
 */
export function frontIsFullScreen(
  list: readonly MacWindow[],
  ownPid: number,
  displays: readonly { bounds: Rect; workArea: Rect }[]
): boolean {
  const front = frontWindow(list)
  if (front === null || front.pid === ownPid) return false
  const telling = displays.filter((d) => !fills(d.workArea, [d.bounds])).map((d) => d.bounds)
  return fills(front.bounds, telling)
}

/** The CGWindowID in BrowserWindow.getMediaSourceId()'s "window:<id>:<other>"; null if not there. */
export function mediaSourceWindowId(sourceId: string): bigint | null {
  const m = /^window:(\d+):/.exec(sourceId)
  if (!m) return null
  const id = BigInt(m[1])
  return id > 0n ? id : null
}
