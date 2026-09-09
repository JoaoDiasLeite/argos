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
// the duplication was unchecked. The picker's rows were once written out inline in
// the settings modal, and nothing anywhere would have noticed a swatch drifting
// from the palette it names, or a palette added to the CSS and never offered in the
// picker. `palettes.test.ts` reads global.css off disk and holds the two sides
// together. It is the point of this module, not decoration around it — if that test
// is deleted, this file goes back to being a stale copy waiting to happen.

export interface Palette {
  id: string
  name: string
  /** The three colours the picker's chip shows: --bg-0, --bg-2 and --accent of the dark block. */
  swatch: readonly [string, string, string]
  /** The same three tokens read from the light block, for a picker that offers a light chip too. */
  lightSwatch: readonly [string, string, string]
}

/**
 * Presentation order is the picker's order — this is the sequence the swatches appear
 * in, so reordering here is a visible UI change.
 */
export const PALETTES: readonly Palette[] = [
  {
    id: 'warm-rust',
    name: 'Warm Rust',
    swatch: ['#141312', '#252320', '#df7a52'],
    lightSwatch: ['#f7f5f1', '#eae6de', '#bd5d44']
  },
  {
    id: 'graphite-indigo',
    name: 'Graphite Indigo',
    swatch: ['#121316', '#21242d', '#7c83ff'],
    lightSwatch: ['#f7f8fb', '#e6eaf1', '#4c54e0']
  },
  {
    id: 'midnight-violet',
    name: 'Midnight Violet',
    swatch: ['#0f0e16', '#1e1c2b', '#a78bfa'],
    lightSwatch: ['#f9f8fc', '#ebe5f3', '#7c5cf0']
  },
  {
    id: 'slate-teal',
    name: 'Slate Teal',
    swatch: ['#0f1414', '#1e2726', '#2dd4bf'],
    lightSwatch: ['#f5f8f8', '#e3ebea', '#0f9e88']
  },
  {
    id: 'charcoal-amber',
    name: 'Charcoal Amber',
    swatch: ['#131211', '#242220', '#e3a857'],
    lightSwatch: ['#f8f6f2', '#eae5db', '#c2880f']
  },
  {
    id: 'arctic-sky',
    name: 'Arctic Sky',
    swatch: ['#0f1318', '#1d242e', '#4f9cf5'],
    lightSwatch: ['#f6f8fb', '#e6ebf2', '#2f7fd6']
  },
  {
    id: 'rose-noir',
    name: 'Rose Noir',
    swatch: ['#151113', '#261f23', '#ec6a93'],
    lightSwatch: ['#faf6f7', '#ece2e6', '#c84d76']
  },
  {
    id: 'evergreen',
    name: 'Evergreen',
    swatch: ['#0f1411', '#1d2620', '#34d27f'],
    lightSwatch: ['#f5f8f5', '#e3ebe4', '#1e9e5e']
  },
  {
    id: 'ruby-ember',
    name: 'Ruby Ember',
    swatch: ['#141110', '#25201f', '#e85c6b'],
    lightSwatch: ['#f9f6f5', '#eae2e0', '#cc3f50']
  },
  {
    id: 'ocean-cyan',
    name: 'Ocean Cyan',
    swatch: ['#0d1417', '#1a262b', '#25c4dd'],
    lightSwatch: ['#f4f8f9', '#e0ebed', '#0e9fb8']
  },
  {
    id: 'harbor',
    name: 'Harbor',
    swatch: ['#0e1822', '#1d2c3a', '#f9c24a'],
    lightSwatch: ['#ffffff', '#e9eef4', '#cf9417']
  },
  {
    id: 'dusk-copper',
    name: 'Dusk Copper',
    swatch: ['#14121a', '#27232f', '#d97c52'],
    lightSwatch: ['#f8f6fb', '#e9e2f0', '#b85e35']
  },
  {
    id: 'sage-stone',
    name: 'Sage Stone',
    swatch: ['#111412', '#20251f', '#8ac06a'],
    lightSwatch: ['#f5f7f4', '#e3e9df', '#4f9430']
  },
  {
    id: 'solar-dune',
    name: 'Solar Dune',
    swatch: ['#181411', '#2c2520', '#f5a742'],
    lightSwatch: ['#faf7f3', '#ede5d8', '#c97f14']
  },
  {
    id: 'github',
    name: 'GitHub',
    swatch: ['#0d1117', '#1c2330', '#58a6ff'],
    lightSwatch: ['#ffffff', '#eef1f4', '#0969da']
  },
  {
    id: 'codex',
    name: 'Codex',
    swatch: ['#101113', '#1f2124', '#12b886'],
    lightSwatch: ['#f7f8f8', '#e6e9e9', '#0e9670']
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    swatch: ['#11111b', '#1e1e2e', '#cba6f7'],
    lightSwatch: ['#eff1f5', '#dce0e8', '#8839ef']
  },
  {
    id: 'everforest',
    name: 'Everforest',
    swatch: ['#1e2326', '#2d3438', '#a7c080'],
    lightSwatch: ['#f8f5e4', '#e8e3c8', '#5f8a3c']
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    swatch: ['#1d2021', '#32302e', '#fabd2f'],
    lightSwatch: ['#fbf1c7', '#ebdbb2', '#b57614']
  },
  {
    id: 'linear',
    name: 'Linear',
    swatch: ['#0e0e12', '#1e1f27', '#5e6ad2'],
    lightSwatch: ['#fbfbfc', '#ebecf1', '#4550c8']
  },
  {
    id: 'notion',
    name: 'Notion',
    swatch: ['#191919', '#2a2a2a', '#2383e2'],
    lightSwatch: ['#ffffff', '#efeeec', '#1a6fc4']
  },
  {
    id: 'one',
    name: 'One',
    swatch: ['#21252b', '#2c313c', '#61afef'],
    lightSwatch: ['#fafafa', '#e5e5e6', '#4078f2']
  },
  {
    id: 'proof',
    name: 'Proof',
    swatch: ['#121315', '#212226', '#6c5ce7'],
    lightSwatch: ['#f8f8fa', '#e8e8ee', '#5340c9']
  },
  {
    id: 'raycast',
    name: 'Raycast',
    swatch: ['#131217', '#221f29', '#ff6363'],
    lightSwatch: ['#faf9fb', '#e9e6ee', '#d43f39']
  },
  {
    id: 'rose-pine',
    name: 'Rose Pine',
    swatch: ['#191724', '#26233a', '#ea9a97'],
    lightSwatch: ['#faf4ed', '#e9ded2', '#b4637a']
  },
  {
    id: 'solarized',
    name: 'Solarized',
    swatch: ['#002b36', '#0e434f', '#268bd2'],
    lightSwatch: ['#fdf6e3', '#eee8d5', '#268bd2']
  },
  {
    id: 'vercel',
    name: 'Vercel',
    swatch: ['#0a0a0a', '#1a1a1a', '#0070f3'],
    lightSwatch: ['#ffffff', '#f0f0f0', '#0761d1']
  },
  {
    id: 'vs-code-plus',
    name: 'VS Code Plus',
    swatch: ['#161616', '#252526', '#2599ff'],
    lightSwatch: ['#ffffff', '#eaeaea', '#0067c0']
  },
  {
    id: 'xcode',
    name: 'Xcode',
    swatch: ['#1e2128', '#2d323c', '#3574f0'],
    lightSwatch: ['#ffffff', '#eef0f4', '#1f5bd6']
  },
  {
    id: 'absolutely',
    name: 'Absolutely',
    swatch: ['#141116', '#25202b', '#e0479e'],
    lightSwatch: ['#faf6fa', '#e9dfec', '#b5288a']
  }
]

/**
 * The palette applied when a config carries none. Its tokens live in bare `:root`
 * in global.css rather than under a `[data-palette]` block, which is why it is the
 * fallback rather than merely the first entry.
 */
export const DEFAULT_PALETTE = 'warm-rust'

// Applying a palette used to live here, as `applyPalette` — two lines that every
// renderer window had to run, gathered in one place so the `'warm-rust'` fallback was
// written once instead of five times. It has moved to lib/theme.ts, because those two
// lines are now the beginning of a longer answer (colour overrides, contrast, fonts,
// sizes) and splitting that answer across two modules is how the windows drift apart.
// This module is back to being what its name says: the registry, and the default.
