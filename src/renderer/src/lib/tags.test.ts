import { describe, it, expect } from 'vitest'
import { tagsSatisfy } from './tags'

describe('tagsSatisfy', () => {
  it('matches everything when no filter is active', () => {
    // So the caller can apply it unconditionally instead of branching on "is a
    // filter set" at every call site.
    expect(tagsSatisfy([], [], 'all')).toBe(true)
    expect(tagsSatisfy(['ui'], [], 'any')).toBe(true)
  })

  it('all requires every selected tag', () => {
    expect(tagsSatisfy(['ui', 'bug'], ['ui', 'bug'], 'all')).toBe(true)
    expect(tagsSatisfy(['ui', 'bug', 'perf'], ['ui', 'bug'], 'all')).toBe(true)
    expect(tagsSatisfy(['ui'], ['ui', 'bug'], 'all')).toBe(false)
  })

  it('any requires one', () => {
    expect(tagsSatisfy(['ui'], ['ui', 'bug'], 'any')).toBe(true)
    expect(tagsSatisfy(['perf'], ['ui', 'bug'], 'any')).toBe(false)
  })

  it('matches on exact names, case included', () => {
    // "UI" and "ui" are separate labels; the manager offers a merge for that.
    expect(tagsSatisfy(['UI'], ['ui'], 'any')).toBe(false)
  })

  it('handles a session with no tags', () => {
    expect(tagsSatisfy([], ['ui'], 'any')).toBe(false)
    expect(tagsSatisfy([], ['ui'], 'all')).toBe(false)
  })
})
