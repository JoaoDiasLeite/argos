import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OPS_BRIDGE_TOOLS, OPS_TOOL_RULES, OPS_WHY_MAX, opsToolDefs } from './ops-tool-defs-pure'

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
    expect(shape('note').safeParse({ kind: 'summary', text: 's'.repeat(1500) }).success).toBe(true)
    expect(shape('note').safeParse({ kind: 'action', text: 'x', when: 'later' }).success).toBe(true)
    expect(shape('note').safeParse({ kind: 'action', text: 'x', when: 'soon' }).success).toBe(false)
    expect(describe_('note')).toMatch(/summary note/)
    expect(shape('ask_operator').safeParse({ cmd: 'id', why: 'who', hostId: 'h1' }).success).toBe(true)
    expect(shape('ask_operator').safeParse({ cmd: 'id' }).success).toBe(false)
    expect(describe_('ask_operator')).toMatch(/not instructions/)
    expect(describe_('ask_operator')).toMatch(/hostId: h1/)
  })

  it('asks run, script and write for a one-line why, and lets read and list leave it out', () => {
    const shape = (name: string) => z.object(opsToolDefs(z, HOSTS).find((d) => d.name === name)!.shape)
    expect(shape('run').safeParse({ hostId: 'h1', cmd: 'df -h', why: 'Ver o espaço livre.' }).success).toBe(true)
    expect(shape('run').safeParse({ hostId: 'h1', cmd: 'df -h' }).success).toBe(false)
    expect(shape('run').safeParse({ hostId: 'h1', cmd: 'df -h', why: '' }).success).toBe(false)
    expect(shape('run').safeParse({ hostId: 'h1', cmd: 'df -h', why: 'x'.repeat(OPS_WHY_MAX + 1) }).success).toBe(false)
    expect(shape('script').safeParse({ hostId: 'h1', name: 'a.sh' }).success).toBe(false)
    expect(shape('script').safeParse({ hostId: 'h1', name: 'a.sh', why: 'w' }).success).toBe(true)
    expect(shape('write').safeParse({ hostId: 'h1', path: '/a', content: '' }).success).toBe(false)
    expect(shape('read').safeParse({ hostId: 'h1', path: '/a' }).success).toBe(true)
    expect(shape('list').safeParse({ hostId: 'h1', path: '/a', why: 'w' }).success).toBe(true)
    for (const name of ['run', 'script', 'read', 'list', 'write']) expect(describe_(name)).toMatch(/Give why: one sentence/)
  })

  it('offers past_interventions as a local read with an optional run id, and names it in the rules', () => {
    const shape = z.object(opsToolDefs(z, HOSTS).find((d) => d.name === 'past_interventions')!.shape)
    expect(shape.safeParse({}).success).toBe(true)
    expect(shape.safeParse({ runId: 'run-20261103-ab_1' }).success).toBe(true)
    expect(shape.safeParse({ runId: '../etc' }).success).toBe(false)
    expect(describe_('past_interventions')).toMatch(/never touches a host/)
    expect(OPS_TOOL_RULES).toMatch(/past_interventions/)
  })
})
