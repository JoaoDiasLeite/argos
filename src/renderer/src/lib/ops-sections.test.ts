import { describe, expect, it } from 'vitest'
import { splitSections } from './ops-sections'

describe('splitSections', () => {
  it('splits on == title == lines and trims each body', () => {
    expect(splitSections('== no ==\npve\n== uptime ==\n up 1 min\n')).toEqual([
      { title: 'no', body: 'pve' },
      { title: 'uptime', body: ' up 1 min' }
    ])
  })

  it('keeps text before the first marker as an untitled section', () => {
    expect(splitSections('hello\n== a ==\nx')).toEqual([
      { title: '', body: 'hello' },
      { title: 'a', body: 'x' }
    ])
  })

  it('keeps a titled section with no output', () => {
    expect(splitSections('== a ==\n== b ==\ny')).toEqual([
      { title: 'a', body: '' },
      { title: 'b', body: 'y' }
    ])
  })

  it('returns null when there is no marker', () => {
    expect(splitSections('just\noutput')).toBeNull()
    expect(splitSections('')).toBeNull()
  })

  it('does not treat a == inside a line as a marker', () => {
    expect(splitSections('a == b == c')).toBeNull()
  })

  it('handles CRLF', () => {
    expect(splitSections('== a ==\r\nx\r\n')).toEqual([{ title: 'a', body: 'x' }])
  })
})
