// The Settings screen's sections, as data.
//
// Apart from SettingsView.tsx because that view is lazy-loaded: the command palette
// lists one entry per section, and importing the list from the view would pull the whole
// screen into the main bundle.

export const SETTINGS_SECTIONS = [
  'appearance',
  'general',
  'connection',
  'system',
  'companion',
  'interventions',
  'ops',
  'about'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

/** The section's name, as shown in the Settings nav and the palette. */
export const settingsSectionLabel = (id: SettingsSectionId) => `settings.section.${id}` as const

/** A section name from a deep link or from storage, if it is one of ours. */
export function settingsSectionOf(name: string | null | undefined): SettingsSectionId | null {
  return (SETTINGS_SECTIONS as readonly string[]).includes(name ?? '') ? (name as SettingsSectionId) : null
}

const LAST_SECTION_KEY = 'argos.settings.section'

/** The section Settings was last on, so it reopens there instead of on Appearance. */
export function lastSettingsSection(): SettingsSectionId | null {
  try {
    return settingsSectionOf(localStorage.getItem(LAST_SECTION_KEY))
  } catch {
    return null
  }
}

export function rememberSettingsSection(id: SettingsSectionId): void {
  try {
    localStorage.setItem(LAST_SECTION_KEY, id)
  } catch {
    // Storage unavailable: Settings opens on its first section next time.
  }
}
