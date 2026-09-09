import { describe, it, expect } from 'vitest'
import {
  isSameDomain,
  linuxMachineId,
  parseRegistryEntry,
  pidDomainFor,
  procStartFromStat
} from './live-sessions-pure'

/**
 * A real registry file from this machine, verbatim apart from the socket path. Every
 * case below starts from this and takes one field away, so a test that passes is a
 * test that ran against the shape Claude Code actually writes.
 */
const REAL = {
  pid: 33040,
  sessionId: '4a62471b-5a99-4e66-aecf-a88dd8c080af',
  cwd: 'C:\\Users\\JoãoLeite\\Desktop\\João\\Projetos\\claude-gui',
  startedAt: 1787930332048,
  procStart: '134324039312837109',
  version: '2.1.250',
  peerProtocol: 1,
  peerFeatures: ['notify_idle', 'artifact_yield'],
  kind: 'interactive',
  entrypoint: 'cli',
  pidDomain: 'win32:joao-leite',
  name: 'claude-gui-26',
  nameSource: 'derived',
  nameSince: 1787930332048,
  status: 'busy',
  updatedAt: 1787937363419,
  statusUpdatedAt: 1787937363419
}

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...REAL }
  delete copy[key]
  return copy
}

describe('parseRegistryEntry', () => {
  it('reads a real registry entry', () => {
    const e = parseRegistryEntry(REAL)!
    expect(e).not.toBeNull()
    expect(e.pid).toBe(33040)
    expect(e.sessionId).toBe('4a62471b-5a99-4e66-aecf-a88dd8c080af')
    expect(e.name).toBe('claude-gui-26')
    expect(e.status).toBe('busy')
    expect(e.kind).toBe('interactive')
    expect(e.version).toBe('2.1.250')
    expect(e.pidDomain).toBe('win32:joao-leite')
  })

  it('keeps procStart as the raw string, unparsed', () => {
    // 134324039312837109 is past Number.MAX_SAFE_INTEGER: parsing it and printing it
    // back gives ...120, and a PID-reuse guard that is off by eleven is not a guard.
    const e = parseRegistryEntry(REAL)!
    expect(e.procStart).toBe('134324039312837109')
    expect(String(Number(e.procStart))).not.toBe(e.procStart)
  })

  it('rejects anything that is not a JSON object', () => {
    expect(parseRegistryEntry(null)).toBeNull()
    expect(parseRegistryEntry(undefined)).toBeNull()
    expect(parseRegistryEntry('{}')).toBeNull()
    expect(parseRegistryEntry(42)).toBeNull()
    expect(parseRegistryEntry([REAL])).toBeNull()
  })

  it('rejects a pid that is not a positive safe integer', () => {
    // 0 and -1 are process-group wildcards to process.kill, not processes.
    expect(parseRegistryEntry({ ...REAL, pid: 0 })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pid: -1 })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pid: 12.5 })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pid: Number.NaN })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pid: 2 ** 60 })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pid: '33040' })).toBeNull()
    expect(parseRegistryEntry(without('pid'))).toBeNull()
  })

  it('rejects a missing or empty sessionId', () => {
    expect(parseRegistryEntry(without('sessionId'))).toBeNull()
    expect(parseRegistryEntry({ ...REAL, sessionId: '' })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, sessionId: 123 })).toBeNull()
  })

  it('rejects a missing pidDomain rather than defaulting it to ours', () => {
    // The whole point: an entry that will not say which PID space it belongs to is
    // exactly the one that must never be signalled.
    expect(parseRegistryEntry(without('pidDomain'))).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pidDomain: '' })).toBeNull()
    expect(parseRegistryEntry({ ...REAL, pidDomain: null })).toBeNull()
  })

  it('maps an absent status to unknown, never to idle', () => {
    // One of the three live entries on this machine genuinely has no status field.
    const e = parseRegistryEntry(without('status'))!
    expect(e.status).toBe('unknown')
  })

  it('maps an unrecognised status to unknown', () => {
    expect(parseRegistryEntry({ ...REAL, status: 'thinking' })!.status).toBe('unknown')
    expect(parseRegistryEntry({ ...REAL, status: 7 })!.status).toBe('unknown')
    expect(parseRegistryEntry({ ...REAL, status: 'idle' })!.status).toBe('idle')
  })

  it('blanks a missing cwd, name and kind instead of rejecting the entry', () => {
    const e = parseRegistryEntry({
      pid: 1234,
      sessionId: 'sid',
      pidDomain: 'win32:host',
      procStart: '1'
    })!
    expect(e.cwd).toBe('')
    expect(e.name).toBe('')
    expect(e.kind).toBe('')
    expect(e.version).toBeUndefined()
  })

  it('blanks a missing procStart but still lists the entry', () => {
    // Not signallable in round 2, still worth showing as live in round 1.
    const e = parseRegistryEntry(without('procStart'))!
    expect(e.procStart).toBe('')
  })

  it('zeroes non-numeric timestamps rather than carrying junk into a sort', () => {
    const e = parseRegistryEntry({ ...REAL, startedAt: 'soon', updatedAt: undefined })!
    expect(e.startedAt).toBe(0)
    expect(e.updatedAt).toBe(0)
  })
})

describe('pidDomainFor', () => {
  it('builds the observed <platform>:<identity> shape', () => {
    expect(pidDomainFor('win32', 'joao-leite')).toBe('win32:joao-leite')
    expect(pidDomainFor('linux', 'ubuntu')).toBe('linux:ubuntu')
  })

  it('lower-cases the identity, because the registry writes it lower-cased', () => {
    // Verified on this machine: os.hostname() is `JOAO-LEITE`, and the registry's
    // pidDomain is `win32:joao-leite`. Without the lowering, our own entries would
    // read as foreign on nothing but case.
    expect(pidDomainFor('win32', 'JOAO-LEITE')).toBe('win32:joao-leite')
  })
})

describe('isSameDomain', () => {
  it('matches two domains that say the same thing', () => {
    expect(isSameDomain('win32:joao-leite', 'win32:joao-leite')).toBe(true)
  })

  it('ignores case on both sides', () => {
    expect(isSameDomain('WIN32:Joao-Leite', 'win32:joao-leite')).toBe(true)
  })

  it('separates another platform, host or user', () => {
    // A WSL distro's pid 33040 names some process of that distro's, not ours.
    expect(isSameDomain('linux:ubuntu', 'win32:joao-leite')).toBe(false)
    expect(isSameDomain('win32:other-pc', 'win32:joao-leite')).toBe(false)
  })

  it('never treats an unknown domain as a match', () => {
    // "I could not tell" reading as "yes" is how a terminate lands on a stranger.
    expect(isSameDomain('', 'win32:joao-leite')).toBe(false)
    expect(isSameDomain('win32:joao-leite', '')).toBe(false)
    expect(isSameDomain('', '')).toBe(false)
  })
})

describe('linuxMachineId', () => {
  it('reads the machine-id out of a real WSL pid domain', () => {
    expect(linuxMachineId('linux:06178f3711d44ca1ab0929a257093c5b:pid:[4026532245]')).toBe(
      '06178f3711d44ca1ab0929a257093c5b'
    )
  })

  it('returns null for a domain that is not the linux shape', () => {
    expect(linuxMachineId('win32:joao-leite')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(linuxMachineId('')).toBeNull()
  })
})

describe('procStartFromStat', () => {
  // A real /proc/<pid>/stat line from a WSL distro on this machine.
  const REAL_STAT =
    '106381 (claude) S 60945 106381 60945 34824 106381 4194304 339085 1872852 102 4971 12430 4077 3118 1388 20 0 23 0 266801 5736427520 76337 18446744073709551615 26319360 87422288 140723438040560 0 0 0 0 4096 2072145151 0 0 0 17 9 0 0 0 0 0 87426384 217989120 376877056 140723438046951 140723438047003 140723438047003 140723438051292 0'

  it('reads field 22 (starttime) from a real stat line', () => {
    expect(procStartFromStat(REAL_STAT)).toBe('266801')
  })

  it('returns the value as a string, not a number', () => {
    // Same float53 reasoning as RegistryEntry.procStart: assert it round-trips a
    // starttime too large for Number to represent exactly.
    const huge = REAL_STAT.replace('266801', '134324039312837109')
    const result = procStartFromStat(huge)
    expect(result).toBe('134324039312837109')
    expect(String(Number(result))).not.toBe(result)
  })

  it('handles a comm containing spaces and a closing paren', () => {
    // After the last ')': "S" is field 3 (state), so the fields below start at field
    // 4 — starttime is field 22, i.e. index 22 - 4 = 18 into this array.
    const fields = Array(40).fill('0')
    fields[18] = '266801'
    const line = `1234 (my ) proc) S ${fields.join(' ')}`
    expect(procStartFromStat(line)).toBe('266801')
  })

  it('returns null for a truncated or garbage line', () => {
    expect(procStartFromStat('')).toBeNull()
    expect(procStartFromStat('not a stat line at all')).toBeNull()
    expect(procStartFromStat('106381 (claude) S 1 2 3')).toBeNull()
  })
})
