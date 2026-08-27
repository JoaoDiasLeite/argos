import { describe, it, expect } from 'vitest'
import {
  InvalidTagError,
  LABEL_PALETTE,
  MAX_TAGS,
  nextFreeColor,
  normalizeTags
} from './tags-pure'

describe('normalizeTags', () => {
  it('trims and drops empties', () => {
    expect(normalizeTags(['  ui  ', '', '   ', 'bug'])).toEqual(['ui', 'bug'])
  })

  it('dedupes', () => {
    // The regression this guards: with validation living in the IPC handler instead
    // of the write point, the rename path built its line by hand and wrote
    // ["ui","ui"] whenever a conversation already carried both names.
    expect(normalizeTags(['ui', 'ui', 'bug'])).toEqual(['ui', 'bug'])
  })

  it('keeps case distinct', () => {
    // Folding these together is a merge, and a merge is the user's decision.
    expect(normalizeTags(['UI', 'ui'])).toEqual(['UI', 'ui'])
  })

  it('accepts letters from any script, including accents', () => {
    expect(normalizeTags(['memória', 'ação', 'ção-2'])).toEqual(['memória', 'ação', 'ção-2'])
  })

  it('accepts digits, spaces, underscores and hyphens', () => {
    expect(normalizeTags(['v2 release', 'back_end', 'in-progress'])).toEqual([
      'v2 release',
      'back_end',
      'in-progress'
    ])
  })

  it('rejects characters that would make a tag unsafe to read back', () => {
    for (const bad of ['a,b', 'a"b', 'a/b', 'a\\b', 'a[b]', "a'b"]) {
      expect(() => normalizeTags([bad])).toThrow(InvalidTagError)
    }
  })

  it('rejects a tag over the length limit', () => {
    expect(() => normalizeTags(['x'.repeat(41)])).toThrow(InvalidTagError)
    expect(normalizeTags(['x'.repeat(40)])).toHaveLength(1)
  })

  it('rejects more tags than the limit', () => {
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)
    expect(() => normalizeTags(many)).toThrow(InvalidTagError)
  })

  it('rejects a non-array or a non-string member', () => {
    expect(() => normalizeTags('ui')).toThrow(InvalidTagError)
    expect(() => normalizeTags([1])).toThrow(InvalidTagError)
    expect(() => normalizeTags([null])).toThrow(InvalidTagError)
  })

  it('throws rather than silently repairing', () => {
    // Dropping the invalid half of a set would leave the user believing it saved.
    expect(() => normalizeTags(['ok', 'not,ok'])).toThrow(InvalidTagError)
  })
})

describe('nextFreeColor', () => {
  it('takes the first palette colour nobody is using', () => {
    expect(nextFreeColor([])).toBe(LABEL_PALETTE[0])
    expect(nextFreeColor([LABEL_PALETTE[0]])).toBe(LABEL_PALETTE[1])
  })

  it('ignores case when deciding what is taken', () => {
    expect(nextFreeColor([LABEL_PALETTE[0].toUpperCase()])).toBe(LABEL_PALETTE[1])
  })

  it('cycles deterministically once the palette is exhausted', () => {
    // Not "everything past the twelfth label is the same colour".
    const all = [...LABEL_PALETTE]
    expect(nextFreeColor(all)).toBe(LABEL_PALETTE[all.length % LABEL_PALETTE.length])
    expect(nextFreeColor([...all, 'x'])).toBe(LABEL_PALETTE[(all.length + 1) % LABEL_PALETTE.length])
  })
})
