import { describe, it, expect } from 'vitest'
import {
  CREDENTIAL_AUTH_FIELDS,
  PUBLIC_CREDENTIAL_FIELDS,
  cleanCredentialFields,
  credentialConnectionChanged,
  credentialFieldProblem,
  credentialUsage,
  hostConnectionChanged,
  resolveHostAuth,
  stripCredentialAuth,
  toPublicCredential,
  withCredentialInfo,
  type EffectiveSshHost,
  type SshCredential,
  type StoredSshHost
} from './ssh-credential-pure'
import { SECRET_FIELDS, effectiveElevation, mergeSecrets, toPublicHost } from './ssh-host-pure'
import { splitHostSecrets, mergeHosts } from './profile-transfer-pure'
import type { SshGroup } from './ssh-group-pure'

const cred: SshCredential = {
  id: 'cred_1',
  name: 'Client A admin',
  username: 'admin',
  authType: 'password',
  password: 'cred-pw',
  elevation: 'other',
  elevationPassword: 'cred-ep',
  elevateCommand: 'sudo su -'
}

/** The effective host alone, the shape getHost returns. */
const resolve = (h: StoredSshHost, creds: readonly SshCredential[], groups: readonly SshGroup[] = []): EffectiveSshHost =>
  resolveHostAuth(h, creds, groups).effective

const linked: StoredSshHost = {
  id: 'h1',
  name: 'web',
  host: 'web.example',
  port: 2222,
  remotePath: '/srv',
  production: true,
  credentialId: 'cred_1'
}

describe('resolveHostAuth', () => {
  it('returns an unlinked host as it is', () => {
    const own: StoredSshHost = { id: 'h2', name: 'db', host: 'db', port: 22, username: 'u', authType: 'key', privateKeyPath: '/k', passphrase: 'pp' }
    expect(resolve(own, [cred])).toEqual({ ...own, authSource: 'own' })
    expect(resolveHostAuth(own, [cred]).source).toBe('own')
  })

  it('takes the login of a linked host from its credential and keeps its own fields', () => {
    const eff = resolve(linked, [cred])
    expect(eff).toEqual({
      id: 'h1',
      name: 'web',
      host: 'web.example',
      port: 2222,
      remotePath: '/srv',
      production: true,
      credentialId: 'cred_1',
      credentialName: 'Client A admin',
      authSource: 'credential',
      username: 'admin',
      authType: 'password',
      password: 'cred-pw',
      elevation: 'other',
      elevationPassword: 'cred-ep',
      elevateCommand: 'sudo su -'
    })
  })

  it('never lets a stale login or secret of the host show through', () => {
    const stale = {
      ...linked,
      username: 'old',
      authType: 'key',
      privateKeyPath: '/old',
      password: 'stale-pw',
      passphrase: 'stale-pp',
      elevation: 'login',
      elevationPassword: 'stale-ep',
      elevateCommand: 'su -'
    } as StoredSshHost
    const agentCred: SshCredential = { id: 'cred_1', name: 'agent', username: 'deploy', authType: 'agent' }
    const eff = resolve(stale, [agentCred])
    expect(eff.username).toBe('deploy')
    expect(eff.authType).toBe('agent')
    for (const k of ['privateKeyPath', 'elevation', 'elevateCommand', ...SECRET_FIELDS]) expect(eff, k).not.toHaveProperty(k)
    expect(JSON.stringify(eff)).not.toMatch(/stale|old/)
  })

  it('marks a host whose credential is gone, with no login and no secret', () => {
    const stale = { ...linked, username: 'old', authType: 'password', password: 'stale-pw' } as StoredSshHost
    const eff = resolve(stale, [])
    expect(eff.credentialMissing).toBe(true)
    expect(eff.username).toBe('')
    for (const k of SECRET_FIELDS) expect(eff).not.toHaveProperty(k)
    expect(eff).not.toHaveProperty('credentialName')
  })

  it('inherits the elevation of the credential', () => {
    expect(effectiveElevation(resolve(linked, [cred]))).toBe('other')
    const loginCred: SshCredential = { id: 'cred_1', name: 'x', username: 'u', authType: 'password', password: 'pw' }
    const eff = resolve(linked, [loginCred])
    expect(effectiveElevation(eff)).toBe('login')
    expect(toPublicHost(eff).hasElevation).toBe(true)
    const keyCred: SshCredential = { id: 'cred_1', name: 'x', username: 'u', authType: 'key', passphrase: 'pp' }
    expect(effectiveElevation(resolve(linked, [keyCred]))).toBe('none')
  })
})

describe('the renderer view of a linked host', () => {
  it('has the effective flags and the credential name, never a secret', () => {
    const eff = resolve(linked, [cred])
    const pub = withCredentialInfo(toPublicHost(eff), eff)
    expect(pub).toMatchObject({ username: 'admin', authType: 'password', credentialId: 'cred_1', credentialName: 'Client A admin', hasPassword: true, hasElevation: true })
    expect(JSON.stringify(pub)).not.toMatch(/cred-pw|cred-ep/)
  })

  it('says when the credential is missing', () => {
    const eff = resolve(linked, [])
    const pub = withCredentialInfo(toPublicHost(eff), eff)
    expect(pub).toMatchObject({ credentialId: 'cred_1', credentialMissing: true, hasPassword: false })
  })
})

describe('credential allowlist', () => {
  const full: Required<SshCredential> = {
    id: 'c',
    name: 'n',
    username: 'u',
    authType: 'password',
    privateKeyPath: '/k',
    elevation: 'other',
    elevateCommand: 'su -',
    password: 'pw',
    passphrase: 'pp',
    elevationPassword: 'ep'
  }

  it('covers every field as public or secret, and gives the renderer no secret', () => {
    for (const k of Object.keys(full)) {
      expect((PUBLIC_CREDENTIAL_FIELDS as readonly string[]).includes(k) || (SECRET_FIELDS as readonly string[]).includes(k), k).toBe(true)
    }
    const pub = toPublicCredential({ ...full, token: 'x' } as SshCredential, 3)
    const allowed = new Set<string>([...PUBLIC_CREDENTIAL_FIELDS, 'hasPassword', 'hasPassphrase', 'hasElevation', 'usedBy', 'usedByGroups'])
    for (const k of Object.keys(pub)) expect(allowed.has(k), k).toBe(true)
    expect(JSON.stringify(pub)).not.toMatch(/"(pw|pp|ep)"/)
    expect(pub).toMatchObject({ hasPassword: true, hasPassphrase: true, hasElevation: true, usedBy: 3 })
  })

  it('drops an off-list elevation value', () => {
    const pub = toPublicCredential({ ...full, elevation: 'root', elevateCommand: 'sudo -i; id' } as unknown as SshCredential, 0)
    expect(pub).not.toHaveProperty('elevation')
    expect(pub).not.toHaveProperty('elevateCommand')
  })

  it('counts the hosts that link a credential', () => {
    expect(credentialUsage([{ id: '1', credentialId: 'c' }, { id: '2' }, { id: '3', credentialId: 'd' }, { id: '4', credentialId: 'c' }], 'c')).toBe(2)
  })
})

describe('credential secrets merge like a host', () => {
  const prev = { password: 'old', elevationPassword: 'ep' }
  it('keeps on undefined, clears on null, replaces on a string', () => {
    expect(mergeSecrets(prev, { authType: 'password', elevation: 'other' })).toEqual(prev)
    expect(mergeSecrets(prev, { authType: 'password', elevation: 'other', password: null })).toEqual({ elevationPassword: 'ep' })
    expect(mergeSecrets(prev, { authType: 'password', elevation: 'other', password: 'new' })).toEqual({ password: 'new', elevationPassword: 'ep' })
  })
})

describe('cleanCredentialFields / credentialFieldProblem', () => {
  it('trims text and drops off-list elevation values', () => {
    const c = cleanCredentialFields({ name: ' A ', username: ' u​ ', authType: 'password', privateKeyPath: ' /k ', elevation: 'x', elevateCommand: 'rm' })
    expect(c).toEqual({ name: 'A', username: 'u', authType: 'password', privateKeyPath: '/k' })
  })

  it('needs a name, a safe username and a known auth type', () => {
    expect(credentialFieldProblem({ name: '', username: 'u', authType: 'password' })).toBe('name')
    expect(credentialFieldProblem({ name: 'n', username: '-oProxyCommand=x', authType: 'password' })).toBe('username')
    expect(credentialFieldProblem({ name: 'n', username: 'u', authType: 'otp' })).toBe('authType')
    expect(credentialFieldProblem({ name: 'n', username: 'u', authType: 'agent' })).toBeNull()
  })
})

describe('what closes pooled connections', () => {
  it('a credential login change does, an elevation-only change does not', () => {
    expect(credentialConnectionChanged(cred, { ...cred })).toBe(false)
    expect(credentialConnectionChanged(cred, { ...cred, elevation: 'none', elevationPassword: undefined, elevateCommand: 'su -', name: 'x' })).toBe(false)
    expect(credentialConnectionChanged(cred, { ...cred, password: 'new' })).toBe(true)
    expect(credentialConnectionChanged(cred, { ...cred, username: 'v' })).toBe(true)
    expect(credentialConnectionChanged(cred, { ...cred, authType: 'agent' })).toBe(true)
    expect(credentialConnectionChanged(cred, { ...cred, privateKeyPath: '/k' })).toBe(true)
    expect(credentialConnectionChanged({ ...cred, authType: 'key' }, { ...cred, authType: 'key', passphrase: 'pp' })).toBe(true)
  })

  it('a host edit that links, unlinks or switches a credential does', () => {
    const a = resolve(linked, [cred])
    const other: SshCredential = { ...cred, id: 'cred_2' }
    const b = resolve({ ...linked, credentialId: 'cred_2' }, [other])
    expect(hostConnectionChanged(a, b)).toBe(true)
    const own: EffectiveSshHost = { ...stripCredentialAuth(a), credentialId: undefined, credentialName: undefined, authSource: 'own', username: 'admin', authType: 'password', password: 'cred-pw' }
    expect(hostConnectionChanged(a, own)).toBe(true)
    expect(hostConnectionChanged(a, resolve(linked, []))).toBe(true)
  })

  it('a login change of an unlinked host does: address, user, auth, key path, a secret replaced or cleared', () => {
    const own: EffectiveSshHost = { id: 'h', name: 'n', host: 'h', port: 22, authSource: 'own', username: 'u', authType: 'key', privateKeyPath: '/k', passphrase: 'pp' }
    expect(hostConnectionChanged(own, { ...own })).toBe(false)
    expect(hostConnectionChanged(own, { ...own, host: 'h2' })).toBe(true)
    expect(hostConnectionChanged(own, { ...own, username: 'v' })).toBe(true)
    expect(hostConnectionChanged(own, { ...own, authType: 'agent', passphrase: undefined })).toBe(true)
    expect(hostConnectionChanged(own, { ...own, privateKeyPath: '/k2' })).toBe(true)
    expect(hostConnectionChanged(own, { ...own, passphrase: 'new' })).toBe(true)
    expect(hostConnectionChanged(own, { ...own, passphrase: undefined })).toBe(true)
    const pw: EffectiveSshHost = { ...own, authType: 'password', privateKeyPath: undefined, passphrase: undefined, password: 'a' }
    expect(hostConnectionChanged(pw, { ...pw, password: 'b' })).toBe(true)
    expect(hostConnectionChanged(pw, { ...pw, password: undefined })).toBe(true)
  })

  it('organisation and elevation edits of a host do not', () => {
    const a = resolve(linked, [cred])
    expect(hostConnectionChanged(a, { ...a, name: 'x', tags: ['t'], notes: 'n', favorite: true, elevation: 'none', elevationPassword: undefined })).toBe(false)
    expect(hostConnectionChanged(a, { ...a, port: 22 })).toBe(true)
    expect(hostConnectionChanged({ ...a, port: 22 }, { ...a, port: 0 })).toBe(false)
  })
})

describe('stripCredentialAuth', () => {
  it('removes every field a credential supplies', () => {
    const h = stripCredentialAuth({ ...linked, username: 'u', authType: 'password', password: 'pw', privateKeyPath: '/k', elevation: 'other', elevationPassword: 'e', elevateCommand: 'su -' })
    for (const k of CREDENTIAL_AUTH_FIELDS) expect(h).not.toHaveProperty(k)
    expect(h).toMatchObject({ id: 'h1', host: 'web.example', credentialId: 'cred_1' })
  })
})

describe('credentials in a profile export', () => {
  it('travel without any secret in the clear; the secrets go to the payload keyed by id', () => {
    const { hosts: creds, secrets } = splitHostSecrets([cred, { id: 'cred_2', name: 'k', username: 'u', authType: 'key', passphrase: 'k-pp' } as SshCredential])
    for (const c of creds) for (const k of SECRET_FIELDS) expect(c).not.toHaveProperty(k)
    expect(JSON.stringify(creds)).not.toMatch(/cred-pw|cred-ep|k-pp/)
    expect(secrets).toEqual({ cred_1: { password: 'cred-pw', elevationPassword: 'cred-ep' }, cred_2: { passphrase: 'k-pp' } })
  })

  it('merge by id, keeping a local secret the import lacks', () => {
    const merged = mergeHosts<SshCredential>([cred], [{ ...cred, name: 'renamed', password: undefined }, { id: 'cred_3', name: 'n', username: 'u', authType: 'agent' }])
    expect(merged[0]).toMatchObject({ id: 'cred_1', name: 'renamed', password: 'cred-pw', elevationPassword: 'cred-ep' })
    expect(merged[1]).toEqual({ id: 'cred_3', name: 'n', username: 'u', authType: 'agent' })
  })

  it('a host that now links a credential keeps no secret of its own after a merge', () => {
    type H = { id: string; name: string; credentialId?: string; password?: string; authType?: string }
    const merged = mergeHosts<H>([{ id: 'h1', name: 'a', authType: 'password', password: 'local' }], [{ id: 'h1', name: 'a', credentialId: 'cred_1' }])
    expect(merged).toEqual([{ id: 'h1', name: 'a', credentialId: 'cred_1' }])
  })
})

describe('resolveHostAuth: the chain own, credential, group', () => {
  const groupCred: SshCredential = { id: 'cred_g', name: 'Câmara X admin', username: 'cx', authType: 'password', password: 'group-pw' }
  const groups: SshGroup[] = [
    { id: 'grp_x', name: 'Câmara X', credentialId: 'cred_g' },
    { id: 'grp_bare', name: 'Bare' }
  ]
  const inheriting: StoredSshHost = { id: 'h3', name: 'app', host: 'app.x', port: 22, groupId: 'grp_x', authSource: 'group' }

  it('takes the login of an inheriting host from its group and says so', () => {
    const res = resolveHostAuth(inheriting, [cred, groupCred], groups)
    expect(res.source).toBe('group')
    expect(res.credentialName).toBe('Câmara X admin')
    expect(res.effective).toMatchObject({
      authSource: 'group',
      groupName: 'Câmara X',
      credentialId: 'cred_g',
      credentialName: 'Câmara X admin',
      username: 'cx',
      authType: 'password',
      password: 'group-pw',
      groupId: 'grp_x'
    })
    expect(res.effective.credentialMissing).toBeUndefined()
  })

  it('never inherits for a host with a login of its own, even in a group with a credential', () => {
    const own: StoredSshHost = { id: 'h4', name: 'db', host: 'db.x', port: 22, groupId: 'grp_x', username: 'me', authType: 'password', password: 'mine' }
    const res = resolveHostAuth(own, [groupCred], groups)
    expect(res.source).toBe('own')
    expect(res.effective.username).toBe('me')
    expect(res.effective.password).toBe('mine')
    expect(res.effective).not.toHaveProperty('credentialId')
    expect(resolveHostAuth({ ...own, authSource: 'own', credentialId: 'cred_g' }, [groupCred], groups).effective.password).toBe('mine')
  })

  it('prefers the host\'s own credential link over its group', () => {
    const res = resolveHostAuth({ ...linked, groupId: 'grp_x', authSource: 'credential' }, [cred, groupCred], groups)
    expect(res.source).toBe('credential')
    expect(res.effective.username).toBe('admin')
    expect(res.effective).not.toHaveProperty('groupName')
  })

  it('reads a host saved before groups by its credential link', () => {
    expect(resolveHostAuth(linked, [cred]).source).toBe('credential')
  })

  it('marks an inheriting host with no login when the group is gone, carries none, or its credential is gone', () => {
    for (const [host, creds] of [
      [{ ...inheriting, groupId: 'grp_gone' }, [groupCred]],
      [{ ...inheriting, groupId: 'grp_bare' }, [groupCred]],
      [{ ...inheriting, groupId: undefined }, [groupCred]],
      [inheriting, []]
    ] as [StoredSshHost, SshCredential[]][]) {
      const res = resolveHostAuth(host, creds, groups)
      expect(res.source).toBe('group')
      expect(res.effective.credentialMissing).toBe(true)
      expect(res.effective.username).toBe('')
      for (const k of SECRET_FIELDS) expect(res.effective).not.toHaveProperty(k)
    }
  })

  it('never lets a stale login of an inheriting host show through', () => {
    const stale = { ...inheriting, username: 'old', authType: 'key', password: 'stale-pw', credentialId: 'cred_1' } as StoredSshHost
    const eff = resolve(stale, [cred, groupCred], groups)
    expect(eff.username).toBe('cx')
    expect(eff.credentialId).toBe('cred_g')
    expect(JSON.stringify(eff)).not.toMatch(/stale|old/)
  })

  it('shows the origin to the renderer, never the secret', () => {
    const eff = resolve(inheriting, [groupCred], groups)
    const pub = withCredentialInfo(toPublicHost(eff), eff)
    expect(pub).toMatchObject({ authSource: 'group', groupName: 'Câmara X', credentialName: 'Câmara X admin', hasPassword: true })
    expect(JSON.stringify(pub)).not.toMatch(/group-pw/)
    const gone = resolve({ ...inheriting, groupId: 'grp_bare' }, [groupCred], groups)
    expect(withCredentialInfo(toPublicHost(gone), gone)).toMatchObject({ authSource: 'group', groupName: 'Bare', credentialMissing: true })
  })

  it('a change of the group\'s credential closes the pooled connection', () => {
    const other: SshCredential = { ...groupCred, id: 'cred_h' }
    const a = resolve(inheriting, [groupCred, other], groups)
    const b = resolve(inheriting, [groupCred, other], [{ ...groups[0], credentialId: 'cred_h' }])
    expect(hostConnectionChanged(a, b)).toBe(true)
    expect(hostConnectionChanged(a, resolve(inheriting, [groupCred], []))).toBe(true)
  })

  it('counts hosts that inherit a credential as using it', () => {
    const hosts = [inheriting, linked, { id: 'h5', groupId: 'grp_x' }]
    expect(credentialUsage(hosts, 'cred_g', groups)).toBe(1)
    expect(credentialUsage(hosts, 'cred_1', groups)).toBe(1)
    expect(credentialUsage(hosts, 'cred_g')).toBe(0)
  })
})

describe('profile merge of an inheriting host', () => {
  it('keeps no secret of its own', () => {
    const local: { id: string; authSource?: string; groupId?: string; password?: string }[] = [{ id: 'h3', authSource: 'own', password: 'pw' }]
    const merged = mergeHosts(local, [{ id: 'h3', authSource: 'group', groupId: 'grp_x' }])
    for (const k of SECRET_FIELDS) expect(merged[0]).not.toHaveProperty(k)
  })
})
