import { describe, it, expect } from 'vitest'
import { noteTerminalBusy, runIndicatorCount } from './run-indicators-pure'

describe('run indicators from terminal busy', () => {
  it('counts SDK runs and busy terminals together', () => {
    expect(runIndicatorCount(0, new Set())).toBe(0)
    expect(runIndicatorCount(2, new Set(['t1']))).toBe(3)
  })

  it('announces only transitions', () => {
    const set = new Set<string>()
    expect(noteTerminalBusy(set, 't1', true, 0)).toEqual({ kind: 'started', total: 1 })
    expect(noteTerminalBusy(set, 't1', true, 0)).toEqual({ kind: 'none', total: 1 })
    expect(noteTerminalBusy(set, 't2', true, 0)).toEqual({ kind: 'started', total: 2 })
    expect(noteTerminalBusy(set, 't1', false, 0)).toEqual({ kind: 'finished', total: 1 })
    expect(noteTerminalBusy(set, 't1', false, 0)).toEqual({ kind: 'none', total: 1 })
    expect(noteTerminalBusy(set, 't2', false, 0)).toEqual({ kind: 'finished', total: 0 })
  })

  it('an idle terminal never seen busy is not a finish', () => {
    expect(noteTerminalBusy(new Set(), 'tx', false, 0)).toEqual({ kind: 'none', total: 0 })
  })

  it('a finish while an SDK run is still going leaves the total above zero', () => {
    const set = new Set(['t1'])
    expect(noteTerminalBusy(set, 't1', false, 1)).toEqual({ kind: 'finished', total: 1 })
  })
})
