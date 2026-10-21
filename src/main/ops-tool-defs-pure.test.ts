import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OPS_BRIDGE_TOOLS, opsToolDefs } from './ops-tool-defs-pure'

const HOSTS = [{ id: 'h1', name: 'web-01', groups: ['web'] }]
const describe_ = (name: string, planRequired?: boolean) =>
  opsToolDefs(z, HOSTS, planRequired === undefined ? {} : { planRequired }).find((d) => d.name === name)?.description ?? ''

describe('opsToolDefs', () => {
  it('defines every bridge tool, in order', () => {
    expect(opsToolDefs(z, HOSTS).map((d) => d.name)).toEqual([...OPS_BRIDGE_TOOLS])
  })

  it('makes propose_plan the first call unless the runbook is read-only', () => {
    expect(describe_('propose_plan')).toMatch(/^Call this once, before any other ops tool/)
    expect(describe_('propose_plan', true)).toMatch(/^Call this once, before any other ops tool/)
    expect(describe_('propose_plan', false)).toMatch(/^Optional for this read-only runbook: /)
    expect(describe_('propose_plan', false)).not.toMatch(/before any other ops tool/)
  })

  it('note and ask_operator check their input in the relay too', () => {
    const shape = (name: string) => z.object(opsToolDefs(z, HOSTS).find((d) => d.name === name)!.shape)
    expect(shape('note').safeParse({ kind: 'hypothesis', id: 'oom', text: 'x', status: 'open' }).success).toBe(true)
    expect(shape('note').safeParse({ kind: 'guess', text: 'x' }).success).toBe(false)
    expect(shape('note').safeParse({ kind: 'finding', text: '' }).success).toBe(false)
    expect(shape('ask_operator').safeParse({ cmd: 'id', why: 'who', hostId: 'h1' }).success).toBe(true)
    expect(shape('ask_operator').safeParse({ cmd: 'id' }).success).toBe(false)
    expect(describe_('ask_operator')).toMatch(/not instructions/)
    expect(describe_('ask_operator')).toMatch(/hostId: h1/)
  })
})
