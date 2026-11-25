import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  claudeKeychainService,
  decodeKeychainOutput,
  joinChunks,
  looksLikeCredentials,
  parseChunkManifest
} from './claude-keychain-pure'

describe('claudeKeychainService', () => {
  it('is the bare service for the default config dir', () => {
    expect(claudeKeychainService(null)).toBe('Claude Code-credentials')
  })

  it('appends the first 8 hex of sha256(dir) for a custom CLAUDE_CONFIG_DIR', () => {
    // sha256("abc") = ba7816bf… is the standard test vector.
    const dir = '/Users/x/.claude-work'
    const expected = createHash('sha256').update(dir).digest('hex').slice(0, 8)
    expect(claudeKeychainService(dir)).toBe(`Claude Code-credentials-${expected}`)
    expect(claudeKeychainService('abc')).toBe('Claude Code-credentials-ba7816bf')
  })

  it('hashes the NFC form, so a decomposed accent gives the same service', () => {
    const nfc = '/Users/joão/acc'
    const nfd = '/Users/joão/acc'
    expect(claudeKeychainService(nfd)).toBe(claudeKeychainService(nfc))
  })
})

describe('keychain output', () => {
  const json = '{"claudeAiOauth":{"accessToken":"t","expiresAt":1}}'

  it('passes plain JSON through and decodes hex-encoded JSON', () => {
    expect(decodeKeychainOutput(`${json}\n`)).toBe(json)
    expect(decodeKeychainOutput(Buffer.from(json).toString('hex'))).toBe(json)
    expect(decodeKeychainOutput('abcd')).toBe('abcd')
  })

  it('recognises credentials without exposing them', () => {
    expect(looksLikeCredentials(json)).toBe(true)
    expect(looksLikeCredentials('{"accessToken":"t"}')).toBe(true)
    expect(looksLikeCredentials('{"claudeAiOauth":{}}')).toBe(false)
    expect(looksLikeCredentials('not json')).toBe(false)
  })

  it('reassembles chunked values against the manifest', () => {
    const b64 = Buffer.from(json).toString('base64')
    const manifest = parseChunkManifest(JSON.stringify({ n: 2, l: b64.length }))
    expect(manifest).toEqual({ n: 2, l: b64.length })
    expect(joinChunks([b64.slice(0, 10), b64.slice(10)], manifest!)).toBe(json)
    expect(joinChunks([b64.slice(0, 10)], manifest!)).toBeNull()
    expect(parseChunkManifest('{"n":0,"l":1}')).toBeNull()
    expect(parseChunkManifest('x')).toBeNull()
  })
})
