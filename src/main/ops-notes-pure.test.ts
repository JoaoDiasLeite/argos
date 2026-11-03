import { describe, expect, it } from 'vitest'
import { runHeadline, type FoldedNotes } from './ops-notes-pure'

const empty = (): FoldedNotes => ({ hypotheses: [], findings: [], events: [], actions: [], asks: [] })

describe('runHeadline', () => {
  it('is undefined when the run noted nothing', () => {
    expect(runHeadline(empty())).toBeUndefined()
  })

  it('prefers the summary, then a confirmed hypothesis, then a finding, then any hypothesis', () => {
    const f = empty()
    f.hypotheses.push({ id: 'h1', text: 'open one', status: 'open' })
    expect(runHeadline(f)).toBe('open one')
    f.findings.push({ kind: 'finding', text: 'a finding' } as FoldedNotes['findings'][number])
    expect(runHeadline(f)).toBe('a finding')
    f.hypotheses.push({ id: 'h2', text: 'the cause', status: 'confirmed' })
    expect(runHeadline(f)).toBe('the cause')
    f.summary = 'Puma  a reiniciar\nde 5 em 5 minutos'
    expect(runHeadline(f)).toBe('Puma a reiniciar de 5 em 5 minutos')
  })

  it('cuts a long line', () => {
    const f = empty()
    f.summary = 'x'.repeat(300)
    const h = runHeadline(f)!
    expect(h.length).toBe(140)
    expect(h.endsWith('…')).toBe(true)
  })
})
