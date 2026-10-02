import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLedger } from './ops-audit'
import { GENESIS } from './ops-audit-pure'
import type { OpsAuditEvent } from './ops-types'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-ops-audit-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const HOST = { id: 'h1', name: 'web-01', host: '10.20.0.11' }

const START: OpsAuditEvent = {
  kind: 'run.start',
  runId: 'run-1',
  appSessionId: 's1',
  runbook: {
    name: 'nginx-config-reload',
    path: '/repo/runbooks/nginx-config-reload',
    policySha256: 'a'.repeat(64),
    runbookMdSha256: 'b'.repeat(64),
    platform: 'cityfy'
  },
  hosts: [HOST],
  model: 'claude-opus',
  planText: '1. Check nginx'
}

const DECIDED: OpsAuditEvent = {
  kind: 'call.decided',
  runId: 'run-1',
  callId: 'c1',
  tool: 'run',
  hostId: 'h1',
  host: 'web-01',
  rawInput: { tool: 'run', hostId: 'h1', cmd: 'systemctl status nginx-frontend' },
  argv: ['systemctl', 'status', 'nginx-frontend'],
  class: 'read',
  decision: 'allow',
  reason: 'matched allow[0]',
  rule: '^systemctl status nginx-frontend$',
  title: 'A verificação do estado do serviço web'
}

const STARTED: OpsAuditEvent = { kind: 'call.started', runId: 'run-1', callId: 'c1' }

const FINISHED: OpsAuditEvent = {
  kind: 'call.finished',
  runId: 'run-1',
  callId: 'c1',
  exitCode: 0,
  timedOut: false,
  durationMs: 120,
  stdoutBytes: 30,
  stderrBytes: 0,
  stdoutSha256: 'c'.repeat(64),
  stderrSha256: 'd'.repeat(64),
  stdoutHead: 'nginx-frontend.service active',
  stderrHead: ''
}

const END: OpsAuditEvent = { kind: 'run.end', runId: 'run-1', ok: true, costUsd: 0.01 }

const OTHER: OpsAuditEvent = { kind: 'plan.approved', runId: 'run-2', by: 'user' }

const lines = (file: string): string[] => fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)

describe('ops ledger on disk', () => {
  it('appends three events to one day file, creating the folder, and verifies', async () => {
    const sub = path.join(dir, 'ops-audit')
    const ledger = createLedger(sub)
    const at = new Date('2026-03-05T10:00:00.000Z')
    const results = await Promise.all([ledger.append(START, at), ledger.append(DECIDED, at), ledger.append(STARTED, at)])
    expect(results.every((r) => r.ok)).toBe(true)
    const file = path.join(sub, '2026-03-05.jsonl')
    const raws = lines(file)
    expect(raws.map((r) => JSON.parse(r).event.kind)).toEqual(['run.start', 'call.decided', 'call.started'])
    expect(JSON.parse(raws[0]).prev).toBe(GENESIS)
    expect(await ledger.verify('2026-03-05')).toEqual({ ok: true, lines: 3 })
    expect(await ledger.info()).toEqual({ dir: sub, files: 1, bytes: fs.statSync(file).size })
  })

  it('continues the chain from the file tail after a restart', async () => {
    const at = new Date('2026-03-05T10:00:00.000Z')
    await createLedger(dir).append(START, at)
    const second = createLedger(dir)
    await second.append(DECIDED, at)
    expect(await second.verify('2026-03-05')).toEqual({ ok: true, lines: 2 })
  })

  it('starts a new file at genesis across midnight, and readRun finds both halves', async () => {
    const ledger = createLedger(dir)
    await ledger.append(START, new Date('2026-03-05T23:59:58.000Z'))
    await ledger.append(DECIDED, new Date('2026-03-05T23:59:59.000Z'))
    await ledger.append(OTHER, new Date('2026-03-05T23:59:59.500Z'))
    await ledger.append(STARTED, new Date('2026-03-06T00:00:01.000Z'))
    await ledger.append(FINISHED, new Date('2026-03-06T00:00:02.000Z'))

    const day1 = lines(path.join(dir, '2026-03-05.jsonl'))
    const day2 = lines(path.join(dir, '2026-03-06.jsonl'))
    expect(day1).toHaveLength(3)
    expect(day2).toHaveLength(2)
    expect(JSON.parse(day2[0]).prev).toBe(GENESIS)
    expect(await ledger.verify('2026-03-05')).toEqual({ ok: true, lines: 3 })
    expect(await ledger.verify('2026-03-06')).toEqual({ ok: true, lines: 2 })

    const near = await ledger.readRun('run-1', new Date('2026-03-06T08:00:00.000Z'))
    expect(near.ok && near.lines.map((l) => l.event.kind)).toEqual([
      'run.start',
      'call.decided',
      'call.started',
      'call.finished'
    ])
    // Read months later: the fallback scan still finds it.
    const later = await ledger.readRun('run-1', new Date('2026-09-01T00:00:00.000Z'))
    expect(later.ok && later.lines).toHaveLength(4)
    expect(await ledger.readRun('nope')).toEqual({ ok: true, lines: [] })
  })

  it('detects a tampered byte', async () => {
    const ledger = createLedger(dir)
    const at = new Date('2026-03-05T10:00:00.000Z')
    for (const e of [START, DECIDED, STARTED]) await ledger.append(e, at)
    const file = path.join(dir, '2026-03-05.jsonl')
    const text = fs.readFileSync(file, 'utf-8')
    fs.writeFileSync(file, text.replace('nginx-frontend', 'nginx-frontenD'))
    const r = await ledger.verify('2026-03-05')
    expect(r).toMatchObject({ ok: false, brokenAt: 3 })
  })

  it('does not fuse a new line onto an interrupted one', async () => {
    const at = new Date('2026-03-05T10:00:00.000Z')
    await createLedger(dir).append(START, at)
    const file = path.join(dir, '2026-03-05.jsonl')
    fs.appendFileSync(file, '{"at":"cut off')
    const ledger = createLedger(dir)
    expect((await ledger.append(DECIDED, at)).ok).toBe(true)
    const raws = lines(file)
    expect(raws).toHaveLength(3)
    expect(JSON.parse(raws[2]).event.kind).toBe('call.decided')
    // The cut line is still there and the chain says so.
    expect(await ledger.verify('2026-03-05')).toMatchObject({ ok: false, brokenAt: 2 })
  })

  it('verify refuses a bad date and a missing day', async () => {
    const ledger = createLedger(dir)
    expect(await ledger.verify('05-03-2026')).toMatchObject({ ok: false })
    expect(await ledger.verify('2026-01-01')).toMatchObject({ ok: false, reason: /No ledger file/ })
  })

  it('renders the internal report with the argv and the client report without it', async () => {
    const ledger = createLedger(dir)
    const at = new Date()
    for (const e of [START, DECIDED, STARTED, FINISHED, END]) await ledger.append(e, at)

    const internal = await ledger.report('run-1', 'internal')
    expect(internal.ok).toBe(true)
    if (!internal.ok) return
    expect(internal.markdown).toContain('systemctl status nginx-frontend')
    expect(internal.warnings).toEqual([])

    const client = await ledger.report('run-1', 'client', { hostGroups: { web: ['web-*'] }, hosts: [HOST] })
    expect(client.ok).toBe(true)
    if (!client.ok) return
    expect(client.markdown).not.toContain('systemctl')
    expect(client.markdown).not.toContain('nginx-frontend')
    expect(client.markdown).not.toContain('10.20.0.11')
    expect(client.markdown).not.toContain('web-01')

    expect(await ledger.report('missing', 'internal')).toMatchObject({ ok: false })
  })

  it('readSession returns every run of one chat, across days, in file order', async () => {
    const ledger = createLedger(dir)
    const START2: OpsAuditEvent = { ...START, runId: 'run-3' } as OpsAuditEvent
    const OTHER_START: OpsAuditEvent = { ...START, runId: 'run-2', appSessionId: 's2' } as OpsAuditEvent
    await ledger.append(START, new Date('2026-03-05T23:59:58.000Z'))
    await ledger.append(OTHER_START, new Date('2026-03-05T23:59:59.000Z'))
    await ledger.append(OTHER, new Date('2026-03-05T23:59:59.500Z'))
    await ledger.append(DECIDED, new Date('2026-03-06T00:00:01.000Z'))
    await ledger.append(END, new Date('2026-03-06T00:00:02.000Z'))
    await ledger.append(START2, new Date('2026-03-07T09:00:00.000Z'))
    await ledger.append({ kind: 'plan.approved', runId: 'run-3', by: 'user' }, new Date('2026-03-07T09:00:01.000Z'))

    const r = await ledger.readSession('s1')
    expect(r.ok && r.lines.map((l) => `${l.event.runId}:${l.event.kind}`)).toEqual([
      'run-1:run.start',
      'run-1:call.decided',
      'run-1:run.end',
      'run-3:run.start',
      'run-3:plan.approved'
    ])
    const other = await ledger.readSession('s2')
    expect(other.ok && other.lines.map((l) => `${l.event.runId}:${l.event.kind}`)).toEqual(['run-2:run.start', 'run-2:plan.approved'])
    expect(await ledger.readSession('nobody')).toEqual({ ok: true, lines: [] })
    expect(await createLedger(path.join(dir, 'not-yet')).readSession('s1')).toEqual({ ok: true, lines: [] })
  })

  it('readSession looks through the newest 30 day files only', async () => {
    const ledger = createLedger(dir)
    await ledger.append(START, new Date('2026-01-01T10:00:00.000Z'))
    for (let d = 0; d < 30; d++) {
      await ledger.append(OTHER, new Date(Date.parse('2026-02-01T10:00:00.000Z') + d * 86_400_000))
    }
    expect(await ledger.readSession('s1')).toEqual({ ok: true, lines: [] })
  })

  it('reports an empty folder that does not exist yet', async () => {
    const missing = path.join(dir, 'not-yet')
    expect(await createLedger(missing).info()).toEqual({ dir: missing, files: 0, bytes: 0 })
  })
})
