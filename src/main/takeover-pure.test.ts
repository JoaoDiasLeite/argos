import { describe, it, expect } from 'vitest'
import { RegistryEntry } from './live-sessions-pure'
import { ProcessIdentity, verifyTakeover } from './takeover-pure'

const OURS = 'win32:joao-leite'
const START = '134324039312837109'

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 33040,
    sessionId: 'a-session',
    cwd: 'C:\\dev\\thing',
    name: 'thing-1',
    status: 'idle',
    kind: 'interactive',
    startedAt: 1,
    updatedAt: 2,
    procStart: START,
    pidDomain: OURS,
    ...over
  }
}

const live: ProcessIdentity = { name: 'claude', procStart: START }

describe('verifyTakeover', () => {
  it('allows a session that clears every guard, and signals the pid the registry gives', () => {
    expect(verifyTakeover(entry(), 33040, OURS, live)).toEqual({ ok: true, pid: 33040 })
  })

  // No entry means the session ended between the listing and the click.
  it('refuses when the session is no longer in the registry', () => {
    expect(verifyTakeover(null, 33040, OURS, live)).toEqual({ ok: false, error: 'not-found' })
  })

  // The one refusal that can never be resolved by retrying: that pid names an
  // unrelated process on this side.
  it('refuses a pid from another domain even when everything else lines up', () => {
    const res = verifyTakeover(entry({ pidDomain: 'linux:ubuntu' }), 33040, OURS, live)
    expect(res).toEqual({ ok: false, error: 'foreign' })
  })

  // Checked before the identity read, so a foreign entry is never probed at all.
  it('refuses a foreign entry without needing any process identity', () => {
    const res = verifyTakeover(entry({ pidDomain: 'linux:ubuntu' }), 33040, OURS, null)
    expect(res).toEqual({ ok: false, error: 'foreign' })
  })

  // The session restarted between render and click: the click aimed at a dead pid.
  it('refuses when the registry now names a different pid than the one shown', () => {
    expect(verifyTakeover(entry({ pid: 40000 }), 33040, OURS, live)).toEqual({
      ok: false,
      error: 'pid-changed'
    })
  })

  // Without a recorded start time there is no way to rule out pid reuse, so the
  // signal is refused rather than sent unguarded.
  it('refuses an entry that carries no start time', () => {
    expect(verifyTakeover(entry({ procStart: '' }), 33040, OURS, live)).toEqual({
      ok: false,
      error: 'no-proc-start'
    })
  })

  // "I could not tell" must never read as "yes".
  it('refuses when the process identity could not be read', () => {
    expect(verifyTakeover(entry(), 33040, OURS, null)).toEqual({
      ok: false,
      error: 'unverifiable'
    })
  })

  // The pid was recycled: something else is wearing it now.
  it('refuses when the live start time differs from the recorded one', () => {
    const other: ProcessIdentity = { name: 'claude', procStart: '134324039312837110' }
    expect(verifyTakeover(entry(), 33040, OURS, other)).toEqual({
      ok: false,
      error: 'pid-reused'
    })
  })

  // A one-digit difference is a different process. Compared as strings precisely so
  // this cannot round to equal.
  it('treats a start time differing only in its last digit as a different process', () => {
    const off = { name: 'claude', procStart: START.slice(0, -1) + '8' }
    expect(verifyTakeover(entry(), 33040, OURS, off).ok).toBe(false)
  })

  it('refuses a process that is not claude', () => {
    const other: ProcessIdentity = { name: 'postgres', procStart: START }
    expect(verifyTakeover(entry(), 33040, OURS, other)).toEqual({
      ok: false,
      error: 'not-claude'
    })
  })

  it('accepts the process name whatever its case', () => {
    const shouty: ProcessIdentity = { name: 'CLAUDE', procStart: START }
    expect(verifyTakeover(entry(), 33040, OURS, shouty).ok).toBe(true)
  })

  it('matches the pid domain case-insensitively', () => {
    expect(verifyTakeover(entry({ pidDomain: 'WIN32:JOAO-LEITE' }), 33040, OURS, live).ok).toBe(true)
  })

  // Ordering matters: the domain check is absolute and must not be reachable past a
  // more forgiving one.
  it('reports the domain refusal ahead of a changed pid', () => {
    const res = verifyTakeover(entry({ pidDomain: 'linux:ubuntu', pid: 999 }), 33040, OURS, live)
    expect(res).toEqual({ ok: false, error: 'foreign' })
  })
})
