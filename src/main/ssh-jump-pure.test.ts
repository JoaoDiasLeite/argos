import { describe, expect, it } from 'vitest'
import {
  buildProxyCommand,
  effectiveJumpId,
  hostIdsUsingJump,
  isSafeWindowsProxyWord,
  jumpBreakage,
  jumpSaveProblem,
  resolveJump,
  type ProxyCommandInput
} from './ssh-jump-pure'

type H = { id: string; name: string; jumpHostId?: string; group?: string }

const gw: H = { id: 'gw', name: 'Gateway' }
const target: H = { id: 't', name: 'Target', jumpHostId: 'gw' }
const plain: H = { id: 'p', name: 'Plain' }

/** Stand-in for groups: a host's group gateway by group name. */
const groups: Record<string, string> = { clientA: 'gw', loop: 'chained' }
const groupJumpOf = (h: H): string | undefined => (h.group ? groups[h.group] : undefined)

describe('resolveJump', () => {
  it('is direct when nothing is set', () => {
    expect(resolveJump(plain, [plain, gw])).toEqual({ ok: true, jump: null, source: 'none' })
  })

  it("follows the host's own gateway", () => {
    expect(resolveJump(target, [gw, target])).toEqual({ ok: true, jump: gw, source: 'host' })
  })

  it("inherits the group's gateway when the host sets none", () => {
    const h: H = { id: 'a', name: 'A', group: 'clientA' }
    expect(resolveJump(h, [gw, h], groupJumpOf)).toEqual({ ok: true, jump: gw, source: 'group' })
  })

  it("lets the host's own value override the group, and '' mean direct", () => {
    const other: H = { id: 'o', name: 'Other' }
    const own: H = { id: 'a', name: 'A', group: 'clientA', jumpHostId: 'o' }
    expect(resolveJump(own, [gw, other, own], groupJumpOf)).toEqual({ ok: true, jump: other, source: 'host' })
    const none: H = { id: 'b', name: 'B', group: 'clientA', jumpHostId: '' }
    expect(resolveJump(none, [gw, none], groupJumpOf)).toEqual({ ok: true, jump: null, source: 'none' })
    expect(effectiveJumpId(none, groupJumpOf)).toEqual({ id: '', source: 'none' })
  })

  it('refuses itself', () => {
    const self: H = { id: 's', name: 'S', jumpHostId: 's' }
    expect(resolveJump(self, [self])).toMatchObject({ ok: false, problem: 'self' })
  })

  it('refuses an id no saved host has', () => {
    const lost: H = { id: 'l', name: 'L', jumpHostId: 'gone' }
    expect(resolveJump(lost, [lost, gw])).toMatchObject({ ok: false, problem: 'unknown', jumpHostId: 'gone' })
  })

  it('refuses a gateway that has a gateway, which also rules out every cycle', () => {
    const a: H = { id: 'a', name: 'A', jumpHostId: 'b' }
    const b: H = { id: 'b', name: 'B', jumpHostId: 'a' }
    expect(resolveJump(a, [a, b])).toMatchObject({ ok: false, problem: 'chained' })
    expect(resolveJump(b, [a, b])).toMatchObject({ ok: false, problem: 'chained' })
    const c: H = { id: 'c', name: 'C', jumpHostId: 't' }
    expect(resolveJump(c, [gw, target, c])).toMatchObject({ ok: false, problem: 'chained', jumpHostId: 't' })
  })

  it("counts a gateway's inherited jump as a chain too", () => {
    const g2: H = { id: 'g2', name: 'G2', group: 'clientA' }
    const h: H = { id: 'h', name: 'H', jumpHostId: 'g2' }
    expect(resolveJump(h, [gw, g2, h], groupJumpOf)).toMatchObject({ ok: false, problem: 'chained' })
  })
})

describe('jumpSaveProblem', () => {
  it('accepts a direct host and a host behind a direct gateway', () => {
    expect(jumpSaveProblem('p', [plain, gw])).toBeNull()
    expect(jumpSaveProblem('t', [gw, target])).toBeNull()
  })

  it("reports the saved host's own problem", () => {
    expect(jumpSaveProblem('s', [{ id: 's', name: 'S', jumpHostId: 's' }])).toBe('self')
    expect(jumpSaveProblem('x', [{ id: 'x', name: 'X', jumpHostId: 'nope' }])).toBe('unknown')
  })

  it('refuses giving a gateway a gateway of its own', () => {
    const gwWithJump: H = { ...gw, jumpHostId: 'p' }
    expect(jumpSaveProblem('gw', [gwWithJump, target, plain])).toBe('isGateway')
  })

  it('lists the hosts that ride a gateway', () => {
    const t2: H = { id: 't2', name: 'T2', jumpHostId: 'gw' }
    expect(hostIdsUsingJump('gw', [gw, target, t2, plain])).toEqual(['t', 't2'])
    expect(hostIdsUsingJump('p', [gw, target, plain])).toEqual([])
  })
})

const winBase: ProxyCommandInput = {
  sshPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  jump: { host: '127.0.0.1', port: 2222, username: 'demo', authType: 'password' },
  knownHostsPath: 'C:\\Users\\JoãoLeite\\AppData\\Roaming\\argos\\ssh-known-hosts',
  platform: 'win32'
}

describe('buildProxyCommand on Windows', () => {
  it('builds the inner ssh with the same trust options and the gateway port', () => {
    const res = buildProxyCommand(winBase)
    expect(res).toEqual({
      ok: true,
      command:
        '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -p 2222 -o "UserKnownHostsFile=\\"C:\\Users\\JoãoLeite\\AppData\\Roaming\\argos\\ssh-known-hosts\\"" -o StrictHostKeyChecking=yes -W "[%h]:%p" -- "demo@127.0.0.1"'
    })
  })

  it("adds the gateway's key with IdentitiesOnly, quoted (a space is fine)", () => {
    const res = buildProxyCommand({
      ...winBase,
      sshPath: 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
      jump: { ...winBase.jump, authType: 'key', privateKeyPath: 'C:\\Users\\João Leite\\.ssh\\id_ed25519' }
    })
    expect(res.ok && res.command).toContain('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -p 2222 -i "C:\\Users\\João Leite\\.ssh\\id_ed25519" -o IdentitiesOnly=yes')
  })

  it('takes a key path only for a key gateway', () => {
    const res = buildProxyCommand({ ...winBase, jump: { ...winBase.jump, authType: 'agent', privateKeyPath: 'C:\\k' } })
    expect(res.ok && res.command).not.toContain('-i')
  })

  it('keeps a directory account readable for both Windows readers', () => {
    const res = buildProxyCommand({ ...winBase, jump: { ...winBase.jump, username: 'CORP\\joao' } })
    expect(res.ok && res.command.endsWith('-- "CORP\\joao@127.0.0.1"')).toBe(true)
  })

  it('refuses key paths that could break out of the quotes or be expanded', () => {
    for (const bad of [
      'C:\\k" -oProxyCommand=calc "',
      'C:\\k$(calc)',
      'C:\\k`calc`',
      'C:\\%USERPROFILE%\\k',
      'C:\\k\\',
      '\\\\server\\share\\k',
      'C:\\k\\"x',
      'C:\\k\nx',
      ''
    ]) {
      const res = buildProxyCommand({ ...winBase, jump: { ...winBase.jump, authType: 'key', privateKeyPath: bad } })
      if (bad === '') expect(res.ok, 'empty path means no key').toBe(true)
      else expect(res, JSON.stringify(bad)).toEqual({ ok: false, problem: 'keyPath' })
    }
  })

  it('refuses an unsafe known_hosts or ssh path', () => {
    expect(buildProxyCommand({ ...winBase, knownHostsPath: 'C:\\a"b\\kh' })).toEqual({ ok: false, problem: 'knownHosts' })
    expect(buildProxyCommand({ ...winBase, knownHostsPath: 'C:\\50%\\kh' })).toEqual({ ok: false, problem: 'knownHosts' })
    expect(buildProxyCommand({ ...winBase, sshPath: 'C:\\$x\\ssh.exe' })).toEqual({ ok: false, problem: 'sshPath' })
  })

  it('refuses hostile users, hosts and ports', () => {
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, username: '-oProxyCommand=calc' } })).toEqual({ ok: false, problem: 'username' })
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, username: 'a" & calc & "' } })).toEqual({ ok: false, problem: 'username' })
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, username: 'a\\\\b' } })).toEqual({ ok: false, problem: 'username' })
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, host: 'h;calc' } })).toEqual({ ok: false, problem: 'host' })
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, host: '-oProxyCommand=calc' } })).toEqual({ ok: false, problem: 'host' })
    expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, host: 'fe80::1%eth0' } })).toEqual({ ok: false, problem: 'host' })
    for (const port of [0, 65536, 22.5, NaN, '22 -oX=y' as unknown as number]) {
      expect(buildProxyCommand({ ...winBase, jump: { ...winBase.jump, port } }), String(port)).toEqual({ ok: false, problem: 'port' })
    }
  })

  it('takes a numeric port given as a string (an imported host)', () => {
    const res = buildProxyCommand({ ...winBase, jump: { ...winBase.jump, port: '2200' as unknown as number } })
    expect(res.ok && res.command).toContain(' -p 2200 ')
  })
})

describe('buildProxyCommand on sh', () => {
  const posix: ProxyCommandInput = {
    sshPath: 'ssh',
    jump: { host: 'gw.example', port: 22, username: 'ops', authType: 'key', privateKeyPath: "/home/o'brien/.ssh/id key" },
    knownHostsPath: '/home/me/.config/argos/ssh-known-hosts',
    platform: 'linux'
  }

  it('single-quotes every value, a quote inside included', () => {
    const res = buildProxyCommand(posix)
    expect(res).toEqual({
      ok: true,
      command:
        "'ssh' -p 22 -i '/home/o'\\''brien/.ssh/id key' -o IdentitiesOnly=yes -o 'UserKnownHostsFile=\"/home/me/.config/argos/ssh-known-hosts\"' -o StrictHostKeyChecking=yes -W '[%h]:%p' -- 'ops@gw.example'"
    })
  })

  it('leaves $ and backquotes literal inside single quotes, and refuses %', () => {
    const res = buildProxyCommand({ ...posix, jump: { ...posix.jump, privateKeyPath: '/k/$(touch x)`id`' } })
    expect(res.ok && res.command).toContain("-i '/k/$(touch x)`id`'")
    expect(buildProxyCommand({ ...posix, jump: { ...posix.jump, privateKeyPath: '/k/%d' } })).toEqual({ ok: false, problem: 'keyPath' })
  })
})

describe('isSafeWindowsProxyWord', () => {
  it('accepts ordinary Windows paths, spaces and accents included', () => {
    expect(isSafeWindowsProxyWord('C:\\Users\\João Leite\\.ssh\\id_rsa')).toBe(true)
    expect(isSafeWindowsProxyWord('C:\\Users\\JOOLEI~1\\kh')).toBe(true)
  })
})

describe('jumpBreakage (a group gateway changing)', () => {
  type G = { id: string; name: string; jumpHostId?: string; groupId?: string }
  const lookup = (groups: Record<string, string | undefined>) => (h: G) => (h.groupId ? groups[h.groupId] : undefined)

  it('accepts a gateway outside the group', () => {
    const hosts: G[] = [{ id: 'gw', name: 'GW' }, { id: 'a', name: 'A', groupId: 'g1' }]
    expect(jumpBreakage(hosts, lookup({}), lookup({ g1: 'gw' }))).toBeNull()
  })

  it('refuses a gateway inside the group that would take itself, unless it is set to direct', () => {
    const hosts: G[] = [{ id: 'gw', name: 'GW', groupId: 'g1' }, { id: 'a', name: 'A', groupId: 'g1' }]
    expect(jumpBreakage(hosts, lookup({}), lookup({ g1: 'gw' }))).toMatchObject({ hostId: 'gw', problem: 'self' })
    const direct: G[] = [{ id: 'gw', name: 'GW', groupId: 'g1', jumpHostId: '' }, { id: 'a', name: 'A', groupId: 'g1' }]
    expect(jumpBreakage(direct, lookup({}), lookup({ g1: 'gw' }))).toBeNull()
  })

  it('refuses a group gateway that has a gateway, and a member others go through', () => {
    const chained: G[] = [{ id: 'gw', name: 'GW', jumpHostId: 'x' }, { id: 'x', name: 'X' }, { id: 'a', name: 'A', groupId: 'g1' }]
    expect(jumpBreakage(chained, lookup({}), lookup({ g1: 'gw' }))).toMatchObject({ hostId: 'a', problem: 'chained' })
    const rider: G[] = [{ id: 'gw', name: 'GW' }, { id: 'm', name: 'M', groupId: 'g1' }, { id: 'r', name: 'R', jumpHostId: 'm' }]
    expect(jumpBreakage(rider, lookup({}), lookup({ g1: 'gw' }))).toMatchObject({ hostId: 'r', problem: 'chained' })
  })

  it('a host overriding the group keeps its own gateway, or direct', () => {
    const hosts: G[] = [{ id: 'gw', name: 'GW' }, { id: 'o', name: 'O' }, { id: 'a', name: 'A', groupId: 'g1', jumpHostId: 'o' }]
    expect(resolveJump(hosts[2], hosts, lookup({ g1: 'gw' }))).toMatchObject({ ok: true, jump: hosts[1], source: 'host' })
  })
})
