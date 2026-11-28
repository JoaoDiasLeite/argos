// What the Settings search looks through: one entry per row, with the section it is in.
//
// An index rather than a scan of the screen, because only the open section is mounted
// (and Companion, System and Ops load their values when opened), so there is nothing to
// scan for the other four. Every key is a MessageKey, so a row whose label is renamed or
// removed fails the typecheck here instead of leaving a result that leads nowhere.
//
// A result does not show the control; picking it opens the section and scrolls to the
// row (SettingsView finds it by its label), which keeps every control in one place.

import type { MessageKey, TFunction } from '../../../shared/i18n'
import type { SettingsSectionId } from './settings-sections'

export interface SettingsEntry {
  section: SettingsSectionId
  /** The row's own label: what a result shows, and what the jump looks for on screen. */
  label: MessageKey
  /** More text that should find this row: its explanation, and the names of the
      controls it holds when it holds several (a chip, a second select). */
  also?: MessageKey[]
  /** A row that only exists on some platforms. */
  only?: 'windows'
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  { section: 'appearance', label: 'settings.appearance.mode.label', also: ['settings.appearance.mode.hint'] },
  { section: 'appearance', label: 'settings.general.density.label', also: ['settings.general.density.hint'] },
  { section: 'appearance', label: 'settings.appearance.preset.label', also: ['settings.appearance.preset.hint'] },
  {
    section: 'appearance',
    label: 'settings.appearance.colors.label',
    also: ['settings.appearance.accent.label', 'settings.appearance.background.label', 'settings.appearance.foreground.label']
  },
  { section: 'appearance', label: 'settings.appearance.contrast.label', also: ['settings.appearance.contrast.hint'] },
  { section: 'appearance', label: 'settings.appearance.translucent.label', also: ['settings.appearance.translucent.hint'] },
  {
    section: 'appearance',
    label: 'settings.appearance.fonts.title',
    also: ['settings.appearance.fonts.ui.label', 'settings.appearance.fonts.content.label', 'settings.appearance.fonts.code.label']
  },
  {
    section: 'appearance',
    label: 'settings.appearance.sizes.title',
    also: ['settings.appearance.sizes.ui.label', 'settings.appearance.sizes.code.label']
  },

  { section: 'general', label: 'settings.general.backgroundModel.label', also: ['settings.general.backgroundModel.hint'] },
  { section: 'general', label: 'settings.connection.accounts.label' },
  { section: 'general', label: 'settings.general.language.label', also: ['settings.general.language.hint'] },
  { section: 'general', label: 'settings.general.navRail.label', also: ['settings.general.navRail.eyebrow', 'settings.general.navRail.hint'] },
  { section: 'general', label: 'settings.general.startView.label', also: ['settings.general.startView.hint'] },
  { section: 'general', label: 'settings.general.weekPlanner.label', also: ['settings.general.weekPlanner.hint'] },
  { section: 'general', label: 'settings.general.permissions.label' },
  { section: 'general', label: 'settings.general.hooks.label' },
  { section: 'general', label: 'settings.general.notifications.label' },

  {
    section: 'system',
    label: 'settings.system.startClose.label',
    also: [
      'settings.system.startup.labelWindows',
      'settings.system.startup.label',
      'settings.system.minimized.label',
      'settings.system.closeToTray.label'
    ]
  },
  { section: 'system', label: 'settings.system.explorerMenu.label', also: ['settings.system.explorerMenu.hint'], only: 'windows' },
  { section: 'system', label: 'settings.system.shortcut.label', also: ['settings.system.shortcut.hint'] },
  { section: 'system', label: 'settings.connection.secrets.label' },
  { section: 'system', label: 'settings.transfer.label', also: ['settings.transfer.eyebrow', 'settings.transfer.hint'] },

  {
    section: 'companion',
    label: 'settings.companion.look.label',
    also: ['settings.companion.look.animal', 'settings.companion.size.label', 'settings.companion.character.hint']
  },
  { section: 'companion', label: 'settings.companion.stay.label', also: ['settings.companion.stay.hint'] },
  { section: 'companion', label: 'settings.companion.shortcut.label', also: ['settings.companion.shortcut.hint'] },
  {
    section: 'companion',
    label: 'settings.companion.alertWhen.label',
    also: ['settings.companion.alertWhen.chat', 'settings.companion.alertWhen.plan', 'settings.companion.group.alerts']
  },
  { section: 'companion', label: 'settings.companion.focusAssist.label', also: ['settings.companion.focusAssist.hint'] },
  {
    section: 'companion',
    label: 'settings.companion.times.label',
    also: ['settings.companion.leadTime.label', 'settings.companion.morning.label', 'settings.companion.group.reminders']
  },
  { section: 'companion', label: 'settings.companion.askModel.label', also: ['settings.companion.askModel.hint'] },
  { section: 'companion', label: 'settings.companion.capture.label', also: ['settings.companion.capture.hint'] },
  { section: 'companion', label: 'settings.companion.voice.label', also: ['settings.companion.voice.hint'] },
  { section: 'companion', label: 'settings.companion.obsidian.label', also: ['settings.companion.obsidian.hint'] },

  { section: 'ops', label: 'settings.interventions.runbooksDir', also: ['settings.interventions.runbooksDirHelp'] },
  { section: 'ops', label: 'settings.interventions.runbookFolders' },
  { section: 'ops', label: 'settings.interventions.reports' },
  { section: 'ops', label: 'settings.interventions.handovers' },
  { section: 'ops', label: 'settings.ops.folder.label', also: ['settings.ops.group.audit'] },
  { section: 'ops', label: 'settings.ops.verify.label', also: ['settings.ops.verify.hint', 'settings.ops.verify.week'] }
]

/** Case and accents out of the way: "predefinicao" finds "Predefinição". */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export interface SettingsHit {
  entry: SettingsEntry
  /** The row's label, translated. */
  text: string
}

/**
 * The rows a query finds, in index order with label matches ahead of the rest. Every
 * word of the query has to appear somewhere in the row's text.
 */
export function searchSettings(query: string, t: TFunction, platform: string, index = SETTINGS_INDEX): SettingsHit[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const inLabel: SettingsHit[] = []
  const elsewhere: SettingsHit[] = []
  for (const entry of index) {
    if (entry.only === 'windows' && platform !== 'win32') continue
    const text = t(entry.label)
    const label = foldText(text)
    const all = label + ' ' + (entry.also ?? []).map((k) => foldText(t(k))).join(' ')
    if (!words.every((w) => all.includes(w))) continue
    ;(words.every((w) => label.includes(w)) ? inLabel : elsewhere).push({ entry, text })
  }
  return [...inLabel, ...elsewhere]
}
