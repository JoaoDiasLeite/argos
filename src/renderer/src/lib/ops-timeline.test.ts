import { describe, it, expect } from 'vitest'
import { foldOpsEvents } from './ops-timeline'
import type { OpsLiveEvent } from '../types'

let n = 0
const ev = (event: Record<string, unknown>, runId = 'r1'): OpsLiveEvent => ({
  appSessionId: 's1',
  runId,
  line: {
    at: `2026-10-02T10:00:${String(n++).padStart(2, '0')}.000Z`,
    prev: 'x',
    event: { runId, ...event } as OpsLiveEvent['line']['event']
  }
})

const start = ev({
  kind: 'run.start',
  appSessionId: 's1',
  runbook: { name: 'restart-app', path: '/rb', policySha256: 'a', runbookMdSha256: 'b' },
  hosts: [{ id: 'h1', name: 'web1', host: '10.0.0.1' }, { id: 'h2', name: 'db1', host: '10.0.0.2' }],
  model: 'm',
  planText: 'the plan'
})

const decided = (callId: string, decision: string, extra: Record<string, unknown> = {}) =>
  ev({
    kind: 'call.decided',
    callId,
    tool: 'run',
    hostId: 'h1',
    host: 'web1',
    rawInput: {},
    argv: ['systemctl', 'status', 'app'],
    class: 'read',
    decision,
    reason: 'matched allow[0]',
    rule: '^systemctl status app$',
    ...extra
  })

const finished = (callId: string, exitCode: number | null, timedOut = false) =>
  ev({
    kind: 'call.finished',
    callId,
    exitCode,
    timedOut,
    durationMs: 42,
    stdoutBytes: 2,
    stderrBytes: 0,
    stdoutSha256: 's',
    stderrSha256: 's',
    stdoutHead: 'ok',
    stderrHead: ''
  })

const row = (events: OpsLiveEvent[]) => foldOpsEvents(events)[0].calls[0]

describe('foldOpsEvents', () => {
  it('reads the run header from run.start', () => {
    const [run] = foldOpsEvents([start])
    expect(run).toMatchObject({ runId: 'r1', runbook: 'restart-app', hosts: ['web1', 'db1'], planText: 'the plan' })
    expect(run.startedAt).toBe(start.line.at)
    expect(run.calls).toEqual([])
    expect(run.ended).toBeUndefined()
  })

  it('a decided allow stays decided and carries the gate fields', () => {
    expect(row([start, decided('c1', 'allow')])).toMatchObject({
      callId: 'c1', host: 'web1', tool: 'run', class: 'read', decision: 'allow', status: 'decided',
      argv: ['systemctl', 'status', 'app'], rule: '^systemctl status app$'
    })
  })

  it('deny → denied', () => {
    expect(row([start, decided('c1', 'deny')]).status).toBe('denied')
  })

  it('asked → asked', () => {
    expect(row([start, decided('c1', 'ask'), ev({ kind: 'call.asked', callId: 'c1' })]).status).toBe('asked')
  })

  it('answered allow → queued, deny → denied, stop → stopped', () => {
    const asked = [start, decided('c1', 'ask'), ev({ kind: 'call.asked', callId: 'c1' })]
    expect(row([...asked, ev({ kind: 'call.answered', callId: 'c1', answer: 'allow' })])).toMatchObject({ status: 'queued', answer: 'allow' })
    expect(row([...asked, ev({ kind: 'call.answered', callId: 'c1', answer: 'deny' })]).status).toBe('denied')
    expect(row([...asked, ev({ kind: 'call.answered', callId: 'c1', answer: 'stop' })]).status).toBe('stopped')
  })

  it('started → running', () => {
    expect(row([start, decided('c1', 'allow'), ev({ kind: 'call.started', callId: 'c1' })]).status).toBe('running')
  })

  it('finished exit 0 → done, with duration and heads', () => {
    expect(row([start, decided('c1', 'allow'), ev({ kind: 'call.started', callId: 'c1' }), finished('c1', 0)])).toMatchObject({
      status: 'done', exitCode: 0, durationMs: 42, stdoutHead: 'ok', stderrHead: ''
    })
  })

  it('finished non-zero or null exit → failed', () => {
    expect(row([start, decided('c1', 'allow'), finished('c1', 3)])).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(row([start, decided('c1', 'allow'), finished('c1', null)])).toMatchObject({ status: 'failed', exitCode: null })
  })

  it('timed out → timed-out, even with exit 0', () => {
    expect(row([start, decided('c1', 'allow'), finished('c1', 0, true)]).status).toBe('timed-out')
  })

  it('records a write backup', () => {
    const r = row([
      start,
      decided('c1', 'allow', { tool: 'write', argv: undefined, path: '/etc/app.conf' }),
      ev({ kind: 'write.backup', callId: 'c1', path: '/etc/app.conf', backupPath: '/etc/app.conf.bak', beforeSha256: 'a', afterSha256: 'b' })
    ])
    expect(r).toMatchObject({ path: '/etc/app.conf', backup: { path: '/etc/app.conf', backupPath: '/etc/app.conf.bak' } })
  })

  it('keeps an event for an unknown callId as a row', () => {
    const r = row([start, ev({ kind: 'call.started', callId: 'ghost' })])
    expect(r).toMatchObject({ callId: 'ghost', status: 'running', reason: 'decided event missing' })
  })

  it('keeps calls in arrival order', () => {
    const [run] = foldOpsEvents([start, decided('c1', 'allow'), decided('c2', 'deny'), finished('c1', 0)])
    expect(run.calls.map((c) => [c.callId, c.status])).toEqual([['c1', 'done'], ['c2', 'denied']])
  })

  it('reads run.end', () => {
    const [run] = foldOpsEvents([start, ev({ kind: 'run.end', ok: false, costUsd: 0.12, aborted: true, error: 'stopped' })])
    expect(run.ended).toEqual({ ok: false, costUsd: 0.12, aborted: true, error: 'stopped' })
  })

  it('separates runs and creates one for lines without run.start', () => {
    const runs = foldOpsEvents([start, ev({ kind: 'call.asked', callId: 'x' }, 'r2')])
    expect(runs.map((r) => r.runId)).toEqual(['r1', 'r2'])
    expect(runs[1]).toMatchObject({ runbook: '', hosts: [] })
    expect(runs[1].calls[0]).toMatchObject({ callId: 'x', status: 'asked', reason: 'decided event missing' })
  })

  it('reads the plan decision', () => {
    const approved = ev({ kind: 'plan.approved' })
    const [run] = foldOpsEvents([start, approved])
    expect(run.planDecision).toBe('approved')
    expect(run.planAt).toBe(approved.line.at)
    const [rej] = foldOpsEvents([start, ev({ kind: 'plan.rejected' })])
    expect(rej.planDecision).toBe('rejected')
  })
})

describe('plan steps', () => {
  const step = { title: 'check app', commands: ['systemctl status app'], verdict: 'runs', hostName: 'web1' }

  it('folds the latest approved plan steps, skipping malformed ones, and leaves a rejection out', () => {
    const [run] = foldOpsEvents([
      start,
      ev({ kind: 'plan.approved', planText: '1. check app', steps: [step, { commands: ['x'] }, 'junk'] }),
      ev({ kind: 'plan.rejected', planText: '1. other', steps: [{ ...step, title: 'other' }] })
    ])
    expect(run.planSteps).toEqual([step])
    // run.start's plan text stays the run's.
    expect(run.planText).toBe('the plan')
    expect(run.planDecision).toBe('rejected')
  })

  it('takes the plan text from plan.approved when run.start has none', () => {
    const bare = ev({ kind: 'run.start', appSessionId: 's1', runbook: { name: 'rb' }, hosts: [], model: 'm' }, 'r3')
    const [run] = foldOpsEvents([
      bare,
      ev({ kind: 'plan.approved', planText: '1. first', steps: [step] }, 'r3'),
      ev({ kind: 'plan.approved', planText: '1. second' }, 'r3')
    ])
    expect(run.planText).toBe('1. second')
    expect(run.planSteps).toEqual([step])
  })
})
