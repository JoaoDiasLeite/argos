import { describe, it, expect } from 'vitest'
import {
  LANGUAGES,
  format,
  isLanguage,
  localeOf,
  makeT,
  normalizeLanguage,
  plural,
  type MessageKey
} from './index'
import { en } from './en'
import { ptPT } from './pt-PT'

describe('format', () => {
  it('replaces every named placeholder', () => {
    expect(format('{a} and {b}, {a} again', { a: 'x', b: 2 })).toBe('x and 2, x again')
  })

  it('leaves a placeholder with no param as written', () => {
    expect(format('Hello {name}', {})).toBe('Hello {name}')
    expect(format('Hello {name}')).toBe('Hello {name}')
  })

  it('renders 0 and empty strings rather than dropping them', () => {
    expect(format('{n}|{s}|', { n: 0, s: '' })).toBe('0||')
  })
})

describe('makeT', () => {
  it('looks up and interpolates', () => {
    expect(makeT('en')('main.tray.quickLauncherWithShortcut', { shortcut: 'Alt+Space' })).toBe(
      'Quick launcher (Alt+Space)'
    )
    expect(makeT('pt-PT')('common.cancel')).toBe('Cancelar')
  })

  it('falls back to English for a key the dictionary lacks', () => {
    const key = 'common.cancel' as MessageKey
    const saved = ptPT[key]
    delete (ptPT as Record<string, string>)[key]
    try {
      expect(makeT('pt-PT')(key)).toBe('Cancel')
    } finally {
      ptPT[key] = saved
    }
  })

  it('falls back to the key itself when nobody has it', () => {
    expect(makeT('en')('nope.missing' as MessageKey)).toBe('nope.missing')
  })

  it('treats an unknown language as English', () => {
    expect(makeT('xx' as never)('common.cancel')).toBe('Cancel')
  })
})

describe('plural', () => {
  const t = makeT('en')

  it('picks one for 1 and other otherwise, with {n}', () => {
    expect(plural(t, 'settings.general.hooks.count', 1)).toBe('1 hook')
    expect(plural(t, 'settings.general.hooks.count', 0)).toBe('0 hooks')
    expect(plural(t, 'settings.general.hooks.count', 7)).toBe('7 hooks')
  })
})

describe('languages', () => {
  it('lists each language once with a native label', () => {
    expect(LANGUAGES.map((l) => l.id)).toEqual(['en', 'pt-PT'])
    expect(LANGUAGES.find((l) => l.id === 'pt-PT')?.label).toBe('Português (Portugal)')
  })

  it('normalizes anything unknown to English', () => {
    expect(isLanguage('pt-PT')).toBe(true)
    expect(isLanguage('pt')).toBe(false)
    expect(normalizeLanguage(undefined)).toBe('en')
    expect(normalizeLanguage('pt-PT')).toBe('pt-PT')
  })

  it('keeps the OS locale for English', () => {
    expect(localeOf('en')).toBeUndefined()
    expect(localeOf('pt-PT')).toBe('pt-PT')
  })
})

describe('dictionaries', () => {
  it('pt-PT has exactly the English keys', () => {
    expect(Object.keys(ptPT).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty translations', () => {
    for (const [key, value] of Object.entries(ptPT)) expect(value, key).not.toBe('')
  })

  it('keeps the same placeholders in every translation', () => {
    const names = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(names(ptPT[key]), key).toEqual(names(en[key]))
    }
  })

  it('pairs every plural .one with an .other', () => {
    for (const key of Object.keys(en)) {
      if (key.endsWith('.one')) expect(key.replace(/\.one$/, '.other') in en, key).toBe(true)
    }
  })
})
