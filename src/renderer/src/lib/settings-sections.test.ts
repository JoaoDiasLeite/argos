import { describe, it, expect } from 'vitest'
import { SETTINGS_SECTIONS, settingsSectionOf } from './settings-sections'

describe('settingsSectionOf', () => {
  it('accepts every current section', () => {
    for (const id of SETTINGS_SECTIONS) expect(settingsSectionOf(id)).toBe(id)
  })

  it('sends a section that was folded away to where its rows went', () => {
    // 'settings/companion' is the one deep link main emits today; the rest are what an
    // older build may have stored as the last section, or what a saved link still says.
    expect(settingsSectionOf('connection')).toBe('general')
    expect(settingsSectionOf('interventions')).toBe('ops')
    expect(settingsSectionOf('about')).toBe('general')
  })

  it('rejects anything else', () => {
    expect(settingsSectionOf('nope')).toBeNull()
    expect(settingsSectionOf('')).toBeNull()
    expect(settingsSectionOf(null)).toBeNull()
    // Not a section, and not a property lookup that happens to succeed either.
    expect(settingsSectionOf('constructor')).toBeNull()
  })
})
