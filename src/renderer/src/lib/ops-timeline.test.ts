import { describe, it, expect } from 'vitest'
import {
  currentStepKey,
  exitMeaning,
  foldOpsEvents,
  groupCallsBySteps,
  planProgress,
  rowLabel,
  rowTone,
  runCounts,
  splitRuns,
  touchedHosts
} from './ops-timeline'
import type { OpsLiveEvent } from '../types'
import { makeT } from '../../../shared/i18n'

const t = makeT('en')

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

describe('intervention fields and host answers', () => {
  it('reads task, ticket, client, scope and policy sha from run.start', () => {
    const s = ev({
      kind: 'run.start', appSessionId: 's1', model: 'm', hosts: [],
      runbook: { name: 'rb', path: '/rb', policySha256: 'b2f5ae7f00', runbookMdSha256: 'x' },
      task: 'diagnose', ticket: 'WM-1', client: 'CM Porto', scope: { kind: 'host', hostId: 'h1' }
    }, 'r4')
    const [run] = foldOpsEvents([s])
    expect(run).toMatchObject({ task: 'diagnose', ticket: 'WM-1', client: 'CM Porto', scope: { kind: 'host', hostId: 'h1' }, policySha256: 'b2f5ae7f00' })
    expect(run.hostAnswers).toEqual([])
  })

  it('places host answers among the calls and counts touched hosts', () => {
    const approved = ev({ kind: 'host.approved', hostId: 'h2', host: 'db1', by: 'user' })
    const [run] = foldOpsEvents([
      start,
      decided('c1', 'allow'),
      approved,
      ev({ kind: 'host.denied', hostId: 'h3', host: 'cache1', by: 'user' }),
      decided('c2', 'allow', { hostId: 'h2', host: '10.0.0.2' })
    ])
    expect(run.hostAnswers).toEqual([
      { hostId: 'h2', host: 'db1', answer: 'approved', at: approved.line.at, beforeCall: 1 },
      expect.objectContaining({ hostId: 'h3', answer: 'denied', beforeCall: 1 })
    ])
    expect(touchedHosts(run)).toEqual(['db1', 'web1'])
  })

  it('marks asked calls and stamps the decision time', () => {
    const d = decided('c1', 'ask')
    const r = row([start, d, ev({ kind: 'call.asked', callId: 'c1' }), ev({ kind: 'call.answered', callId: 'c1', answer: 'allow' })])
    expect(r).toMatchObject({ asked: true, at: d.line.at, status: 'queued' })
  })
})

describe('step progress', () => {
  const steps = [1, 2, 3].map((i) => ({ title: `s${i}`, commands: [`c${i}`], verdict: 'runs' }))

  it('is null without an approved plan', () => {
    expect(planProgress(foldOpsEvents([start, decided('c1', 'allow'), finished('c1', 0)])[0])).toBeNull()
    expect(planProgress(foldOpsEvents([start, ev({ kind: 'plan.rejected', steps })])[0])).toBeNull()
  })

  // Each call's argv is its step's command, so it lands on that step.
  const ran = (id: string, cmd: string, code = 0) => [decided(id, 'allow', { argv: [cmd] }), finished(id, code)]
  const before = [start, decided('c0', 'allow'), finished('c0', 0), ev({ kind: 'plan.approved', steps })]

  it('counts the steps the run has moved past, not the calls', () => {
    // Several calls on step 1 alone: still 0 of 3, not "3 of 3".
    const [onFirst] = foldOpsEvents([...before, ...ran('a', 'c1'), ...ran('b', 'c1'), ...ran('c', 'c1'), ...ran('d', 'c1')])
    expect(planProgress(onFirst)).toEqual({ done: 0, total: 3 })
    // Step 2 started: step 1 is done.
    const [onSecond] = foldOpsEvents([...before, ...ran('a', 'c1', 3), ...ran('b', 'c2')])
    expect(planProgress(onSecond)).toEqual({ done: 1, total: 3 })
  })

  it('finishes the last step when the run ends, and never a step whose call is still out', () => {
    const all = [...before, ...ran('a', 'c1'), ...ran('b', 'c2'), ...ran('c', 'c3')]
    expect(planProgress(foldOpsEvents([...all, ev({ kind: 'run.end', ok: true, costUsd: 0 })])[0])).toEqual({ done: 3, total: 3 })
    const pending = foldOpsEvents([...before, decided('a', 'allow', { argv: ['c1'] }), ...ran('b', 'c2')])[0]
    expect(planProgress(pending)).toEqual({ done: 0, total: 3 })
  })
})

describe('row reading', () => {
  it('labels and colours each outcome', () => {
    const at = (events: OpsLiveEvent[]) => { const r = row(events); return [rowTone(r), rowLabel(r, t)] }
    expect(at([start, decided('c1', 'allow'), finished('c1', 0)])).toEqual(['ok', '42 ms'])
    expect(at([start, decided('c1', 'allow'), finished('c1', 4)])).toEqual(['idle', 'no such unit'])
    expect(at([start, decided('c1', 'allow'), finished('c1', 1)])).toEqual(['warn', 'exit 1'])
    expect(at([start, decided('c1', 'deny', { reason: 'no allow rule matched and the runbook is strict' })])).toEqual(['bad', 'not in runbook'])
    expect(at([start, decided('c1', 'deny', { reason: "script 'x.sh' is not in this runbook" })])).toEqual(['bad', 'not in runbook'])
    expect(at([start, decided('c1', 'deny', { reason: 'sudo command matches no literal sudo rule in this runbook' })])).toEqual(['bad', 'sudo rule missing'])
    expect(at([start, decided('c1', 'deny', { reason: "script 'x.sh' takes at most 0 argument(s); got 1" })])).toEqual(['bad', 'bad script args'])
    expect(at([start, decided('c1', 'deny', { reason: "script 'x.sh' has no valid pinned sha256" })])).toEqual(['bad', 'script not pinned'])
    expect(at([start, decided('c1', 'deny', { reason: 'denylisted: reboot — no runbook can allow this' })])).toEqual(['bad', 'never allowed'])
    expect(at([start, decided('c1', 'deny', { reason: "outside this intervention's scope: db1" })])).toEqual(['bad', 'outside scope'])
    expect(at([start, decided('c1', 'ask'), ev({ kind: 'call.answered', callId: 'c1', answer: 'deny' })])).toEqual(['bad', 'denied by you'])
    expect(at([start, decided('c1', 'ask'), ev({ kind: 'call.asked', callId: 'c1' })])).toEqual(['warn', 'waiting'])
    expect(at([start, decided('c1', 'allow'), ev({ kind: 'call.started', callId: 'c1' })])).toEqual(['idle', 'running'])
  })

  it('counts the report tiles', () => {
    const [run] = foldOpsEvents([
      start,
      decided('c1', 'allow'), finished('c1', 0),
      decided('c2', 'ask'), ev({ kind: 'call.asked', callId: 'c2' }), ev({ kind: 'call.answered', callId: 'c2', answer: 'allow' }), finished('c2', 0),
      decided('c3', 'deny')
    ])
    expect(runCounts(run)).toEqual({ calls: 3, ran: 2, asked: 1, notAllowed: 1 })
  })
})

describe('splitRuns', () => {
  const runs = foldOpsEvents([start, ev({ kind: 'call.asked', callId: 'x' }, 'r2'), ev({ kind: 'call.asked', callId: 'y' }, 'r3')])

  it('takes the named run as current and the rest newest first', () => {
    const { current, earlier } = splitRuns(runs, 'r2')
    expect(current?.runId).toBe('r2')
    expect(earlier.map((r) => r.runId)).toEqual(['r3', 'r1'])
  })

  it('has no current run while the named one has not arrived, and the newest without a name', () => {
    expect(splitRuns(runs, 'r9')).toMatchObject({ current: undefined })
    expect(splitRuns(runs, 'r9').earlier).toHaveLength(3)
    expect(splitRuns(runs, '').current).toBeUndefined()
    expect(splitRuns(runs).current?.runId).toBe('r3')
  })
})

describe('skipped plan steps', () => {
  const steps = [1, 2, 3, 4].map((i) => ({ title: `s${i}`, commands: [`c${i}`], verdict: 'runs' }))

  it('marks the steps the operator skipped, ignoring bad indices', () => {
    const [run] = foldOpsEvents([start, ev({ kind: 'plan.approved', steps, skippedSteps: [1, 3, 9, 'x'] })])
    expect(run.planSteps?.map((s) => !!s.skipped)).toEqual([false, true, false, true])
  })

  it('counts only the steps left to run', () => {
    const [run] = foldOpsEvents([
      start,
      ev({ kind: 'plan.approved', steps, skippedSteps: [0, 2] }),
      ...[['a', 'c2'], ['b', 'c4']].flatMap(([id, cmd]) => [decided(id, 'allow', { argv: [cmd] }), finished(id, 0)]),
      ev({ kind: 'run.end', ok: true, costUsd: 0 })
    ])
    expect(planProgress(run)).toEqual({ done: 2, total: 2 })
  })

  it('has no progress when every step was skipped', () => {
    const [run] = foldOpsEvents([start, ev({ kind: 'plan.approved', steps, skippedSteps: [0, 1, 2, 3] })])
    expect(planProgress(run)).toBeNull()
  })
})

describe('exit meanings', () => {
  const r = (argv: string[], code: number) =>
    row([start, decided('c1', 'allow', { argv }), finished('c1', code)])

  it('reads an expected non-zero exit as an answer', () => {
    expect(exitMeaning(r(['pgrep', '-af', 'puma'], 1), t)).toBe('no process')
    expect(exitMeaning(r(['sudo', '-u', 'app', 'grep', 'x', '/f'], 1), t)).toBe('no match')
    expect(exitMeaning(r(['systemctl', 'status', 'redis', '--no-pager'], 3), t)).toBe('inactive')
    expect(exitMeaning(r(['/usr/bin/systemctl', '--no-pager', 'status', 'x'], 4), t)).toBe('no such unit')
    expect(exitMeaning(r(['systemctl', 'is-enabled', 'x'], 1), t)).toBe('disabled')
  })

  it('leaves real failures alone', () => {
    expect(exitMeaning(r(['pgrep', '-af', 'puma'], 2), t)).toBeUndefined()
    expect(exitMeaning(r(['curl', 'http://x'], 7), t)).toBeUndefined()
    expect(exitMeaning(r(['systemctl', 'restart', 'x'], 1), t)).toBeUndefined()
    expect(exitMeaning(r(['pgrep', 'x'], 0), t)).toBeUndefined()
  })
})

describe('calls by plan step', () => {
  const steps = [
    { title: 'Sistema', commands: ['uptime', 'free -m'], verdict: 'runs' },
    { title: 'Serviços', commands: ["systemctl status 'puma'"], verdict: 'runs' },
    { title: 'Rede', commands: ['ss -tlnp'], verdict: 'runs' }
  ]
  const call = (id: string, argv: string[]) => [decided(id, 'allow', { argv }), finished(id, 0)]

  it('puts calls before the plan apart and each later call under its step', () => {
    const [run] = foldOpsEvents([
      start,
      ...call('c0', ['cat', '/etc/os-release']),
      ev({ kind: 'plan.approved', steps }),
      ...call('c1', ['uptime']),
      ...call('c2', ['free', '-m']),
      ...call('c3', ['systemctl', 'status', 'puma']),
      ...call('c4', ['journalctl', '-u', 'puma'])
    ])
    const groups = groupCallsBySteps(run, t)
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.callId)])).toEqual([
      ['Before the plan', ['c0']],
      ['Sistema', ['c1', 'c2']],
      // Not in any step's commands: it stays on the step the run is on.
      ['Serviços', ['c3', 'c4']]
      // Rede has not run anything, so it is not listed.
    ])
    expect(currentStepKey(run, groups)).toBe('p0:s1')
  })

  it('has no current step while a new plan has run nothing, nor once ended', () => {
    const approved = [start, ...call('c0', ['uptime']), ev({ kind: 'plan.approved', steps })]
    const [run] = foldOpsEvents(approved)
    expect(groupCallsBySteps(run, t).map((g) => g.key)).toEqual(['pre'])
    expect(currentStepKey(run, groupCallsBySteps(run, t))).toBeNull()
    const [done] = foldOpsEvents([...approved, ...call('c1', ['uptime']), ev({ kind: 'run.end', ok: true, costUsd: 0 })])
    expect(currentStepKey(done, groupCallsBySteps(done, t))).toBeNull()
  })

  it('keeps a skipped step out unless something ran for it', () => {
    const [run] = foldOpsEvents([start, ev({ kind: 'plan.approved', steps, skippedSteps: [1] }), ...call('c1', ['uptime'])])
    expect(groupCallsBySteps(run, t).map((g) => g.title)).toEqual(['Sistema'])
  })

  it('matches a script call to its step, which the plan spells script <name> <args>', () => {
    const scriptSteps = [
      { title: 'Backup', commands: ['script app-step.sh backup_current_files'], verdict: 'runs' },
      { title: 'Ficheiros novos', commands: ["script app-step.sh get_new_files --version='10.13.0'"], verdict: 'runs' },
      { title: 'Gems', commands: ['script app-step.sh install_gems'], verdict: 'runs' }
    ]
    const script = (id: string, argv: string[]) => [decided(id, 'allow', { tool: 'script', argv }), finished(id, 0)]
    const [run] = foldOpsEvents([
      start,
      ev({ kind: 'plan.approved', steps: scriptSteps }),
      ...script('c1', ['app-step.sh', 'backup_current_files']),
      ...script('c2', ['/opt/runbook/app-step.sh', 'get_new_files', '--version=10.13.0']),
      ...call('c3', ['pgrep', '-af', 'rake'])
    ])
    expect(groupCallsBySteps(run, t).map((g) => [g.title, g.rows.map((r) => r.callId)])).toEqual([
      ['Backup', ['c1']],
      // A read the plan does not name stays on the step the run is on.
      ['Ficheiros novos', ['c2', 'c3']]
    ])
    expect(planProgress(run)).toEqual({ done: 1, total: 3 })
  })

  it('has one group and no plan when the run never got one', () => {
    const [run] = foldOpsEvents([start, ...call('c1', ['uptime'])])
    expect(groupCallsBySteps(run, t).map((g) => g.key)).toEqual(['pre'])
  })
})
