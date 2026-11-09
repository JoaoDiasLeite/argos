import { describe, it, expect } from 'vitest'
import { keyTypeOf, knownHostsFile, knownHostsLine, parseTrustEntry, splitEndpoint, sshOptionPath } from './ssh-trust-pure'

function sshString(s: string | Buffer): Buffer {
  const body = typeof s === 'string' ? Buffer.from(s, 'latin1') : s
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  return Buffer.concat([len, body])
}

const ed25519 = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 7))])

describe('keyTypeOf', () => {
  it('reads the key type of an ed25519 wire blob', () => {
    expect(keyTypeOf(ed25519)).toBe('ssh-ed25519')
  })

  it('refuses a malformed blob', () => {
    expect(keyTypeOf(Buffer.alloc(0))).toBeNull()
    expect(keyTypeOf(Buffer.from([0, 0, 0]))).toBeNull()
    expect(keyTypeOf(Buffer.from([0, 0, 0, 0]))).toBeNull()
    expect(keyTypeOf(Buffer.from([0, 0, 0, 20, 0x61, 0x62]))).toBeNull()
    expect(keyTypeOf(sshString('ssh ed25519'))).toBeNull()
  })
})

describe('knownHostsLine', () => {
  it('uses the bare host on port 22', () => {
    expect(knownHostsLine('srv.example', 22, 'ssh-ed25519', 'AAAA')).toBe('srv.example ssh-ed25519 AAAA')
  })

  it('uses [host]:port on any other port', () => {
    expect(knownHostsLine('10.0.0.5', 2222, 'ssh-rsa', 'AAAB')).toBe('[10.0.0.5]:2222 ssh-rsa AAAB')
  })
})

describe('parseTrustEntry', () => {
  it('reads the legacy fingerprint string', () => {
    expect(parseTrustEntry('SHA256:abc')).toEqual({ fp: 'SHA256:abc' })
  })

  it('reads the object form', () => {
    expect(parseTrustEntry({ fp: 'SHA256:abc', type: 'ssh-ed25519', key: 'AAAA' })).toEqual({ fp: 'SHA256:abc', type: 'ssh-ed25519', key: 'AAAA' })
    expect(parseTrustEntry({ fp: 'SHA256:abc', type: 3 })).toEqual({ fp: 'SHA256:abc' })
  })

  it('refuses anything else', () => {
    expect(parseTrustEntry('')).toBeNull()
    expect(parseTrustEntry(null)).toBeNull()
    expect(parseTrustEntry(42)).toBeNull()
    expect(parseTrustEntry(['SHA256:abc'])).toBeNull()
    expect(parseTrustEntry({ type: 'ssh-ed25519', key: 'AAAA' })).toBeNull()
  })
})

describe('splitEndpoint', () => {
  it('splits on the last colon', () => {
    expect(splitEndpoint('srv:22')).toEqual({ host: 'srv', port: 22 })
    expect(splitEndpoint('::1:2222')).toEqual({ host: '::1', port: 2222 })
    expect(splitEndpoint('srv')).toBeNull()
    expect(splitEndpoint('srv:x')).toBeNull()
  })
})

describe('knownHostsFile', () => {
  it('writes one line per entry that carries its full key', () => {
    const key = ed25519.toString('base64')
    const text = knownHostsFile({
      'a.example:22': { fp: 'SHA256:a', type: 'ssh-ed25519', key },
      'b.example:2222': { fp: 'SHA256:b', type: 'ssh-ed25519', key },
      'legacy.example:22': { fp: 'SHA256:c' },
      'bad host:22': { fp: 'SHA256:d', type: 'ssh-ed25519', key }
    })
    expect(text).toBe(`a.example ssh-ed25519 ${key}\n[b.example]:2222 ssh-ed25519 ${key}\n`)
  })

  it('is empty when no entry has a key', () => {
    expect(knownHostsFile({ 'a:22': { fp: 'SHA256:a' } })).toBe('')
  })
})

describe('sshOptionPath', () => {
  it('leaves a plain path, non-ASCII included, as it is', () => {
    const p = String.raw`C:\Users\JoãoLeite\AppData\Roaming\Argos\ssh-known-hosts`
    expect(sshOptionPath(p)).toBe(p)
  })

  it('quotes a path with spaces and doubles a literal %', () => {
    expect(sshOptionPath(String.raw`C:\Users\Jo Leite\100%\kh`)).toBe(String.raw`"C:\Users\Jo Leite\100%%\kh"`)
  })
})
