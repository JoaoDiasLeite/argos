// Colour maths for the appearance engine. Pure — no DOM, no CSS, no prefs.
//
// The engine's job is to take three colours a user picked and produce the twenty-odd
// tokens global.css actually uses. That means the ramps have to be *derived* rather
// than guessed, and the derivation has to land somewhere near where the hand-tuned
// palettes already sit — otherwise a custom background looks nothing like the thirty
// presets it sits next to in the picker. The step constants below were read back off
// Warm Rust (the palette whose tokens live in bare `:root`), which is why they are
// oddly specific numbers rather than round ones.

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** True for `#rgb` / `#rrggbb` only — see parseHex for why nothing else counts. */
export function isHexColor(value: string): boolean {
  return HEX.test(value.trim())
}

/**
 * `#rgb` / `#rrggbb` → channels, or null.
 *
 * Deliberately not a general CSS colour parser. Everything that reaches here either
 * came from a colour input (always six digits) or was read back out of global.css
 * (always three or six), and a parser that quietly accepted `rgba(...)` or a named
 * colour would return a wrong number rather than an honest null.
 */
export function parseHex(hex: string): Rgb | null {
  const s = hex.trim()
  if (!HEX.test(s)) return null
  const body = s.slice(1)
  const full = body.length === 3 ? body[0] + body[0] + body[1] + body[1] + body[2] + body[2] : body
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function toHex(c: Rgb): string {
  return '#' + [c.r, c.g, c.b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('')
}

/** `t` = 0 returns `a`, 1 returns `b`. Straight sRGB mix — see the note on lighten. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return {
    r: clamp255(a.r + (b.r - a.r) * k),
    g: clamp255(a.g + (b.g - a.g) * k),
    b: clamp255(a.b + (b.b - a.b) * k)
  }
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/**
 * Move `amount` of the way to white.
 *
 * Mixing in plain sRGB rather than a perceptual space is a choice, not an oversight:
 * the existing palettes' elevation steps were hand-picked as sRGB hex, so sRGB mixing
 * is what reproduces them. A perceptual mix would be more even and would not match.
 */
export function lighten(c: Rgb, amount: number): Rgb {
  return mix(c, WHITE, amount)
}

export function darken(c: Rgb, amount: number): Rgb {
  return mix(c, BLACK, amount)
}

/** `rgba(...)` string, for the accent-dim convention global.css already uses. */
export function rgba(c: Rgb, alpha: number): string {
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${alpha})`
}

/** WCAG 2.x relative luminance: 0 for black, 1 for white. */
export function luminance(c: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). Order does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** Near-white and near-black ink. Not pure #fff/#000: neither reads well on screen. */
export const INK_LIGHT = '#f5f3f0'
export const INK_DARK = '#1a1917'

/**
 * The better of the two inks on `bg`, by contrast ratio. Used for text that sits on a
 * user-chosen colour (an accent-filled button, say) where neither ink is safe to assume.
 */
export function readableOn(bg: Rgb): string {
  const light = parseHex(INK_LIGHT) as Rgb
  const dark = parseHex(INK_DARK) as Rgb
  return contrastRatio(bg, light) >= contrastRatio(bg, dark) ? INK_LIGHT : INK_DARK
}

// ─── Derived ramps ────────────────────────────────────────────────────────────

/**
 * How far each surface token sits from --bg-0, as a fraction of the distance to white
 * (dark) or to black (light).
 *
 * Measured off Warm Rust: dark #141312 → #1c1b19 / #252320 / #302d29 / #3a3530, and
 * light #f7f5f1 → #f1eee7 / #eae6de / #e2ddd3 / #ebe7df. Note that --bg-hover is
 * *above* --bg-3 in dark and *below* it in light, which is not a mistake in the CSS:
 * a hover in light mode is a gentle tint, not the deepest surface.
 */
const SURFACE_STEPS = {
  dark: { bg1: 0.035, bg2: 0.075, bg3: 0.12, hover: 0.165, border: 0.12, borderLight: 0.22 },
  light: { bg1: 0.025, bg2: 0.055, bg3: 0.085, hover: 0.05, border: 0.095, borderLight: 0.17 }
} as const

/** How far --text-1 / --text-2 fade from --text-0 toward the background pole. */
const TEXT_STEPS = { text1: 0.25, text2: 0.47 } as const

export interface SurfaceRamp {
  '--bg-0': string
  '--bg-1': string
  '--bg-2': string
  '--bg-3': string
  '--bg-hover': string
  '--border': string
  '--border-light': string
}

export interface TextRamp {
  '--text-0': string
  '--text-1': string
  '--text-2': string
}

/**
 * `contrast` (0–100, 50 = the palette's own separation) as a multiplier on step size.
 *
 * Linear around the midpoint: 50 → 1, 100 → 2 (twice the separation), 0 → 0 (every
 * surface the same colour, which is a legitimate thing to ask for and looks flat by
 * design rather than by accident).
 */
export function contrastScale(contrast: number | undefined): number {
  if (typeof contrast !== 'number' || !Number.isFinite(contrast)) return 1
  return Math.max(0, Math.min(100, contrast)) / 50
}

/**
 * The full surface ramp from a base --bg-0.
 *
 * `--bg-0` is included in the result even though it is the input: the caller writes
 * the whole set as one block, and leaving the base out would mean the ramp and the
 * background it was derived from could be written by two different code paths.
 */
export function surfaceRamp(base: Rgb, theme: 'dark' | 'light', contrast?: number): SurfaceRamp {
  const steps = SURFACE_STEPS[theme]
  const scale = contrastScale(contrast)
  const step = (amount: number): string =>
    toHex(theme === 'dark' ? lighten(base, amount * scale) : darken(base, amount * scale))
  return {
    '--bg-0': toHex(base),
    '--bg-1': step(steps.bg1),
    '--bg-2': step(steps.bg2),
    '--bg-3': step(steps.bg3),
    '--bg-hover': step(steps.hover),
    '--border': step(steps.border),
    '--border-light': step(steps.borderLight)
  }
}

/**
 * --text-1 / --text-2 from a base --text-0.
 *
 * There is deliberately no contrast input here. The slider is a surface control: it
 * spreads --bg-0..--bg-3 and leaves the type hierarchy exactly where the palette put
 * it. An earlier version did tighten the muted steps toward the primary, which meant
 * a control labelled for surfaces quietly restyled every piece of secondary text in
 * the app — so the knob was removed rather than left for a caller to find.
 */
export function textRamp(base: Rgb, theme: 'dark' | 'light'): TextRamp {
  const step = (amount: number): string =>
    toHex(theme === 'dark' ? darken(base, amount) : lighten(base, amount))
  return {
    '--text-0': toHex(base),
    '--text-1': step(TEXT_STEPS.text1),
    '--text-2': step(TEXT_STEPS.text2)
  }
}

export interface AccentRamp {
  '--accent': string
  '--accent-hover': string
  '--accent-dim': string
}

/**
 * Accent, its hover and its dim wash.
 *
 * Both derivations copy conventions already in global.css rather than inventing new
 * ones: hover goes lighter in dark mode and darker in light (Warm Rust: #df7a52 →
 * #ed8f6b, #bd5d44 → #aa523b), and dim is the same RGB at 0.17 / 0.13 alpha, which is
 * what every one of the thirty palette blocks writes.
 */
export function accentRamp(base: Rgb, theme: 'dark' | 'light'): AccentRamp {
  return {
    '--accent': toHex(base),
    '--accent-hover': toHex(theme === 'dark' ? lighten(base, 0.15) : darken(base, 0.1)),
    '--accent-dim': rgba(base, theme === 'dark' ? 0.17 : 0.13)
  }
}
