import { describe, it, expect } from 'vitest'
import { isTerminalReport } from './terminal-reports'

describe('isTerminalReport', () => {
  it('recognises what xterm sends on its own', () => {
    expect(isTerminalReport('\x1b[I')).toBe(true)
    expect(isTerminalReport('\x1b[<35;40;12M\x1b[<35;41;12M')).toBe(true)
    expect(isTerminalReport('\x1b[?1;2c')).toBe(true)
    expect(isTerminalReport('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toBe(true)
  })

  it('still counts typing as using the chat', () => {
    expect(isTerminalReport('a')).toBe(false)
    expect(isTerminalReport('\r')).toBe(false)
    expect(isTerminalReport('\x1b[A')).toBe(false)
    expect(isTerminalReport('\x1b[<35;40;12Mx')).toBe(false)
  })
})
