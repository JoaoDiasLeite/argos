import { describe, it, expect } from 'vitest'
import { distinctTitles, interventionLabel, type InterventionLabelInput } from './intervention-label'
import { makeT } from '../../../shared/i18n'

const en = makeT('en')
const pt = makeT('pt-PT')

const base: InterventionLabelInput = {
  runbook: 'C:\\argos\\runbooks\\despiste',
  builtin: true,
  server: { kind: 'host', name: 'web1' }
}

describe('interventionLabel', () => {
  it('names the server and tags the built-in runbook in the UI language', () => {
    expect(interventionLabel(base, en)).toMatchObject({ title: 'web1', tag: 'Diagnosis', tagTone: 'neutral' })
    expect(interventionLabel(base, pt)).toMatchObject({ title: 'web1', tag: 'Despiste' })
  })

  it('tags another runbook with its folder, amber when it changes the server', () => {
    const rb = { ...base, runbook: '/rb/pg-tls-renew/', builtin: false }
    expect(interventionLabel(rb, en)).toMatchObject({ tag: 'pg-tls-renew', tagTone: 'neutral' })
    expect(interventionLabel({ ...rb, mutates: true }, en).tagTone).toBe('warn')
    // The built-in one is read-only whatever is said.
    expect(interventionLabel({ ...base, mutates: true }, en).tagTone).toBe('neutral')
  })

  it('names an open intervention by the servers it reached', () => {
    expect(interventionLabel({ ...base, server: { kind: 'open' } }, en).title).toBe('Several servers')
    expect(interventionLabel({ ...base, server: { kind: 'open' } }, pt).title).toBe('Vários servidores')
    expect(interventionLabel({ ...base, server: { kind: 'open', reached: ['db1', 'web1'] } }, en).title).toBe('db1, web1')
    const many = interventionLabel({ ...base, server: { kind: 'open', reached: ['a', 'b', 'c', 'd'] } }, en)
    expect(many.title).toBe('a, b +2')
    expect(many.tooltip.split('\n')[0]).toBe('Servers reached: a, b, c, d')
  })

  it('waits on an unknown server name', () => {
    expect(interventionLabel({ ...base, server: { kind: 'host' } }, en).title).toBe('…')
  })

  it('puts server, mode, client, ticket and task in the tooltip', () => {
    const l = interventionLabel({ ...base, client: 'CM Porto', ticket: 'WM-12', task: 'Disk full', waiting: true }, en)
    expect(l.tooltip).toBe('Server: web1 (waiting for you)\nMode: Diagnosis\nClient: CM Porto\nTicket: WM-12\nTask: Disk full')
    const rb = interventionLabel({ ...base, builtin: false, runbook: '/rb/nginx', ended: true }, pt)
    expect(rb.tooltip).toBe('Servidor: web1 (parada)\nRunbook: nginx')
  })
})

describe('distinctTitles', () => {
  const label = (title: string, tag = 'Diagnosis') => ({ title, tag, tagTone: 'neutral' as const, tooltip: '' })

  it('leaves distinct titles alone', () => {
    expect(distinctTitles([{ label: label('web1') }, { label: label('web1', 'nginx') }, { label: label('db1') }])).toEqual([
      'web1',
      'web1',
      'db1'
    ])
  })

  it('tells clashes apart by ticket, then by opening order', () => {
    expect(
      distinctTitles([
        { label: label('web1') },
        { label: label('web1'), ticket: 'WM-1' },
        { label: label('web1') },
        { label: label('web1') }
      ])
    ).toEqual(['web1', 'web1 · WM-1', 'web1 #2', 'web1 #3'])
  })
})
