// The Appearance panel of the Settings screen.
//
// Two things about this file are load-bearing and easy to undo by accident.
//
// First: it holds no theme state. Every control patches the main process and re-reads
// the `ui` prop that comes back, because main is the one writer of the resolved
// `theme`/`palette` fields and it broadcasts to all four windows. A local copy here
// would be right until the OS flipped light/dark, or until another window wrote.
//
// Second: the preview is painted from computed values, not from CSS. The palette
// blocks in global.css are written as `:root[data-palette='x']` — scoped to the
// document root — so putting data-theme/data-palette on a nested <div> inherits
// nothing, and a preview built that way silently shows the ACTIVE theme's colours for
// both sides. Instead `paintFor` runs the same lib/color.ts ramps the engine runs, so
// the preview cannot disagree with what applying the theme will actually do.

import { ReactNode, useEffect, useRef, useState } from 'react'
import { ThemeSettings, ThemeSettingsPatch, UiPrefs, UiPrefsPatch } from '../types'
import { DEFAULT_PALETTE, PALETTES } from '../lib/palettes'
import { Rgb, accentRamp, parseHex, readableOn, surfaceRamp, textRamp } from '../lib/color'
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
 * derives the surfaces too — from these same functions — and the preview becomes
 * exactly what the app will paint. Contrast is a surface control only: it is not an
 * input to the text ramp here, because it is not one in the engine either.
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
  // No contrast here, deliberately: the engine keeps it off the text ramp, so passing it
  // would make the preview show typography the app will never paint.
  const text = textRamp(fgBase, theme)

  const accentBase = (side?.accent ? parseHex(side.accent) : null) ?? parseHex(swatchAccent) ?? bgBase
  const accent = accentRamp(accentBase, theme)

  return {
    bg0: ramp['--bg-0'],
    bg1: ramp['--bg-1'],
    bg2: engineDerives ? ramp['--bg-2'] : swatchBg2,
    border: ramp['--border'],
    text0: text['--text-0'],
    text1: text['--text-1'],
    text2: text['--text-2'],
    accent: accent['--accent'],
    onAccent: readableOn(accentBase)
  }
}

/**
 * The app, in miniature: a rail, a line of primary text, a muted second line, something
 * accent-filled and a label chip. One of these, for the theme being edited.
 */
function ThemePreview({ paint }: { paint: PreviewPaint }) {
  return (
    <div className="tp" style={{ background: paint.bg0, borderColor: paint.border }} aria-hidden="true">
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
      </div>
    </div>
  )
}

// ─── Small building blocks ───────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">{label}</span>
        {hint && <span className="help">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A quiet button that stays in its place at 45 % when there is nothing to reset. */
function ResetButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn-ghost small ap-reset" onClick={onClick} disabled={disabled}>
      Reset
    </button>
  )
}

/**
 * A range input with a filled part.
 *
 * The native track cannot be filled without a gradient, so the track and the fill are
 * two plain elements under a transparent input that supplies the thumb and the keyboard.
 */
function Slider({
  min,
  max,
  value,
  onChange,
  label
}: {
  min: number
  max: number
  value: number
  onChange: (next: number) => void
  label: string
}) {
  const p = (Math.min(max, Math.max(min, value)) - min) / (max - min)
  return (
    <span className="ap-slider" style={{ ['--p' as string]: p }}>
      <span className="ap-slider-track" />
      <span className="ap-slider-fill" />
      <input
        className="ap-range"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </span>
  )
}

/**
 * A colour that reads "default" until the user picks one.
 *
 * `''` is what clears it — mergeSide in ui-prefs-pure.ts treats an empty string and
 * undefined alike as "delete the override" — so default is a real state of the model,
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
        <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        <span className="ap-color-value">{custom ? value : 'default'}</span>
      </label>
      <ResetButton disabled={!custom} onClick={() => onChange('')} />
    </Row>
  )
}

/**
 * The preset picker.
 *
 * Custom rather than a `<select>` for one reason: each row carries the palette's three
 * colours, and a native option list cannot draw them. It is shaped like the select it
 * stands in for: a 4 px surface with the value and a chevron at the right.
 */
function PalettePicker({ side, value, onChange }: { side: Side; value: string; onChange: (id: string) => void }) {
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
        type="button"
        className="ap-preset-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Chip colours={chipOf(current)} />
        <span className="ap-preset-name">{current.name}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="ap-preset-menu" role="listbox">
          {PALETTES.map((palette) => (
            <button
              type="button"
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

const MODES: { id: 'system' | 'light' | 'dark'; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

export default function AppearanceSettings({ ui, onSetUi }: Props) {
  const uiFonts = availableFonts('ui')
  const monoFonts = availableFonts('mono')

  // Which side the rows below edit. It only chooses what is shown and written to; the
  // data is still `ui.light` / `ui.dark`, patched through main like everything else.
  // Starts on the theme that is showing now, since that is the one being looked at.
  const [editing, setEditing] = useState<Side>(ui.theme === 'light' ? 'light' : 'dark')

  const uiSlider = useSlider(ui.uiFontSize ?? UI_FONT_SIZE.default, (uiFontSize) => onSetUi({ uiFontSize }))
  const codeSlider = useSlider(ui.codeFontSize ?? CODE_FONT_SIZE.default, (codeFontSize) =>
    onSetUi({ codeFontSize })
  )

  const patchSide = (side: Side, patch: ThemeSettingsPatch): void =>
    onSetUi(side === 'light' ? { light: patch } : { dark: patch })

  // One per side, both always called: a hook cannot sit behind the choice of side, and a
  // drag in progress on one side must survive flipping the control to the other.
  const contrastSliders: Record<Side, ReturnType<typeof useSlider>> = {
    light: useSlider(ui.light?.contrast ?? 50, (contrast) => patchSide('light', { contrast })),
    dark: useSlider(ui.dark?.contrast ?? 50, (contrast) => patchSide('dark', { contrast }))
  }

  const side = editing
  const settings = side === 'light' ? ui.light : ui.dark
  const paint = paintFor(side, settings)
  const contrast = contrastSliders[side]
  const mode = ui.mode ?? ui.theme

  return (
    <div className="ap">
      <Row label="Mode" hint="Which theme the app shows.">
        <div className="seg-control" role="group" aria-label="Mode">
          {MODES.map(({ id, label }) => (
            <button type="button" key={id} className={mode === id ? 'on' : ''} onClick={() => onSetUi({ mode: id })} aria-pressed={mode === id}>
              {label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Theme being edited" hint="Each theme keeps its own preset, colours and contrast.">
        <div className="seg-control" role="group" aria-label="Theme being edited">
          {(['light', 'dark'] as Side[]).map((s) => (
            <button type="button" key={s} className={editing === s ? 'on' : ''} onClick={() => setEditing(s)} aria-pressed={editing === s}>
              {s === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </Row>

      <ThemePreview paint={paint} />

      <Row label="Preset" hint="A starting point; the rows below override it.">
        <PalettePicker side={side} value={settings?.palette || DEFAULT_PALETTE} onChange={(palette) => patchSide(side, { palette })} />
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
        <Slider min={0} max={100} value={contrast.shown} onChange={contrast.onChange} label={`${side} contrast`} />
        <span className="ap-number">{contrast.shown}</span>
        <ResetButton
          disabled={settings?.contrast === undefined}
          onClick={() => {
            contrast.clear()
            patchSide(side, { contrast: null })
          }}
        />
      </Row>

      <Row label="Translucent sidebar" hint="Blurs whatever is behind the chat list.">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={!!settings?.translucentSidebar}
            onChange={(e) => patchSide(side, { translucentSidebar: e.target.checked })}
            aria-label="Translucent sidebar"
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
        </label>
      </Row>

      <div className="eyebrow ap-eyebrow">Fonts</div>
      <Row label="UI font" hint="Menus, buttons, lists: the chrome.">
        <select className="text-input ap-select" value={ui.fonts?.ui || 'system'} onChange={(e) => onSetUi({ fonts: { ui: e.target.value } })}>
          {uiFonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Content font" hint="Chat messages and rendered markdown: the reading face.">
        <select className="text-input ap-select" value={ui.fonts?.content || 'inherit'} onChange={(e) => onSetUi({ fonts: { content: e.target.value } })}>
          <option value="inherit">Same as UI font</option>
          {uiFonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Code font" hint="Code blocks, diffs, the terminal.">
        <select className="text-input ap-select mono" value={ui.fonts?.code || 'system-mono'} onChange={(e) => onSetUi({ fonts: { code: e.target.value } })}>
          {monoFonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Row>

      <div className="eyebrow ap-eyebrow">Sizes</div>
      <Row label="UI font size" hint="Scales the whole interface, not just text. Expect the window to resize its contents as you drag.">
        <Slider min={UI_FONT_SIZE.min} max={UI_FONT_SIZE.max} value={uiSlider.shown} onChange={uiSlider.onChange} label="UI font size" />
        <span className="ap-number">{uiSlider.shown}px</span>
        <ResetButton
          disabled={uiSlider.shown === UI_FONT_SIZE.default}
          onClick={() => {
            uiSlider.clear()
            onSetUi({ uiFontSize: UI_FONT_SIZE.default })
          }}
        />
      </Row>
      <Row label="Code font size" hint="Code blocks, diffs and tool output only.">
        <Slider min={CODE_FONT_SIZE.min} max={CODE_FONT_SIZE.max} value={codeSlider.shown} onChange={codeSlider.onChange} label="Code font size" />
        <span className="ap-number">{codeSlider.shown}px</span>
        <ResetButton
          disabled={codeSlider.shown === CODE_FONT_SIZE.default}
          onClick={() => {
            codeSlider.clear()
            onSetUi({ codeFontSize: CODE_FONT_SIZE.default })
          }}
        />
      </Row>
    </div>
  )
}
