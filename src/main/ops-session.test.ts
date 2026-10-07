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
  listOperatorScripts,
  runOperatorScript,
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
  extra: { plan?: boolean; askSecret?: OpsAskSecretFn } & Pick<OpsSessionOptions, 'scope' | 'task' | 'ticket' | 'client' | 'syslog'> = {}
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
    ...(extra.askSecret ? { askSecret: extra.askSecret } : {}),
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.task !== undefined ? { task: extra.task } : {}),
    ...(extra.ticket !== undefined ? { ticket: extra.ticket } : {}),
    ...(extra.client !== undefined ? { client: extra.client } : {}),
    ...(extra.syslog ? { syslog: extra.syslog } : {})
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

  it('a later abort does not rewrite the outcome of a run already ended', async () => {
    const { session } = await start()
    await finishOpsRun(session.ctx, { ok: true, costUsd: 0 })
    // The terminal closed after the run had ended: no second run.end, no aborted outcome.
    await finishOpsRun(session.ctx, { ok: false, costUsd: 0, aborted: true, error: 'the terminal was closed' })
    const ends = (await lines()).filter((l) => l.event.kind === 'run.end')
    expect(ends).toHaveLength(1)
    expect(ends[0].event).toEqual({ kind: 'run.end', runId: 'run-1', ok: true, costUsd: 0 })
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

  it("the operator's own script run needs no plan, but the model's call to the same script still does", async () => {
    const { fake, session, call } = await start({}, async () => ({ allow: true }), { plan: false })
    const input = { hostId: 'h1', name: 'check.sh', args: [] }
    expect((await call('script', input)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])

    const ran = await runOperatorScript(session, 'check.sh', 'h1', [])
    expect(ran).toMatchObject({ isError: false })
    expect(hostCalls(fake).length).toBeGreaterThan(0)
    // The operator's click did not approve a plan for the model.
    expect(session.ctx.planApproved).toBe(false)
    expect((await call('script', input)).isError).toBe(true)
  })

  it("the operator's run is still gated: a script outside the policy is refused", async () => {
    const { fake, session } = await start({}, async () => ({ allow: true }), { plan: false })
    const r = await runOperatorScript(session, 'other.sh', 'h1', [])
    expect(r.isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
  })

  it('lists the policy scripts with the hosts of this run that they reach', async () => {
    const { session } = await start({}, undefined, { plan: false })
    expect(listOperatorScripts(session.ctx)).toEqual([
      { name: 'check.sh', title: 'Verificação', class: 'read', hosts: [{ id: 'h1', name: expect.any(String) }], maxArgs: 0 }
    ])
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

describe('intervention scope', () => {
  const WEB_STATUS = { hostId: 'h1', cmd: 'systemctl status nginx' }
  const DB_STATUS = { hostId: 'h2', cmd: 'systemctl status postgresql' }

  /** Both hosts in the policy, each with a read rule, so only the scope tells them apart. */
  beforeEach(() => {
    const policyFile = path.join(rbDir, 'policy.json')
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf-8'))
    policy.hosts.db = ['db-01']
    policy.allow.push({ hosts: ['db'], cmd: '^systemctl status postgresql$', class: 'read', title: 'Estado da base de dados' })
    fs.writeFileSync(policyFile, JSON.stringify(policy))
  })

  it('a locked scope reaches and records only its host, and logs the task, ticket and client', async () => {
    const { fake } = await start({}, undefined, {
      scope: { kind: 'host', hostId: 'h1' },
      task: '  Reload nginx after\nthe certificate change ',
      ticket: 'WM-1234',
      client: '  '
    })
    expect(fake.calls.filter((c) => c.kind === 'reachable').map((c) => c.hostId)).toEqual(['h1'])
    const startEv = (await lines())[0].event
    expect(startEv).toMatchObject({
      kind: 'run.start',
      hosts: [HOSTS[0]],
      task: 'Reload nginx after\nthe certificate change',
      ticket: 'WM-1234',
      scope: { kind: 'host', hostId: 'h1' }
    })
    expect(startEv).not.toHaveProperty('client')
  })

  it('an empty task is left out of run.start', async () => {
    await start({}, undefined, { scope: { kind: 'host', hostId: 'h1' }, task: '  ' })
    expect((await lines())[0].event).not.toHaveProperty('task')
  })

  it('a locked scope on a host the runbook does not know refuses to start', async () => {
    const fake = createFakeBackend()
    const r = await openOpsSession({ ...baseOptions(fake), scope: { kind: 'host', hostId: 'nope' } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/not in any host group of runbook nginx-config-reload/)
    expect(fake.calls).toEqual([])
  })

  it('a locked scope refuses another host whatever the policy says, logs the deny, and hides it from hello', async () => {
    const asked: string[] = []
    const { fake, session, call } = await start(
      {},
      async (req) => {
        asked.push(req.tool)
        return { allow: true }
      },
      { scope: { kind: 'host', hostId: 'h1' } }
    )
    expect(bridgeSessionFor(session).hello().hosts.map((h) => h.id)).toEqual(['h1'])
    expect(await call('run', DB_STATUS)).toEqual({ text: "Refused: outside this intervention's scope: db-01.", isError: true })
    expect((await call('run', WEB_STATUS)).isError).toBe(false)
    expect(asked).toEqual([])
    expect(hostCalls(fake).map((c) => c.hostId)).toEqual(['h1'])
    expect((await lines())[1].event).toMatchObject({
      kind: 'call.decided',
      hostId: 'h2',
      host: 'db-01',
      decision: 'deny',
      reason: "outside this intervention's scope: db-01"
    })
  })

  it('an open scope asks once per host, then allows without asking', async () => {
    const asked: Parameters<OpsAskFn>[0][] = []
    const { fake, call } = await start(
      { exec: () => ({ stdout: 'active' }) },
      async (req) => {
        asked.push(req)
        return { allow: true }
      },
      { scope: { kind: 'open' } }
    )
    // Two calls on a new host at once share one prompt.
    const [a, b] = await Promise.all([call('run', DB_STATUS), call('run', DB_STATUS)])
    expect(a.isError || b.isError).toBe(false)
    expect((await call('run', DB_STATUS)).isError).toBe(false)
    expect(asked).toEqual([
      {
        tool: 'mcp__ops__host',
        input: { hostId: 'h2' },
        ops: {
          hostName: 'db-01',
          hostAddress: 'ops@h2:22',
          tool: 'host',
          class: 'read',
          reason: 'first use of this host in an open intervention',
          queuedBehind: 0,
          runbook: 'nginx-config-reload'
        }
      }
    ])
    expect(hostCalls(fake)).toHaveLength(3)
    const k = await kinds()
    expect(k.filter((x) => x === 'host.approved')).toHaveLength(1)
    expect(k.indexOf('host.approved')).toBeLessThan(k.indexOf('call.decided'))
    expect((await lines()).find((l) => l.event.kind === 'host.approved')?.event).toEqual({
      kind: 'host.approved',
      runId: 'run-1',
      hostId: 'h2',
      host: 'db-01',
      by: 'user'
    })
  })

  it('an open scope keeps a refused host refused for the rest of the run, asking once', async () => {
    let asks = 0
    const { fake, call } = await start(
      {},
      async () => {
        asks++
        return { allow: false }
      },
      { scope: { kind: 'open' } }
    )
    const msg = { text: 'Refused: the operator refused db-01 for this intervention.', isError: true }
    expect(await call('run', DB_STATUS)).toEqual(msg)
    expect(await call('run', DB_STATUS)).toEqual(msg)
    expect(asks).toBe(1)
    expect(hostCalls(fake)).toEqual([])
    expect(await kinds()).toEqual(['run.start', 'host.denied', 'call.decided', 'call.decided'])
  })

  it('an open scope does not ask about a host for a call the gate refuses anyway', async () => {
    let asks = 0
    const { call } = await start({}, async () => (asks++, { allow: true }), { scope: { kind: 'open' } })
    expect((await call('run', { hostId: 'h2', cmd: 'rm -rf /var/lib/pgsql' })).text).toMatch(/^Refused by the runbook policy: /)
    expect(asks).toBe(0)
  })

  it('stop on a host prompt aborts the run', async () => {
    const { abort, call } = await start({}, async () => ({ allow: false, stop: true }), { scope: { kind: 'open' } })
    expect(await call('run', DB_STATUS)).toEqual({ text: 'Denied by the operator, who stopped the run.', isError: true })
    expect(abort.signal.aborted).toBe(true)
    expect(await kinds()).toEqual(['run.start', 'host.denied', 'call.decided'])
  })

  it('the plan preview marks a step on a host outside a locked scope as denied', async () => {
    const asked: Parameters<OpsAskFn>[0][] = []
    const { call } = await start(
      {},
      async (req) => {
        asked.push(req)
        return { allow: false }
      },
      { plan: false, scope: { kind: 'host', hostId: 'h1' } }
    )
    await call('propose_plan', {
      steps: [
        { title: 'check nginx', hostId: 'h1', cmd: 'systemctl status nginx' },
        { title: 'check the database', hostId: 'h2', cmd: 'systemctl status postgresql' }
      ]
    })
    const ops = asked[0].ops
    expect(ops.planSteps?.map((s) => [s.verdict, s.reason])).toEqual([
      ['runs', 'Estado do serviço web'],
      ['denied', "outside this intervention's scope: db-01"]
    ])
    expect(ops.planSummary).toEqual({ runs: 1, asks: 0, denied: 1, mutates: 0 })
  })
})

describe('skipped plan steps', () => {
  const PLAN = {
    steps: [
      { title: 'check nginx', hostId: 'h1', cmd: 'systemctl status nginx' },
      { title: 'reload nginx', hostId: 'h1', cmd: 'sudo  systemctl reload nginx' },
      { title: 'run the check', hostId: 'h1', script: 'check.sh' },
      'tell the operator'
    ]
  }

  it('skipped steps are logged, named to the model, and refused when tried; the rest run', async () => {
    let planAsks = 0
    const { fake, call } = await start(
      { exec: () => ({ stdout: 'ok' }) },
      async (req) => {
        if (req.tool !== 'mcp__ops__propose_plan') return { allow: true }
        planAsks++
        // Out of range, a title-only step, a non-integer and a repeat are all ignored.
        return planAsks === 1 ? { allow: true, skipSteps: [2, 1, 3, 99, -1, 1.5, 1] } : { allow: true }
      },
      { plan: false }
    )
    const reply = await call('propose_plan', PLAN)
    expect(reply.isError).toBe(false)
    // Steps are named by title and command, never by number: the model's own numbering
    // is not ours (seen on the first real run).
    expect(reply.text).toContain('Skipped, do NOT run these:')
    expect(reply.text).toContain('Approved, run these in order')
    expect(reply.text).not.toMatch(/Steps? d/)
    const approved = (await lines()).find((l) => l.event.kind === 'plan.approved')?.event
    expect(approved).toMatchObject({ kind: 'plan.approved', skippedSteps: [1, 2] })
    expect((approved as { steps: unknown[] }).steps).toHaveLength(4)

    const skipped = { text: 'Refused: step skipped by the operator.', isError: true }
    expect(await call('run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })).toEqual(skipped)
    expect(await call('script', { hostId: 'h1', name: 'check.sh' })).toEqual(skipped)
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])
    const denied = (await lines()).filter(
      (l) => l.event.kind === 'call.decided' && (l.event as { reason: string }).reason === 'step skipped by the operator'
    )
    expect(denied.map((l) => (l.event as { decision: string; tool: string }).tool)).toEqual(['run', 'script'])

    // A new approved plan is a new set of decisions: the skips go.
    expect(await call('propose_plan', PLAN)).toEqual({ text: 'Plan approved. Proceed step by step.', isError: false })
    expect((await call('run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })).isError).toBe(false)
  })

  it('the internal report marks skipped steps', async () => {
    const { session, call } = await start(
      {},
      async (req) => (req.tool === 'mcp__ops__propose_plan' ? { allow: true, skipSteps: [0] } : { allow: true }),
      { plan: false }
    )
    expect((await call('propose_plan', PLAN)).text).toContain('Skipped, do NOT run these:')
    await finishOpsRun(session.ctx, { ok: true, costUsd: 0 })
    const summary = summarizeRun(await lines(), 'run-1')
    expect(summary?.planSteps?.map((s) => s.skipped === true)).toEqual([true, false, false, false])
    const report = await ledger.report('run-1', 'internal')
    expect(report.ok && report.markdown).toContain('1. Estado do serviço web (web-01) – `systemctl status nginx` (skipped)\n')
  })
})

describe("the host's syslog", () => {
  const SYSLOG = { operator: 'JoãoLeite', sshUser: () => 'ops' }
  /** The fake's answer per program: the probe, logger, or the command itself. */
  const hosted = (over: { probe?: number; logger?: number; cmd?: FakeScript['exec'] } = {}): FakeScript => ({
    exec: (argv) =>
      argv[0] === 'command'
        ? { exitCode: over.probe ?? 0, stdout: '/usr/bin/logger' }
        : argv[0] === 'logger'
          ? { exitCode: over.logger ?? 0, stdout: '', stderr: over.logger ? 'logger: socket /dev/log: Connection refused' : '' }
          : (over.cmd?.(argv) ?? { stdout: 'ok' })
  })
  const execs = (fake: FakeBackend) =>
    hostCalls(fake).map((c) => {
      const argv = (c.args as { argv?: string[]; name?: string }).argv
      return c.kind === 'exec' && argv ? argv : [c.kind]
    })
  const loggerLines = (fake: FakeBackend) =>
    execs(fake)
      .filter((a) => a[0] === 'logger')
      .map((a) => ({ priority: a[4], msg: a[6] }))

  it('probes once per host, then writes start and end around the command as separate execs', async () => {
    const { fake, call } = await start(hosted(), undefined, { syslog: SYSLOG })
    await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })
    await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })

    const a = execs(fake)
    expect(a.map((x) => x[0])).toEqual(['command', 'logger', 'systemctl', 'logger', 'logger', 'systemctl', 'logger'])
    // The approved command is exactly what the gate produced, never wrapped.
    expect(a[2]).toEqual(['systemctl', 'status', 'nginx'])
    expect(a[1].slice(0, 6)).toEqual(['logger', '-t', 'argos', '-p', 'user.notice', '--'])
    const [startLine, endLine] = loggerLines(fake)
    expect(startLine.msg).toMatch(
      /^intervention=run-1 runbook=nginx-config-reload event=start call=run-1-1 operator="JoãoLeite" host=web-01 user=ops tool=run class=read approval=auto rule="Estado do serviço web" cmd="systemctl status nginx"$/
    )
    expect(endLine.msg).toMatch(/event=end exit=0 duration_ms=\d+ call=run-1-1 /)
    expect(await kinds()).not.toContain('host.syslog-unavailable')
  })

  it('logs a failed command at err', async () => {
    const { fake, call } = await start(hosted({ cmd: () => ({ exitCode: 3, stdout: '' }) }), undefined, { syslog: SYSLOG })
    await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })
    expect(loggerLines(fake).map((l) => l.priority)).toEqual(['user.notice', 'user.err'])
    expect(loggerLines(fake)[1].msg).toContain('event=end exit=3')
  })

  it('logs a command killed by the limit as timeout, at err', async () => {
    // The fake times out a call whose delay passes its limit: 20 ms for the command, while
    // the logger execs keep their own 10 s.
    const policy = JSON.parse(fs.readFileSync(path.join(rbDir, 'policy.json'), 'utf-8'))
    fs.writeFileSync(path.join(rbDir, 'policy.json'), JSON.stringify({ ...policy, limits: { timeoutMs: 20 } }))
    const { fake, call } = await start({ ...hosted(), delayMs: 50 }, undefined, { syslog: SYSLOG })
    await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })
    const [, end] = loggerLines(fake)
    expect(end.priority).toBe('user.err')
    expect(end.msg).toMatch(/event=timeout duration_ms=\d+ call=run-1-1 /)
  })

  it('never blocks: with logger missing the command runs and the report warns once for the host', async () => {
    const { fake, call } = await start(hosted({ probe: 1 }), undefined, { syslog: SYSLOG })
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)

    // One probe for the run, no logger exec, both commands ran.
    expect(execs(fake).map((x) => x[0])).toEqual(['command', 'systemctl', 'systemctl'])
    const warn = (await lines()).filter((l) => l.event.kind === 'host.syslog-unavailable')
    expect(warn.map((l) => l.event)).toEqual([
      { kind: 'host.syslog-unavailable', runId: 'run-1', hostId: 'h1', host: 'web-01', reason: 'logger is not installed on the host' }
    ])
    const report = await ledger.report('run-1', 'internal')
    expect(report.ok && report.warnings).toContain(
      "web-01 has no syslog record of this run's commands (logger is not installed on the host); the ledger is the only record there."
    )
    expect(report.ok && report.markdown).toContain('## Host syslog warnings')
  })

  it('never blocks: a failing logger still lets the command run, with one warning for the host', async () => {
    const { fake, call } = await start(hosted({ logger: 1 }), undefined, { syslog: SYSLOG })
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)
    expect((await call('run', { hostId: 'h1', cmd: 'systemctl status nginx' })).isError).toBe(false)
    expect(execs(fake).filter((x) => x[0] === 'systemctl')).toHaveLength(2)
    const warn = (await lines()).filter((l) => l.event.kind === 'host.syslog-unavailable')
    expect(warn).toHaveLength(1)
    expect(warn[0].event).toMatchObject({ reason: 'logger exited 1: logger: socket /dev/log: Connection refused' })
  })

  it('a call the gate refuses never reaches the host, so nothing is logged there', async () => {
    const { fake, call } = await start(hosted(), undefined, { syslog: SYSLOG })
    expect((await call('run', { hostId: 'h1', cmd: 'rm -rf /' })).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
  })

  it('a script logs start, upload, end and remove, with its name, sha256 and arguments', async () => {
    const { fake, call } = await start(hosted(), undefined, { syslog: SYSLOG })
    await call('script', { hostId: 'h1', name: 'check.sh', args: [] })
    // The fake records runScript as it is called, before its upload hook fires.
    expect(execs(fake).map((x) => x[0])).toEqual(['command', 'logger', 'runScript', 'logger', 'logger', 'logger'])
    const msgs = loggerLines(fake).map((l) => l.msg)
    expect(msgs.map((m) => /event=(\w+)/.exec(m)?.[1])).toEqual(['start', 'upload', 'end', 'remove'])
    expect(msgs[0]).toContain(`script=check.sh sha256=${sha256Hex(CHECK_SH)} args=""`)
    expect(msgs[1]).toContain('file=/home/ops/.argos-ops/fake/check.sh')
    expect(msgs[3]).toContain('file=/home/ops/.argos-ops/fake/check.sh')
  })

  it('a write logs the path and the content hash, never the content', async () => {
    const policy = JSON.parse(fs.readFileSync(path.join(rbDir, 'policy.json'), 'utf-8'))
    fs.writeFileSync(path.join(rbDir, 'policy.json'), JSON.stringify({ ...policy, write: { paths: ['^/etc/nginx/.*$'], approval: 'ask' } }))
    const { fake, call } = await start(hosted(), async () => ({ allow: true }), { syslog: SYSLOG })
    const content = 'password = s3cr3t-value\n'
    expect((await call('write', { hostId: 'h1', path: '/etc/nginx/x.conf', content })).isError).toBe(false)
    const msgs = loggerLines(fake).map((l) => l.msg)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toContain(`path=/etc/nginx/x.conf sha256=${sha256Hex(content)}`)
    expect(msgs[0]).toContain('approval=ask approved_by="JoãoLeite"')
    expect(msgs[1]).toContain('event=end exit=0')
    expect(msgs.join('\n')).not.toContain('s3cr3t')
  })

  it('a sudo retried with the password logs the gate form of the command, never the password', async () => {
    const sudo = hosted({ cmd: (argv) => (argv[1] === '-S' ? { stdout: 'reloaded' } : { exitCode: 1, stderr: 'sudo: a password is required' }) })
    const { fake, call } = await start(sudo, async () => ({ allow: true }), { syslog: SYSLOG, askSecret: async () => 'hunter2' })
    expect((await call('run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })).isError).toBe(false)
    const msgs = loggerLines(fake).map((l) => l.msg)
    expect(msgs.map((m) => /event=(\w+) (?:exit=(\d+) )?.*call=(\S+)/.exec(m)?.slice(1).filter(Boolean).join(':'))).toEqual([
      'start:run-1-1',
      'end:1:run-1-1',
      'start:run-1-1-retry',
      'end:0:run-1-1-retry'
    ])
    for (const m of msgs) expect(m).toContain('cmd="sudo systemctl reload nginx"')
    expect(JSON.stringify(execs(fake).filter((a) => a[0] === 'logger'))).not.toContain('hunter2')
  })
})
