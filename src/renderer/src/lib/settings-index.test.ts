import { describe, it, expect } from 'vitest'
import { makeT } from '../../../shared/i18n'
import { SETTINGS_INDEX, foldText, searchSettings } from './settings-index'
import { SETTINGS_SECTIONS } from './settings-sections'

const pt = makeT('pt-PT')
const en = makeT('en')
const labels = (query: string, platform = 'win32', t = pt) => searchSettings(query, t, platform).map((h) => h.text)

describe('searchSettings', () => {
  it('finds nothing for an empty query', () => {
    expect(searchSettings('   ', pt, 'win32')).toEqual([])
  })

  it('ignores case and accents', () => {
    expect(labels('PREDEFINICAO')).toContain(pt('settings.appearance.preset.label'))
    expect(foldText('Predefinição')).toBe('predefinicao')
  })

  it('finds both global shortcuts first, each in its own section', () => {
    // Voice dictation mentions a shortcut in its explanation, so it is found too, but
    // after the two rows that are about one.
    const hits = searchSettings('atalho', pt, 'win32')
    expect(hits.slice(0, 2).map((h) => h.entry.section).sort()).toEqual(['companion', 'system'])
    expect(hits.slice(0, 2).every((h) => foldText(h.text).includes('atalho'))).toBe(true)
  })

  it('finds a row by the name of a control inside it', () => {
    // "Minimized" is a chip of the start-and-close row, not a row of its own.
    expect(labels('minimizado')).toEqual([pt('settings.system.startClose.label')])
  })

  it('puts label matches ahead of matches in the explanation', () => {
    const hits = labels('theme', 'win32', en)
    expect(hits.length).toBeGreaterThan(0)
    const firstElsewhere = hits.findIndex((text) => !foldText(text).includes('theme'))
    if (firstElsewhere >= 0) expect(hits.slice(firstElsewhere).every((text) => !foldText(text).includes('theme'))).toBe(true)
  })

  it('needs every word of the query', () => {
    expect(labels('pasta relatorios')).toEqual([pt('settings.interventions.reports')])
    expect(labels('pasta zebra')).toEqual([])
  })

  it('leaves out a row the platform does not have', () => {
    const explorer = pt('settings.system.explorerMenu.label')
    expect(labels('explorador', 'win32')).toContain(explorer)
    expect(labels('explorador', 'darwin')).not.toContain(explorer)
  })
})

describe('SETTINGS_INDEX', () => {
  it('names only sections that exist, and covers all of them', () => {
    const used = new Set(SETTINGS_INDEX.map((e) => e.section))
    expect([...used].sort()).toEqual([...SETTINGS_SECTIONS].sort())
  })

  it('has no two rows with the same label in one section', () => {
    const seen = new Set<string>()
    for (const e of SETTINGS_INDEX) {
      const id = `${e.section}:${e.label}`
      expect(seen.has(id), id).toBe(false)
      seen.add(id)
    }
  })
})
