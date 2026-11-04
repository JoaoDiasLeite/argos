import { describe, expect, it } from 'vitest'
import { chainIsEmpty, chainsOf } from './ops-chains'
import type { OpsRunListItem } from '../types'

const run = (runId: string, startedAt: string, extra: Partial<OpsRunListItem> = {}): OpsRunListItem => ({
  runId,
  appSessionId: 's',
  startedAt,
  endedAt: startedAt,
  runbook: 'diagnosis',
  runbookPath: '/rb',
  hostNames: ['Storm'],
  calls: 0,
  ...extra
})

describe('chainsOf', () => {
  it('joins a run with the one that resumed it, newest first', () => {
    const runs = [
      run('c', '2026-11-03T10:00:00Z', { resumesRunId: 'b', calls: 3, headline: 'Found it', openHypotheses: 2 }),
      run('x', '2026-11-02T10:00:00Z', { calls: 1, task: 'Other' }),
      run('b', '2026-11-01T10:00:00Z', { resumesRunId: 'a', calls: 2, headline: 'Old' }),
      run('a', '2026-10-31T10:00:00Z', { calls: 4, task: 'Slow login' })
    ]
    const chains = chainsOf(runs)
    expect(chains.map((c) => c.newest.runId)).toEqual(['c', 'x'])
    const [c] = chains
    expect(c.runs.map((r) => r.runId)).toEqual(['c', 'b', 'a'])
    expect(c.oldest.runId).toBe('a')
    expect(c.sessions).toBe(3)
    expect(c.calls).toBe(9)
    expect(c.headline).toBe('Found it')
    expect(c.task).toBe('Slow login')
    expect(c.hostName).toBe('Storm')
    expect(c.openHypotheses).toBe(2)
  })

  it('falls back to the first non-empty headline in the chain', () => {
    const [c] = chainsOf([
      run('b', '2026-11-01T10:00:00Z', { resumesRunId: 'a' }),
      run('a', '2026-10-31T10:00:00Z', { headline: '  Root cause  ' })
    ])
    expect(c.headline).toBe('Root cause')
    expect(c.openHypotheses).toBe(0)
  })

  it('keeps a run whose parent is missing, and survives a cycle', () => {
    const chains = chainsOf([
      run('b', '2026-11-02T10:00:00Z', { resumesRunId: 'gone' }),
      run('p', '2026-11-01T10:00:00Z', { resumesRunId: 'q' }),
      run('q', '2026-10-31T10:00:00Z', { resumesRunId: 'p' })
    ])
    expect(chains.flatMap((c) => c.runs).map((r) => r.runId).sort()).toEqual(['b', 'p', 'q'])
  })
})

describe('chainIsEmpty', () => {
  it('is empty only when every run is a bare start and stop', () => {
    expect(chainIsEmpty(chainsOf([run('a', '2026-11-01T10:00:00Z')])[0])).toBe(true)
    expect(chainIsEmpty(chainsOf([run('a', '2026-11-01T10:00:00Z', { calls: 1 })])[0])).toBe(false)
    expect(chainIsEmpty(chainsOf([run('a', '2026-11-01T10:00:00Z', { endedAt: undefined })])[0])).toBe(false)
  })
})
