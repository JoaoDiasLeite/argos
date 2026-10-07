import { describe, it, expect } from 'vitest'
import { cleanHostFields, cleanHostText, decodeHostsFile, refuseOverwriteMessage } from './ssh-host-pure'

describe('cleanHostText', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanHostText('  192.168.1.10 \t')).toBe('192.168.1.10')
  })

  it('strips a trailing non-breaking space and a BOM', () => {
    expect(cleanHostText('192.168.1.10\u00a0')).toBe('192.168.1.10')
    expect(cleanHostText('\ufeffjdl')).toBe('jdl')
  })

  it('strips zero-width characters, which trim() keeps', () => {
    expect(cleanHostText('192.168.1.10\u200b')).toBe('192.168.1.10')
    expect(cleanHostText('pve\u200c-\u200d01\u2060')).toBe('pve-01')
  })

  it('keeps inner spaces', () => {
    expect(cleanHostText(' my server ')).toBe('my server')
  })
})

describe('cleanHostFields', () => {
  const base = { id: 'ssh_1', name: ' pve-01 ', host: '192.168.1.10 ', port: 22, username: 'jdl\u200b', authType: 'key' as const }

  it('cleans name, host and username', () => {
    const out = cleanHostFields(base)
    expect(out.name).toBe('pve-01')
    expect(out.host).toBe('192.168.1.10')
    expect(out.username).toBe('jdl')
  })

  it('cleans the optional path fields only when present', () => {
    const out = cleanHostFields({ ...base, privateKeyPath: ' C:\\k\\id ', remotePath: '/srv ' })
    expect(out.privateKeyPath).toBe('C:\\k\\id')
    expect(out.remotePath).toBe('/srv')
    expect('claudePath' in out).toBe(false)
  })

  it('leaves secrets and unrelated fields untouched', () => {
    const out = cleanHostFields({ ...base, password: ' keep me ', passphrase: ' too ' })
    expect(out.password).toBe(' keep me ')
    expect(out.passphrase).toBe(' too ')
    expect(out.port).toBe(22)
    expect(out.id).toBe('ssh_1')
  })
})

describe('decodeHostsFile', () => {
  const hosts = [{ id: 'ssh_1', name: 'pve-01' }]
  const json = JSON.stringify(hosts)
  // A stand-in for safeStorage: "encrypted" bytes are the JSON behind a marker.
  const MARK = 'ENC:'
  const encrypt = (s: string): Buffer => Buffer.from(MARK + s, 'utf-8')
  const decrypt = (b: Buffer): string => {
    const s = b.toString('utf-8')
    if (!s.startsWith(MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    return s.slice(MARK.length)
  }
  const unavailable = (): string => {
    throw new Error('Encryption is not available.')
  }

  it('reads an encrypted file while encryption is available', () => {
    expect(decodeHostsFile(encrypt(json), { encryptionAvailable: true, decrypt })).toEqual({ ok: true, hosts })
  })

  it('reads a plaintext file while encryption is unavailable', () => {
    expect(decodeHostsFile(Buffer.from(json), { encryptionAvailable: false, decrypt: unavailable })).toEqual({ ok: true, hosts })
  })

  it('falls back to plaintext when a plaintext file meets available encryption', () => {
    expect(decodeHostsFile(Buffer.from(json), { encryptionAvailable: true, decrypt })).toEqual({ ok: true, hosts })
  })

  it('falls back to decrypting when an encrypted file meets unavailable encryption', () => {
    expect(decodeHostsFile(encrypt(json), { encryptionAvailable: false, decrypt })).toEqual({ ok: true, hosts })
  })

  it('reads an empty list as an empty list', () => {
    expect(decodeHostsFile(encrypt('[]'), { encryptionAvailable: true, decrypt })).toEqual({ ok: true, hosts: [] })
  })

  it('is an error, not an empty list, when neither mode decodes', () => {
    const res = decodeHostsFile(Buffer.from([0x01, 0x02, 0xff]), { encryptionAvailable: true, decrypt })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/^encrypted: .*decrypting.*; plaintext: /)
    }
  })

  it('is an error when the file decodes to something other than a list', () => {
    const res = decodeHostsFile(encrypt('{"id":"ssh_1"}'), { encryptionAvailable: true, decrypt })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not a list of hosts')
  })

  it('is an error for an empty (truncated) file', () => {
    expect(decodeHostsFile(Buffer.alloc(0), { encryptionAvailable: false, decrypt: unavailable }).ok).toBe(false)
  })
})

describe('refuseOverwriteMessage', () => {
  it('says nothing was written and names the file', () => {
    const msg = refuseOverwriteMessage('C:\\data\\ssh-hosts.bin', 'bad decrypt')
    expect(msg).toContain('refusing to overwrite')
    expect(msg).toContain('bad decrypt')
    expect(msg).toContain('C:\\data\\ssh-hosts.bin')
  })
})
