import { describe, it, expect } from 'vitest'
import { BRIEFING_MAX_BYTES, historyListText, renderBriefing } from './ops-briefing-pure'
import type { OpsRunListItem } from './ops-audit-pure'
import type { OpsAuditEvent, OpsAuditLine, OpsNote } from './ops-types'

const RUN = 'run-1'
const HOSTS = [
  { id: 'h1', name: 'cmtvwiremaze', host: '192.168.0.38' },
  { id: 'h2', name: 'pg-main', host: '10.0.0.5' }
]

/** Ledger lines one minute apart from 2026-10-19 16:00Z (17:00 in Lisbon). */
function ledger(events: OpsAuditEvent[], t0 = Date.parse('2026-10-19T16:00:00Z')): OpsAuditLine[] {
  return events.map((event, i) => ({ at: new Date(t0 + i * 60_000).toISOString(), prev: 'x', event }))
}

const start = (over: Partial<Extract<OpsAuditEvent, { kind: 'run.start' }>> = {}): OpsAuditEvent => ({
  kind: 'run.start',
  runId: RUN,
  appSessionId: 'term-1',
  runbook: { name: 'despiste', path: '/app/runbooks/despiste', policySha256: 'p', runbookMdSha256: 'r' },
  hosts: HOSTS,
  model: 'claude-opus-5-5',
  scope: { kind: 'host', hostId: 'h1' },
  ...over
})

const note = (n: OpsNote, runId = RUN): OpsAuditEvent => ({ kind: 'note', runId, note: n })

function call(callId: string, argv: string[], over: { exitCode?: number; decision?: 'allow' | 'deny' | 'ask'; runId?: string } = {}): OpsAuditEvent[] {
  const runId = over.runId ?? RUN
  const decided: OpsAuditEvent = {
    kind: 'call.decided',
    runId,
    callId,
    tool: 'run',
    hostId: 'h1',
    host: 'cmtvwiremaze',
    rawInput: { cmd: argv.join(' ') },
    argv,
    class: 'read',
    decision: over.decision ?? 'allow',
    reason: 'matched allow[0]'
  }
  if (over.decision === 'deny') return [decided]
  return [
    decided,
    { kind: 'call.started', runId, callId },
    {
      kind: 'call.finished',
      runId,
      callId,
      exitCode: over.exitCode ?? 0,
      timedOut: false,
      durationMs: 10,
      stdoutBytes: 5,
      stderrBytes: 0,
      stdoutSha256: '',
      stderrSha256: '',
      stdoutHead: 'SECRET-STDOUT',
      stderrHead: ''
    }
  ]
}

const FULL: OpsAuditEvent[] = [
  start({ task: 'Puma does not start under monit.', ticket: 'WM-123', client: 'CM Torres Vedras', resumesRunId: 'run-0' }),
  {
    kind: 'plan.approved',
    runId: RUN,
    by: 'user',
    steps: [
      { title: 'Read the monit log', commands: ['journalctl -t monit'], verdict: 'auto', hostName: 'cmtvwiremaze' },
      { title: 'Restart puma', commands: ['systemctl restart puma'], verdict: 'ask' }
    ],
    skippedSteps: [1]
  },
  note({ kind: 'hypothesis', id: 'oom', text: 'Killed by the OOM killer', status: 'open' }),
  note({ kind: 'hypothesis', id: 'tty', text: 'Blocked waiting for a TTY', status: 'open' }),
  ...call('c1', ['journalctl', '-b', '-t', 'monit']),
  ...call('c2', ['cat', '/etc/shadow'], { decision: 'deny' }),
  ...call('c3', ['systemctl', 'status', 'puma'], { exitCode: 3 }),
  note({ kind: 'hypothesis', id: 'oom', text: 'Killed by the OOM killer', status: 'ruled_out', evidence: 'no OOM in dmesg' }),
  note({ kind: 'hypothesis', id: 'tty', text: 'Blocked waiting for a TTY', status: 'confirmed', evidence: 'wchan=pipe_read' }),
  note({ kind: 'finding', text: 'monit timeout is 30s', evidence: 'puma.conf' }),
  note({ kind: 'summary', text: 'First summary.' }),
  note({ kind: 'summary', text: 'Puma blocks in nginx.sh configure.' }),
  { kind: 'operator.asked', runId: RUN, askId: 'a1', cmd: "sudo grep -h 'puma' /var/log/messages", why: 'monit history', host: 'cmtvwiremaze' },
  { kind: 'operator.answered', runId: RUN, askId: 'a1', output: 'x'.repeat(1000) },
  { kind: 'operator.asked', runId: RUN, askId: 'a2', cmd: 'sudo cat /var/log/nginx/error.log', why: 'the 502s' },
  { kind: 'operator.answered', runId: RUN, askId: 'a2', declined: true },
  { kind: 'run.handover', runId: RUN, childRunId: 'run-2', runbook: 'reload-wmcp' },
  { kind: 'run.end', runId: RUN, ok: true, costUsd: 0.1 }
]

describe('renderBriefing', () => {
  it('briefs a finished run from its ledger lines', () => {
    const md = renderBriefing(ledger(FULL), [], { resumedBy: [{ runId: 'run-9', startedAt: '2026-10-20T09:00:00Z' }] })
    expect(md).toMatch(/^# Earlier intervention run-1\n\n- When: 2026-10-19 17:00 to 2026-10-19 \d\d:\d\d \(Lisbon\)\n/)
    expect(md).toContain('- Server: cmtvwiremaze\n')
    expect(md).toContain('- Runbook: despiste\n')
    expect(md).toContain('- Task: Puma does not start under monit.\n')
    expect(md).toContain('- Ticket: WM-123\n')
    expect(md).toContain('- Client: CM Torres Vedras\n')
    expect(md).toContain('- Outcome: finished\n')
    expect(md).toContain('- Resumed run run-0\n')
    expect(md).toContain('- Handed over to runbook reload-wmcp (run run-2)\n')
    expect(md).toContain('- Resumed later by run run-9 (2026-10-20 10:00)\n')
    // The latest summary wins; hypotheses keep their place with their last status.
    expect(md).toContain('## Summary\n\nPuma blocks in nginx.sh configure.\n')
    expect(md).not.toContain('First summary.')
    expect(md).toContain('1. Read the monit log (cmtvwiremaze)\n2. Restart puma (skipped)\n')
    expect(md).toContain('- [ruled_out] Killed by the OOM killer (evidence: no OOM in dmesg)\n- [confirmed] Blocked waiting for a TTY (evidence: wchan=pipe_read)\n')
    expect(md).toContain('- monit timeout is 30s (evidence: puma.conf)\n')
    // Operator output: the first 300 characters only; a decline says so.
    expect(md).toContain(`answered: "${'x'.repeat(300)}… [cut]"`)
    expect(md).not.toContain('x'.repeat(301))
    expect(md).toContain('- `sudo cat /var/log/nginx/error.log`: declined\n')
    expect(md).toContain('## Calls (3)\n\n- cmtvwiremaze: `journalctl -b -t monit` (allowed, exit 0)\n- cmtvwiremaze: `cat /etc/shadow` (denied by policy)\n- cmtvwiremaze: `systemctl status puma` (allowed, exit 3)\n')
    // Call output never reaches the briefing.
    expect(md).not.toContain('SECRET-STDOUT')
  })

  it('says how an aborted run, and one with no end, finished', () => {
    const aborted = renderBriefing(ledger([start(), { kind: 'run.end', runId: RUN, ok: false, costUsd: 0, aborted: true }]), [])
    expect(aborted).toContain('- Outcome: stopped by the operator\n')
    expect(aborted).toContain('## Calls (0)\n\nNone.\n')
    const error = renderBriefing(ledger([start(), { kind: 'run.end', runId: RUN, ok: false, costUsd: 0, error: 'CLI exited 1' }]), [])
    expect(error).toContain('- Outcome: ended with an error: CLI exited 1\n')
    expect(renderBriefing(ledger([start()]), [])).toContain('- Outcome: no end recorded')
  })

  it('lists only the last 40 calls and stays under 8 KB, cutting with a marker', () => {
    const many: OpsAuditEvent[] = [start()]
    for (let i = 0; i < 60; i++) many.push(...call(`c${i}`, ['grep', '-r', `pattern-${i}-${'y'.repeat(250)}`, '/var/log']))
    const md = renderBriefing(ledger(many), [])
    expect(Buffer.byteLength(md, 'utf-8')).toBeLessThanOrEqual(BRIEFING_MAX_BYTES)
    expect(md).toContain('## Calls (last 40 of 60)')
    expect(md).not.toContain('pattern-19-')
    expect(md).toContain('pattern-20-')
    expect(md).toMatch(/\[briefing cut at 8 KB: \d+ more lines left out\]\n$/)
    // A short run is never cut.
    expect(renderBriefing(ledger(FULL), [])).not.toContain('briefing cut')
  })

  it('names at most three ancestors, one line each, nearest first', () => {
    const anc = (id: string, day: string, task: string): OpsAuditLine[] =>
      ledger([start({ runId: id, task }), { kind: 'run.end', runId: id, ok: true, costUsd: 0 }], Date.parse(`${day}T09:00:00Z`))
    const md = renderBriefing(ledger([start({ resumesRunId: 'r3' })]), [
      anc('r3', '2026-10-18', 'Third'),
      anc('r2', '2026-10-17', 'Second'),
      anc('r1', '2026-10-16', 'First'),
      anc('r0', '2026-10-15', 'Zeroth')
    ])
    expect(md).toContain(
      '## Earlier in this chain\n\n- r3 (2026-10-18 10:00, despiste): Third; finished\n- r2 (2026-10-17 10:00, despiste): Second; finished\n- r1 (2026-10-16 10:00, despiste): First; finished\n'
    )
    expect(md).not.toContain('Zeroth')
  })

  it('has nothing to brief without a run.start', () => {
    expect(renderBriefing([], [])).toBe('This run has no start in the ledger, so there is nothing to brief.\n')
  })
})

describe('historyListText', () => {
  it('says so when there is nothing in scope', () => {
    expect(historyListText([])).toBe('No earlier interventions on record for the hosts this run may reach.\n')
  })

  it('lists one run per line with its id, day, hosts, runbook, task and outcome', () => {
    const item: OpsRunListItem = {
      runId: 'run-5',
      appSessionId: 'term-1',
      startedAt: '2026-10-19T16:00:00Z',
      endedAt: '2026-10-19T16:30:00Z',
      runbook: 'despiste',
      runbookPath: '/app/runbooks/despiste',
      hostNames: ['cmtvwiremaze'],
      task: 'Puma\ndoes not start',
      ok: true,
      calls: 7,
      resumesRunId: 'run-4'
    }
    const text = historyListText([item, { ...item, runId: 'run-6', task: undefined, ok: false, aborted: true, resumesRunId: undefined }])
    expect(text).toContain('newest first (2). Call past_interventions with a runId to read one.\n\n')
    expect(text).toContain('- run-5 · 2026-10-19 17:00 · cmtvwiremaze · despiste · Puma does not start · finished, 7 calls; resumed run-4\n')
    expect(text).toContain('- run-6 · 2026-10-19 17:00 · cmtvwiremaze · despiste · (no task) · stopped, 7 calls\n')
  })
})
