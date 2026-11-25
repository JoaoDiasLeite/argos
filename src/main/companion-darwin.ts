/**
 * The macOS calls behind companion-win32.ts's exports (docs/COMPANION_PLAN.md §13.3, R):
 * the windows on screen, front to back, read with CGWindowListCopyWindowInfo.
 *
 * Through koffi, loaded on first use and only on macOS, as on Windows; anywhere it cannot
 * load, or a call throws, the answer is null (or empty) and the features stay off. Only
 * the layer, bounds, number, owner PID and alpha of each window are read: never its name,
 * so no Screen Recording permission is needed. Quartz's global coordinates are already
 * Electron's (points, top-left origin of the main display), so nothing is converted. The
 * choices made from the list are in companion-darwin-pure.ts.
 */
import { screen } from 'electron'
import type { CompanionRect } from './companion-types'
import { findWindow, foregroundOf, frontIsFullScreen, roundRect, windowsToLandOn, type MacWindow } from './companion-darwin-pure'

/** CGWindowListOption bits (CGWindow.h). */
const kCGWindowListOptionOnScreenOnly = 1 << 0
const kCGWindowListExcludeDesktopElements = 1 << 4
const kCGNullWindowID = 0
/** CFNumberType (CFNumber.h) and CFStringEncoding (CFString.h). */
const kCFNumberSInt64Type = 4
const kCFNumberDoubleType = 13
const kCFStringEncodingUTF8 = 0x08000100

const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

/** The prototypes, in one place (CF types are pointers; CFIndex and CFTypeID are `long`). */
export const DARWIN_PROTOTYPES = {
  CFArrayGetCount: 'long CFArrayGetCount(void *array)',
  CFArrayGetValueAtIndex: 'void *CFArrayGetValueAtIndex(void *array, long index)',
  CFDictionaryGetValue: 'void *CFDictionaryGetValue(void *dict, void *key)',
  CFStringCreateWithCString: 'void *CFStringCreateWithCString(void *alloc, const char *text, uint32_t encoding)',
  CFGetTypeID: 'unsigned long CFGetTypeID(void *cf)',
  CFNumberGetTypeID: 'unsigned long CFNumberGetTypeID()',
  CFDictionaryGetTypeID: 'unsigned long CFDictionaryGetTypeID()',
  CFRelease: 'void CFRelease(void *cf)',
  CGWindowListCopyWindowInfo: 'void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)',
  CGRectMakeWithDictionaryRepresentation: 'bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ ARGOS_CGRECT *rect)'
} as const

/** A CF object: a pointer, which koffi 3 hands over as a BigInt (or null for NULL). */
type CF = unknown

interface Darwin {
  CFArrayGetCount: (array: CF) => number | bigint
  CFArrayGetValueAtIndex: (array: CF, index: number) => CF
  CFDictionaryGetValue: (dict: CF, key: CF) => CF
  CFGetTypeID: (cf: CF) => number | bigint
  CFNumberGetInt64: (num: CF, type: number, out: [number | bigint]) => boolean
  CFNumberGetDouble: (num: CF, type: number, out: [number]) => boolean
  CFRelease: (cf: CF) => void
  CGWindowListCopyWindowInfo: (option: number, relativeTo: number) => CF
  CGRectMakeWithDictionaryRepresentation: (dict: CF, rect: Record<string, number>) => boolean
  numberType: number
  dictionaryType: number
  /** The kCGWindow* keys: CFStrings made once and kept for the life of the process. */
  keys: { layer: CF; bounds: CF; number: CF; pid: CF; alpha: CF }
}

let darwin: Darwin | null | undefined

function load(): Darwin | null {
  if (darwin !== undefined) return darwin
  darwin = null
  if (process.platform !== 'darwin') return null
  try {
    const koffi = require('koffi')
    const cf = koffi.load(CORE_FOUNDATION)
    const cg = koffi.load(CORE_GRAPHICS)
    koffi.struct('ARGOS_CGRECT', { x: 'double', y: 'double', width: 'double', height: 'double' })
    const P = DARWIN_PROTOTYPES
    const CFStringCreateWithCString = cf.func(P.CFStringCreateWithCString)
    // The constants' values are their own names (kCGWindowLayer is @"kCGWindowLayer", …).
    const key = (name: string): CF => {
      const s = CFStringCreateWithCString(null, name, kCFStringEncodingUTF8)
      if (!s) throw new Error(`CFString for ${name}`)
      return s
    }
    const CFNumberGetTypeID = cf.func(P.CFNumberGetTypeID)
    const CFDictionaryGetTypeID = cf.func(P.CFDictionaryGetTypeID)
    darwin = {
      CFArrayGetCount: cf.func(P.CFArrayGetCount),
      CFArrayGetValueAtIndex: cf.func(P.CFArrayGetValueAtIndex),
      CFDictionaryGetValue: cf.func(P.CFDictionaryGetValue),
      CFGetTypeID: cf.func(P.CFGetTypeID),
      CFNumberGetInt64: cf.func('CFNumberGetValue', 'bool', ['void *', 'long', '_Out_ int64_t *']),
      CFNumberGetDouble: cf.func('CFNumberGetValue', 'bool', ['void *', 'long', '_Out_ double *']),
      CFRelease: cf.func(P.CFRelease),
      CGWindowListCopyWindowInfo: cg.func(P.CGWindowListCopyWindowInfo),
      CGRectMakeWithDictionaryRepresentation: cg.func(P.CGRectMakeWithDictionaryRepresentation),
      numberType: Number(CFNumberGetTypeID()),
      dictionaryType: Number(CFDictionaryGetTypeID()),
      keys: {
        layer: key('kCGWindowLayer'),
        bounds: key('kCGWindowBounds'),
        number: key('kCGWindowNumber'),
        pid: key('kCGWindowOwnerPID'),
        alpha: key('kCGWindowAlpha')
      }
    }
  } catch (e) {
    console.warn('[companion] macOS window calls unavailable:', e)
    darwin = null
  }
  return darwin
}

/** A CFNumber value of the dictionary, or null when the key is missing or not a number. */
function numberOf(d: Darwin, dict: CF, key: CF, double: boolean): number | null {
  const v = d.CFDictionaryGetValue(dict, key)
  if (!v || Number(d.CFGetTypeID(v)) !== d.numberType) return null
  if (double) {
    const out: [number] = [0]
    return d.CFNumberGetDouble(v, kCFNumberDoubleType, out) ? out[0] : null
  }
  const out: [number | bigint] = [0]
  return d.CFNumberGetInt64(v, kCFNumberSInt64Type, out) ? Number(out[0]) : null
}

/** One window's dictionary; null when a field it needs is missing. */
function windowOf(d: Darwin, dict: CF): MacWindow | null {
  if (!dict || Number(d.CFGetTypeID(dict)) !== d.dictionaryType) return null
  const id = numberOf(d, dict, d.keys.number, false)
  const pid = numberOf(d, dict, d.keys.pid, false)
  const layer = numberOf(d, dict, d.keys.layer, false)
  if (id === null || pid === null || layer === null) return null
  // Not every entry has an alpha; one without is drawn.
  const alpha = numberOf(d, dict, d.keys.alpha, true) ?? 1
  const boundsDict = d.CFDictionaryGetValue(dict, d.keys.bounds)
  if (!boundsDict) return null
  const rect = { x: 0, y: 0, width: 0, height: 0 }
  if (!d.CGRectMakeWithDictionaryRepresentation(boundsDict, rect)) return null
  return { id, pid, layer, alpha, bounds: roundRect(rect) }
}

/**
 * The windows on screen on the current Space, front to back, every layer (the pure
 * module picks). The copied array is released here; the dictionaries and numbers in it
 * belong to it ("Get" rule) and go with it.
 */
function onScreen(): MacWindow[] | null {
  const d = load()
  if (!d) return null
  let list: CF = null
  try {
    list = d.CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    if (!list) return null
    const out: MacWindow[] = []
    const count = Number(d.CFArrayGetCount(list))
    for (let i = 0; i < count && i < 1000; i++) {
      const w = windowOf(d, d.CFArrayGetValueAtIndex(list, i))
      if (w) out.push(w)
    }
    return out
  } catch {
    return null
  } finally {
    try {
      if (list) d.CFRelease(list)
    } catch {
      /* nothing more to do */
    }
  }
}

/** Every display's work area and full bounds: a window that fills one is zoomed or full screen. */
function screens(): CompanionRect[] {
  return screen.getAllDisplays().flatMap((s) => [s.workArea, s.bounds])
}

/** The window's bounds by CGWindowID, or null when it is gone, minimised, hidden or on another Space. */
export function macWindowBounds(id: unknown): CompanionRect | null {
  if (typeof id !== 'number') return null
  const list = onScreen()
  return list ? (findWindow(list, id)?.bounds ?? null) : null
}

/** The window in front, unless it is Argos's own or fills its display: its CGWindowID and bounds. */
export function macForegroundWindow(skip: readonly bigint[] = []): { hwnd: unknown; bounds: CompanionRect } | null {
  const list = onScreen()
  if (!list) return null
  const front = foregroundOf(list, process.pid, screens(), skip)
  return front ? { hwnd: front.id, bounds: front.bounds } : null
}

/** The windows a falling Argos could land on or be hidden behind, front to back. */
export function macWindowsOnScreen(skip: readonly bigint[] = []): { hwnd: unknown; bounds: CompanionRect }[] {
  const list = onScreen()
  return list ? windowsToLandOn(list, skip).map((w) => ({ hwnd: w.id, bounds: w.bounds })) : []
}

/**
 * Whether another app's window in front covers a whole display (full screen, a slideshow).
 * macOS has no SHQueryUserNotificationState and Focus is not readable without private API,
 * so this is all there is; null where the list cannot be read.
 */
export function macFrontIsFullScreen(): boolean | null {
  const list = onScreen()
  if (!list) return null
  return frontIsFullScreen(list, process.pid, screen.getAllDisplays())
}
