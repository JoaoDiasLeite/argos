import { describe, it, expect } from 'vitest'
import { applyUiPatch, migrateUiPrefs, resolveUiPrefs, UiPrefs } from './ui-prefs-pure'

// What is actually at stake here is other people's config files. Two rules matter more
// than everything else in this suite: a config written before this system must come out
// of migration meaning exactly what it meant going in, and `theme`/`palette` must always
// be the resolved truth on the way out, because thirty CSS blocks and four windows read
// nothing else.

/** Exactly the shape an older build wrote — no mode, no light, no dark, and the
    pre-workMode key for chat-vs-terminal. Cast because that key is no longer in the
    model: reading it is the migration's whole job. */
const LEGACY = {
  theme: 'dark',
  palette: 'gruvbox',
  density: 'compact',
  fontSize: 'lg',
  onboarded: true,
  defaultChatView: 'terminal'
} as unknown as UiPrefs

describe('migration', () => {
  it('reads an old dark config as mode dark with its palette on both sides', () => {
    const migrated = migrateUiPrefs(LEGACY)
    expect(migrated.mode).toBe('dark')
    expect(migrated.dark).toEqual({ palette: 'gruvbox' })
    // The light side gets the same palette rather than the default: the first thing a
    // user does in the new settings screen may well be to try light mode, and finding
    // Warm Rust there instead of their own Gruvbox reads as having lost the setting.
    expect(migrated.light).toEqual({ palette: 'gruvbox' })
  })

  it('reads an old light config as mode light', () => {
    expect(migrateUiPrefs({ ...LEGACY, theme: 'light' }).mode).toBe('light')
  })

  it('changes nothing a legacy config already said', () => {
    const migrated = migrateUiPrefs(LEGACY)
    expect(migrated.theme).toBe(LEGACY.theme)
    expect(migrated.palette).toBe(LEGACY.palette)
    expect(migrated.density).toBe('compact')
    expect(migrated.fontSize).toBe('lg')
    expect(migrated.onboarded).toBe(true)
    expect(migrated.uiFontSize).toBeUndefined()
    expect(migrated.codeFontSize).toBeUndefined()
    expect(migrated.fonts).toBeUndefined()
  })

  it('carries a legacy defaultChatView over to workMode', () => {
    // A config that opened new chats in the terminal must come out of migration in
    // terminal mode — the setting is promoted, not reset.
    expect(migrateUiPrefs(LEGACY).workMode).toBe('terminal')
    expect(
      migrateUiPrefs({ ...LEGACY, defaultChatView: 'chat' } as unknown as UiPrefs).workMode
    ).toBe('chat')
  })

  it('defaults workMode to chat when neither key is present', () => {
    const { defaultChatView, ...noMode } = LEGACY as UiPrefs & { defaultChatView?: string }
    expect(migrateUiPrefs(noMode as UiPrefs).workMode).toBe('chat')
  })

  it('leaves an explicit workMode alone', () => {
    const current = { ...LEGACY, workMode: 'chat' } as unknown as UiPrefs
    expect(migrateUiPrefs(current).workMode).toBe('chat')
  })

  it('leaves an already-migrated config alone', () => {
    // Fully migrated means workMode is already there too — LEGACY still carries the old
    // key, so spell the new one out rather than letting migration add it.
    const current: UiPrefs = {
      ...LEGACY,
      workMode: 'terminal',
      mode: 'system',
      light: { palette: 'notion', accent: '#112233' },
      dark: { palette: 'vercel' }
    }
    expect(migrateUiPrefs(current)).toEqual(current)
  })

  it('repairs a mode that is not one of the three', () => {
    // A hand-edited config, or one written by a future version and opened by an older
    // one. An unrecognised mode must not leave resolution guessing.
    const broken = { ...LEGACY, mode: 'auto' } as unknown as UiPrefs
    expect(migrateUiPrefs(broken).mode).toBe('dark')
  })
})

describe('resolution', () => {
  const migrated = (): UiPrefs =>
    migrateUiPrefs({ ...LEGACY, light: { palette: 'notion' }, dark: { palette: 'vercel' } })

  it('takes theme and palette from the side the mode names', () => {
    const dark = resolveUiPrefs({ ...migrated(), mode: 'dark' }, false)
    expect(dark.theme).toBe('dark')
    expect(dark.palette).toBe('vercel')

    const light = resolveUiPrefs({ ...migrated(), mode: 'light' }, true)
    expect(light.theme).toBe('light')
    expect(light.palette).toBe('notion')
  })

  it('asks the OS only for mode system', () => {
    const ui = { ...migrated(), mode: 'system' as const }
    expect(resolveUiPrefs(ui, true).theme).toBe('dark')
    expect(resolveUiPrefs(ui, true).palette).toBe('vercel')
    expect(resolveUiPrefs(ui, false).theme).toBe('light')
    expect(resolveUiPrefs(ui, false).palette).toBe('notion')
    // An explicit mode ignores the OS entirely — that is the point of choosing one.
    expect(resolveUiPrefs({ ...ui, mode: 'light' }, true).theme).toBe('light')
  })

  it('keeps the existing palette when the chosen side has none', () => {
    const ui: UiPrefs = { ...LEGACY, mode: 'light', light: undefined, dark: undefined }
    expect(resolveUiPrefs(ui, false).palette).toBe('gruvbox')
  })

  it('is idempotent', () => {
    const once = resolveUiPrefs(migrated(), false)
    expect(resolveUiPrefs(once, false)).toEqual(once)
  })
})

describe('patching', () => {
  it('deep-merges a side instead of replacing it', () => {
    // The bug this is here for: `{ dark: { accent: '#ffffff' } }` arriving as a plain
    // spread wipes dark.palette, and the app silently falls back to the default palette.
    const start = applyUiPatch(LEGACY, {}, false)
    const next = applyUiPatch(start, { dark: { accent: '#ffffff' } }, false)
    expect(next.dark).toEqual({ palette: 'gruvbox', accent: '#ffffff' })
    expect(next.palette).toBe('gruvbox')
  })

  it('touches only the side the patch names', () => {
    const start = applyUiPatch(LEGACY, {}, false)
    const next = applyUiPatch(start, { light: { background: '#ffffff' } }, false)
    expect(next.light).toEqual({ palette: 'gruvbox', background: '#ffffff' })
    expect(next.dark).toEqual({ palette: 'gruvbox' })
  })

  it('rejects a malformed colour rather than storing it', () => {
    // These end up in a CSS custom property and are parsed back out to derive a ramp.
    // Storing one means a broken theme that survives every restart.
    const start = applyUiPatch(LEGACY, { dark: { accent: '#abcdef' } }, false)
    for (const bad of ['red', 'rgb(0,0,0)', '#ff', '#12345g', 'var(--accent)']) {
      const next = applyUiPatch(start, { dark: { accent: bad } }, false)
      expect(next.dark?.accent, `accent '${bad}' should have been rejected`).toBe('#abcdef')
    }
  })

  it('accepts and normalises a well-formed colour', () => {
    const next = applyUiPatch(LEGACY, { dark: { accent: '#ABCDEF' } }, false)
    expect(next.dark?.accent).toBe('#abcdef')
    expect(applyUiPatch(LEGACY, { dark: { accent: '#abc' } }, false).dark?.accent).toBe('#abc')
  })

  it('clears an override when the patch sets it to undefined or empty', () => {
    const start = applyUiPatch(LEGACY, { dark: { accent: '#abcdef' } }, false)
    expect(applyUiPatch(start, { dark: { accent: '' } }, false).dark?.accent).toBeUndefined()
    expect(
      applyUiPatch(start, { dark: { accent: undefined } }, false).dark
    ).toEqual({ palette: 'gruvbox' })
  })

  it('clears an override when the patch sets it to null', () => {
    // The form "clear" actually takes on the wire. A settings screen sends its reset
    // buttons across IPC, where a key whose value is `undefined` relies on the
    // serializer keeping the key at all — so null is the signal that carries the
    // intent instead of leaving it to be inferred from `'contrast' in patch`.
    const start = applyUiPatch(
      LEGACY,
      { dark: { accent: '#abcdef', background: '#101010', contrast: 80, translucentSidebar: true } },
      false
    )
    expect(start.dark).toEqual({
      palette: 'gruvbox',
      accent: '#abcdef',
      background: '#101010',
      contrast: 80,
      translucentSidebar: true
    })
    const cleared = applyUiPatch(
      start,
      { dark: { accent: null, background: null, contrast: null, translucentSidebar: null } },
      false
    )
    expect(cleared.dark).toEqual({ palette: 'gruvbox' })
  })

  it('clamps the numeric fields', () => {
    expect(applyUiPatch(LEGACY, { uiFontSize: 99 }, false).uiFontSize).toBe(20)
    expect(applyUiPatch(LEGACY, { uiFontSize: 2 }, false).uiFontSize).toBe(11)
    expect(applyUiPatch(LEGACY, { uiFontSize: 15.6 }, false).uiFontSize).toBe(16)
    expect(applyUiPatch(LEGACY, { codeFontSize: 0 }, false).codeFontSize).toBe(10)
    expect(applyUiPatch(LEGACY, { codeFontSize: 40 }, false).codeFontSize).toBe(18)
    expect(applyUiPatch(LEGACY, { dark: { contrast: 1000 } }, false).dark?.contrast).toBe(100)
    expect(applyUiPatch(LEGACY, { dark: { contrast: -5 } }, false).dark?.contrast).toBe(0)
    // NaN and friends arrive from a number input mid-edit; they clear rather than store.
    expect(applyUiPatch(LEGACY, { uiFontSize: NaN }, false).uiFontSize).toBeUndefined()
  })

  it('always recomputes theme and palette', () => {
    // The contract on those two fields. A patch that changes the showing side's palette
    // has to move `palette` with it, or every window keeps painting the old one.
    const start = applyUiPatch({ ...LEGACY, theme: 'light' }, {}, false)
    expect(start.theme).toBe('light')
    const next = applyUiPatch(start, { light: { palette: 'notion' } }, false)
    expect(next.palette).toBe('notion')
    expect(next.dark?.palette).toBe('gruvbox')
  })

  it('follows the OS when the patch turns on system mode', () => {
    const light = applyUiPatch(LEGACY, { mode: 'system' }, false)
    expect(light.theme).toBe('light')
    const dark = applyUiPatch(LEGACY, { mode: 'system' }, true)
    expect(dark.theme).toBe('dark')
  })

  it('reads a legacy theme patch as a mode patch', () => {
    // The settings screen that shipped before this system patches `theme` and `palette`
    // directly. Since resolution runs last and would put both straight back, those
    // patches have to be translated or the old UI silently stops working.
    const next = applyUiPatch(LEGACY, { theme: 'light' }, false)
    expect(next.mode).toBe('light')
    expect(next.theme).toBe('light')
  })

  it('reads a legacy palette patch as the showing side palette', () => {
    const next = applyUiPatch(LEGACY, { palette: 'notion' }, false)
    expect(next.palette).toBe('notion')
    expect(next.dark?.palette).toBe('notion')
    // The other side is not dragged along — they are separate choices now.
    expect(next.light?.palette).toBe('gruvbox')
  })

  it('lands a combined legacy patch on the side it switched to', () => {
    const next = applyUiPatch(LEGACY, { theme: 'light', palette: 'notion' }, false)
    expect(next.theme).toBe('light')
    expect(next.palette).toBe('notion')
    expect(next.light?.palette).toBe('notion')
    expect(next.dark?.palette).toBe('gruvbox')
  })

  it('leaves an untouched preset with no override fields at all', () => {
    // "All fields optional so an untouched preset stays a preset": if a no-op patch
    // seeded contrast: 50 or accent: <the palette's own>, every config would carry a
    // full set of overrides and the palettes would stop being able to change anything.
    const next = applyUiPatch(LEGACY, { density: 'comfortable' }, false)
    expect(next.dark).toEqual({ palette: 'gruvbox' })
    expect(next.light).toEqual({ palette: 'gruvbox' })
    expect(next.fonts).toBeUndefined()
    expect(next.uiFontSize).toBeUndefined()
    expect(next.codeFontSize).toBeUndefined()
  })

  it('merges and trims the font ids', () => {
    const start = applyUiPatch(LEGACY, { fonts: { ui: 'inter' } }, false)
    const next = applyUiPatch(start, { fonts: { code: '  consolas  ' } }, false)
    expect(next.fonts).toEqual({ ui: 'inter', code: 'consolas' })
    // An empty string is a cleared picker, not a family named ''.
    expect(applyUiPatch(next, { fonts: { ui: '' } }, false).fonts).toEqual({ code: 'consolas' })
  })
})
