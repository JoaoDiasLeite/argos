import { describe, it, expect } from 'vitest'
import { decodeOsc52 } from './osc52'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('decodeOsc52', () => {
  it('decodes the clipboard selection', () => {
    expect(decodeOsc52(`c;${b64('Interrupted')}`)).toBe('Interrupted')
  })

  it('keeps UTF-8 intact', () => {
    expect(decodeOsc52(`c;${b64('ação — café 🎉')}`)).toBe('ação — café 🎉')
  })

  it('accepts the other selection names, and an empty one', () => {
    expect(decodeOsc52(`p;${b64('primary')}`)).toBe('primary')
    expect(decodeOsc52(`;${b64('default')}`)).toBe('default')
  })

  it('refuses to answer a read', () => {
    expect(decodeOsc52('c;?')).toBeNull()
  })

  it('ignores a clear, a malformed payload and a missing separator', () => {
    expect(decodeOsc52('c;')).toBeNull()
    expect(decodeOsc52('c;not base64!!')).toBeNull()
    expect(decodeOsc52('c')).toBeNull()
  })
})
