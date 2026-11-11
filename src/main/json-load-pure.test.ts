import { describe, it, expect } from 'vitest'
import { classifyJsonRead, isPlainObject, staleCorruptCopies } from './json-load-pure'
import { isStrictlyInside } from './path-contain-pure'

const errno = (code: string): Error => Object.assign(new Error(code), { code })
const parse = (text: string) => () => JSON.parse(text)

describe('classifyJsonRead', () => {
  it('a missing file is missing, not corrupt', () => {
    expect(classifyJsonRead(() => { throw errno('ENOENT') }, isPlainObject)).toEqual({ kind: 'missing' })
  })

  it('a valid object is ok', () => {
    expect(classifyJsonRead(parse('{"a":1}'), isPlainObject)).toEqual({ kind: 'ok', value: { a: 1 } })
  })

  it('truncated JSON is corrupt', () => {
    expect(classifyJsonRead(parse('{"a":'), isPlainObject)).toEqual({ kind: 'corrupt' })
  })

  it('an array, a string or null where an object is expected is corrupt', () => {
    for (const text of ['[1]', '"x"', 'null', '3']) {
      expect(classifyJsonRead(parse(text), isPlainObject)).toEqual({ kind: 'corrupt' })
    }
  })

  it('a transient read error is unreadable, never corrupt', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const e = errno(code)
      expect(classifyJsonRead(() => { throw e }, isPlainObject)).toEqual({ kind: 'unreadable', error: e })
    }
  })

  it('accepts a custom shape check', () => {
    expect(classifyJsonRead(parse('[1]'), Array.isArray)).toEqual({ kind: 'ok', value: [1] })
    expect(classifyJsonRead(parse('{}'), Array.isArray)).toEqual({ kind: 'corrupt' })
  })
})

describe('staleCorruptCopies', () => {
  it('keeps the newest N and ignores unrelated names', () => {
    const names = ['config.json', 'config.json.corrupt-30', 'config.json.corrupt-5', 'config.json.corrupt-100', 'config.json.corrupt-7', 'other.json.corrupt-1', 'config.json.corrupt-x']
    expect(staleCorruptCopies(names, 'config.json', 3)).toEqual(['config.json.corrupt-5'])
    expect(staleCorruptCopies(names, 'config.json', 10)).toEqual([])
  })
})

describe('isStrictlyInside', () => {
  const win = process.platform === 'win32'
  const sep = win ? '\\' : '/'
  const root = win ? 'C:\\ud\\cc-accounts' : '/ud/cc-accounts'
  const j = (...p: string[]) => [root, ...p].join(sep)

  it('accepts a child', () => {
    expect(isStrictlyInside(root, j('acc_1'))).toBe(true)
    expect(isStrictlyInside(root, j('acc_1', 'sub'))).toBe(true)
  })

  it('rejects the root itself, siblings sharing a prefix, parents and escapes', () => {
    expect(isStrictlyInside(root, root)).toBe(false)
    expect(isStrictlyInside(root, root + '-evil')).toBe(false)
    expect(isStrictlyInside(root, j('..'))).toBe(false)
    expect(isStrictlyInside(root, j('acc_1', '..', '..', 'x'))).toBe(false)
    expect(isStrictlyInside(root, win ? 'C:\\Users' : '/home')).toBe(false)
    expect(isStrictlyInside(root, '')).toBe(false)
  })
})
