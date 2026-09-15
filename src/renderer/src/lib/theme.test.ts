import { describe, it, expect, afterEach } from 'vitest'
import { UiPrefs } from '../types'
import { applyTheme, MANAGED_VARS, planTheme, zoomFor } from './theme'
import { SYSTEM_MONO } from './fonts'

// vitest runs in node, so there is no document to apply a theme to. Rather than pull
// in a DOM implementation for two properties and a dataset, the engine was split:
// `planTheme` decides what to write and is pure, `applyTheme` is the only part that
// touches an element — and what it touches is small enough to stand in for honestly.
// The stub below records every set and remove, which is exactly what the stale-override
// behaviour has to be checked against.

function fakeRoot() {
  const props = new Map<string, string>()
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
      getPropertyValue: (name: string) => props.get(name) ?? ''
    }
  }
  return { root: root as unknown as HTMLElement, props }
}

/**
 * Pretend the stylesheet is live and Warm Rust is applied. applyTheme reads --bg-0 and
 * --text-0 back so `contrast` can work on a palette the user has not otherwise touched;
 * without a stub, node's missing getComputedStyle takes the "leave the ramp alone" path.
 */
function stubComputedStyle(values: Record<string, string> | null): void {
  const g = globalThis as unknown as { getComputedStyle?: unknown }
  if (!values) {
    delete g.getComputedStyle
    return
  }
  g.getComputedStyle = () => ({ getPropertyValue: (name: string) => values[name] ?? '' })
}

afterEach(() => stubComputedStyle(null))

/** Exactly what a config written before this whole system contains — nothing more. */
const LEGACY: UiPrefs = {
  theme: 'dark',
  palette: 'gruvbox',
  density: 'comfortable',
  fontSize: 'md',
  onboarded: true,
  workMode: 'chat'
}

const WARM_RUST_DARK = { '--bg-0': ' #141312', '--text-0': '#efece8' }

describe('a config that predates the appearance system', () => {
  it('writes the two data attributes and nothing else', () => {
    // The whole backwards-compatibility claim in one assertion: an old config must put
    // the app in exactly the state applyPalette used to leave it in. Any inline custom
    // property here is a token overriding a palette that was never asked to be overridden.
    const { root, props } = fakeRoot()
    applyTheme(root, LEGACY)
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.palette).toBe('gruvbox')
    expect([...props.keys()]).toEqual([])
    expect(root.dataset.translucentSidebar).toBe('')
  })

  it('falls back to the default palette when the id is empty', () => {
    const { root } = fakeRoot()
    applyTheme(root, { ...LEGACY, palette: '' })
    expect(root.dataset.palette).toBe('warm-rust')
  })

  it('keeps the legacy sm/md/lg zoom steps', () => {
    expect(zoomFor({ ...LEGACY, fontSize: 'sm' })).toBe(0.9)
    expect(zoomFor({ ...LEGACY, fontSize: 'md' })).toBe(1)
    expect(zoomFor({ ...LEGACY, fontSize: 'lg' })).toBe(1.12)
  })

  it('reads nothing off the stylesheet it does not need', () => {
    // Contrast is the only reason to read the palette back. With no contrast set, a
    // legacy config must not acquire a ramp just because the read-back succeeded.
    stubComputedStyle(WARM_RUST_DARK)
    const { root, props } = fakeRoot()
    applyTheme(root, LEGACY)
    expect([...props.keys()]).toEqual([])
  })
})

describe('uiFontSize', () => {
  it('makes 14px zoom 1.0', () => {
    expect(zoomFor({ ...LEGACY, uiFontSize: 14 })).toBe(1)
  })

  it('scales linearly either side of it, and wins over the legacy field', () => {
    expect(zoomFor({ ...LEGACY, fontSize: 'sm', uiFontSize: 20 })).toBeCloseTo(20 / 14, 10)
    expect(zoomFor({ ...LEGACY, fontSize: 'lg', uiFontSize: 11 })).toBeCloseTo(11 / 14, 10)
  })
})

describe('overrides', () => {
  it('derives the accent trio from an accent override', () => {
    const plan = planTheme({ ...LEGACY, dark: { palette: 'gruvbox', accent: '#ff0000' } })
    expect(plan.vars['--accent']).toBe('#ff0000')
    expect(plan.vars['--accent-dim']).toBe('rgba(255, 0, 0, 0.17)')
    // Lighter in dark mode.
    expect(plan.vars['--accent-hover']).toBe('#ff2626')
  })

  it('derives the whole surface ramp from a background override', () => {
    const plan = planTheme({ ...LEGACY, dark: { palette: 'gruvbox', background: '#101010' } })
    expect(plan.vars['--bg-0']).toBe('#101010')
    for (const name of ['--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--border', '--border-light']) {
      expect(plan.vars[name], `${name} missing from a background-derived ramp`).toBeTruthy()
    }
    // Text is a separate override — a background alone must not rewrite it.
    expect(plan.vars['--text-1']).toBeUndefined()
  })

  it('derives text from a foreground override only', () => {
    const plan = planTheme({ ...LEGACY, dark: { palette: 'gruvbox', foreground: '#ffffff' } })
    expect(plan.vars['--text-0']).toBe('#ffffff')
    expect(plan.vars['--text-1']).toBeTruthy()
    expect(plan.vars['--bg-1']).toBeUndefined()
  })

  it('ignores a colour it cannot parse rather than writing it into CSS', () => {
    const plan = planTheme({ ...LEGACY, dark: { palette: 'gruvbox', accent: 'red' } })
    expect(plan.vars['--accent']).toBeUndefined()
  })

  it('applies the side the resolved theme selects, not both', () => {
    const ui: UiPrefs = {
      ...LEGACY,
      theme: 'light',
      light: { palette: 'gruvbox', accent: '#0000ff' },
      dark: { palette: 'gruvbox', accent: '#ff0000' }
    }
    expect(planTheme(ui).vars['--accent']).toBe('#0000ff')
    // Darker hover in light mode — the opposite direction from the dark side.
    expect(planTheme(ui).vars['--accent-hover']).toBe('#0000e6')
    expect(planTheme({ ...ui, theme: 'dark' }).vars['--accent']).toBe('#ff0000')
  })
})

describe('contrast with no background override', () => {
  it('re-derives the ramp from the palette own tokens', () => {
    stubComputedStyle(WARM_RUST_DARK)
    const { root, props } = fakeRoot()
    applyTheme(root, { ...LEGACY, palette: 'warm-rust', dark: { palette: 'warm-rust', contrast: 100 } })
    // Doubled separation: --bg-2 has to be further from --bg-0 than the palette's own
    // #252320, which is what a contrast slider on an untouched preset means.
    expect(props.get('--bg-0')).toBe('#141312')
    expect(parseInt((props.get('--bg-2') as string).slice(1, 3), 16)).toBeGreaterThan(0x25)
    // ...and the typography is left alone: contrast moves surfaces only, so a palette
    // with no foreground override keeps the text ramp its own stylesheet already set.
    expect(props.get('--text-1')).toBeUndefined()
    expect(props.get('--text-2')).toBeUndefined()
  })

  it('leaves the ramp alone when the read-back comes up empty', () => {
    // getComputedStyle returns '' for a custom property before the stylesheet is live,
    // which is exactly when the first apply runs in a new window. Deriving from that
    // would repaint the app in whatever a failed parse produces.
    stubComputedStyle({})
    const { root, props } = fakeRoot()
    applyTheme(root, { ...LEGACY, dark: { palette: 'gruvbox', contrast: 90 } })
    expect([...props.keys()]).toEqual([])
  })

  it('still derives from an override when the read-back is empty', () => {
    stubComputedStyle({})
    const { root, props } = fakeRoot()
    applyTheme(root, { ...LEGACY, dark: { palette: 'gruvbox', background: '#101010', contrast: 90 } })
    expect(props.get('--bg-0')).toBe('#101010')
  })
})

describe('clearing stale overrides', () => {
  it('removes an override the new prefs do not set', () => {
    // The bug this exists to prevent: an inline custom property beats every stylesheet
    // rule, so an --accent left behind by a customised theme survives the switch to an
    // untouched one and cannot be dislodged by any palette. Forever.
    const { root, props } = fakeRoot()
    applyTheme(root, { ...LEGACY, dark: { palette: 'gruvbox', accent: '#ff0000' } })
    expect(props.get('--accent')).toBe('#ff0000')

    applyTheme(root, { ...LEGACY, dark: { palette: 'gruvbox' } })
    expect(props.has('--accent')).toBe(false)
    expect(props.has('--accent-hover')).toBe(false)
    expect(props.has('--accent-dim')).toBe(false)
  })

  it('drops the previous side overrides when the theme flips', () => {
    const { root, props } = fakeRoot()
    const ui: UiPrefs = {
      ...LEGACY,
      light: { palette: 'gruvbox' },
      dark: { palette: 'gruvbox', background: '#101010' }
    }
    applyTheme(root, ui)
    expect(props.get('--bg-hover')).toBeTruthy()

    applyTheme(root, { ...ui, theme: 'light' })
    // A dark background ramp still inline under a light theme is the worst version of
    // this bug: light text on light surfaces, unreadable and unexplainable.
    for (const name of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--border', '--border-light']) {
      expect(props.has(name), `${name} survived the flip to light`).toBe(false)
    }
  })

  it('clears every property it is able to write', () => {
    // Set the lot, then apply a legacy config and require an empty slate. This is the
    // check that catches a token added to planTheme and forgotten in MANAGED_VARS.
    const { root, props } = fakeRoot()
    applyTheme(root, {
      ...LEGACY,
      dark: { palette: 'gruvbox', accent: '#ff0000', background: '#101010', foreground: '#ffffff' },
      fonts: { ui: 'inter', content: 'georgia', code: 'consolas' },
      codeFontSize: 16
    })
    expect(props.size).toBeGreaterThan(0)
    for (const name of props.keys()) {
      expect(
        (MANAGED_VARS as readonly string[]).includes(name),
        `applyTheme wrote ${name}, which is not in MANAGED_VARS — nothing will ever clear it`
      ).toBe(true)
    }

    applyTheme(root, LEGACY)
    expect([...props.keys()]).toEqual([])
  })
})

describe('fonts and sizes', () => {
  it('writes the stack of a chosen family, not its id', () => {
    const plan = planTheme({ ...LEGACY, fonts: { ui: 'inter', code: 'cascadia-code' } })
    expect(plan.vars['--font-sans']).toContain("'Inter'")
    expect(plan.vars['--font-mono']).toContain("'Cascadia Code'")
    // The stacks keep their fallbacks: a family that vanishes (uninstalled between
    // sessions) has to land somewhere sane rather than on the browser default.
    expect(plan.vars['--font-mono']).toContain(SYSTEM_MONO)
  })

  it('writes nothing for an unknown family id', () => {
    // A config naming a family that has since been dropped from the curated list must
    // fall through to the palette default, not write `--font-sans: not-a-font`.
    const plan = planTheme({ ...LEGACY, fonts: { ui: 'not-a-font' } })
    expect(plan.vars['--font-sans']).toBeUndefined()
  })

  it("treats a content font of 'inherit' as nothing to write", () => {
    // :root already says --font-content is var(--font-sans); saying it again inline
    // would pin the content face to the UI face even after the UI face changes.
    const plan = planTheme({ ...LEGACY, fonts: { ui: 'inter', content: 'inherit' } })
    expect(plan.vars['--font-content']).toBeUndefined()
    expect(plan.vars['--font-sans']).toContain("'Inter'")
  })

  it('writes the code size in px', () => {
    expect(planTheme({ ...LEGACY, codeFontSize: 16 }).vars['--font-size-code']).toBe('16px')
    expect(planTheme(LEGACY).vars['--font-size-code']).toBeUndefined()
  })
})

describe('the translucent sidebar flag', () => {
  it('is per side, and off unless that side asks for it', () => {
    const ui: UiPrefs = {
      ...LEGACY,
      light: { palette: 'gruvbox', translucentSidebar: true },
      dark: { palette: 'gruvbox' }
    }
    const { root } = fakeRoot()
    applyTheme(root, ui)
    expect(root.dataset.translucentSidebar).toBe('')
    applyTheme(root, { ...ui, theme: 'light' })
    expect(root.dataset.translucentSidebar).toBe('on')
  })
})
