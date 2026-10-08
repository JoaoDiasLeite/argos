import { describe, it, expect } from 'vitest'
import {
  describeOpsRequest, displayArgv, summarizeOps, planTotals, planTotalsGroups, planChangesLine,
  planTarget, planStepLabel, opsToastText, opsToastQuestion, opsToastEyebrow, planTotalsWithout
} from './ops-approval'
import type { ApprovalOpsContext, OpsPlanStep } from '../types'

const base: ApprovalOpsContext = {
  hostName: 'web1', hostAddress: 'ops@10.0.0.1:22', tool: 'run', class: 'read',
  reason: 'r', queuedBehind: 0, runbook: 'rb'
}

describe('displayArgv', () => {
  it('quotes words with spaces or quotes', () => {
    expect(displayArgv(['ls', '-la', 'my dir', "it's"])).toBe(`ls -la 'my dir' 'it'\''s'`)
  })
})

describe('describeOpsRequest', () => {
  it('describes a command', () => {
    expect(describeOpsRequest({ ...base, argv: ['df', '-h'] })).toEqual({
      verb: 'run a command on web1', lines: ['df -h']
    })
  })
  it('describes a script with sha', () => {
    const r = describeOpsRequest({ ...base, tool: 'script', argv: ['backup.sh'], scriptSha256: 'abcdef0123456789' })
    expect(r.verb).toBe('run script backup.sh on web1')
    expect(r.lines).toContain('sha256 abcdef012345…')
  })
  it('describes file tools', () => {
    expect(describeOpsRequest({ ...base, tool: 'read', path: '/etc/hosts' }).verb).toBe('read /etc/hosts on web1')
    expect(describeOpsRequest({ ...base, tool: 'list', path: '/var' }).verb).toBe('list /var on web1')
    expect(describeOpsRequest({ ...base, tool: 'write', path: '/tmp/x' }).lines).toEqual(['/tmp/x'])
  })
})

const step = (s: Partial<OpsPlanStep>): OpsPlanStep => ({ title: 't', commands: ['true'], verdict: 'runs', ...s })

describe('plan approvals', () => {
  const steps: OpsPlanStep[] = [
    step({ title: 'check disk', hostName: 'web1', commands: ['df -h'], class: 'read' }),
    step({
      title: 'restart service', hostName: 'web1', commands: ['sudo systemctl restart app'],
      verdict: 'asks', class: 'mutate', sudo: true, reason: 'rule: restart'
    })
  ]
  const plan: ApprovalOpsContext = { ...base, tool: 'plan', hostName: 'restart-app', planSteps: steps }

  it('describes a plan with its step titles', () => {
    expect(describeOpsRequest(plan)).toEqual({
      verb: 'approve the plan for restart-app', lines: ['check disk', 'restart service']
    })
  })
  it('summarizes a plan', () => {
    expect(summarizeOps(plan)).toBe('Plan: 2 steps for restart-app')
    expect(summarizeOps({ ...plan, planSteps: [steps[0]] })).toBe('Plan: 1 step for restart-app')
  })
  it('counts totals from the steps when no summary came', () => {
    const t = planTotals(plan)
    expect(t).toEqual({ runs: 1, asks: 1, denied: 0, mutates: 1, unknown: 0, total: 2 })
    expect(planTotalsGroups(t).map((g) => `${g.n} ${g.text}`)).toEqual(['1 runs on its own', '1 will ask you first'])
    expect(planChangesLine(t)).toBe('1 changes the host')
  })
  it('prefers the gate summary and leaves zero groups out', () => {
    const t = planTotals({ ...plan, planSummary: { runs: 1, asks: 0, denied: 0, mutates: 0 } })
    expect(t.unknown).toBe(1)
    expect(planTotalsGroups(t).map((g) => `${g.n} ${g.text}`)).toEqual(['1 runs on its own'])
    expect(planChangesLine(t)).toBe('nothing changes')
    const many = planTotals({ ...plan, planSummary: { runs: 5, asks: 2, denied: 1, mutates: 3 } })
    expect(planTotalsGroups(many).map((g) => `${g.n} ${g.text}`)).toEqual([
      '5 run on their own', '2 will ask you first', '1 not allowed'
    ])
    expect(planChangesLine(many)).toBe('3 change the host')
  })
  it('names the single host, else the runbook', () => {
    expect(planTarget(plan)).toBe('on web1')
    expect(planTarget({ ...plan, planSteps: [...steps, step({ hostName: 'db1' })] })).toBe('runbook rb')
  })
  it('labels steps', () => {
    expect(planStepLabel(step({ class: 'read' }))).toBe('read')
    expect(planStepLabel(step({ commands: ['a', 'b', 'c'] }))).toBe('read · 3')
    expect(planStepLabel(step({ verdict: 'asks', sudo: true }))).toBe('asks · sudo')
    expect(planStepLabel(step({ verdict: 'denied' }))).toBe('not allowed')
  })
})

describe('opsToastText', () => {
  it('asks in words, never with the MCP tool name', () => {
    expect(opsToastText({ ...base, argv: ['systemctl', 'status', 'puma'], hostName: 'rocky-test', title: 'Estado' })).toEqual({
      title: 'Allow `systemctl status puma` on rocky-test?',
      detail: 'Estado'
    })
    expect(opsToastText({ ...base, tool: 'read', path: '/etc/hosts' }).title).toBe('Allow reading /etc/hosts on web1?')
    expect(opsToastText({ ...base, tool: 'script', argv: ['check.sh'] }).title).toBe('Allow script check.sh on web1?')
    expect(opsToastText({ ...base, tool: 'run' }).detail).toBe('r')
  })

  it('names the runbook for a plan, with its size and what changes', () => {
    const plan: ApprovalOpsContext = {
      ...base,
      tool: 'plan',
      hostName: 'diagnose-rails-host',
      runbook: 'diagnose-rails-host',
      planSteps: [{ title: 'a', commands: ['uptime'], verdict: 'runs', class: 'read' }]
    }
    expect(opsToastText(plan)).toEqual({ title: 'Approve the plan for diagnose-rails-host', detail: '1 step · nothing changes' })
  })
})

describe('host approvals', () => {
  const host: ApprovalOpsContext = {
    ...base, tool: 'host', hostName: 'db-01', hostAddress: 'ops@10.0.0.2:22',
    reason: 'first use of this host in an open intervention', runbook: 'diagnose-rails-host'
  }

  it('describes and summarises the first touch of a host', () => {
    expect(describeOpsRequest(host)).toEqual({ verb: 'reach db-01 for this intervention', lines: ['ops@10.0.0.2:22'] })
    expect(summarizeOps(host)).toBe('Reach db-01?')
    expect(opsToastText(host)).toEqual({
      title: 'Allow reaching db-01 for this intervention?',
      detail: 'first use of this host in an open intervention'
    })
  })

  it('asks the toast question in words, with no chip', () => {
    expect(opsToastQuestion(host)).toEqual({ lead: 'The model wants to reach db-01. Allow for this intervention?', tail: '' })
    expect(opsToastEyebrow(host)).toBe('Argos · diagnose-rails-host on db-01')
  })
})

describe('opsToastQuestion', () => {
  it('puts the command or path in the chip', () => {
    expect(opsToastQuestion({ ...base, argv: ['sudo', 'nginx', '-t'] })).toEqual({ lead: 'Allow ', code: 'sudo nginx -t', tail: '?' })
    expect(opsToastQuestion({ ...base, tool: 'read', path: '/etc/hosts' })).toEqual({ lead: 'Allow reading ', code: '/etc/hosts', tail: '?' })
    expect(opsToastQuestion({ ...base, tool: 'plan', planSteps: [step({})] }).code).toBeUndefined()
    expect(opsToastEyebrow({ ...base, tool: 'plan' })).toBe('Argos · rb')
  })
})

describe('planTotalsWithout', () => {
  const plan: ApprovalOpsContext = {
    ...base,
    tool: 'plan',
    planSummary: { runs: 2, asks: 1, denied: 0, mutates: 1 },
    planSteps: [
      step({ verdict: 'runs', class: 'read' }),
      step({ verdict: 'asks', class: 'mutate' }),
      step({ verdict: 'runs', class: 'read' })
    ]
  }
  it('keeps the gate summary when nothing is skipped', () => {
    expect(planTotalsWithout(plan, new Set())).toEqual(planTotals(plan))
  })
  it('counts only the steps left', () => {
    expect(planTotalsWithout(plan, new Set([1]))).toEqual({ runs: 2, asks: 0, denied: 0, mutates: 0, unknown: 0, total: 2 })
  })
})
