import { describe, it, expect } from 'vitest'
import { mergeById } from './merge-by-id'

type Item = { id: string; v?: number }
const key = (i: Item): string => i.id

describe('mergeById', () => {
  it('appends the missing items after the existing ones', () => {
    expect(mergeById<Item>([{ id: 'a' }], [{ id: 'b' }, { id: 'c' }], key)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })

  it('keeps an existing entry over an incoming one with the same id', () => {
    expect(mergeById<Item>([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }], key)).toEqual([{ id: 'a', v: 1 }])
  })

  it('returns the same array when nothing is new', () => {
    const current = [{ id: 'a' }]
    expect(mergeById<Item>(current, [{ id: 'a' }], key)).toBe(current)
    expect(mergeById<Item>(current, [], key)).toBe(current)
  })

  it('dedupes within the incoming list', () => {
    expect(mergeById<Item>([], [{ id: 'a', v: 1 }, { id: 'a', v: 2 }], key)).toEqual([{ id: 'a', v: 1 }])
  })
})
