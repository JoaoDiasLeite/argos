// The appearance model, and the pure rules that keep it coherent.
//
// This lives apart from config.ts for one reason: config.ts imports `electron`, so a
// test cannot load it in node. Migration and resolution are exactly the parts that
// must not be trusted to review-by-eye — a config written by an older build has to
// keep rendering identically, and `theme`/`palette` have to stay truthful for the
// four windows and the thirty CSS blocks that read them. So they live here, pure,
// with `ui-prefs-pure.test.ts` next to them, and config.ts is left holding only the
// file I/O.

/** One side of the appearance model: everything that can differ between light and dark. */
export interface ThemeSettings {
  /** Palette id (see global.css [data-palette]). */
  palette: string
  /** `#rrggbb` override of the palette's own --accent. Absent = use the palette's. */
  accent?: string
  /** `#rrggbb` override of --bg-0; the rest of the surface ramp is derived from it. */
  background?: string
  /** `#rrggbb` override of --text-0; --text-1/--text-2 are derived from it. */
  foreground?: string
  /**
   * 0–100, where 50 means "the palette's own separation between surfaces". Below 50
   * flattens the ramp, above 50 spreads it. Absent is not the same as 50 only in
   * that absent writes nothing at all — see theme.ts.
   */
  contrast?: number
  /** Semi-transparent, blurred sidebar. In-app translucency, not Windows acrylic. */
  translucentSidebar?: boolean
}

export interface UiPrefs {
  /**
   * RESOLVED light/dark. Do not "clean this up" as redundant with `mode`: `mode` can
   * be 'system', and this is the answer after asking the OS. Every consumer in the app
   * reads this — the four renderer windows, and `[data-theme='light']` in global.css —
   * so `setUiPrefs` recomputes and persists it on every write. It is a cache with one
   * writer, which is why it is safe to depend on and unsafe to hand-edit.
   */
  theme: 'dark' | 'light'
  /**
   * RESOLVED palette id: whichever of `light.palette` / `dark.palette` the resolved
   * `theme` selects. Same contract as `theme` above — computed, persisted, read
   * everywhere, never the source of truth.
   */
  palette: string
  density: 'comfortable' | 'compact'
  /**
   * Legacy three-step UI scale. Superseded by `uiFontSize`, and still honoured when
   * that is absent, because that is what every config written before this system says.
   */
  fontSize: 'sm' | 'md' | 'lg'
  onboarded: boolean
  /** Which panel new chats open in. */
  defaultChatView: 'chat' | 'terminal'

  /** The source of truth for light vs dark. Absent in configs older than this system. */
  mode?: 'system' | 'light' | 'dark'
  light?: ThemeSettings
  dark?: ThemeSettings
  /**
   * Family ids from lib/fonts.ts, or undefined/'system' for the platform default.
   * `content` additionally accepts 'inherit', meaning "same as the UI font".
   */
  fonts?: { ui?: string; content?: string; code?: string }
  /** UI scale in px, 11–20. Absent falls back to `fontSize`. */
  uiFontSize?: number
  /** Code/monospace size in px, 10–18. */
  codeFontSize?: number
}

/**
 * What a caller may send to `setUiPrefs`.
 *
 * Not `Partial<UiPrefs>`: `light`/`dark` are patched a level deeper than that, and
 * `ThemeSettings.palette` is required, so `{ dark: { accent: '#fff' } }` — the single
 * most ordinary thing a settings screen does — would not typecheck against it.
 */
export type UiPrefsPatch = Partial<Omit<UiPrefs, 'light' | 'dark'>> & {
  light?: Partial<ThemeSettings>
  dark?: Partial<ThemeSettings>
}

export const UI_FONT_SIZE_MIN = 11
export const UI_FONT_SIZE_MAX = 20
/** The px size that means zoom 1.0 — the size this UI was drawn at. */
export const UI_FONT_SIZE_DEFAULT = 14

export const CODE_FONT_SIZE_MIN = 10
export const CODE_FONT_SIZE_MAX = 18
/** Matches `--font-size-code` in global.css, i.e. what code blocks already render at. */
export const CODE_FONT_SIZE_DEFAULT = 13

/**
 * `#rgb` / `#rrggbb`, and nothing else.
 *
 * The narrowness is the point: these strings are written straight into CSS custom
 * properties, and lib/color.ts has to be able to parse every one of them back out to
 * derive a ramp from it. `red`, `rgb(1 2 3)` and `#abcd` would all pass a laxer check
 * and then fail to derive, leaving half a theme applied.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.max(min, Math.min(max, value)))
}

/**
 * Bring a config written before this system up to the current model, without changing
 * what the user sees.
 *
 * The old model was a single `theme` plus a single `palette`. Read as the new model
 * that is "mode = whatever theme was, and both sides use the palette they already
 * had" — so the first thing the user does in the new settings screen (flip to light,
 * say) finds their palette already there instead of the default.
 */
export function migrateUiPrefs(ui: UiPrefs): UiPrefs {
  const next: UiPrefs = { ...ui }
  if (next.mode !== 'system' && next.mode !== 'light' && next.mode !== 'dark') {
    next.mode = next.theme === 'light' ? 'light' : 'dark'
  }
  if (!next.light) next.light = { palette: ui.palette }
  if (!next.dark) next.dark = { palette: ui.palette }
  return next
}

/**
 * Merge one side of the model. Absent keys in the patch are left alone; a key set to
 * `undefined` or `''` clears the override, which is how the settings screen offers a
 * "back to the palette's own colour" button. An unparseable colour is dropped on the
 * floor rather than stored — see isHexColor.
 */
function mergeSide(current: ThemeSettings | undefined, patch: Partial<ThemeSettings> | undefined, fallbackPalette: string): ThemeSettings {
  const base: ThemeSettings = { ...(current ?? { palette: fallbackPalette }) }
  if (!patch) return base
  if (typeof patch.palette === 'string' && patch.palette) base.palette = patch.palette

  for (const key of ['accent', 'background', 'foreground'] as const) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === undefined || value === '') delete base[key]
    else if (isHexColor(value)) base[key] = value.toLowerCase()
    // else: malformed, keep what was there
  }

  if ('contrast' in patch) {
    const c = clampInt(patch.contrast, 0, 100)
    if (c === undefined) delete base.contrast
    else base.contrast = c
  }
  if ('translucentSidebar' in patch) {
    if (patch.translucentSidebar === undefined) delete base.translucentSidebar
    else base.translucentSidebar = !!patch.translucentSidebar
  }
  return base
}

/**
 * Resolve the computed fields. `systemPrefersDark` is passed in rather than read here
 * so this stays pure — main/index.ts owns the nativeTheme subscription that supplies it.
 */
export function resolveUiPrefs(ui: UiPrefs, systemPrefersDark: boolean): UiPrefs {
  const mode = ui.mode ?? (ui.theme === 'light' ? 'light' : 'dark')
  const theme: 'dark' | 'light' =
    mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
  const side = theme === 'light' ? ui.light : ui.dark
  return { ...ui, mode, theme, palette: side?.palette || ui.palette }
}

/**
 * The whole write path in one place: migrate what is on disk, merge the patch, sanitize
 * the numbers, then resolve. Callers get back exactly what should be persisted.
 *
 * A patch that names `theme` or `palette` is read as the old API it is: `theme` means
 * "set mode to this", `palette` means "set the palette of whichever side is showing".
 * Without that, the pre-existing settings screen — which still patches those two
 * directly — would appear to do nothing, because resolution runs last and would put
 * both fields straight back.
 */
export function applyUiPatch(current: UiPrefs, patch: UiPrefsPatch, systemPrefersDark: boolean): UiPrefs {
  const base = migrateUiPrefs(current)
  // light/dark are pulled out of the spread: they are merged a level deeper, below.
  const { light: _light, dark: _dark, ...scalars } = patch
  const next: UiPrefs = { ...base, ...scalars }

  if (patch.mode === undefined && (patch.theme === 'dark' || patch.theme === 'light')) {
    next.mode = patch.theme
  }

  next.light = mergeSide(base.light, patch.light, base.palette)
  next.dark = mergeSide(base.dark, patch.dark, base.palette)

  if (typeof patch.palette === 'string' && patch.palette && !patch.light && !patch.dark) {
    // Which side "showing" means has to be decided with the patch's mode already in
    // place, so `{ theme: 'light', palette: 'x' }` in one call lands on the light side.
    const showing = resolveUiPrefs(next, systemPrefersDark).theme
    if (showing === 'light') next.light = { ...next.light, palette: patch.palette }
    else next.dark = { ...next.dark, palette: patch.palette }
  }

  if ('fonts' in patch) {
    const merged = { ...(base.fonts ?? {}), ...(patch.fonts ?? {}) }
    for (const key of ['ui', 'content', 'code'] as const) {
      const value = merged[key]
      if (typeof value !== 'string' || !value.trim()) delete merged[key]
      else merged[key] = value.trim().slice(0, 64)
    }
    next.fonts = Object.keys(merged).length ? merged : undefined
  }

  if ('uiFontSize' in patch) {
    next.uiFontSize = patch.uiFontSize === undefined ? undefined : clampInt(patch.uiFontSize, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX)
  }
  if ('codeFontSize' in patch) {
    next.codeFontSize = patch.codeFontSize === undefined ? undefined : clampInt(patch.codeFontSize, CODE_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX)
  }

  return resolveUiPrefs(next, systemPrefersDark)
}
