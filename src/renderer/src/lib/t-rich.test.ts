import { describe, it, expect } from 'vitest'
import { createElement as h, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { rich } from './t-rich'

/** The node a slot fragment wraps, or undefined when `part` is not a fragment. */
const inner = (part: ReactNode): ReactNode => {
  if (!isValidElement(part) || part.type !== Fragment) return undefined
  return (part as ReactElement<{ children: ReactNode }>).props.children
}

describe('rich', () => {
  it('returns the text alone when there are no slots', () => {
    expect(rich('Nothing to fill here.', { path: h('code', null, 'x') })).toEqual(['Nothing to fill here.'])
  })

  it('puts a node where its single slot is', () => {
    const code = h('code', null, '~/.ssh')
    const out = rich('Keys live in {path} on this machine.', { path: code })
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('Keys live in ')
    expect(inner(out[1])).toBe(code)
    expect(out[2]).toBe(' on this machine.')
  })

  it('fills several slots in the order the text has them', () => {
    const a = h('b', null, 'A')
    const b = h('i', null, 'B')
    const out = rich('{second} before {first}', { first: a, second: b })
    expect(out).toHaveLength(3)
    expect(inner(out[0])).toBe(b)
    expect(out[1]).toBe(' before ')
    expect(inner(out[2])).toBe(a)
  })

  it('repeats a node for a slot that appears twice, with distinct keys', () => {
    const host = h('strong', null, 'web-1')
    const out = rich('{host} or {host}', { host })
    expect(out).toHaveLength(3)
    expect(inner(out[0])).toBe(host)
    expect(inner(out[2])).toBe(host)
    expect(isValidElement(out[0]) && isValidElement(out[2]) && out[0].key !== out[2].key).toBe(true)
  })

  it('leaves a marker with no node as written', () => {
    const out = rich('Hello {name}, see {path}', { path: h('code', null, 'p') })
    expect(out[0]).toBe('Hello ')
    expect(out[1]).toBe('{name}')
    expect(out[2]).toBe(', see ')
    expect(isValidElement(out[3])).toBe(true)
  })

  it('accepts plain strings as slot values', () => {
    const out = rich('Guidelines in {file}: {text}', { text: 'Be careful {file}.', file: 'RUNBOOK.md' })
    expect(out.map(inner)).toEqual([undefined, 'RUNBOOK.md', undefined, 'Be careful {file}.'])
  })
})
