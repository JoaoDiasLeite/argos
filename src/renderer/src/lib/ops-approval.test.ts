import { describe, it, expect } from 'vitest'
import {
  describeOpsRequest, displayArgv, summarizeOps, planTotals, planTotalsGroups, planChangesLine,
  planTarget, planStepLabel, opsToastText, opsToastQuestion, opsToastEyebrow, planTotalsWithout
} from './ops-approval'
import type { ApprovalOpsContext, OpsPlanStep } from '../types'
import { makeT } from '../../../shared/i18n'

const t = makeT('en')

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
    expect(describeOpsRequest({ ...base, argv: ['df', '-h'] }, t)).toEqual({
      verb: 'run a command on web1', lines: ['df -h']
    })
  })
  it('describes a script with sha', () => {
    const r = describeOpsRequest({ ...base, tool: 'script', argv: ['backup.sh'], scriptSha256: 'abcdef0123456789' }, t)
    expect(r.verb).toBe('run script backup.sh on web1')
    expect(r.lines).toContain('sha256 abcdef012345…')
  })
  it('describes file tools', () => {
    expect(describeOpsRequest({ ...base, tool: 'read', path: '/etc/hosts' }, t).verb).toBe('read /etc/hosts on web1')
    expect(describeOpsRequest({ ...base, tool: 'list', path: '/var' }, t).verb).toBe('list /var on web1')
    expect(describeOpsRequest({ ...base, tool: 'write', path: '/tmp/x' }, t).lines).toEqual(['/tmp/x'])
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
    expect(describeOpsRequest(plan, t)).toEqual({
      verb: 'approve the plan for restart-app', lines: ['check disk', 'restart service']
    })
  })
  it('summarizes a plan', () => {
    expect(summarizeOps(plan, t)).toBe('Plan: 2 steps for restart-app')
    expect(summarizeOps({ ...plan, planSteps: [steps[0]] }, t)).toBe('Plan: 1 step for restart-app')
  })
  it('counts totals from the steps when no summary came', () => {
    const totals = planTotals(plan)
    expect(totals).toEqual({ runs: 1, asks: 1, denied: 0, mutates: 1, unknown: 0, total: 2 })
    expect(planTotalsGroups(totals, t).map((g) => `${g.n} ${g.text}`)).toEqual(['1 runs on its own', '1 will ask you first'])
    expect(planChangesLine(totals, t)).toBe('1 changes the host')
  })
  it('prefers the gate summary and leaves zero groups out', () => {
    const totals = planTotals({ ...plan, planSummary: { runs: 1, asks: 0, denied: 0, mutates: 0 } })
    expect(totals.unknown).toBe(1)
    expect(planTotalsGroups(totals, t).map((g) => `${g.n} ${g.text}`)).toEqual(['1 runs on its own'])
    expect(planChangesLine(totals, t)).toBe('nothing changes')
    const many = planTotals({ ...plan, planSummary: { runs: 5, asks: 2, denied: 1, mutates: 3 } })
    expect(planTotalsGroups(many, t).map((g) => `${g.n} ${g.text}`)).toEqual([
      '5 run on their own', '2 will ask you first', '1 not allowed'
    ])
    expect(planChangesLine(many, t)).toBe('3 change the host')
  })
  it('names the single host, else the runbook', () => {
    expect(planTarget(plan, t)).toBe('on web1')
    expect(planTarget({ ...plan, planSteps: [...steps, step({ hostName: 'db1' })] }, t)).toBe('runbook rb')
  })
  it('labels steps', () => {
    expect(planStepLabel(step({ class: 'read' }), t)).toBe('read')
    expect(planStepLabel(step({ commands: ['a', 'b', 'c'] }), t)).toBe('read · 3')
    expect(planStepLabel(step({ verdict: 'asks', sudo: true }), t)).toBe('asks · sudo')
    expect(planStepLabel(step({ verdict: 'denied' }), t)).toBe('not allowed')
  })
})

describe('opsToastText', () => {
  it('asks in words, never with the MCP tool name', () => {
    expect(opsToastText({ ...base, argv: ['systemctl', 'status', 'puma'], hostName: 'rocky-test', title: 'Estado' }, t)).toEqual({
      title: 'Allow `systemctl status puma` on rocky-test?',
      detail: 'Estado'
    })
    expect(opsToastText({ ...base, tool: 'read', path: '/etc/hosts' }, t).title).toBe('Allow reading /etc/hosts on web1?')
    expect(opsToastText({ ...base, tool: 'script', argv: ['check.sh'] }, t).title).toBe('Allow script check.sh on web1?')
    expect(opsToastText({ ...base, tool: 'run' }, t).detail).toBe('r')
  })

  it('names the runbook for a plan, with its size and what changes', () => {
    const plan: ApprovalOpsContext = {
      ...base,
      tool: 'plan',
      hostName: 'diagnose-rails-host',
      runbook: 'diagnose-rails-host',
      planSteps: [{ title: 'a', commands: ['uptime'], verdict: 'runs', class: 'read' }]
    }
    expect(opsToastText(plan, t)).toEqual({ title: 'Approve the plan for diagnose-rails-host', detail: '1 step · nothing changes' })
  })
})

describe('host approvals', () => {
  const host: ApprovalOpsContext = {
    ...base, tool: 'host', hostName: 'db-01', hostAddress: 'ops@10.0.0.2:22',
    reason: 'first use of this host in an open intervention', runbook: 'diagnose-rails-host'
  }

  it('describes and summarises the first touch of a host', () => {
    expect(describeOpsRequest(host, t)).toEqual({ verb: 'reach db-01 for this intervention', lines: ['ops@10.0.0.2:22'] })
    expect(summarizeOps(host, t)).toBe('Reach db-01?')
    expect(opsToastText(host, t)).toEqual({
      title: 'Allow reaching db-01 for this intervention?',
      detail: 'first use of this host in an open intervention'
    })
  })

  it('asks the toast question in words, with no chip', () => {
    expect(opsToastQuestion(host, t)).toEqual({ text: 'The model wants to reach db-01. Allow for this intervention?' })
    expect(opsToastEyebrow(host, t)).toBe('Argos · diagnose-rails-host on db-01')
  })
})

describe('opsToastQuestion', () => {
  it('puts the command or path in the chip', () => {
    expect(opsToastQuestion({ ...base, argv: ['sudo', 'nginx', '-t'] }, t)).toEqual({ text: 'Allow {code}?', code: 'sudo nginx -t' })
    expect(opsToastQuestion({ ...base, tool: 'read', path: '/etc/hosts' }, t)).toEqual({ text: 'Allow reading {code}?', code: '/etc/hosts' })
    expect(opsToastQuestion({ ...base, tool: 'plan', planSteps: [step({})] }, t).code).toBeUndefined()
    expect(opsToastEyebrow({ ...base, tool: 'plan' }, t)).toBe('Argos · rb')
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
