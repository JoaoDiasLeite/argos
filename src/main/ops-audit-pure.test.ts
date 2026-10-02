import { describe, it, expect } from 'vitest'
import {
  buildLine,
  DECIDED_MISSING,
  GENESIS,
  parseLedger,
  runEvents,
  sha256Hex,
  summarizeRun,
  verifyChain
} from './ops-audit-pure'
import type { OpsAuditEvent, OpsAuditLine } from './ops-types'

const T0 = Date.parse('2026-03-05T10:00:00.000Z')
const at = (sec: number): Date => new Date(T0 + sec * 1000)

/** Chain events into ledger text, one second apart, each line ending in `\n`. */
function ledger(events: OpsAuditEvent[]): { text: string; raws: string[] } {
  let prev: string | null = null
  const raws: string[] = []
  events.forEach((e, i) => {
    const { raw } = buildLine(prev, e, at(i))
    raws.push(raw)
    prev = raw
  })
  return { text: raws.map((r) => r + '\n').join(''), raws }
}

const RUNBOOK = {
  name: 'restart-api',
  path: '/repo/runbooks/restart-api',
  policySha256: 'a'.repeat(64),
  runbookMdSha256: 'b'.repeat(64),
  platform: 'cityfy' as const
}
const HOSTS = [{ id: 'h1', name: 'web-1', host: '10.0.0.5' }]

const start = (runId = 'r1'): OpsAuditEvent => ({
  kind: 'run.start',
  runId,
  appSessionId: 's1',
  runbook: RUNBOOK,
  hosts: HOSTS,
  model: 'claude-opus',
  planText: '1. check\n2. restart'
})

const three: OpsAuditEvent[] = [
  start(),
  { kind: 'plan.approved', runId: 'r1', by: 'user' },
  { kind: 'run.end', runId: 'r1', ok: true, costUsd: 0.12 }
]

describe('sha256Hex', () => {
  it('hashes strings and bytes alike', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })
})

describe('buildLine', () => {
  it('starts a file at genesis and links each line to the previous raw text', () => {
    const a = buildLine(null, three[0], at(0))
    expect(a.line.prev).toBe(GENESIS)
    expect(a.line.at).toBe('2026-03-05T10:00:00.000Z')
    const b = buildLine(a.raw, three[1], at(1))
    expect(b.line.prev).toBe(sha256Hex(a.raw))
    expect(JSON.parse(b.raw)).toEqual(b.line)
  })

  it('keeps a newline inside a string field on one line and round-trips it', () => {
    const { raw } = buildLine(null, start(), at(0))
    expect(raw).not.toContain('\n')
    const parsed = parseLedger(raw + '\n')
    const ev = parsed.lines[0].event
    expect(ev.kind === 'run.start' && ev.planText).toBe('1. check\n2. restart')
  })
})

describe('parseLedger', () => {
  it('parses complete lines and keeps their raw text', () => {
    const { text, raws } = ledger(three)
    const p = parseLedger(text)
    expect(p.lines).toHaveLength(3)
    expect(p.raws).toEqual(raws)
    expect(p.errors).toEqual([])
    expect(p.partial).toBeUndefined()
  })

  it('tolerates a blank last line', () => {
    const { text } = ledger(three)
    const p = parseLedger(text + '\n')
    expect(p.lines).toHaveLength(3)
    expect(p.errors).toEqual([])
    expect(p.partial).toBeUndefined()
    expect(verifyChain(text + '\n')).toEqual({ ok: true, lines: 3 })
  })

  it('reports bad JSON and missing fields by line number without throwing', () => {
    const { raws } = ledger(three)
    const text = [raws[0], '{not json', JSON.stringify({ at: 'x', prev: 'y', event: {} }), raws[1]]
      .map((r) => r + '\n')
      .join('')
    const p = parseLedger(text)
    expect(p.lines).toHaveLength(2)
    expect(p.errors.map((e) => e.line)).toEqual([2, 3])
    expect(p.errors[0].reason).toMatch(/invalid JSON/)
    expect(p.errors[1].reason).toBe('missing "event.kind"')
  })

  it('reports a trailing line with no newline as partial, not as an error', () => {
    const { text } = ledger(three)
    const truncated = text.slice(0, text.length - 20)
    const p = parseLedger(truncated)
    expect(p.lines).toHaveLength(2)
    expect(p.errors).toEqual([])
    expect(p.partial?.line).toBe(3)
  })
})

describe('verifyChain', () => {
  it('verifies a chain of three lines', () => {
    expect(verifyChain(ledger(three).text)).toEqual({ ok: true, lines: 3 })
  })

  it('an empty file is an empty, valid chain', () => {
    expect(verifyChain('')).toEqual({ ok: true, lines: 0 })
  })

  it('an edit to line 2 breaks the link on line 3, which points at it', () => {
    const { raws } = ledger(three)
    raws[1] = raws[1].replace('"by":"user"', '"by":"usex"')
    const r = verifyChain(raws.map((x) => x + '\n').join(''))
    expect(r).toMatchObject({ ok: false, brokenAt: 3 })
  })

  it('deleting line 2 breaks the chain at the line that moved up into its place', () => {
    const { raws } = ledger(three)
    const r = verifyChain([raws[0], raws[2]].map((x) => x + '\n').join(''))
    expect(r).toMatchObject({ ok: false, brokenAt: 2 })
  })

  it('a first line that is not genesis is broken at line 1', () => {
    const { raws } = ledger(three)
    expect(verifyChain(raws.slice(1).map((x) => x + '\n').join(''))).toMatchObject({
      ok: false,
      brokenAt: 1
    })
  })

  it('a truncated last line leaves the chain ok up to it', () => {
    const { text } = ledger(three)
    expect(verifyChain(text.slice(0, text.length - 20))).toEqual({ ok: true, lines: 2 })
  })

  it('an unparseable line in the middle is a broken link', () => {
    const { raws } = ledger(three)
    const text = [raws[0], 'garbage', raws[1]].map((x) => x + '\n').join('')
    expect(verifyChain(text)).toMatchObject({ ok: false, brokenAt: 2 })
  })
})

// ─── Run fold ─────────────────────────────────────────────────────────────────────

const decided = (
  callId: string,
  extra: Partial<Extract<OpsAuditEvent, { kind: 'call.decided' }>> = {}
): OpsAuditEvent => ({
  kind: 'call.decided',
  runId: 'r1',
  callId,
  tool: 'run',
  hostId: 'h1',
  host: 'web-1',
  rawInput: { tool: 'run', hostId: 'h1', cmd: 'systemctl status api' },
  argv: ['systemctl', 'status', 'api'],
  class: 'read',
  decision: 'allow',
  reason: 'matched allow[0]',
  rule: '^systemctl status api$',
  title: 'verificação do estado do serviço',
  ...extra
})

const finished = (callId: string, exitCode: number | null, timedOut = false): OpsAuditEvent => ({
  kind: 'call.finished',
  runId: 'r1',
  callId,
  exitCode,
  timedOut,
  durationMs: 1200,
  stdoutBytes: 10,
  stderrBytes: 0,
  stdoutSha256: 'c'.repeat(64),
  stderrSha256: 'd'.repeat(64),
  stdoutHead: `out ${callId}`,
  stderrHead: ''
})

function fixtureLines(): OpsAuditLine[] {
  const events: OpsAuditEvent[] = [
    start(),
    { kind: 'plan.approved', runId: 'r1', by: 'user' },
    // c1: allowed, exit 0
    decided('c1'),
    { kind: 'call.started', runId: 'r1', callId: 'c1' },
    finished('c1', 0),
    // another run interleaved in the same file
    start('r2'),
    // c2: asked, answered allow, exit 1
    decided('c2', { class: 'mutate', decision: 'ask', reason: 'mutate asks', title: 'reinício' }),
    { kind: 'call.asked', runId: 'r1', callId: 'c2' },
    { kind: 'call.answered', runId: 'r1', callId: 'c2', answer: 'allow' },
    { kind: 'call.started', runId: 'r1', callId: 'c2' },
    finished('c2', 1),
    // c3: denied
    decided('c3', { decision: 'deny', reason: 'hard denylist', denylist: 'rm-root', title: undefined }),
    // c4: timed out
    decided('c4'),
    { kind: 'call.started', runId: 'r1', callId: 'c4' },
    finished('c4', null, true),
    { kind: 'run.end', runId: 'r1', ok: false, costUsd: 0.5, error: 'step failed' }
  ]
  return parseLedger(ledger(events).text).lines
}

describe('runEvents', () => {
  it('keeps one run, in file order', () => {
    const lines = fixtureLines()
    expect(runEvents(lines, 'r2')).toHaveLength(1)
    const r1 = runEvents(lines, 'r1')
    expect(r1[0].event.kind).toBe('run.start')
    expect(r1[r1.length - 1].event.kind).toBe('run.end')
    expect(r1.every((l) => l.event.runId === 'r1')).toBe(true)
  })
})

describe('summarizeRun', () => {
  it('folds a run of four calls', () => {
    const s = summarizeRun(fixtureLines(), 'r1')!
    expect(s).toMatchObject({
      runId: 'r1',
      startedAt: '2026-03-05T10:00:00.000Z',
      endedAt: '2026-03-05T10:00:15.000Z',
      runbook: RUNBOOK,
      hosts: HOSTS,
      model: 'claude-opus',
      planText: '1. check\n2. restart',
      planDecision: 'approved',
      ok: false,
      error: 'step failed',
      costUsd: 0.5
    })
    expect(s.calls.map((c) => c.callId)).toEqual(['c1', 'c2', 'c3', 'c4'])
    const [c1, c2, c3, c4] = s.calls
    expect(c1).toMatchObject({
      decision: 'allow',
      class: 'read',
      exitCode: 0,
      timedOut: false,
      durationMs: 1200,
      startedAt: '2026-03-05T10:00:03.000Z',
      argv: ['systemctl', 'status', 'api'],
      stdoutHead: 'out c1',
      title: 'verificação do estado do serviço'
    })
    expect(c1.answer).toBeUndefined()
    expect(c2).toMatchObject({ decision: 'ask', answer: 'allow', exitCode: 1, class: 'mutate' })
    expect(c3).toMatchObject({ decision: 'deny', reason: 'hard denylist' })
    expect(c3.exitCode).toBeUndefined()
    expect(c3.title).toBeUndefined()
    expect(c4).toMatchObject({ exitCode: null, timedOut: true })
  })

  it('returns null for a run with no run.start', () => {
    expect(summarizeRun(fixtureLines(), 'nope')).toBeNull()
  })

  it('keeps a call seen before its call.decided and marks it', () => {
    const lines = parseLedger(
      ledger([
        start(),
        { kind: 'call.started', runId: 'r1', callId: 'x' },
        finished('x', 0),
        { kind: 'call.started', runId: 'r1', callId: 'y' },
        decided('y')
      ]).text
    ).lines
    const s = summarizeRun(lines, 'r1')!
    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]).toMatchObject({ callId: 'x', reason: DECIDED_MISSING, exitCode: 0 })
    // a late decision fills the details but cannot clear the mark
    expect(s.calls[1]).toMatchObject({ callId: 'y', reason: DECIDED_MISSING, decision: 'allow' })
  })

  it('takes the plan from the latest plan.approved when run.start has none', () => {
    const { planText: _omit, ...bare } = start() as Extract<OpsAuditEvent, { kind: 'run.start' }>
    const step = (title: string) => ({ title, commands: [`echo ${title}`], verdict: 'runs', hostName: 'web-1' })
    const events: OpsAuditEvent[] = [
      bare,
      { kind: 'plan.approved', runId: 'r1', by: 'user', planText: '1. first', steps: [step('first')] },
      { kind: 'plan.approved', runId: 'r1', by: 'user', planText: '1. second', steps: [step('second')] },
      // A rejected revision is a decision, not the run's plan.
      { kind: 'plan.rejected', runId: 'r1', by: 'user', planText: '1. third', steps: [step('third')] }
    ]
    const s = summarizeRun(parseLedger(ledger(events).text).lines, 'r1')!
    expect(s.planText).toBe('1. second')
    expect(s.planSteps).toEqual([step('second')])
    expect(s.planDecision).toBe('rejected')

    // A plan written at run.start stays the run's plan text.
    const withStart = summarizeRun(parseLedger(ledger([start(), events[1]]).text).lines, 'r1')!
    expect(withStart.planText).toBe('1. check\n2. restart')
    expect(withStart.planSteps).toEqual([step('first')])
  })

  it('records a write backup', () => {
    const lines = parseLedger(
      ledger([
        start(),
        decided('w', { tool: 'write', path: '/etc/app.conf', argv: undefined }),
        {
          kind: 'write.backup',
          runId: 'r1',
          callId: 'w',
          path: '/etc/app.conf',
          backupPath: '/etc/app.conf.bak',
          beforeSha256: 'e',
          afterSha256: 'f'
        }
      ]).text
    ).lines
    expect(summarizeRun(lines, 'r1')!.calls[0].backup).toEqual({
      path: '/etc/app.conf',
      backupPath: '/etc/app.conf.bak'
    })
  })
})
