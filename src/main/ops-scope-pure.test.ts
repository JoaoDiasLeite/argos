import { describe, it, expect } from 'vitest'
import { HOST_ASK_REASON, hostApprovalContext, interventionPrompt, scopeVerdict } from './ops-scope-pure'
import { classifyPlanSteps } from './ops-run-pure'
import type { OpsPolicy } from './ops-types'
import { makeT } from '../shared/i18n'

const t = makeT('en')

describe('scopeVerdict', () => {
  const none = new Set<string>()

  it('a host scope allows its own host and denies every other', () => {
    expect(scopeVerdict({ kind: 'host', hostId: 'h1' }, 'h1', none)).toBe('allow')
    expect(scopeVerdict({ kind: 'host', hostId: 'h1' }, 'h2', none)).toBe('deny')
    // An approval cannot widen a locked scope.
    expect(scopeVerdict({ kind: 'host', hostId: 'h1' }, 'h2', new Set(['h2']))).toBe('deny')
  })

  it('an open scope asks first, then keeps the answer', () => {
    expect(scopeVerdict({ kind: 'open' }, 'h2', none)).toBe('ask')
    expect(scopeVerdict({ kind: 'open' }, 'h2', new Set(['h2']))).toBe('allow')
    expect(scopeVerdict({ kind: 'open' }, 'h2', none, new Set(['h2']))).toBe('deny')
    // A refusal wins over an approval.
    expect(scopeVerdict({ kind: 'open' }, 'h2', new Set(['h2']), new Set(['h2']))).toBe('deny')
  })
})

describe('hostApprovalContext', () => {
  it('names the host asked for and says why', () => {
    expect(hostApprovalContext({ name: 'db-01' }, 'ops@10.0.0.12:22', 'rb')).toEqual({
      hostName: 'db-01',
      hostAddress: 'ops@10.0.0.12:22',
      tool: 'host',
      class: 'read',
      reason: HOST_ASK_REASON,
      queuedBehind: 0,
      runbook: 'rb'
    })
  })
})

describe('interventionPrompt', () => {
  it('is the fixed lead and the task on one line', () => {
    expect(interventionPrompt('  Reload nginx\nafter the\t certificate change  ')).toBe(
      'Read RUNBOOK.md in this folder before proposing a plan, then: Reload nginx after the certificate change'
    )
  })

  it('without a task, reads the runbook and waits', () => {
    const waits = 'Read RUNBOOK.md in this folder before proposing a plan, then wait for instructions.'
    expect(interventionPrompt('')).toBe(waits)
    expect(interventionPrompt(' \n ')).toBe(waits)
  })
})

describe('classifyPlanSteps with a scope', () => {
  const POLICY: OpsPolicy = {
    version: 1,
    strict: true,
    hosts: { web: ['web-01'], db: ['db-01'] },
    allow: [
      { hosts: ['web'], cmd: '^uptime$', class: 'read' },
      { hosts: ['db'], cmd: '^uptime$', class: 'read' }
    ],
    scripts: []
  }
  const HOSTS = new Map([
    ['h1', { host: { id: 'h1', name: 'web-01', host: '10.0.0.11' }, groups: ['web'] }],
    ['h2', { host: { id: 'h2', name: 'db-01', host: '10.0.0.12' }, groups: ['db'] }]
  ])
  const STEPS = [
    { title: 'web', hostId: 'h1', commands: ['uptime'] },
    { title: 'db', hostId: 'h2', commands: ['uptime'] }
  ]

  it('without a scope, both steps run as before', () => {
    expect(classifyPlanSteps(STEPS, POLICY, HOSTS, t).steps.map((s) => s.verdict)).toEqual(['runs', 'runs'])
  })

  it('a locked scope denies the other host with the scope reason', () => {
    const plan = classifyPlanSteps(STEPS, POLICY, HOSTS, t, { scope: { kind: 'host', hostId: 'h1' } })
    expect(plan.steps[1]).toEqual({
      title: 'db',
      hostName: 'db-01',
      commands: ['uptime'],
      verdict: 'denied',
      reason: "outside this intervention's scope: db-01"
    })
    expect(plan.summary).toEqual({ runs: 1, asks: 0, denied: 1, mutates: 0 })
  })

  it('an open scope shows a refused host as denied and a host not asked about yet as the gate says', () => {
    const plan = classifyPlanSteps(STEPS, POLICY, HOSTS, t, { scope: { kind: 'open' }, deniedHosts: new Set(['h2']) })
    expect(plan.steps.map((s) => [s.verdict, s.reason])).toEqual([
      ['runs', 'matched allow rule ^uptime$ (read, auto)'],
      ['denied', 'the operator refused db-01 for this intervention']
    ])
  })
})
