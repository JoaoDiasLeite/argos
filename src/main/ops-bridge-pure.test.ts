import { describe, it, expect } from 'vitest'
import {
  bridgeEndpoint,
  createLineSplitter,
  encodeFrame,
  encodeReply,
  isOpsToken,
  OPS_BRIDGE_MAX_FRAME,
  parseReply,
  parseRequest
} from './ops-bridge-pure'

const TOKEN = '0123456789abcdef0123456789abcdef'

describe('isOpsToken', () => {
  it('takes 32 lowercase hex characters and nothing else', () => {
    expect(isOpsToken(TOKEN)).toBe(true)
    expect(isOpsToken(TOKEN.toUpperCase())).toBe(false)
    expect(isOpsToken(TOKEN.slice(1))).toBe(false)
    expect(isOpsToken(`${TOKEN}0`)).toBe(false)
    expect(isOpsToken(42)).toBe(false)
  })
})

describe('parseRequest', () => {
  it('accepts a hello and a call', () => {
    expect(parseRequest(JSON.stringify({ id: '1', token: TOKEN, kind: 'hello' }))).toEqual({
      ok: true,
      msg: { id: '1', token: TOKEN, kind: 'hello' }
    })
    expect(parseRequest(JSON.stringify({ id: '2', token: TOKEN, kind: 'call', tool: 'run', args: { hostId: 'h1' } }))).toEqual({
      ok: true,
      msg: { id: '2', token: TOKEN, kind: 'call', tool: 'run', args: { hostId: 'h1' } }
    })
  })

  it('refuses anything off the shape', () => {
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ token: TOKEN, kind: 'hello' }),
      JSON.stringify({ id: '', token: TOKEN, kind: 'hello' }),
      JSON.stringify({ id: 'x'.repeat(129), token: TOKEN, kind: 'hello' }),
      JSON.stringify({ id: '1', token: 'nope', kind: 'hello' }),
      JSON.stringify({ id: '1', token: TOKEN, kind: 'exec' }),
      JSON.stringify({ id: '1', token: TOKEN, kind: 'call' }),
      JSON.stringify({ id: '1', token: TOKEN, kind: 'call', tool: 'Run;rm' }),
      JSON.stringify({ id: '1', token: TOKEN, kind: 'call', tool: 'run', args: ['a'] })
    ]
    for (const line of bad) expect(parseRequest(line).ok, line).toBe(false)
  })
})

describe('parseReply', () => {
  it('reads both reply shapes and refuses others', () => {
    expect(parseReply(JSON.stringify({ id: '1', ok: true, result: { text: 'hi', isError: false } }))).toEqual({
      ok: true,
      msg: { id: '1', ok: true, result: { text: 'hi', isError: false } }
    })
    expect(parseReply(JSON.stringify({ id: '1', ok: false, error: 'no' }))).toEqual({ ok: true, msg: { id: '1', ok: false, error: 'no' } })
    expect(parseReply(JSON.stringify({ id: '1', ok: true })).ok).toBe(false)
    expect(parseReply('{').ok).toBe(false)
  })
})

describe('createLineSplitter', () => {
  it('reassembles lines split across chunks, drops blank lines and a trailing CR', () => {
    const s = createLineSplitter()
    expect(s.push('{"a":')).toEqual({ lines: [] })
    expect(s.push('1}\r\n\n{"b"')).toEqual({ lines: ['{"a":1}'] })
    expect(s.push(Buffer.from(':2}\n'))).toEqual({ lines: ['{"b":2}'] })
  })

  it('keeps a multi-byte character split across chunks intact', () => {
    const s = createLineSplitter()
    const bytes = Buffer.from('"João"\n', 'utf-8')
    expect(s.push(bytes.subarray(0, 4))).toEqual({ lines: [] })
    expect(s.push(bytes.subarray(4))).toEqual({ lines: ['"João"'] })
  })

  it('fails once a line passes the cap, complete or still open, and stays failed', () => {
    const open = createLineSplitter(10)
    expect(open.push('12345').error).toBeUndefined()
    expect(open.push('678901').error).toMatch(/larger than 10/)
    expect(open.push('\n')).toEqual({ lines: [], error: 'closed' })

    const done = createLineSplitter(10)
    const r = done.push('ok\n12345678901\n')
    expect(r.lines).toEqual(['ok'])
    expect(r.error).toMatch(/larger than 10/)
  })
})

describe('encodeReply', () => {
  it('is one JSON line', () => {
    const line = encodeReply({ id: '1', ok: true, result: { text: 'a\nb', isError: false } })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ id: '1', ok: true, result: { text: 'a\nb', isError: false } })
    expect(encodeFrame({ x: 1 })).toBe('{"x":1}\n')
  })

  it('cuts a result too large for one frame, and says so', () => {
    const max = 10_000
    const line = encodeReply({ id: '1', ok: true, result: { text: '"\\'.repeat(20_000), isError: true } }, max)
    expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(max)
    const back = JSON.parse(line)
    expect(back.result.isError).toBe(true)
    expect(back.result.text).toMatch(/truncated by the ops bridge/)
    expect(OPS_BRIDGE_MAX_FRAME).toBe(4 * 1024 * 1024)
  })
})

describe('bridgeEndpoint', () => {
  it('is a named pipe on Windows and a socket file elsewhere', () => {
    const join = (...p: string[]) => p.join('/')
    expect(bridgeEndpoint('win32', 'abc', '/ignored', join)).toBe('\\\\.\\pipe\\argos-ops-abc')
    expect(bridgeEndpoint('linux', 'abc', '/run/user/1000', join)).toBe('/run/user/1000/argos-ops-abc.sock')
  })
})
