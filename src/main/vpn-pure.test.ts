import { describe, expect, it } from 'vitest'
import {
  MAX_VPN_COMMAND,
  RAN_MARKER,
  checkVpns,
  groupVpnProblem,
  isSafeVpnTarget,
  plainLine,
  plainStep,
  readStatus,
  resolveVpn,
  scrubOutput,
  sudoProbeLine,
  sudoStdinLine,
  sudoStep,
  usableVpns,
  vpnCommand,
  vpnSaveProblem,
  vpnUsesSudo,
  type VpnHostRef,
  type VpnProfile
} from './vpn-pure'

const preset = (kind: VpnProfile['kind'], target: string, extra: Partial<VpnProfile> = {}): VpnProfile => ({ id: 'v1', name: 'Client', kind, target, ...extra })

describe('vpnCommand: presets', () => {
  it('builds openvpn on the openvpn-client@ template unit', () => {
    const v = preset('openvpn', 'camara-x')
    expect(vpnCommand(v, 'up')).toBe(`systemctl start 'openvpn-client@camara-x'`)
    expect(vpnCommand(v, 'down')).toBe(`systemctl stop 'openvpn-client@camara-x'`)
    expect(vpnCommand(v, 'status')).toBe(`systemctl is-active 'openvpn-client@camara-x'`)
  })

  it('builds openfortivpn on its template unit', () => {
    const v = preset('openfortivpn', 'cm.x')
    expect(vpnCommand(v, 'up')).toBe(`systemctl start 'openfortivpn@cm.x'`)
    expect(vpnCommand(v, 'status')).toBe(`systemctl is-active 'openfortivpn@cm.x'`)
  })

  it('builds wireguard with wg-quick and ip link', () => {
    const v = preset('wireguard', 'wg0')
    expect(vpnCommand(v, 'up')).toBe(`wg-quick up 'wg0'`)
    expect(vpnCommand(v, 'down')).toBe(`wg-quick down 'wg0'`)
    expect(vpnCommand(v, 'status')).toBe(`ip link show dev 'wg0'`)
  })

  it('builds nmcli, the status listing the active connections', () => {
    const v = preset('nmcli', 'Camara_X')
    expect(vpnCommand(v, 'up')).toBe(`nmcli connection up id 'Camara_X'`)
    expect(vpnCommand(v, 'down')).toBe(`nmcli connection down id 'Camara_X'`)
    expect(vpnCommand(v, 'status')).toBe(`nmcli -t -f NAME connection show --active`)
  })

  it('refuses a target that is not a plain name, whatever the kind', () => {
    const attempts = [
      'wg0; rm -rf /',
      "x' ; id; '",
      '$(id)',
      '`id`',
      'a b',
      'a|b',
      'a&b',
      'a>b',
      '../etc/x',
      'a\nb',
      '-x',
      '--help',
      '',
      'x'.repeat(65),
      'ção'
    ]
    for (const kind of ['openvpn', 'wireguard', 'nmcli', 'openfortivpn'] as const) {
      for (const target of attempts) {
        for (const action of ['up', 'down', 'status'] as const) {
          expect(vpnCommand(preset(kind, target), action), `${kind} ${JSON.stringify(target)}`).toBeNull()
        }
      }
    }
  })

  it('accepts the characters a unit, interface or connection name uses', () => {
    for (const ok of ['wg0', 'client.conf-1', 'a@b', 'A_b.c-d', 'x'.repeat(64)]) expect(isSafeVpnTarget(ok), ok).toBe(true)
    expect(isSafeVpnTarget('-wg0')).toBe(false)
  })

  it('always quotes the target, even where it would be safe bare', () => {
    expect(vpnCommand(preset('wireguard', 'wg0'), 'up')).toContain(`'wg0'`)
  })
})

describe('vpnCommand: custom', () => {
  const custom: VpnProfile = { id: 'c', name: 'C', kind: 'custom', up: ' sudo touch /tmp/x ', down: 'rm -f /tmp/x', status: 'test -f /tmp/x' }

  it('runs the user lines as written, trimmed', () => {
    expect(vpnCommand(custom, 'up')).toBe('sudo touch /tmp/x')
    expect(vpnCommand(custom, 'down')).toBe('rm -f /tmp/x')
    expect(vpnCommand(custom, 'status')).toBe('test -f /tmp/x')
  })

  it('ignores a target on a custom profile', () => {
    expect(vpnCommand({ ...custom, target: 'wg0' }, 'up')).toBe('sudo touch /tmp/x')
  })

  it('refuses a missing, multi-line or too long command', () => {
    expect(vpnCommand({ ...custom, up: '' }, 'up')).toBeNull()
    expect(vpnCommand({ ...custom, up: 'a\nb' }, 'up')).toBeNull()
    expect(vpnCommand({ ...custom, up: 'x'.repeat(MAX_VPN_COMMAND + 1) }, 'up')).toBeNull()
    expect(vpnCommand({ ...custom, up: 'x'.repeat(MAX_VPN_COMMAND) }, 'up')).not.toBeNull()
  })
})

describe('readStatus', () => {
  it('reads nmcli up only on the exact active line', () => {
    const v = preset('nmcli', 'Camara_X')
    expect(readStatus(v, 0, 'Wired\nCamara_X\n')).toBe('up')
    expect(readStatus(v, 0, 'Camara_X2\nxCamara_X')).toBe('down')
    expect(readStatus(v, 8, 'Error: NetworkManager is not running.')).toBe('error')
  })

  it('takes a command that is not there as missing, never down', () => {
    expect(readStatus(preset('openvpn', 'x'), 127, 'sh: systemctl: not found')).toBe('missing')
    expect(readStatus(preset('nmcli', 'x'), 127, '')).toBe('missing')
    expect(readStatus(preset('wireguard', 'wg0'), 126, '')).toBe('missing')
  })

  it('reads the other kinds from the exit code', () => {
    expect(readStatus(preset('openvpn', 'x'), 0, 'active')).toBe('up')
    expect(readStatus(preset('openvpn', 'x'), 3, 'inactive')).toBe('down')
    expect(readStatus(preset('wireguard', 'wg0'), 1, "can't find device")).toBe('down')
    expect(readStatus({ id: 'c', name: 'C', kind: 'custom', up: 'u', down: 'd', status: 's' }, 1, '')).toBe('down')
  })
})

describe('vpnUsesSudo', () => {
  it('defaults to sudo for presets, not for custom', () => {
    expect(vpnUsesSudo({ kind: 'wireguard' }, 'up')).toBe(true)
    expect(vpnUsesSudo({ kind: 'custom' }, 'up')).toBe(false)
    expect(vpnUsesSudo({ kind: 'wireguard', sudo: false }, 'down')).toBe(false)
    expect(vpnUsesSudo({ kind: 'custom', sudo: true }, 'up')).toBe(true)
  })

  it('never uses sudo for a preset status, but does for a custom one that asks', () => {
    expect(vpnUsesSudo({ kind: 'openvpn', sudo: true }, 'status')).toBe(false)
    expect(vpnUsesSudo({ kind: 'custom', sudo: true }, 'status')).toBe(true)
  })
})

describe('checkVpns / usableVpns', () => {
  it('keeps only the fields the kind uses', () => {
    const res = checkVpns([
      { id: 'a', name: ' A ', kind: 'wireguard', target: 'wg0', up: 'x', sudo: false },
      { id: 'b', name: 'B', kind: 'custom', target: 'wg0', up: 'u', down: 'd', status: 's' }
    ])
    expect(res).toEqual({
      ok: true,
      vpns: [
        { id: 'a', name: 'A', kind: 'wireguard', target: 'wg0', sudo: false },
        { id: 'b', name: 'B', kind: 'custom', up: 'u', down: 'd', status: 's' }
      ]
    })
  })

  it('names the first problem and the profile at fault', () => {
    expect(checkVpns([{ id: 'a', name: 'A', kind: 'wireguard', target: 'wg0;id' }])).toEqual({ ok: false, problem: 'target', index: 0 })
    expect(checkVpns([preset('wireguard', 'wg0'), { id: 'b', name: '', kind: 'nmcli', target: 'x' }])).toEqual({ ok: false, problem: 'name', index: 1 })
    expect(checkVpns([{ id: 'a', name: 'A', kind: 'ipsec', target: 'x' }])).toEqual({ ok: false, problem: 'kind', index: 0 })
    expect(checkVpns([{ id: 'a', name: 'A', kind: 'custom', up: 'u', down: 'd' }])).toEqual({ ok: false, problem: 'status', index: 0 })
    expect(checkVpns([{ id: 'bad id', name: 'A', kind: 'nmcli', target: 'x' }])).toEqual({ ok: false, problem: 'id', index: 0 })
    expect(checkVpns([preset('nmcli', 'x'), preset('nmcli', 'y')])).toEqual({ ok: false, problem: 'id', index: 1 })
    expect(checkVpns(Array.from({ length: 21 }, (_, i) => ({ ...preset('nmcli', 'x'), id: `v${i}` })))).toEqual({ ok: false, problem: 'tooMany' })
  })

  it('reads absent as none', () => {
    expect(checkVpns(undefined)).toEqual({ ok: true, vpns: [] })
  })

  it('usableVpns drops what would not pass, for an imported host', () => {
    expect(usableVpns([preset('wireguard', '-x'), preset('nmcli', 'ok'), 'junk', null]).map((v) => v.target)).toEqual(['ok'])
    expect(usableVpns('nope')).toEqual([])
  })
})

describe('resolveVpn', () => {
  type H = VpnHostRef & { groupId?: string }
  const gw: H = { id: 'gw', vpns: [preset('wireguard', 'wg0'), { ...preset('nmcli', 'x'), id: 'v2', name: 'Other' }] }
  const groups: Record<string, { jumpHostId?: string; vpnId?: string; vpnAutoUp?: boolean }> = {
    g1: { jumpHostId: 'gw', vpnId: 'v2', vpnAutoUp: true },
    g2: { jumpHostId: 'gw' }
  }
  const jumpOf = (h: H): string | undefined => (h.groupId ? groups[h.groupId]?.jumpHostId : undefined)
  const vpnOf = (h: H) => (h.groupId ? groups[h.groupId] : undefined)

  it('gives no VPN to a host that asks for none', () => {
    const h: H = { id: 'h', jumpHostId: 'gw' }
    expect(resolveVpn(h, [gw, h], jumpOf, vpnOf)).toMatchObject({ ok: true, vpn: null, autoUp: false })
  })

  it('takes the host own VPN and its own autoUp', () => {
    const h: H = { id: 'h', jumpHostId: 'gw', vpnId: 'v1', vpnAutoUp: true }
    const r = resolveVpn(h, [gw, h], jumpOf, vpnOf)
    expect(r).toMatchObject({ ok: true, autoUp: true, vpnSource: 'host' })
    expect(r.ok && r.vpn?.id).toBe('v1')
  })

  it('inherits the group VPN, with the group autoUp, through the group gateway', () => {
    const h: H = { id: 'h', groupId: 'g1' }
    const r = resolveVpn(h, [gw, h], jumpOf, vpnOf)
    expect(r).toMatchObject({ ok: true, autoUp: true, vpnSource: 'group', jumpSource: 'group' })
    expect(r.ok && r.vpn?.id).toBe('v2')
  })

  it('lets a host override the group with its own choice or with none', () => {
    const own: H = { id: 'h', groupId: 'g1', vpnId: 'v1' }
    const r = resolveVpn(own, [gw, own], jumpOf, vpnOf)
    expect(r.ok && r.vpn?.id).toBe('v1')
    expect(r).toMatchObject({ autoUp: false })
    const none: H = { id: 'h', groupId: 'g1', vpnId: '' }
    expect(resolveVpn(none, [gw, none], jumpOf, vpnOf)).toMatchObject({ ok: true, vpn: null, vpnSource: 'none' })
  })

  it('refuses a VPN that is not on the gateway, or with no gateway at all', () => {
    const missing: H = { id: 'h', jumpHostId: 'gw', vpnId: 'gone' }
    expect(resolveVpn(missing, [gw, missing], jumpOf, vpnOf)).toMatchObject({ ok: false, problem: 'vpnMissing' })
    const direct: H = { id: 'h', jumpHostId: '', groupId: 'g1' }
    expect(resolveVpn(direct, [gw, direct], jumpOf, vpnOf)).toMatchObject({ ok: false, problem: 'vpnNoGateway', vpnSource: 'group' })
  })

  it('passes a jump problem through', () => {
    const h: H = { id: 'h', jumpHostId: 'nobody', vpnId: 'v1' }
    expect(resolveVpn(h, [gw, h], jumpOf, vpnOf)).toMatchObject({ ok: false, problem: 'unknown' })
  })

  it('ignores a profile on the gateway that would not pass the check', () => {
    const bad: H = { id: 'gw', vpns: [preset('wireguard', 'wg0; id')] }
    const h: H = { id: 'h', jumpHostId: 'gw', vpnId: 'v1' }
    expect(resolveVpn(h, [bad, h], jumpOf, vpnOf)).toMatchObject({ ok: false, problem: 'vpnMissing' })
  })

  it('checks only the host own choice on save', () => {
    const own: H = { id: 'h', jumpHostId: 'gw', vpnId: 'gone' }
    expect(vpnSaveProblem('h', [gw, own], jumpOf, vpnOf)).toBe('vpnMissing')
    const inherits: H = { id: 'h', groupId: 'g1', jumpHostId: '' }
    expect(vpnSaveProblem('h', [gw, inherits], jumpOf, vpnOf)).toBeNull()
  })

  it('checks a group VPN against its gateway', () => {
    expect(groupVpnProblem({ jumpHostId: 'gw', vpnId: 'v2' }, [gw])).toBeNull()
    expect(groupVpnProblem({ jumpHostId: 'gw', vpnId: 'nope' }, [gw])).toBe('vpnMissing')
    expect(groupVpnProblem({ vpnId: 'v2' }, [gw])).toBe('vpnNoGateway')
    expect(groupVpnProblem({ jumpHostId: 'gw' }, [gw])).toBeNull()
  })
})

describe('sudo lines', () => {
  it('probes with -n, then reads the password from stdin with no prompt and no cache', () => {
    expect(sudoProbeLine('test -f /x')).toBe(`env LC_ALL=C sudo -n -- sh -c 'echo ${RAN_MARKER}; test -f /x'`)
    expect(sudoStdinLine('test -f /x')).toBe(`env LC_ALL=C sudo -S -p '' -k -- sh -c 'echo ${RAN_MARKER}; test -f /x'`)
  })

  it('quotes a custom line with quotes in it as one sh -c argument', () => {
    expect(plainLine(`echo 'a'`)).toBe(`sh -c 'echo ${RAN_MARKER}; echo '\\''a'\\'''`)
  })

  it('never has room for a secret: the lines take only the command', () => {
    expect(sudoStdinLine.length).toBe(1)
    expect(sudoProbeLine.length).toBe(1)
  })
})

describe('sudoStep', () => {
  const ran = (code: number, out = '') => ({ code, stdout: `${RAN_MARKER}\n${out}`, stderr: '' })

  it('a probe that ran: the command exit code, the marker taken out', () => {
    expect(sudoStep('probe', ran(0, 'active\n'), false)).toEqual({ kind: 'ran', code: 0, output: 'active\n' })
    // test -f on a missing file: exit 1, and the command did run, so this is "down".
    expect(sudoStep('probe', ran(1), false)).toMatchObject({ kind: 'ran', code: 1 })
  })

  it('a probe sudo stopped for a password: retry with the secret, or say one is needed', () => {
    const asked = { code: 1, stdout: '', stderr: 'sudo: a password is required\n' }
    expect(sudoStep('probe', asked, true)).toEqual({ kind: 'retry-with-secret' })
    expect(sudoStep('probe', asked, false)).toEqual({ kind: 'needs-password' })
  })

  it('a refused password, with the same exit code 1, is never "down"', () => {
    const refused = { code: 1, stdout: '', stderr: 'Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n' }
    expect(sudoStep('stdin', refused, true)).toMatchObject({ kind: 'wrong-password' })
  })

  it('another sudo refusal is a sudo error, not "down"', () => {
    const notSudoer = { code: 1, stdout: '', stderr: 'demo is not in the sudoers file.\n' }
    expect(sudoStep('probe', notSudoer, true)).toMatchObject({ kind: 'sudo-error' })
    expect(sudoStep('stdin', notSudoer, true)).toMatchObject({ kind: 'sudo-error' })
  })

  it('a stdin run that ran is the command outcome, whatever sudo printed', () => {
    expect(sudoStep('stdin', { code: 1, stdout: `${RAN_MARKER}\n`, stderr: '' }, true)).toMatchObject({ kind: 'ran', code: 1 })
  })

  it('plainStep: a run without the marker did not start', () => {
    expect(plainStep({ code: 127, stdout: '', stderr: 'sh: not found' })).toMatchObject({ ran: false })
    expect(plainStep({ code: 0, stdout: `${RAN_MARKER}\nup\n`, stderr: '' })).toEqual({ ran: true, code: 0, output: 'up\n' })
  })
})

describe('scrubOutput', () => {
  it('strips ANSI escapes and control characters', () => {
    expect(scrubOutput('\x1b[1;32mactive\x1b[0m\r\n\x07')).toBe('active')
    expect(scrubOutput('\x1b]0;title\x07ok')).toBe('ok')
  })

  it('replaces every echoed secret before cutting to the last 2 KB', () => {
    const secret = 'S3cret-pw'
    expect(scrubOutput(`pw=${secret} again ${secret}`, [secret])).toBe('pw=•••• again ••••')
    // A secret that straddles the cut is replaced first, so no half of it survives.
    const long = `${'a'.repeat(3000)}${secret}${'b'.repeat(2040)}`
    const out = scrubOutput(long, [secret])
    expect(out).not.toContain('S3cret')
    expect(out).not.toContain('pw')
    expect(out.length).toBeLessThanOrEqual(2048)
    expect(out.startsWith('…')).toBe(true)
  })

  it('ignores an empty or missing secret', () => {
    expect(scrubOutput('abc', ['', undefined])).toBe('abc')
  })
})

describe('VPN fields on hosts and groups', () => {
  it('keeps a group VPN only with a gateway, and autoUp only with a VPN', async () => {
    const { cleanGroup, groupVpnLookup } = await import('./ssh-group-pure')
    expect(cleanGroup({ id: 'g', name: 'G', jumpHostId: 'gw', vpnId: 'v1', vpnAutoUp: true })).toEqual({ id: 'g', name: 'G', jumpHostId: 'gw', vpnId: 'v1', vpnAutoUp: true })
    expect(cleanGroup({ id: 'g', name: 'G', vpnId: 'v1', vpnAutoUp: true })).toEqual({ id: 'g', name: 'G' })
    expect(cleanGroup({ id: 'g', name: 'G', jumpHostId: 'gw', vpnAutoUp: true })).toEqual({ id: 'g', name: 'G', jumpHostId: 'gw' })
    const lookup = groupVpnLookup([{ id: 'g', name: 'G', jumpHostId: 'gw', vpnId: 'v1' }])
    expect(lookup({ groupId: 'g' })).toEqual({ vpnId: 'v1', vpnAutoUp: undefined })
    expect(lookup({})).toBeUndefined()
  })

  it('cleans a host VPN choice: an id or explicitly none, autoUp only with an id', async () => {
    const { cleanHostFields } = await import('./ssh-host-pure')
    const base = { name: 'n', host: 'h', username: 'u' }
    expect(cleanHostFields({ ...base, vpnId: ' v1 ', vpnAutoUp: true })).toMatchObject({ vpnId: 'v1', vpnAutoUp: true })
    expect(cleanHostFields({ ...base, vpnId: '', vpnAutoUp: true })).not.toHaveProperty('vpnAutoUp')
    expect(cleanHostFields({ ...base, vpnId: '' })).toMatchObject({ vpnId: '' })
    expect(cleanHostFields({ ...base, vpnId: 3 })).not.toHaveProperty('vpnId')
    expect(cleanHostFields({ ...base, vpnId: 'v1', vpnAutoUp: 'yes' })).not.toHaveProperty('vpnAutoUp')
  })
})
