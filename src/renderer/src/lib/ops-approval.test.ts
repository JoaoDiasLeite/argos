import { describe, it, expect } from 'vitest'
import { describeOpsRequest, displayArgv, summarizeOps } from './ops-approval'
import type { ApprovalOpsContext } from '../types'

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

describe('plan approvals', () => {
  const plan: ApprovalOpsContext = { ...base, tool: 'plan', hostName: 'restart-app', planSteps: ['check disk', 'restart service'] }
  it('describes a plan with its steps', () => {
    expect(describeOpsRequest(plan)).toEqual({
      verb: 'approve the plan for restart-app', lines: ['check disk', 'restart service']
    })
  })
  it('summarizes a plan', () => {
    expect(summarizeOps(plan)).toBe('Plan: 2 steps for restart-app')
    expect(summarizeOps({ ...plan, planSteps: ['one'] })).toBe('Plan: 1 step for restart-app')
  })
})
