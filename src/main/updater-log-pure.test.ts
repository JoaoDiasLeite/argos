import { describe, it, expect } from 'vitest'
import { formatLogLine } from './updater-log-pure'

describe('formatLogLine', () => {
  const at = new Date('2026-09-24T10:00:00.000Z')

  it('stamps a plain message with its time and level', () => {
    expect(formatLogLine('info', ['Checking for update'], at)).toBe(
      '2026-09-24T10:00:00.000Z [info] Checking for update\n'
    )
  })

  it('writes an error as its stack, indented under the first line', () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED')
    err.stack = 'Error: net::ERR_INTERNET_DISCONNECTED\n  at request (http.js:1:1)'
    expect(formatLogLine('error', [err], at)).toBe(
      '2026-09-24T10:00:00.000Z [error] Error: net::ERR_INTERNET_DISCONNECTED\n' +
        '      at request (http.js:1:1)\n'
    )
  })

  it('joins extra values, turning objects into JSON', () => {
    expect(formatLogLine('warn', ['feed', { version: '1.16.1' }], at)).toBe(
      '2026-09-24T10:00:00.000Z [warn] feed {"version":"1.16.1"}\n'
    )
  })

  it('survives a value JSON cannot encode', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(formatLogLine('debug', [loop], at)).toBe('2026-09-24T10:00:00.000Z [debug] [object Object]\n')
  })
})
