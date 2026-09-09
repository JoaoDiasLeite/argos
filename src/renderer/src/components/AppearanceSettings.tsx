// The Appearance panel of the Settings screen.
//
// Two things about this file are load-bearing and easy to undo by accident.
//
// First: it holds no theme state. Every control patches the main process and re-reads
// the `ui` prop that comes back, because main is the one writer of the resolved
// `theme`/`palette` fields and it broadcasts to all four windows. A local copy here
// would be right until the OS flipped light/dark, or until another window wrote.
//
// Second: the previews are painted from computed values, not from CSS. The palette
// blocks in global.css are written as `:root[data-palette='x']` — scoped to the
// document root — so putting data-theme/data-palette on a nested <div> inherits
// nothing, and a preview built that way silently shows the ACTIVE theme's colours for
// both sides. Instead `paintFor` runs the same lib/color.ts ramps the engine runs, so
// the preview cannot disagree with what applying the theme will actually do.

import { ReactNode, useEffect, useRef, useState } from 'react'
import { ThemeSettings, ThemeSettingsPatch, UiPrefs, UiPrefsPatch } from '../types'
import { DEFAULT_PALETTE, PALETTES } from '../lib/palettes'
import {
  Rgb,
  accentRamp,
  darken,
  lighten,
  mix,
  parseHex,
  readableOn,
  surfaceRamp,
  textRamp,
  toHex
} from '../lib/color'
import { availableFonts } from '../lib/fonts'
import './AppearanceSettings.css'

/**
 * The clamps, mirrored.
 *
 * UI_FONT_SIZE_MIN/MAX/DEFAULT and CODE_FONT_SIZE_* are exported by
 * src/main/ui-prefs-pure.ts, which is the authority — it clamps whatever this screen
 * sends. The renderer has its own tsconfig and cannot import from src/main, the same
 * seam that makes UiPrefs itself a second declaration in types.ts and UI_FONT_SIZE_BASE
 * a second constant in lib/theme.ts. Widen a range there and it has to be widened here
 * too, or the slider stops at the old edge and the reason is invisible.
 */
const UI_FONT_SIZE = { min: 11, max: 20, default: 14 }
const CODE_FONT_SIZE = { min: 10, max: 18, default: 13 }

type Side = 'light' | 'dark'

/**
 * A slider's value while it is being dragged, and the one write it makes at the end.
 *
 * This is the single, deliberate exception to "this panel holds no theme state", and
 * it lasts exactly as long as a drag. `onChange` on a range input fires per step, so
 * sending each step straight through means a config.json write plus a broadcast to
 * four windows for every pixel of travel — and the UI-size slider re-zooms the whole
 * window on each one. The pending value therefore lives here and the write is
 * debounced; `pending` is held until the prop comes back carrying it, rather than
 * cleared on commit, so the number does not flicker back to the old value during the
 * IPC round trip. `clear` is for the Reset button, whose new value arrives from
 * somewhere other than the slider.
 */
function useSlider(
  value: number,
  commit: (next: number) => void,
  delay = 120
): { shown: number; onChange: (next: number) => void; clear: () => void } {
  const [pending, setPending] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (pending !== null && value === pending) setPending(null)
  }, [value, pending])

  return {
    shown: pending ?? value,
    onChange: (next: number) => {
      setPending(next)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => commitRef.current(next), delay)
    },
    clear: () => {
      clearTimeout(timer.current)
      setPending(null)
    }
  }
}

interface Props {
  ui: UiPrefs
  onSetUi: (patch: UiPrefsPatch) => void
}

// ─── Preview painting ────────────────────────────────────────────────────────

/** The tints for the two diff lines in the code sample. */
const DIFF_ADD: Rgb = { r: 74, g: 172, b: 112 }
const DIFF_DEL: Rgb = { r: 214, g: 88, b: 88 }

/** Every colour one preview needs. Computed, never inherited — see the header. */
interface PreviewPaint {
  bg0: string
  bg1: string
  bg2: string
  border: string
  text0: string
  text1: string
  text2: string
  accent: string
  onAccent: string
  addBg: string
  addText: string
  delBg: string
  delText: string
}

const FALLBACK_BG: Rgb = { r: 20, g: 19, b: 18 }

/**
 * What this side of the model would look like, worked out with the engine's own maths.
 *
 * Where it is exact and where it is close, because the difference is worth knowing:
 * `PALETTES` carries three values per side (--bg-0, --bg-2, --accent), so a preset the
 * user has not customised shows its real background, real second surface and real
 * accent, while --bg-1/--border/--text-* are derived from --bg-0 the way surfaceRamp
 * derives them. The moment the user sets a background or moves contrast, the engine
 * derives the whole ramp too — from these same functions — and the preview becomes
 * exactly what the app will paint.
 */
function paintFor(theme: Side, side: ThemeSettings | undefined): PreviewPaint {
  const palette = PALETTES.find((p) => p.id === (side?.palette || DEFAULT_PALETTE)) ?? PALETTES[0]
  const [swatchBg0, swatchBg2, swatchAccent] = theme === 'dark' ? palette.swatch : palette.lightSwatch

  const bgOverride = side?.background ? parseHex(side.background) : null
  const bgBase = bgOverride ?? parseHex(swatchBg0) ?? FALLBACK_BG
  const ramp = surfaceRamp(bgBase, theme, side?.contrast)
  // planTheme only writes a derived ramp when there is a background override or contrast
  // has moved off its midpoint; until then the palette's own CSS block wins, and --bg-2
  // is the one step of it this module can see as a value.
  const engineDerives = !!bgOverride || side?.contrast !== undefined

  // The palette's own --text-0 is not in the registry, so an untouched preset's ink is
  // the better of the two standard inks on its background — which is what every one of
  // those CSS blocks picked by hand anyway.
  const fgBase = (side?.foreground ? parseHex(side.foreground) : null) ?? parseHex(readableOn(bgBase))!
  const text = textRamp(fgBase, theme, side?.contrast)

  const accentBase = (side?.accent ? parseHex(side.accent) : null) ?? parseHex(swatchAccent) ?? bgBase
  const accent = accentRamp(accentBase, theme)

  const surface = parseHex(ramp['--bg-1']) ?? bgBase
  const tint = (colour: Rgb): string => toHex(mix(surface, colour, theme === 'dark' ? 0.22 : 0.16))
  const ink = (colour: Rgb): string => toHex(theme === 'dark' ? lighten(colour, 0.3) : darken(colour, 0.2))

  return {
    bg0: ramp['--bg-0'],
    bg1: ramp['--bg-1'],
    bg2: engineDerives ? ramp['--bg-2'] : swatchBg2,
    border: ramp['--border'],
    text0: text['--text-0'],
    text1: text['--text-1'],
    text2: text['--text-2'],
    accent: accent['--accent'],
    onAccent: readableOn(accentBase),
    addBg: tint(DIFF_ADD),
    addText: ink(DIFF_ADD),
    delBg: tint(DIFF_DEL),
    delText: ink(DIFF_DEL)
  }
}

/**
 * The app, in miniature. Deliberately shows the things a theme is judged on: chrome, a
 * line of primary text, a muted second line, something accent-filled, and a diff with
 * one line added and one removed.
 */
function ThemePreview({ paint }: { paint: PreviewPaint }) {
  return (
    <div className="tp" style={{ background: paint.bg0, borderColor: paint.border }} aria-hidden="true">
      <div className="tp-chrome" style={{ background: paint.bg2, borderColor: paint.border }}>
        <span className="tp-dot" style={{ background: paint.text2 }} />
        <span className="tp-dot" style={{ background: paint.text2 }} />
        <span className="tp-dot" style={{ background: paint.accent }} />
      </div>
      <div className="tp-body">
        <div className="tp-rail" style={{ background: paint.bg1, borderColor: paint.border }}>
          <span className="tp-rail-item" style={{ background: paint.accent }} />
          <span className="tp-rail-item" style={{ background: paint.text2 }} />
          <span className="tp-rail-item" style={{ background: paint.text2 }} />
        </div>
        <div className="tp-main">
          <div className="tp-text" style={{ color: paint.text0 }}>
            The quick brown fox
          </div>
          <div className="tp-muted" style={{ color: paint.text1 }}>
            Secondary text, one step back
          </div>
          <div className="tp-actions">
            <span className="tp-btn" style={{ background: paint.accent, color: paint.onAccent }}>
              Run
            </span>
            <span className="tp-chip" style={{ background: paint.bg2, color: paint.text2, borderColor: paint.border }}>
              opus
            </span>
          </div>
          <div className="tp-code" style={{ background: paint.bg1, borderColor: paint.border }}>
            {/* Braces and backticks go through as expressions, not JSX text: written
                inline they either close the element or silently double the `$`. */}
            <div className="tp-code-line" style={{ color: paint.text2 }}>
              {'function greet(name) {'}
            </div>
            <div className="tp-code-line" style={{ background: paint.delBg, color: paint.delText }}>
              {"- return 'hi ' + name"}
            </div>
            <div className="tp-code-line" style={{ background: paint.addBg, color: paint.addText }}>
              {'+ return `hello ${name}`'}
            </div>
            <div className="tp-code-line" style={{ color: paint.text2 }}>
              {'}'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Small building blocks ───────────────────────────────────────────────────

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="ap-row">
      <div className="ap-row-text">
        <span className="ap-row-label">{label}</span>
        {hint && <span className="ap-row-hint">{hint}</span>}
      </div>
      <div className="ap-row-control">{children}</div>
    </div>
  )
}

/**
 * A colour that reads "Default" until the user picks one.
 *
 * `''` is what clears it — mergeSide in ui-prefs-pure.ts treats an empty string and
 * undefined alike as "delete the override" — so Default is a real state of the model,
 * not a sentinel this component invented.
 */
function ColorRow({
  label,
  hint,
  value,
  fallback,
  onChange
}: {
  label: string
  hint: string
  value: string | undefined
  fallback: string
  onChange: (next: string) => void
}) {
  const custom = !!value
  return (
    <Row label={label} hint={hint}>
      <label className="ap-color">
        <input
          type="color"
          value={value || fallback}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <span className="ap-color-value">{custom ? value : 'Default'}</span>
      </label>
      <button className="btn-text" onClick={() => onChange('')} disabled={!custom}>
        Reset
      </button>
    </Row>
  )
}

/**
 * The preset picker.
 *
 * Custom rather than a `<select>` for one reason: each row carries the palette's three
 * colours, and a native option list cannot draw them. Everything else about it is the
 * boring version — a button, a list, close on outside click or Escape.
 */
function PalettePicker({
  side,
  value,
  onChange
}: {
  side: Side
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const chipOf = (palette: (typeof PALETTES)[number]): readonly [string, string, string] =>
    side === 'dark' ? palette.swatch : palette.lightSwatch

  const current = PALETTES.find((p) => p.id === value) ?? PALETTES[0]

  return (
    <div className="ap-preset" ref={wrap}>
      <button
        className="ap-preset-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Chip colours={chipOf(current)} />
        <span className="ap-preset-name">{current.name}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="ap-preset-menu" role="listbox">
          {PALETTES.map((palette) => (
            <button
              key={palette.id}
              className={`ap-preset-item ${palette.id === value ? 'on' : ''}`}
              role="option"
              aria-selected={palette.id === value}
              onClick={() => {
                onChange(palette.id)
                setOpen(false)
              }}
            >
              <Chip colours={chipOf(palette)} />
              <span>{palette.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ colours }: { colours: readonly [string, string, string] }) {
  return (
    <span className="ap-chip">
      {colours.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  )
}

// ─── The panel ───────────────────────────────────────────────────────────────

const MODES: { id: 'system' | 'light' | 'dark'; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow Windows' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' }
]

/** The mock inside a mode card, painted in what that choice would actually look like. */
function ModeMock({ paint }: { paint: PreviewPaint }) {
  return (
    <div className="ap-mock" style={{ background: paint.bg0, borderColor: paint.border }}>
      <div className="ap-mock-rail" style={{ background: paint.bg1, borderColor: paint.border }} />
      <div className="ap-mock-main">
        <span style={{ background: paint.text1 }} />
        <span style={{ background: paint.text2, width: '70%' }} />
        <span className="ap-mock-accent" style={{ background: paint.accent }} />
      </div>
    </div>
  )
}

export default function AppearanceSettings({ ui, onSetUi }: Props) {
  const uiFonts = availableFonts('ui')
  const monoFonts = availableFonts('mono')

  const lightPaint = paintFor('light', ui.light)
  const darkPaint = paintFor('dark', ui.dark)
  const paintOf = (side: Side): PreviewPaint => (side === 'light' ? lightPaint : darkPaint)

  const uiSlider = useSlider(ui.uiFontSize ?? UI_FONT_SIZE.default, (uiFontSize) =>
    onSetUi({ uiFontSize })
  )
  const codeSlider = useSlider(ui.codeFontSize ?? CODE_FONT_SIZE.default, (codeFontSize) =>
    onSetUi({ codeFontSize })
  )

  const patchSide = (side: Side, patch: ThemeSettingsPatch): void =>
    onSetUi(side === 'light' ? { light: patch } : { dark: patch })

  // One per side, declared here rather than inside themeBlock: that function runs once
  // per side, and a hook called from it would be a hook called in a loop.
  const contrastSliders: Record<Side, ReturnType<typeof useSlider>> = {
    light: useSlider(ui.light?.contrast ?? 50, (contrast) => patchSide('light', { contrast })),
    dark: useSlider(ui.dark?.contrast ?? 50, (contrast) => patchSide('dark', { contrast }))
  }

  const themeBlock = (side: Side) => {
    const settings = side === 'light' ? ui.light : ui.dark
    const paint = paintOf(side)
    const contrast = contrastSliders[side]
    return (
      <section className="ap-block" key={side}>
        <header className="ap-block-head">
          <h4>{side === 'light' ? 'Light theme' : 'Dark theme'}</h4>
          <p className="field-hint">
            {side === 'light'
              ? 'Used whenever the app is showing light — including when Mode follows the system.'
              : 'Used whenever the app is showing dark — including when Mode follows the system.'}
          </p>
        </header>

        <ThemePreview paint={paint} />

        <div className="ap-rows">
          <Row label="Preset" hint="A starting point; the rows below override it.">
            <PalettePicker
              side={side}
              value={settings?.palette || DEFAULT_PALETTE}
              onChange={(palette) => patchSide(side, { palette })}
            />
          </Row>

          <ColorRow
            label="Accent"
            hint="Buttons, links, the active rail entry."
            value={settings?.accent}
            fallback={paint.accent}
            onChange={(accent) => patchSide(side, { accent })}
          />
          <ColorRow
            label="Background"
            hint="The deepest surface; every other surface is derived from it."
            value={settings?.background}
            fallback={paint.bg0}
            onChange={(background) => patchSide(side, { background })}
          />
          <ColorRow
            label="Foreground"
            hint="Primary text; the two muted steps are derived from it."
            value={settings?.foreground}
            fallback={paint.text0}
            onChange={(foreground) => patchSide(side, { foreground })}
          />

          <Row label="Contrast" hint="50 is the preset's own separation between surfaces.">
            <input
              className="ap-range"
              type="range"
              min={0}
              max={100}
              value={contrast.shown}
              onChange={(e) => contrast.onChange(Number(e.target.value))}
              aria-label={`${side} contrast`}
            />
            <span className="ap-number">{contrast.shown}</span>
            <button
              className="btn-text"
              onClick={() => {
                contrast.clear()
                patchSide(side, { contrast: null })
              }}
              disabled={settings?.contrast === undefined}
            >
              Reset
            </button>
          </Row>

          <Row label="Translucent sidebar" hint="Blurs whatever is behind the chat list.">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={!!settings?.translucentSidebar}
                onChange={(e) => patchSide(side, { translucentSidebar: e.target.checked })}
              />
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
            </label>
          </Row>
        </div>
      </section>
    )
  }

  return (
    <div className="ap">
      <section className="ap-group">
        <h3 className="settings-h">Mode</h3>
        <p className="field-hint">Which of the two themes below is showing.</p>
        <div className="ap-modes">
          {MODES.map(({ id, label, hint }) => (
            <button
              key={id}
              className={`ap-mode ${(ui.mode ?? ui.theme) === id ? 'on' : ''}`}
              onClick={() => onSetUi({ mode: id })}
              aria-pressed={(ui.mode ?? ui.theme) === id}
            >
              {/* System shows both, because that is literally what it means: whichever
                  one the OS is asking for at the time. */}
              {id === 'system' ? (
                <div className="ap-mock-pair">
                  <ModeMock paint={lightPaint} />
                  <ModeMock paint={darkPaint} />
                </div>
              ) : (
                <ModeMock paint={paintOf(id)} />
              )}
              <span className="ap-mode-label">{label}</span>
              <span className="ap-mode-hint">{hint}</span>
            </button>
          ))}
        </div>
      </section>

      {themeBlock('light')}
      {themeBlock('dark')}

      <section className="ap-group">
        <h3 className="settings-h">Fonts</h3>
        <p className="field-hint">
          Only families this machine can actually render are offered — a picker that let you
          choose a missing font would show it as chosen and render something else.
        </p>
        <div className="ap-rows">
          <Row label="UI font" hint="Menus, buttons, lists — the chrome.">
            <select
              className="text-input ap-select"
              value={ui.fonts?.ui || 'system'}
              onChange={(e) => onSetUi({ fonts: { ui: e.target.value } })}
            >
              {uiFonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Content font" hint="Chat messages and rendered markdown — the reading face.">
            <select
              className="text-input ap-select"
              value={ui.fonts?.content || 'inherit'}
              onChange={(e) => onSetUi({ fonts: { content: e.target.value } })}
            >
              <option value="inherit">Same as UI font</option>
              {uiFonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Code font" hint="Code blocks, diffs, the terminal.">
            <select
              className="text-input ap-select"
              value={ui.fonts?.code || 'system-mono'}
              onChange={(e) => onSetUi({ fonts: { code: e.target.value } })}
            >
              {monoFonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </section>

      <section className="ap-group">
        <h3 className="settings-h">Sizes</h3>
        <div className="ap-rows">
          <Row
            label="UI font size"
            hint="Scales the whole interface, not just text — expect the window to resize its contents as you drag."
          >
            <input
              className="ap-range"
              type="range"
              min={UI_FONT_SIZE.min}
              max={UI_FONT_SIZE.max}
              value={uiSlider.shown}
              onChange={(e) => uiSlider.onChange(Number(e.target.value))}
              aria-label="UI font size"
            />
            <span className="ap-number">{uiSlider.shown}px</span>
            <button
              className="btn-text"
              onClick={() => {
                uiSlider.clear()
                onSetUi({ uiFontSize: UI_FONT_SIZE.default })
              }}
              disabled={uiSlider.shown === UI_FONT_SIZE.default}
            >
              Reset
            </button>
          </Row>
          <Row label="Code font size" hint="Code blocks, diffs and tool output only.">
            <input
              className="ap-range"
              type="range"
              min={CODE_FONT_SIZE.min}
              max={CODE_FONT_SIZE.max}
              value={codeSlider.shown}
              onChange={(e) => codeSlider.onChange(Number(e.target.value))}
              aria-label="Code font size"
            />
            <span className="ap-number">{codeSlider.shown}px</span>
            <button
              className="btn-text"
              onClick={() => {
                codeSlider.clear()
                onSetUi({ codeFontSize: CODE_FONT_SIZE.default })
              }}
              disabled={codeSlider.shown === CODE_FONT_SIZE.default}
            >
              Reset
            </button>
          </Row>
        </div>
      </section>
    </div>
  )
}
