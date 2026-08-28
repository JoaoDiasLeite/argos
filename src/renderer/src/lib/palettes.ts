// The theme registry: the one list of selectable palettes, and the one place that
// knows which of them is the default.
//
// Why this module is a second copy, and why that is acceptable here:
// a palette *is* a set of CSS custom properties under a `[data-palette='x']`
// selector, and a selector can only live in a stylesheet. So `styles/global.css`
// stays the definition; TypeScript cannot own it. But the settings picker has to
// paint a swatch for each palette before the palette is applied to anything, which
// means it needs those colours as values — a second copy, unavoidably.
//
// The defect this module exists to close is not the duplication itself; it is that
// the duplication was unchecked. The picker's fourteen rows were written out inline
// in SettingsModal.tsx, and nothing anywhere would have noticed a swatch drifting
// from the palette it names, or a palette added to the CSS and never offered in the
// picker. `palettes.test.ts` reads global.css off disk and holds the two sides
// together. It is the point of this module, not decoration around it — if that test
// is deleted, this file goes back to being a stale copy waiting to happen.

export interface Palette {
  id: string
  name: string
  /** The three colours the picker's chip shows: --bg-0, --bg-2 and --accent of the dark block. */
  swatch: readonly [string, string, string]
}

/**
 * Presentation order is the picker's order — this is the sequence the swatches appear
 * in, so reordering here is a visible UI change.
 */
export const PALETTES: readonly Palette[] = [
  { id: 'warm-rust', name: 'Warm Rust', swatch: ['#141312', '#252320', '#df7a52'] },
  { id: 'graphite-indigo', name: 'Graphite Indigo', swatch: ['#121316', '#21242d', '#7c83ff'] },
  { id: 'midnight-violet', name: 'Midnight Violet', swatch: ['#0f0e16', '#1e1c2b', '#a78bfa'] },
  { id: 'slate-teal', name: 'Slate Teal', swatch: ['#0f1414', '#1e2726', '#2dd4bf'] },
  { id: 'charcoal-amber', name: 'Charcoal Amber', swatch: ['#131211', '#242220', '#e3a857'] },
  { id: 'arctic-sky', name: 'Arctic Sky', swatch: ['#0f1318', '#1d242e', '#4f9cf5'] },
  { id: 'rose-noir', name: 'Rose Noir', swatch: ['#151113', '#261f23', '#ec6a93'] },
  { id: 'evergreen', name: 'Evergreen', swatch: ['#0f1411', '#1d2620', '#34d27f'] },
  { id: 'ruby-ember', name: 'Ruby Ember', swatch: ['#141110', '#25201f', '#e85c6b'] },
  { id: 'ocean-cyan', name: 'Ocean Cyan', swatch: ['#0d1417', '#1a262b', '#25c4dd'] },
  { id: 'harbor', name: 'Harbor', swatch: ['#0e1822', '#1d2c3a', '#f9c24a'] },
  { id: 'dusk-copper', name: 'Dusk Copper', swatch: ['#14121a', '#27232f', '#d97c52'] },
  { id: 'sage-stone', name: 'Sage Stone', swatch: ['#111412', '#20251f', '#8ac06a'] },
  { id: 'solar-dune', name: 'Solar Dune', swatch: ['#181411', '#2c2520', '#f5a742'] }
]

/**
 * The palette applied when a config carries none. Its tokens live in bare `:root`
 * in global.css rather than under a `[data-palette]` block, which is why it is the
 * fallback rather than merely the first entry.
 */
export const DEFAULT_PALETTE = 'warm-rust'

/**
 * Put the theme and palette on a document root.
 *
 * Every renderer window — main, overlay, pill, toast — has to do this, and each one
 * used to carry its own two-line copy plus its own `'warm-rust'` literal. Five copies
 * of one fact is four chances to change the default and miss a window; the fifth was
 * found only because this comment went looking for the fourth.
 */
export function applyPalette(root: HTMLElement, theme: string, palette: string | undefined): void {
  root.dataset.theme = theme
  root.dataset.palette = palette || DEFAULT_PALETTE
}
