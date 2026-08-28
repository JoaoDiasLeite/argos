import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { PALETTES, DEFAULT_PALETTE } from './palettes'

// The guard for the registry. `palettes.ts` is necessarily a second copy of what
// global.css defines (see the doc comment there); this test is what makes that copy
// safe. It reads the real stylesheet off disk — vitest runs in node — so it fails on
// the actual CSS, not on a fixture that could itself drift.

// Comments are stripped first: global.css documents the scheme in prose that contains
// a literal `[data-palette='x']`, and scanning that as a definition invents a palette
// named "x" out of a comment.
const CSS = fs
  .readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles/global.css'),
    'utf-8'
  )
  .replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The body of a CSS rule, given its exact selector text. Returns null when no such
 * rule exists — "the block is missing" and "the block is empty" are different
 * failures and the tests below want to tell them apart.
 */
function blockFor(selector: string): string | null {
  const at = CSS.indexOf(selector + ' {')
  if (at === -1) return null
  const open = CSS.indexOf('{', at)
  const close = CSS.indexOf('}', open)
  return close === -1 ? null : CSS.slice(open + 1, close)
}

/** The value of one custom property inside a rule body, e.g. `--bg-0` → `#141312`. */
function token(body: string, name: string): string | null {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;\\n}]+)`))
  return m ? m[1].trim().toLowerCase() : null
}

// The default palette is the one whose tokens live in bare :root rather than under a
// [data-palette] block, so its selectors are a special case everywhere below.
function darkSelector(id: string): string {
  return id === DEFAULT_PALETTE ? ':root' : `:root[data-palette='${id}']`
}
function lightSelector(id: string): string {
  return id === DEFAULT_PALETTE
    ? ":root[data-theme='light']"
    : `:root[data-palette='${id}'][data-theme='light']`
}

describe('the palette registry matches global.css', () => {
  it('gives every registered palette a dark block', () => {
    // Catches a palette offered in the picker that the CSS never defines: the swatch
    // would paint, and selecting it would leave the app on the default's colours.
    for (const p of PALETTES) {
      const sel = darkSelector(p.id)
      expect(blockFor(sel), `palette '${p.id}': no dark block '${sel}' in global.css`).not.toBeNull()
    }
  })

  it('gives every registered palette a light block', () => {
    // Catches the half-added palette — dark block written, light forgotten. The app
    // would not break, it would just quietly show the default's light theme.
    for (const p of PALETTES) {
      const sel = lightSelector(p.id)
      expect(
        blockFor(sel),
        `palette '${p.id}': no light block '${sel}' in global.css`
      ).not.toBeNull()
    }
  })

  it('registers every palette the CSS defines', () => {
    // The reverse direction, and the one an eyeball check never does: a palette added
    // to global.css and never added to the picker is invisible to the user forever.
    const inCss = new Set<string>()
    for (const m of CSS.matchAll(/\[data-palette='([^']+)'\]/g)) inCss.add(m[1])
    const registered = new Set(PALETTES.map((p) => p.id))
    for (const id of inCss) {
      expect(
        registered.has(id),
        `palette '${id}' is defined in global.css but missing from PALETTES, so the picker never offers it`
      ).toBe(true)
    }
  })

  it('paints each swatch from that palette dark block --bg-0, --bg-2 and --accent', () => {
    // The drift this whole lot exists to prevent: a colour retuned in the CSS while the
    // picker keeps showing the old one, so the chip lies about the palette it names.
    const NAMES = ['--bg-0', '--bg-2', '--accent'] as const
    for (const p of PALETTES) {
      const body = blockFor(darkSelector(p.id))
      expect(body, `palette '${p.id}': no dark block to read swatch colours from`).not.toBeNull()
      NAMES.forEach((name, i) => {
        const css = token(body as string, name)
        expect(css, `palette '${p.id}': ${name} not found in its dark block`).not.toBeNull()
        expect(
          p.swatch[i].toLowerCase(),
          `palette '${p.id}': swatch[${i}] is ${p.swatch[i]} but ${name} in global.css is ${css}`
        ).toBe(css)
      })
    }
  })

  it('points DEFAULT_PALETTE at a registered palette', () => {
    // A default that is not in the list makes the picker show nothing as selected,
    // and applyPalette write an id no CSS block answers to.
    expect(
      PALETTES.some((p) => p.id === DEFAULT_PALETTE),
      `DEFAULT_PALETTE is '${DEFAULT_PALETTE}', which is not an id in PALETTES`
    ).toBe(true)
  })

  it('has no duplicate ids', () => {
    // Two rows with one id render two chips that both look selected and one of which
    // can never be reached — the classic result of copy-pasting a row to add a palette.
    const seen = new Set<string>()
    for (const p of PALETTES) {
      expect(seen.has(p.id), `palette id '${p.id}' appears more than once in PALETTES`).toBe(false)
      seen.add(p.id)
    }
  })
})
