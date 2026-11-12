import { describe, expect, it } from 'vitest'
import { StatCache } from './transcript-cache-pure'

describe('StatCache', () => {
  it('hits only on the same mtime and size', () => {
    const c = new StatCache<string>(10)
    c.set('a', 1, 10, 'v')
    expect(c.get('a', 1, 10)).toBe('v')
    expect(c.get('a', 2, 10)).toBeUndefined()
    // the stale entry is gone after a mismatch
    expect(c.get('a', 1, 10)).toBeUndefined()
  })
  it('a rewrite replaces the entry', () => {
    const c = new StatCache<string>(10)
    c.set('a', 1, 10, 'old')
    c.set('a', 2, 12, 'new')
    expect(c.get('a', 2, 12)).toBe('new')
    expect(c.size).toBe(1)
  })
  it('evicts the least recently used past the bound', () => {
    const c = new StatCache<number>(2)
    c.set('a', 1, 1, 1)
    c.set('b', 1, 1, 2)
    c.get('a', 1, 1)
    c.set('c', 1, 1, 3)
    expect(c.size).toBe(2)
    expect(c.get('b', 1, 1)).toBeUndefined()
    expect(c.get('a', 1, 1)).toBe(1)
  })
  it('delete removes an entry', () => {
    const c = new StatCache<number>(2)
    c.set('a', 1, 1, 1)
    c.delete('a')
    expect(c.get('a', 1, 1)).toBeUndefined()
  })
})
