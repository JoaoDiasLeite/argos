import { describe, it, expect } from 'vitest'
import { HOST_ASK_REASON, hostApprovalContext, interventionPrompt, referenceLine, scopeVerdict } from './ops-scope-pure'
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

  it('a runbook added to the base reads the base guidelines first', () => {
    const baseDir = 'C:\\Program Files\\Argos\\resources\\runbooks\\intervention'
    expect(interventionPrompt('restart puma', { baseDir })).toBe(
      `Read the base intervention's RUNBOOK.md in ${baseDir}, then RUNBOOK.md in this folder, which adds to it and wins where it is stricter, before proposing a plan, then: restart puma`
    )
  })

  it('without a task, reads the runbook and waits', () => {
    const waits = 'Read RUNBOOK.md in this folder before proposing a plan, then wait for instructions.'
    expect(interventionPrompt('')).toBe(waits)
    expect(interventionPrompt(' \n ')).toBe(waits)
  })

  it('a read-only runbook needs no plan, so the lead does not mention one', () => {
    expect(interventionPrompt('puma slow since 17h', { planRequired: false })).toBe(
      'Read RUNBOOK.md in this folder before you start, then: puma slow since 17h'
    )
    expect(interventionPrompt('', { planRequired: false })).toBe('Read RUNBOOK.md in this folder before you start, then wait for instructions.')
    expect(interventionPrompt('x', { planRequired: true })).toBe(interventionPrompt('x'))
  })

  it('a resume with its conversation says what did not carry over, then the task', () => {
    expect(interventionPrompt('Reload nginx\nnow', { resume: { runId: 'r1', conversation: true } })).toBe(
      'This is a new Argos run resuming the intervention above (earlier run r1). Its plan approval and tool connection ended with it: propose a new plan before any other ops call. Reload nginx now'
    )
    expect(interventionPrompt('look again', { planRequired: false, resume: { runId: 'r1', conversation: true } })).toBe(
      'This is a new Argos run resuming the intervention above (earlier run r1). Its plan approval and tool connection ended with it: carry on. look again'
    )
    expect(interventionPrompt('', { resume: { runId: 'r1', conversation: true } })).toBe(
      'This is a new Argos run resuming the intervention above (earlier run r1). Its plan approval and tool connection ended with it: propose a new plan before any other ops call.'
    )
  })

  it('a resume without it reads the earlier run first, then starts as any run', () => {
    expect(interventionPrompt('Reload nginx', { resume: { runId: 'r1', conversation: false } })).toBe(
      'This intervention resumes run r1. Call past_interventions with that runId first. Read RUNBOOK.md in this folder before proposing a plan, then: Reload nginx'
    )
  })

  it('names related runs before the task, deduped and without the resumed one', () => {
    expect(interventionPrompt('x', { related: ['a', 'b', 'a'] })).toBe(
      'Related earlier interventions: a, b. Call past_interventions for each before you start. Read RUNBOOK.md in this folder before proposing a plan, then: x'
    )
    expect(interventionPrompt('x', { resume: { runId: 'r1', conversation: false }, related: ['r1', 'a'] })).toBe(
      'This intervention resumes run r1. Call past_interventions with that runId first. Related earlier interventions: a. Call past_interventions for each before you start. Read RUNBOOK.md in this folder before proposing a plan, then: x'
    )
    expect(interventionPrompt('x', { related: [] })).toBe(interventionPrompt('x'))
  })

  it('is always one line', () => {
    const p = interventionPrompt('a\nb\r\nc', { resume: { runId: 'r1', conversation: true }, related: ['z'] })
    expect(p).not.toMatch(/[\r\n]/)
  })
})

describe('referenceLine', () => {
  it('names the run, its day and its task', () => {
    expect(referenceLine({ runId: 'r9', startedAt: '2026-10-30T14:02:00.000Z', task: 'puma\nslow' })).toBe(
      'The operator points you to the earlier intervention r9 (2026-10-30, puma slow). Call past_interventions with that runId and take it into account.'
    )
  })

  it('without a task names the day only, and cuts a long one', () => {
    expect(referenceLine({ runId: 'r9', startedAt: '2026-10-30T14:02:00.000Z' })).toContain('intervention r9 (2026-10-30).')
    const long = referenceLine({ runId: 'r9', startedAt: '2026-10-30T14:02:00.000Z', task: 'x'.repeat(500) })
    expect(long).toContain('x'.repeat(199) + '…)')
    expect(long).not.toContain('x'.repeat(200))
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
