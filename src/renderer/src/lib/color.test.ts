import { describe, it, expect } from 'vitest'
import {
  accentRamp,
  contrastRatio,
  contrastScale,
  darken,
  INK_DARK,
  INK_LIGHT,
  isHexColor,
  lighten,
  luminance,
  mix,
  parseHex,
  readableOn,
  Rgb,
  surfaceRamp,
  textRamp,
  toHex
} from './color'

// These are the numbers the appearance engine derives everything else from, so the
// assertions are on values, not shapes. Two of them are checked against the
// hand-tuned palette in global.css: the ramps exist to make a custom background look
// like it belongs next to the thirty presets, and a derivation that drifts far from
// Warm Rust's own steps has stopped doing that — quietly, since it still produces
// colours and the app still paints.

const rgb = (hex: string): Rgb => parseHex(hex) as Rgb

/**
 * Per-channel closeness, for comparing a derived colour against a hand-picked one.
 *
 * The tolerances below are 14, not 2, and the slack is almost entirely in the blue
 * channel: the hand-tuned palettes lighten toward a *warm* white to keep their tint as
 * surfaces rise, while the derivation mixes toward pure white. That difference is
 * invisible at these step sizes and not worth a second colour space to close. What the
 * check is for is a derivation that has come loose — a step in the wrong direction, a
 * scale factor an order of magnitude out — which lands nowhere near 14.
 */
function channelsWithin(actual: string, expected: string, tolerance: number): boolean {
  const a = rgb(actual)
  const e = rgb(expected)
  return (
    Math.abs(a.r - e.r) <= tolerance &&
    Math.abs(a.g - e.g) <= tolerance &&
    Math.abs(a.b - e.b) <= tolerance
  )
}

describe('parsing', () => {
  it('reads #rrggbb', () => {
    expect(parseHex('#141312')).toEqual({ r: 20, g: 19, b: 18 })
    expect(parseHex('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('  #000000  ')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('expands #rgb', () => {
    // The short form has to double each digit, not pad it: #abc is #aabbcc, and
    // #a0b0c0 is a completely different colour.
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('returns null for anything it cannot parse', () => {
    // Every one of these would reach the engine from a config file or a text field,
    // and every one of them must fail loudly here rather than silently derive a ramp
    // from NaN — which renders as a fully transparent app.
    for (const bad of ['', 'fff', '#ff', '#ffff', '#fffffff', '#12345g', 'red', 'rgb(0,0,0)', '#', 'transparent']) {
      expect(parseHex(bad), `parseHex(${JSON.stringify(bad)})`).toBeNull()
      expect(isHexColor(bad), `isHexColor(${JSON.stringify(bad)})`).toBe(false)
    }
  })

  it('round-trips through toHex', () => {
    for (const hex of ['#000000', '#ffffff', '#df7a52', '#0f1414']) {
      expect(toHex(rgb(hex))).toBe(hex)
    }
    // Short form normalises to long.
    expect(toHex(rgb('#abc'))).toBe('#aabbcc')
  })

  it('clamps out-of-range channels instead of emitting broken hex', () => {
    expect(toHex({ r: -20, g: 300, b: 128.6 })).toBe('#00ff81')
  })
})

describe('mixing', () => {
  it('returns the endpoints at t = 0 and t = 1', () => {
    const a = rgb('#102030')
    const b = rgb('#a0b0c0')
    expect(mix(a, b, 0)).toEqual(a)
    expect(mix(a, b, 1)).toEqual(b)
  })

  it('mixes halfway', () => {
    expect(toHex(mix(rgb('#000000'), rgb('#ffffff'), 0.5))).toBe('#808080')
  })

  it('clamps t rather than extrapolating', () => {
    // An out-of-range amount must not overshoot past white into a wrapped channel.
    expect(toHex(lighten(rgb('#808080'), 5))).toBe('#ffffff')
    expect(toHex(darken(rgb('#808080'), 5))).toBe('#000000')
  })
})

describe('luminance and contrast', () => {
  it('anchors luminance at black and white', () => {
    expect(luminance(rgb('#000000'))).toBe(0)
    expect(luminance(rgb('#ffffff'))).toBeCloseTo(1, 10)
  })

  it('gives black on white the WCAG maximum of 21', () => {
    expect(contrastRatio(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 6)
    // Order must not matter — the formula sorts the two luminances itself.
    expect(contrastRatio(rgb('#ffffff'), rgb('#000000'))).toBeCloseTo(21, 6)
  })

  it('gives a colour against itself the minimum of 1', () => {
    expect(contrastRatio(rgb('#df7a52'), rgb('#df7a52'))).toBeCloseTo(1, 10)
  })

  it('agrees with the published ratio for mid grey on white', () => {
    // #767676 on white is the canonical 4.54:1 example — the darkest grey that still
    // passes AA for body text. If this number moves, the formula is wrong.
    expect(contrastRatio(rgb('#767676'), rgb('#ffffff'))).toBeCloseTo(4.54, 2)
  })

  it('picks the ink that actually contrasts', () => {
    expect(readableOn(rgb('#ffffff'))).toBe(INK_DARK)
    expect(readableOn(rgb('#000000'))).toBe(INK_LIGHT)
    // The interesting case: a mid-bright accent, where the answer is not obvious by eye.
    const chosen = readableOn(rgb('#df7a52'))
    const other = chosen === INK_DARK ? INK_LIGHT : INK_DARK
    expect(contrastRatio(rgb('#df7a52'), rgb(chosen))).toBeGreaterThan(
      contrastRatio(rgb('#df7a52'), rgb(other))
    )
  })
})

describe('the surface ramp', () => {
  it('steps monotonically away from the background in dark mode', () => {
    const ramp = surfaceRamp(rgb('#141312'), 'dark')
    const order = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover'] as const
    const lums = order.map((k) => luminance(rgb(ramp[k])))
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i], `${order[i]} must be lighter than ${order[i - 1]}`).toBeGreaterThan(lums[i - 1])
    }
  })

  it('steps monotonically the other way in light mode', () => {
    const ramp = surfaceRamp(rgb('#f7f5f1'), 'light')
    const order = ['--bg-0', '--bg-1', '--bg-2', '--bg-3'] as const
    const lums = order.map((k) => luminance(rgb(ramp[k])))
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i], `${order[i]} must be darker than ${order[i - 1]}`).toBeLessThan(lums[i - 1])
    }
  })

  it('lands close to Warm Rust, whose own steps it was measured from', () => {
    const dark = surfaceRamp(rgb('#141312'), 'dark')
    const expectedDark = {
      '--bg-1': '#1c1b19',
      '--bg-2': '#252320',
      '--bg-3': '#302d29',
      '--bg-hover': '#3a3530',
      '--border': '#302c28',
      '--border-light': '#48423a'
    } as const
    for (const [name, hex] of Object.entries(expectedDark)) {
      const got = dark[name as keyof typeof expectedDark]
      expect(
        channelsWithin(got, hex, 14),
        `${name}: derived ${got}, global.css has ${hex} — more than 14/255 apart, so a ` +
          'custom background will no longer read like the presets beside it'
      ).toBe(true)
    }

    const light = surfaceRamp(rgb('#f7f5f1'), 'light')
    const expectedLight = {
      '--bg-1': '#f1eee7',
      '--bg-2': '#eae6de',
      '--bg-3': '#e2ddd3',
      '--bg-hover': '#ebe7df'
    } as const
    for (const [name, hex] of Object.entries(expectedLight)) {
      const got = light[name as keyof typeof expectedLight]
      expect(channelsWithin(got, hex, 14), `${name}: derived ${got}, global.css has ${hex}`).toBe(true)
    }
  })

  it('treats contrast 50 as the separation the palette itself has', () => {
    expect(contrastScale(50)).toBe(1)
    expect(contrastScale(undefined)).toBe(1)
    expect(surfaceRamp(rgb('#141312'), 'dark', 50)).toEqual(surfaceRamp(rgb('#141312'), 'dark'))
  })

  it('widens the steps above 50 and flattens them below', () => {
    const base = rgb('#141312')
    const mid = surfaceRamp(base, 'dark', 50)
    const high = surfaceRamp(base, 'dark', 100)
    const low = surfaceRamp(base, 'dark', 10)
    expect(luminance(rgb(high['--bg-2']))).toBeGreaterThan(luminance(rgb(mid['--bg-2'])))
    expect(luminance(rgb(low['--bg-2']))).toBeLessThan(luminance(rgb(mid['--bg-2'])))
    // Contrast 0 is a legitimate ask: every surface the same colour, flat by design.
    const flat = surfaceRamp(base, 'dark', 0)
    expect(flat['--bg-3']).toBe(flat['--bg-0'])
  })
})

describe('the text ramp', () => {
  it('fades toward the background, not away from it', () => {
    const dark = textRamp(rgb('#efece8'), 'dark')
    expect(luminance(rgb(dark['--text-1']))).toBeLessThan(luminance(rgb(dark['--text-0'])))
    expect(luminance(rgb(dark['--text-2']))).toBeLessThan(luminance(rgb(dark['--text-1'])))

    const light = textRamp(rgb('#2a2622'), 'light')
    expect(luminance(rgb(light['--text-1']))).toBeGreaterThan(luminance(rgb(light['--text-0'])))
    expect(luminance(rgb(light['--text-2']))).toBeGreaterThan(luminance(rgb(light['--text-1'])))
  })

  it('lands close to Warm Rust', () => {
    const dark = textRamp(rgb('#efece8'), 'dark')
    expect(channelsWithin(dark['--text-1'], '#b3ada4', 14)).toBe(true)
    expect(channelsWithin(dark['--text-2'], '#7c766e', 14)).toBe(true)
  })

  it('pulls secondary text toward primary as contrast rises', () => {
    const base = rgb('#efece8')
    const mid = textRamp(base, 'dark', 50)
    const high = textRamp(base, 'dark', 100)
    expect(luminance(rgb(high['--text-2']))).toBeGreaterThan(luminance(rgb(mid['--text-2'])))
    // …but never all the way: three identical text colours would erase the hierarchy
    // the whole UI reads by, so the fade is clamped short of zero.
    expect(high['--text-1']).not.toBe(high['--text-0'])
    expect(high['--text-2']).not.toBe(high['--text-1'])
  })
})

describe('the accent ramp', () => {
  it('lightens the hover in dark mode and darkens it in light', () => {
    const dark = accentRamp(rgb('#df7a52'), 'dark')
    expect(luminance(rgb(dark['--accent-hover']))).toBeGreaterThan(luminance(rgb('#df7a52')))
    expect(channelsWithin(dark['--accent-hover'], '#ed8f6b', 10)).toBe(true)

    const light = accentRamp(rgb('#bd5d44'), 'light')
    expect(luminance(rgb(light['--accent-hover']))).toBeLessThan(luminance(rgb('#bd5d44')))
    expect(channelsWithin(light['--accent-hover'], '#aa523b', 10)).toBe(true)
  })

  it('writes accent-dim as the same rgb at the alpha global.css uses', () => {
    // Every palette block writes this token as `rgba(<accent>, 0.17)` in dark and
    // 0.13 in light. Matching it exactly is what keeps a custom accent's washes
    // looking like a preset's.
    expect(accentRamp(rgb('#df7a52'), 'dark')['--accent-dim']).toBe('rgba(223, 122, 82, 0.17)')
    expect(accentRamp(rgb('#bd5d44'), 'light')['--accent-dim']).toBe('rgba(189, 93, 68, 0.13)')
  })
})
