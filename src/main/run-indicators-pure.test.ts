import { describe, it, expect } from 'vitest'
import { noteTerminalBusy } from './run-indicators-pure'

describe('run indicators from terminal busy', () => {
  it('announces only transitions', () => {
    const set = new Set<string>()
    expect(noteTerminalBusy(set, 't1', true)).toEqual({ kind: 'started', total: 1 })
    expect(noteTerminalBusy(set, 't1', true)).toEqual({ kind: 'none', total: 1 })
    expect(noteTerminalBusy(set, 't2', true)).toEqual({ kind: 'started', total: 2 })
    expect(noteTerminalBusy(set, 't1', false)).toEqual({ kind: 'finished', total: 1 })
    expect(noteTerminalBusy(set, 't1', false)).toEqual({ kind: 'none', total: 1 })
    expect(noteTerminalBusy(set, 't2', false)).toEqual({ kind: 'finished', total: 0 })
  })

  it('an idle terminal never seen busy is not a finish', () => {
    expect(noteTerminalBusy(new Set(), 'tx', false)).toEqual({ kind: 'none', total: 0 })
  })
})
