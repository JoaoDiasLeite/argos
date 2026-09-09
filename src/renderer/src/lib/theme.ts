// The appearance engine: the one place that knows how UiPrefs become CSS.
//
// It used to be two lines (`data-theme` + `data-palette`) copied into four windows,
// which is why palettes.ts grew an applyPalette to hold them. Now that a theme can
// also carry three colour overrides, a contrast, three font families and two sizes,
// "one place" stops being tidiness and starts being the only way the four windows can
// agree — so applyPalette is gone and every window calls applyTheme instead.
//
// The split below is deliberate: `planTheme` is pure and decides *what* to write,
// `applyTheme` is the only function that touches the DOM. That is what makes the
// interesting half testable in node, where there is no document.

import { UiPrefs, ThemeSettings } from '../types'
import { DEFAULT_PALETTE } from './palettes'
import { accentRamp, parseHex, surfaceRamp, textRamp } from './color'
import { fontById } from './fonts'

/**
 * The px UI size that means zoom 1.0 — the size this UI was drawn at.
 *
 * Mirrors UI_FONT_SIZE_DEFAULT in src/main/ui-prefs-pure.ts, which clamps the stored
 * value. Renderer and main cannot share a module (separate tsconfigs), the same way
 * UiPrefs itself is declared twice; this is the smaller half of that same seam.
 */
export const UI_FONT_SIZE_BASE = 14

/**
 * Every custom property the engine may write inline on the root.
 *
 * This list is the fix for the bug this module is most likely to ship: overrides are
 * written inline, and an inline property that nobody removes outlives the theme that
 * set it. Switch from a customised dark theme to an untouched light one and the old
 * `--accent` keeps winning over the palette's, forever, because a stylesheet cannot
 * beat an inline style. So applyTheme clears all of these on every call and then sets
 * only the ones this UiPrefs actually asks for. Anything added to planTheme's output
 * MUST be added here too, or it becomes the next stale override.
 */
export const MANAGED_VARS = [
  '--bg-0',
  '--bg-1',
  '--bg-2',
  '--bg-3',
  '--bg-hover',
  '--border',
  '--border-light',
  '--text-0',
  '--text-1',
  '--text-2',
  '--accent',
  '--accent-hover',
  '--accent-dim',
  '--font-sans',
  '--font-content',
  '--font-mono',
  '--font-size-code'
] as const

/** The palette's own values, read back off the stylesheet. Any of them may be missing. */
export interface PaletteBase {
  bg0?: string
}

export interface ThemePlan {
  theme: 'dark' | 'light'
  palette: string
  /** Custom properties to write inline. Empty for a config that customises nothing. */
  vars: Record<string, string>
  translucentSidebar: boolean
}

/**
 * Decide what this UiPrefs means, given what the chosen palette already provides.
 *
 * `base` matters for one case only, and it is the case that is easy to get wrong:
 * `contrast` has to work on a preset the user has not otherwise touched, which means
 * re-deriving the surface ramp from the palette's *own* --bg-0 rather than from an
 * override that does not exist. It never touches the text ramp.
 */
export function planTheme(ui: UiPrefs, base: PaletteBase = {}): ThemePlan {
  const theme: 'dark' | 'light' = ui.theme === 'light' ? 'light' : 'dark'
  const side: ThemeSettings | undefined = theme === 'light' ? ui.light : ui.dark
  const vars: Record<string, string> = {}

  // Surfaces. Derive when there is a background override, or when contrast alone has
  // moved off its midpoint — and in the latter case only if the palette's own --bg-0
  // was readable. Writing a ramp derived from an unparsed base would repaint the whole
  // app in whatever colour a failed parse fell back to, so it is skipped instead.
  const bgOverride = side?.background ? parseHex(side.background) : null
  const bgBase = bgOverride ?? (base.bg0 ? parseHex(base.bg0) : null)
  const wantsSurfaces = !!bgOverride || side?.contrast !== undefined
  if (wantsSurfaces && bgBase) Object.assign(vars, surfaceRamp(bgBase, theme, side?.contrast))

  // Text. Only a foreground override derives this ramp: `contrast` is deliberately not
  // an input here, so the slider moves the surfaces apart and leaves the typography
  // exactly where the palette put it.
  const fgOverride = side?.foreground ? parseHex(side.foreground) : null
  if (fgOverride) Object.assign(vars, textRamp(fgOverride, theme))

  const accent = side?.accent ? parseHex(side.accent) : null
  if (accent) Object.assign(vars, accentRamp(accent, theme))

  // Fonts. 'system' is the default stack, so it is written out rather than skipped:
  // the user may be switching back to it from something else, and the clear-then-set
  // in applyTheme already handles "not set at all".
  const uiFont = fontById(ui.fonts?.ui)
  if (uiFont) vars['--font-sans'] = uiFont.stack
  // 'inherit' means "same as the UI font", which is what :root already says
  // --font-content is; nothing to write.
  const contentFont = ui.fonts?.content === 'inherit' ? undefined : fontById(ui.fonts?.content)
  if (contentFont) vars['--font-content'] = contentFont.stack
  const codeFont = fontById(ui.fonts?.code)
  if (codeFont) vars['--font-mono'] = codeFont.stack

  if (typeof ui.codeFontSize === 'number' && Number.isFinite(ui.codeFontSize)) {
    vars['--font-size-code'] = `${Math.round(ui.codeFontSize)}px`
  }

  return {
    theme,
    palette: ui.palette || DEFAULT_PALETTE,
    vars,
    translucentSidebar: !!side?.translucentSidebar
  }
}

/**
 * The page zoom that expresses this UiPrefs' UI scale.
 *
 * Zoom, not font size, because this UI is written in px throughout: nothing scales
 * off a root font size, so the only lever that moves the whole interface is Electron's
 * own page zoom. 14px is 1.0 — the size the UI was drawn at — and the legacy sm/md/lg
 * is still honoured when `uiFontSize` is absent, which is every config written before
 * this system existed.
 */
export function zoomFor(ui: UiPrefs): number {
  if (typeof ui.uiFontSize === 'number' && Number.isFinite(ui.uiFontSize)) {
    return ui.uiFontSize / UI_FONT_SIZE_BASE
  }
  return ui.fontSize === 'sm' ? 0.9 : ui.fontSize === 'lg' ? 1.12 : 1
}

/**
 * Read the palette's own --bg-0 / --text-0 back off the stylesheet.
 *
 * getComputedStyle can hand back '' for a custom property — most reliably before the
 * stylesheet is live, which is exactly when the first applyTheme runs in a fresh
 * window. Callers treat a missing value as "leave the ramp alone", so an empty read
 * costs the user their contrast setting until the next apply, rather than painting the
 * app from a garbage colour.
 */
function readPaletteBase(root: HTMLElement): PaletteBase {
  if (typeof getComputedStyle !== 'function') return {}
  const style = getComputedStyle(root)
  const read = (name: string): string | undefined => {
    const value = style.getPropertyValue(name).trim()
    return value ? value : undefined
  }
  return { bg0: read('--bg-0') }
}

/**
 * Put a UiPrefs on a document root. Every renderer window calls exactly this.
 *
 * Order is load-bearing. The data attributes go on first so the palette's own blocks
 * are the ones in effect; the inline overrides are cleared next, so the read-back that
 * follows sees the palette rather than a leftover from the previous theme; only then is
 * the new set written.
 */
export function applyTheme(root: HTMLElement, ui: UiPrefs): void {
  root.dataset.theme = ui.theme === 'light' ? 'light' : 'dark'
  root.dataset.palette = ui.palette || DEFAULT_PALETTE

  for (const name of MANAGED_VARS) root.style.removeProperty(name)

  const plan = planTheme(ui, readPaletteBase(root))
  for (const [name, value] of Object.entries(plan.vars)) root.style.setProperty(name, value)

  // '' rather than delete: the CSS matches on [data-translucent-sidebar='on'], and an
  // empty attribute is the cheapest way to say "off" without special-casing removal.
  root.dataset.translucentSidebar = plan.translucentSidebar ? 'on' : ''
}
