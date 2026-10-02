import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLedger, type OpsLedger } from './ops-audit'
import { sha256Hex, summarizeRun } from './ops-audit-pure'
import { clientReportWarnings } from './ops-report-pure'
import { createFakeBackend, type FakeBackend, type FakeScript } from './ops-backend-fake'
import { createExecutor } from './ops-exec-pure'
import { assembleRunbook, scriptPinError, type LoadedRunbook, type LoadRunbookResult } from './ops-runbook-pure'
import {
  bridgeSessionFor,
  callOpsTool,
  DEFAULT_FILE_TITLES,
  finishOpsRun,
  openOpsSession,
  type OpenOpsSessionResult,
  type OpsAskFn,
  type OpsAskSecretFn,
  type OpsSession,
  type OpsSessionOptions
} from './ops-session'
import { PLAN_REJECTED_MESSAGE } from './ops-run-pure'
import type { OpsAuditLine, OpsHostRef } from './ops-types'

/**
 * Whole ops sessions as the terminal bridge drives them: openOpsSession, then every tool
 * call through callOpsTool (the gate's decision, then the handler on the same input),
 * then finishOpsRun. The fake backend stands in for the hosts and the ledger lives in a
 * temp folder. Local tools (Read/Grep/Glob) and calls that bypass the gate go through the
 * session's canUseTool and handlers directly, since callOpsTool only takes ops tools.
 */

const HOSTS: OpsHostRef[] = [
  { id: 'h1', name: 'web-01', host: '10.0.0.11' },
  { id: 'h2', name: 'db-01', host: '10.0.0.12' }
]
const CHECK_SH = '#!/bin/sh\nnginx -t\n'

let root: string
let rbDir: string
let ledgerDir: string
let ledger: OpsLedger

/**
 * The disk half of ops-runbook.ts without its stored-host import (ssh.ts → electron):
 * the same files, the same pure assembly, the hosts handed in.
 */
async function loadFixture(dir: string): Promise<LoadRunbookResult> {
  const scriptsDir = path.join(dir, 'scripts')
  const scriptHashes: Record<string, string> = {}
  for (const f of fs.readdirSync(scriptsDir)) scriptHashes[f] = sha256Hex(fs.readFileSync(path.join(scriptsDir, f)))
  return assembleRunbook({
    dir,
    runbookMd: fs.readFileSync(path.join(dir, 'RUNBOOK.md')),
    policyJson: fs.readFileSync(path.join(dir, 'policy.json')),
    scriptHashes,
    hosts: HOSTS
  })
}

async function readFixtureScript(runbook: LoadedRunbook, name: string) {
  const content = fs.readFileSync(path.join(runbook.scriptsDir, name))
  const sha256 = sha256Hex(content)
  const err = scriptPinError(runbook.policy, name, sha256)
  return err ? { ok: false as const, error: err } : { ok: true as const, content, sha256 }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-ops-session-'))
  rbDir = path.join(root, 'nginx-config-reload')
  ledgerDir = path.join(root, 'ops-audit')
  fs.mkdirSync(path.join(rbDir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(rbDir, 'scripts', 'check.sh'), CHECK_SH)
  fs.writeFileSync(path.join(rbDir, 'RUNBOOK.md'), '# Reload nginx\n1. Check the config.\n')
  fs.writeFileSync(
    path.join(rbDir, 'policy.json'),
    JSON.stringify({
      version: 1,
      strict: true,
      hosts: { web: ['web-01'] },
      allow: [
        { hosts: ['web'], cmd: '^systemctl status nginx$', class: 'read', title: 'Estado do serviço web' },
        { hosts: ['web'], cmd: '^sudo systemctl reload nginx$', class: 'mutate', approval: 'ask', title: 'Recarregamento' }
      ],
      scripts: [{ name: 'check.sh', sha256: sha256Hex(CHECK_SH), hosts: ['web'], class: 'read', title: 'Verificação' }],
      read: { paths: ['^/etc/nginx/.*$'] }
    })
  )
  ledger = createLedger(ledgerDir)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function baseOptions(fake: FakeBackend, abort = new AbortController()): OpsSessionOptions {
  return {
    appSessionId: 'opsterm_t1',
    runbookPath: rbDir,
    model: 'claude CLI (terminal)',
    ledger,
    executor: createExecutor(fake),
    abort,
    loadRunbook: loadFixture,
    readScript: readFixtureScript
  }
}

/**
 * An open session. Most tests are about one call, so the plan counts as approved unless
 * `plan: false` (set directly: no plan.approved line, so their ledger assertions stay
 * about the call).
 */
async function start(
  script: FakeScript = {},
  ask?: OpsAskFn,
  extra: { plan?: boolean; askSecret?: OpsAskSecretFn } = {}
): Promise<{
  fake: FakeBackend
  session: Extract<OpenOpsSessionResult, { ok: true }>
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
  abort: AbortController
  live: OpsAuditLine[]
}> {
  const fake = createFakeBackend(script)
  const abort = new AbortController()
  const live: OpsAuditLine[] = []
  const r = await openOpsSession({
    ...baseOptions(fake, abort),
    hostAddress: (id) => `ops@${id}:22`,
    onEvent: (line) => live.push(line),
    runId: 'run-1',
    ...(ask ? { ask } : {}),
    ...(extra.askSecret ? { askSecret: extra.askSecret } : {})
  })
  if (!r.ok) throw new Error(r.error)
  if (extra.plan !== false) r.ctx.planApproved = true
  const session: OpsSession = r
  return { fake, session: r, call: (tool, args) => callOpsTool(session, tool, args), abort, live }
}

async function kinds(): Promise<string[]> {
  const r = await ledger.readRun('run-1')
  if (!r.ok) throw new Error(r.error)
  return r.lines.map((l) => l.event.kind)
}

async function lines(): Promise<OpsAuditLine[]> {
  const r = await ledger.readRun('run-1')
  if (!r.ok) throw new Error(r.error)
  return r.lines
}

const hostCalls = (fake: FakeBackend) => fake.calls.filter((c) => c.kind !== 'reachable')

describe('ops session through callOpsTool', () => {
  it('a full run logs start, decision, start and end of the call, and run end in order', async () => {
    const { fake, session, call, live } = await start({ exec: () => ({ stdout: 'active (running)' }) })

    const res = await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })
    expect(res).toEqual({ text: 'exit code 0\nstdout:\nactive (running)\nstderr:\n(empty)', isError: false })
    await finishOpsRun(session.ctx, { ok: true, costUsd: 0.12 })
    // A second end (the pty exit after a stop) is not logged twice.
    await finishOpsRun(session.ctx, { ok: false, costUsd: 0 })

    expect(await kinds()).toEqual(['run.start', 'call.decided', 'call.started', 'call.finished', 'run.end'])
    expect(hostCalls(fake)).toEqual([
      { kind: 'exec', hostId: 'h1', args: { argv: ['systemctl', 'status', 'nginx'], stdin: undefined, timeoutMs: 60_000 } }
    ])
    // Reachability is checked once per runbook host, and only for hosts in a group.
    expect(fake.calls.filter((c) => c.kind === 'reachable').map((c) => c.hostId)).toEqual(['h1'])

    const l = await lines()
    expect(l[0].event).toMatchObject({ kind: 'run.start', appSessionId: 'opsterm_t1', model: 'claude CLI (terminal)' })
    expect(l[1].event).toMatchObject({
      kind: 'call.decided',
      callId: 'run-1-1',
      tool: 'run',
      host: 'web-01',
      argv: ['systemctl', 'status', 'nginx'],
      decision: 'allow',
      rule: '^systemctl status nginx$'
    })
    expect(l[3].event).toMatchObject({ kind: 'call.finished', callId: 'run-1-1', exitCode: 0, stdoutHead: 'active (running)' })
    expect(l[4].event).toMatchObject({ kind: 'run.end', ok: true, costUsd: 0.12 })
    // The live timeline saw every line the ledger holds.
    expect(live.map((x) => x.event.kind)).toEqual(await kinds())
  })

  it('refuses an unknown tool without logging, and treats non-object args as empty', async () => {
    const { fake, call } = await start()
    expect(await call('exec', { hostId: 'h1', cmd: 'id' })).toEqual({ text: 'Refused: unknown ops tool exec.', isError: true })
    expect(await call('Bash', { command: 'dir' })).toEqual({ text: 'Refused: unknown ops tool Bash.', isError: true })
    expect(await kinds()).toEqual(['run.start'])

    const arr = await call('run', ['systemctl', 'status', 'nginx'] as unknown as Record<string, unknown>)
    expect(arr.isError).toBe(true)
    expect(arr.text).toMatch(/^Refused: /)
    expect(hostCalls(fake)).toEqual([])
    const l = await lines()
    expect(l[1].event).toMatchObject({ kind: 'call.decided', decision: 'deny', rawInput: {} })
  })

  it('the bridge session says hello with the runbook, its hosts and the six tools, and calls through the gate', async () => {
    const { fake, session } = await start({ exec: () => ({ stdout: 'ok' }) })
    const bridge = bridgeSessionFor(session)
    const hello = bridge.hello()
    expect(hello.runbook).toBe('nginx-config-reload')
    expect(hello.hosts).toEqual([{ id: 'h1', name: 'web-01', groups: ['web'] }])
    expect(hello.tools).toEqual(['propose_plan', 'run', 'script', 'read', 'list', 'write'])
    expect((await bridge.call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)
    expect((await bridge.call('run', { hostId: 'h1', cmd: 'systemctl stop nginx' })).isError).toBe(true)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])
  })

  it('a denied call never reaches the backend, and is logged with the full input', async () => {
    const { fake, session, call } = await start()
    const chained = await call('run', { hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
    expect(chained.isError).toBe(true)
    expect(chained.text).toMatch(/^Refused by the runbook policy: /)
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl stop nginx' })).isError).toBe(true)
    expect((await call('run', { hostId: 'h2', cmd: 'systemctl status nginx' })).isError).toBe(true)

    // Even called straight, past the gate, the handler refuses to run it.
    const direct = await session.tools.run({ hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
    expect(direct.isError).toBe(true)

    expect(hostCalls(fake)).toEqual([])
    const denied = (await lines()).filter((l) => l.event.kind === 'call.decided')
    expect(denied).toHaveLength(4)
    expect(denied.every((l) => (l.event as { decision: string }).decision === 'deny')).toBe(true)
    expect((denied[0].event as { rawInput: unknown }).rawInput).toEqual({ hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
  })

  it('an ask answered deny is logged and not executed', async () => {
    const asked: unknown[] = []
    const { fake, session, call } = await start({}, async (req) => {
      asked.push(req)
      return { allow: false }
    })
    const input = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    expect(await call('run', input)).toEqual({ text: 'Denied by the operator.', isError: true })
    expect(asked).toEqual([
      {
        tool: 'mcp__ops__run',
        input,
        ops: {
          hostName: 'web-01',
          hostAddress: 'ops@h1:22',
          tool: 'run',
          class: 'mutate',
          reason: expect.stringContaining('matched allow rule'),
          rule: '^sudo systemctl reload nginx$',
          title: 'Recarregamento',
          argv: ['sudo', 'systemctl', 'reload', 'nginx'],
          queuedBehind: 0,
          runbook: 'nginx-config-reload'
        }
      }
    ])
    expect(hostCalls(fake)).toEqual([])
    expect(await kinds()).toEqual(['run.start', 'call.decided', 'call.asked', 'call.answered'])
    expect((await lines())[3].event).toMatchObject({ kind: 'call.answered', answer: 'deny' })

    // The denied call's id was dropped, so a stray handler call cannot pick it up.
    expect((await session.tools.run(input)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
  })

  it('an ask answered allow runs; deny-and-stop aborts the run', async () => {
    let answer = { allow: true, stop: false }
    const { fake, call, abort } = await start({}, async () => answer)
    const input = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    expect((await call('run', input)).isError).toBe(false)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])

    answer = { allow: false, stop: true }
    expect(await call('run', input)).toEqual({ text: 'Denied by the operator, who stopped the run.', isError: true })
    expect(abort.signal.aborted).toBe(true)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])
    expect((await lines()).at(-1)?.event).toMatchObject({ kind: 'call.answered', answer: 'stop' })
  })

  it('without an ask hook, an ask is a deny', async () => {
    const { fake, call } = await start()
    expect((await call('run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
  })

  it('an unreachable host stops the run before run.start', async () => {
    const fake = createFakeBackend({ reachable: { h1: false } })
    const r = await openOpsSession(baseOptions(fake))
    expect(r).toEqual({ ok: false, error: 'web-01 is unreachable. Is the VPN connected? Timed out while waiting for handshake' })
    expect((await ledger.info()).files).toBe(0)
  })

  it('an invalid policy refuses the run and lists the errors', async () => {
    fs.writeFileSync(path.join(rbDir, 'policy.json'), JSON.stringify({ version: 1, strict: true, hosts: {}, allow: [{ hosts: [], cmd: 'df', class: 'read' }], scripts: [] }))
    const fake = createFakeBackend()
    const r = await openOpsSession(baseOptions(fake))
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/policy\.json has \d+ error\(s\)\.\n- /)
    expect(fake.calls).toEqual([])
    expect((await ledger.info()).files).toBe(0)
  })

  it('a script edited after load is refused and logged, and never uploaded', async () => {
    const { fake, call } = await start()
    // The gate decides on the pinned hash; the handler re-reads the bytes and refuses.
    fs.writeFileSync(path.join(rbDir, 'scripts', 'check.sh'), CHECK_SH + 'rm -rf /tmp/x\n')
    const res = await call('script', { hostId: 'h1', name: 'check.sh', args: [] })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/changed since the policy pinned it/)
    expect(hostCalls(fake)).toEqual([])
    const l = await lines()
    expect(l.map((x) => x.event.kind)).toEqual(['run.start', 'call.decided', 'call.started', 'call.finished'])
    expect(l[1].event).toMatchObject({ kind: 'call.decided', decision: 'allow' })
    expect(l[3].event).toMatchObject({ kind: 'call.finished', exitCode: null })
    expect((l[3].event as { stderrHead: string }).stderrHead).toMatch(/changed since the policy pinned it/)
  })

  it('an unchanged script runs with its pinned bytes; args past the policy are refused', async () => {
    const { fake, call } = await start()
    expect((await call('script', { hostId: 'h1', name: 'check.sh', args: [] })).isError).toBe(false)
    // The policy gives check.sh no args, so one more is refused before any upload.
    const extra = await call('script', { hostId: 'h1', name: 'check.sh', args: ['--verbose'] })
    expect(extra.isError).toBe(true)
    expect(extra.text).toContain("takes at most 0 argument(s)")
    expect(hostCalls(fake)).toEqual([
      { kind: 'runScript', hostId: 'h1', args: { name: 'check.sh', args: [], sha256: sha256Hex(CHECK_SH), stdin: undefined, timeoutMs: 60_000 } }
    ])
  })

  it('reads go through the read paths', async () => {
    const { fake, call } = await start({ files: { '/etc/nginx/nginx.conf': 'worker_processes 2;' } })
    expect(await call('read', { hostId: 'h1', path: '/etc/nginx/nginx.conf' })).toEqual({ text: 'worker_processes 2;', isError: false })
    expect((await call('read', { hostId: 'h1', path: '/etc/shadow' })).isError).toBe(true)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['read'])
  })

  it('file calls get a default step title, so the client report has words for them', async () => {
    const { call } = await start({ files: { '/etc/nginx/nginx.conf': 'worker_processes 2;' } })
    await call('read', { hostId: 'h1', path: '/etc/nginx/nginx.conf' })
    await call('list', { hostId: 'h1', path: '/etc/nginx' })
    await call('write', { hostId: 'h1', path: '/etc/nginx/x.conf', content: 'x' })
    await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })
    const decided = (await lines()).filter((l) => l.event.kind === 'call.decided').map((l) => l.event)
    expect(decided.map((e) => (e.kind === 'call.decided' ? [e.tool, e.title] : []))).toEqual([
      ['read', DEFAULT_FILE_TITLES.read],
      ['list', DEFAULT_FILE_TITLES.list],
      ['write', DEFAULT_FILE_TITLES.write],
      // A rule's own title wins.
      ['run', 'Estado do serviço web']
    ])
    const summary = summarizeRun(await lines(), 'run-1')
    expect(summary && clientReportWarnings(summary)).toEqual([])
  })

  it('local tools: Read inside the runbook only, everything else refused', async () => {
    const { session } = await start()
    expect((await session.canUseTool('Read', { file_path: path.join(rbDir, 'RUNBOOK.md') })).behavior).toBe('allow')
    expect((await session.canUseTool('Read', { file_path: path.join(root, 'ops-audit', 'x') })).behavior).toBe('deny')
    expect((await session.canUseTool('Bash', { command: 'dir' })).behavior).toBe('deny')
    expect((await session.canUseTool('mcp__github__create_issue', {})).behavior).toBe('deny')
    // None of these are ops calls, so the ledger only has the start.
    expect(await kinds()).toEqual(['run.start'])
  })

  it('local tools: Grep and Glob look inside the runbook folder only', async () => {
    const { session } = await start()
    const allow = async (tool: string, input: Record<string, unknown>) => (await session.canUseTool(tool, input)).behavior
    expect(await allow('Grep', { pattern: 'nginx', path: rbDir })).toBe('allow')
    expect(await allow('Grep', { pattern: 'nginx', path: root })).toBe('deny')
    expect(await allow('Glob', { pattern: '**/*.sh', path: path.join(rbDir, 'scripts') })).toBe('allow')
    expect(await allow('Glob', { pattern: '../**/*' })).toBe('deny')
    expect(await allow('Glob', { pattern: path.join(root, 'ops-audit', '*') })).toBe('deny')
    expect(await kinds()).toEqual(['run.start'])
  })

  it('a malformed ops call is refused and still logged', async () => {
    const { fake, call } = await start()
    expect((await call('script', { hostId: 'h1', name: 'check.sh', args: 'a; b' })).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    expect((await lines())[1].event).toMatchObject({ kind: 'call.decided', decision: 'deny', reason: 'args must be an array of strings' })
  })

  it('a stopped run refuses calls already approved', async () => {
    const { fake, session, abort } = await start()
    const input = { hostId: 'h1', cmd: 'systemctl status nginx' }
    // Split on purpose: the stop lands between the gate's allow and the handler.
    expect((await session.canUseTool('mcp__ops__run', input)).behavior).toBe('allow')
    abort.abort()
    expect((await session.tools.run(input)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    // And once stopped, a new call through the bridge never reaches a host either.
    expect((await callOpsTool(session, 'run', input)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    await finishOpsRun(session.ctx, { ok: false, costUsd: 0, aborted: true })
    expect((await lines()).at(-1)?.event).toMatchObject({ kind: 'run.end', ok: false, aborted: true })
  })

  it('a sudo that wants a password tells the model to stop', async () => {
    const { call } = await start({ exec: () => ({ exitCode: 1, stderr: 'sudo: a password is required' }) }, async () => ({ allow: true }))
    const res = await call('run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('sudo: a password is required')
    expect(res.text).toContain('Argos cannot supply sudo passwords yet')
  })
})

describe('plan first', () => {
  const PLAN = {
    steps: [
      { title: 'check nginx', hostId: 'h1', cmd: 'systemctl status nginx' },
      { title: 'reload nginx', hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    ]
  }
  const STATUS = { hostId: 'h1', cmd: 'systemctl status nginx' }

  it('an ops call before any plan is denied and never reaches the backend; local reads stay open', async () => {
    const { fake, session, call } = await start({}, async () => ({ allow: true }), { plan: false })
    expect(await call('run', STATUS)).toEqual({ text: 'Refused: propose a plan first (mcp__ops__propose_plan).', isError: true })
    // Even called straight, the handler has no decision to run on.
    expect((await session.tools.run(STATUS)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    expect((await session.canUseTool('Read', { file_path: path.join(rbDir, 'RUNBOOK.md') })).behavior).toBe('allow')
    expect((await lines())[1].event).toMatchObject({
      kind: 'call.decided',
      decision: 'deny',
      reason: 'propose a plan first (mcp__ops__propose_plan)',
      argv: ['systemctl', 'status', 'nginx']
    })
  })

  it('an approved plan is asked with its steps, logged, and opens the ops tools', async () => {
    const asked: Parameters<OpsAskFn>[0][] = []
    const { fake, session, call } = await start(
      {},
      async (req) => {
        asked.push(req)
        return { allow: true }
      },
      { plan: false }
    )
    expect(await call('propose_plan', PLAN)).toEqual({ text: 'Plan approved. Proceed step by step.', isError: false })
    expect(asked[0]).toEqual({
      tool: 'mcp__ops__propose_plan',
      input: PLAN,
      ops: {
        hostName: 'nginx-config-reload',
        hostAddress: '',
        tool: 'plan',
        planSteps: [
          {
            title: 'Estado do serviço web',
            hostName: 'web-01',
            commands: ['systemctl status nginx'],
            verdict: 'runs',
            class: 'read',
            reason: 'Estado do serviço web'
          },
          {
            title: 'Recarregamento',
            hostName: 'web-01',
            commands: ['sudo systemctl reload nginx'],
            verdict: 'asks',
            class: 'mutate',
            reason: 'matched allow rule ^sudo systemctl reload nginx$ (mutate, ask)',
            sudo: true
          }
        ],
        planSummary: { runs: 1, asks: 1, denied: 0, mutates: 1 },
        class: 'mutate',
        reason: 'plan approval',
        queuedBehind: 0,
        runbook: 'nginx-config-reload'
      }
    })
    expect(session.ctx.planText).toBe('1. Estado do serviço web — systemctl status nginx\n2. Recarregamento — sudo systemctl reload nginx')
    // Classifying the plan logged nothing per command: only the approval, which carries
    // the steps as the operator saw them (the report's plan, since run.start has none).
    expect(await kinds()).toEqual(['run.start', 'plan.approved'])
    expect((await lines())[1].event).toEqual({
      kind: 'plan.approved',
      runId: 'run-1',
      by: 'user',
      planText: session.ctx.planText,
      steps: [
        { title: 'Estado do serviço web', commands: ['systemctl status nginx'], verdict: 'runs', hostName: 'web-01' },
        { title: 'Recarregamento', commands: ['sudo systemctl reload nginx'], verdict: 'asks', hostName: 'web-01' }
      ]
    })

    expect((await call('run', STATUS)).isError).toBe(false)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])

    // A revised plan goes through the same approval and logs a second plan.approved;
    // plain string steps are still accepted, as steps the gate cannot judge yet.
    expect((await call('propose_plan', { steps: ['web-01: nginx -t'] })).isError).toBe(false)
    expect(asked[1].ops?.planSteps).toEqual([{ title: 'web-01: nginx -t', commands: [], verdict: 'unknown', reason: expect.any(String) }])
    expect(session.ctx.planText).toBe('1. web-01: nginx -t')
    expect(await kinds()).toEqual(['run.start', 'plan.approved', 'call.decided', 'call.started', 'call.finished', 'plan.approved'])
  })

  it('a rejected plan logs plan.rejected and the ops tools stay closed', async () => {
    const { fake, call } = await start({}, async () => ({ allow: false }), { plan: false })
    expect(await call('propose_plan', PLAN)).toEqual({ text: PLAN_REJECTED_MESSAGE, isError: true })
    expect((await call('run', STATUS)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    expect(await kinds()).toEqual(['run.start', 'plan.rejected', 'call.decided'])
    expect((await lines())[1].event).toMatchObject({
      kind: 'plan.rejected',
      steps: [{ title: 'Estado do serviço web' }, { title: 'Recarregamento' }]
    })
  })

  it('a malformed plan is refused without asking; stop on a plan aborts the run', async () => {
    let calls = 0
    const { call, abort } = await start(
      {},
      async () => {
        calls++
        return { allow: false, stop: true }
      },
      { plan: false }
    )
    expect((await call('propose_plan', { steps: [] })).isError).toBe(true)
    expect((await call('propose_plan', { steps: [''] })).isError).toBe(true)
    expect(calls).toBe(0)
    expect(await call('propose_plan', PLAN)).toEqual({ text: 'Denied by the operator, who stopped the run.', isError: true })
    expect(abort.signal.aborted).toBe(true)
    expect(await kinds()).toEqual(['run.start', 'plan.rejected'])
  })
})

describe('sudo password per run', () => {
  const RELOAD = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
  // sudo -S reads the password: the fake succeeds only for the stdin form.
  const sudoScript: FakeScript = {
    exec: (argv) => (argv[1] === '-S' ? { stdout: 'reloaded' } : { exitCode: 1, stderr: 'sudo: a password is required' })
  }

  it('asks once, logs that a password was supplied (never the value), and retries with it on stdin', async () => {
    const asked: unknown[] = []
    const { fake, session, call } = await start(sudoScript, async () => ({ allow: true }), {
      askSecret: async (req) => {
        asked.push(req)
        return 'hunter2'
      }
    })
    const res = await call('run', RELOAD)
    expect(res.isError).toBe(false)
    expect(res.text).toContain('reloaded')
    expect(asked).toEqual([{ hostId: 'h1', hostName: 'web-01', prompt: expect.stringContaining('sudo on web-01') }])
    expect(hostCalls(fake).map((c) => c.args)).toEqual([
      { argv: ['sudo', 'systemctl', 'reload', 'nginx'], stdin: undefined, timeoutMs: 60_000 },
      { argv: ['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'], stdin: 'hunter2\n', timeoutMs: 60_000 }
    ])

    const l = await lines()
    expect(l.map((x) => `${x.event.kind}:${(x.event as { callId?: string }).callId ?? ''}`)).toEqual([
      'run.start:',
      'call.decided:run-1-1',
      'call.asked:run-1-1',
      'call.answered:run-1-1',
      'call.started:run-1-1',
      'call.finished:run-1-1',
      'sudo.password-supplied:',
      'call.decided:run-1-1-retry',
      'call.started:run-1-1-retry',
      'call.finished:run-1-1-retry'
    ])
    expect(l[7].event).toMatchObject({
      kind: 'call.decided',
      decision: 'ask',
      rule: '^sudo systemctl reload nginx$',
      reason: 'retry with sudo password'
    })
    expect(l[9].event).toMatchObject({ exitCode: 0 })
    const raw = fs.readdirSync(ledgerDir).map((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf-8')).join('')
    expect(raw).not.toContain('hunter2')

    // A later sudo on the same host uses the kept password at once: no prompt, no -n.
    expect((await call('run', RELOAD)).isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(hostCalls(fake).at(-1)?.args).toEqual({
      argv: ['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'],
      stdin: 'hunter2\n',
      timeoutMs: 60_000
    })

    await finishOpsRun(session.ctx, { ok: true, costUsd: 0 })
    expect(session.ctx.sudoPasswords.size).toBe(0)
  })

  it('a declined prompt returns the failure with a note and does not retry', async () => {
    const { fake, call } = await start(sudoScript, async () => ({ allow: true }), { askSecret: async () => null })
    const res = await call('run', RELOAD)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('sudo: a password is required')
    expect(res.text).toContain('Operator declined to supply the sudo password.')
    expect(hostCalls(fake)).toHaveLength(1)
    expect(await kinds()).not.toContain('sudo.password-supplied')
  })
})
