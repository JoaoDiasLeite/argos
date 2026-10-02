import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLedger, type OpsLedger } from './ops-audit'
import { sha256Hex } from './ops-audit-pure'
import { createFakeBackend, type FakeBackend, type FakeScript } from './ops-backend-fake'
import { createExecutor } from './ops-exec-pure'
import { assembleRunbook, scriptPinError, type LoadedRunbook, type LoadRunbookResult } from './ops-runbook-pure'
import { finishOpsRun, prepareOpsRun, type OpsAskFn, type OpsAskSecretFn, type PrepareOpsRunResult } from './ops-run'
import { OPS_PREAMBLE, PLAN_REJECTED_MESSAGE } from './ops-run-pure'
import type { OpsAuditLine, OpsHostRef } from './ops-types'

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-ops-run-'))
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

/**
 * A prepared run. Most tests are about one call, so the plan counts as approved unless
 * `plan: false` (set directly: no plan.approved line, so their ledger assertions stay
 * about the call).
 */
async function start(
  script: FakeScript = {},
  ask?: OpsAskFn,
  extra: { plan?: boolean; askSecret?: OpsAskSecretFn } = {}
): Promise<{ fake: FakeBackend; run: Extract<PrepareOpsRunResult, { ok: true }>; abort: AbortController; live: OpsAuditLine[] }> {
  const fake = createFakeBackend(script)
  const abort = new AbortController()
  const live: OpsAuditLine[] = []
  const r = await prepareOpsRun({
    appSessionId: 's1',
    runbookPath: rbDir,
    model: 'claude-opus-4-7',
    ledger,
    executor: createExecutor(fake),
    abort,
    loadRunbook: loadFixture,
    readScript: readFixtureScript,
    hostAddress: (id) => `ops@${id}:22`,
    onEvent: (line) => live.push(line),
    buildServer: async () => ({ stub: true }),
    runId: 'run-1',
    ...(ask ? { ask } : {}),
    ...(extra.askSecret ? { askSecret: extra.askSecret } : {})
  })
  if (!r.ok) throw new Error(r.error)
  if (extra.plan !== false) r.ctx.planApproved = true
  return { fake, run: r, abort, live }
}

async function kinds(): Promise<string[]> {
  const r = await ledger.readRun('run-1')
  if (!r.ok) throw new Error(r.error)
  return r.lines.map((l) => l.event.kind)
}

const hostCalls = (fake: FakeBackend) => fake.calls.filter((c) => c.kind !== 'reachable')

describe('prepareOpsRun', () => {
  it('a full run logs start, decision, start and end of the call, and run end in order', async () => {
    const { fake, run, live } = await start({ exec: () => ({ stdout: 'active (running)' }) })
    const input = { hostId: 'h1', cmd: 'systemctl status nginx' }

    const verdict = await run.canUseTool('mcp__ops__run', input)
    expect(verdict).toEqual({ behavior: 'allow', updatedInput: input })
    const res = await run.tools.run(input)
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toBe('exit code 0\nstdout:\nactive (running)\nstderr:\n(empty)')
    await finishOpsRun(run.ctx, { ok: true, costUsd: 0.12 })
    // A second end (the catch after a result) is not logged twice.
    await finishOpsRun(run.ctx, { ok: false, costUsd: 0 })

    expect(await kinds()).toEqual(['run.start', 'call.decided', 'call.started', 'call.finished', 'run.end'])
    expect(hostCalls(fake)).toEqual([
      { kind: 'exec', hostId: 'h1', args: { argv: ['systemctl', 'status', 'nginx'], stdin: undefined, timeoutMs: 60_000 } }
    ])
    // Reachability is checked once per runbook host, and only for hosts in a group.
    expect(fake.calls.filter((c) => c.kind === 'reachable').map((c) => c.hostId)).toEqual(['h1'])

    const lines = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    const decided = lines.lines[1].event
    expect(decided).toMatchObject({
      kind: 'call.decided',
      callId: 'run-1-1',
      tool: 'run',
      host: 'web-01',
      argv: ['systemctl', 'status', 'nginx'],
      decision: 'allow',
      rule: '^systemctl status nginx$'
    })
    expect(lines.lines[3].event).toMatchObject({ kind: 'call.finished', callId: 'run-1-1', exitCode: 0, stdoutHead: 'active (running)' })
    expect(lines.lines[4].event).toMatchObject({ kind: 'run.end', ok: true, costUsd: 0.12 })
    // The live timeline saw every line the ledger holds.
    expect(live.map((l) => l.event.kind)).toEqual(await kinds())
  })

  it('appends the preamble and RUNBOOK.md to the system prompt', async () => {
    const { run } = await start()
    expect(run.systemAppend.startsWith(OPS_PREAMBLE)).toBe(true)
    expect(run.systemAppend).toContain('<runbook name="nginx-config-reload">\n# Reload nginx\n1. Check the config.\n</runbook>')
    expect(run.mcpServer).toEqual({ stub: true })
  })

  it('a denied call never reaches the backend, and is logged with the full input', async () => {
    const { fake, run } = await start()
    const verdict = await run.canUseTool('mcp__ops__run', { hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
    expect(verdict.behavior).toBe('deny')
    const strictMiss = await run.canUseTool('mcp__ops__run', { hostId: 'h1', cmd: 'systemctl stop nginx' })
    expect(strictMiss.behavior).toBe('deny')
    const otherHost = await run.canUseTool('mcp__ops__run', { hostId: 'h2', cmd: 'systemctl status nginx' })
    expect(otherHost.behavior).toBe('deny')

    // Even called straight, past canUseTool, the handler refuses to run it.
    const direct = await run.tools.run({ hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
    expect(direct.isError).toBe(true)

    expect(hostCalls(fake)).toEqual([])
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    const denied = r.lines.filter((l) => l.event.kind === 'call.decided')
    expect(denied).toHaveLength(4)
    expect(denied.every((l) => (l.event as { decision: string }).decision === 'deny')).toBe(true)
    expect((denied[0].event as { rawInput: unknown }).rawInput).toEqual({ hostId: 'h1', cmd: 'cat /etc/passwd; rm -rf /' })
  })

  it('an ask answered deny is logged and not executed', async () => {
    const asked: unknown[] = []
    const { fake, run } = await start({}, async (req) => {
      asked.push(req)
      return { allow: false }
    })
    const input = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    const verdict = await run.canUseTool('mcp__ops__run', input)
    expect(verdict).toEqual({ behavior: 'deny', message: 'Denied by the operator.' })
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
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines[3].event).toMatchObject({ kind: 'call.answered', answer: 'deny' })

    // The denied call's id was dropped, so a stray handler call cannot pick it up.
    const stray = await run.tools.run(input)
    expect(stray.isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
  })

  it('an ask answered allow runs; deny-and-stop aborts the run', async () => {
    let answer = { allow: true, stop: false }
    const { fake, run, abort } = await start({}, async () => answer)
    const input = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    expect((await run.canUseTool('mcp__ops__run', input)).behavior).toBe('allow')
    await run.tools.run(input)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])

    answer = { allow: false, stop: true }
    const stopped = await run.canUseTool('mcp__ops__run', input)
    expect(stopped.behavior).toBe('deny')
    expect(abort.signal.aborted).toBe(true)
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines.at(-1)?.event).toMatchObject({ kind: 'call.answered', answer: 'stop' })
  })

  it('without an ask hook, an ask is a deny', async () => {
    const { fake, run } = await start()
    expect((await run.canUseTool('mcp__ops__run', { hostId: 'h1', cmd: 'sudo systemctl reload nginx' })).behavior).toBe('deny')
    expect(hostCalls(fake)).toEqual([])
  })

  it('an unreachable host stops the run before run.start', async () => {
    const fake = createFakeBackend({ reachable: { h1: false } })
    const r = await prepareOpsRun({
      appSessionId: 's1',
      runbookPath: rbDir,
      model: 'm',
      ledger,
      executor: createExecutor(fake),
      abort: new AbortController(),
      loadRunbook: loadFixture,
      readScript: readFixtureScript,
      buildServer: async () => ({})
    })
    expect(r).toEqual({ ok: false, error: 'web-01 is unreachable. Is the VPN connected? Timed out while waiting for handshake' })
    expect((await ledger.info()).files).toBe(0)
  })

  it('an invalid policy refuses the run and lists the errors', async () => {
    fs.writeFileSync(path.join(rbDir, 'policy.json'), JSON.stringify({ version: 1, strict: true, hosts: {}, allow: [{ hosts: [], cmd: 'df', class: 'read' }], scripts: [] }))
    const fake = createFakeBackend()
    const r = await prepareOpsRun({
      appSessionId: 's1',
      runbookPath: rbDir,
      model: 'm',
      ledger,
      executor: createExecutor(fake),
      abort: new AbortController(),
      loadRunbook: loadFixture,
      readScript: readFixtureScript,
      buildServer: async () => ({})
    })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/policy\.json has \d+ error\(s\)\.\n- /)
    expect(fake.calls).toEqual([])
    expect((await ledger.info()).files).toBe(0)
  })

  it('a script edited after load is refused and logged, and never uploaded', async () => {
    const { fake, run } = await start()
    const input = { hostId: 'h1', name: 'check.sh', args: [] }
    expect((await run.canUseTool('mcp__ops__script', input)).behavior).toBe('allow')
    fs.writeFileSync(path.join(rbDir, 'scripts', 'check.sh'), CHECK_SH + 'rm -rf /tmp/x\n')
    const res = await run.tools.script(input)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/changed since the policy pinned it/)
    expect(hostCalls(fake)).toEqual([])
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines.map((l) => l.event.kind)).toEqual(['run.start', 'call.decided', 'call.started', 'call.finished'])
    expect(r.lines[3].event).toMatchObject({ kind: 'call.finished', exitCode: null })
    expect((r.lines[3].event as { stderrHead: string }).stderrHead).toMatch(/changed since the policy pinned it/)
  })

  it('an unchanged script runs with its pinned bytes', async () => {
    const { fake, run } = await start()
    const input = { hostId: 'h1', name: 'check.sh' }
    expect((await run.canUseTool('mcp__ops__script', input)).behavior).toBe('allow')
    // The zod schema fills args with [] before the handler sees it.
    const res = await run.tools.script({ ...input, args: [] })
    expect(res.isError).toBe(false)
    expect(hostCalls(fake)).toEqual([
      { kind: 'runScript', hostId: 'h1', args: { name: 'check.sh', args: [], sha256: sha256Hex(CHECK_SH), stdin: undefined, timeoutMs: 60_000 } }
    ])
  })

  it('reads go through the read paths', async () => {
    const { fake, run } = await start({ files: { '/etc/nginx/nginx.conf': 'worker_processes 2;' } })
    const ok = { hostId: 'h1', path: '/etc/nginx/nginx.conf' }
    expect((await run.canUseTool('mcp__ops__read', ok)).behavior).toBe('allow')
    expect((await run.tools.read(ok)).content[0].text).toBe('worker_processes 2;')
    expect((await run.canUseTool('mcp__ops__read', { hostId: 'h1', path: '/etc/shadow' })).behavior).toBe('deny')
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['read'])
  })

  it('local tools: Read inside the runbook only, everything else refused', async () => {
    const { run } = await start()
    expect((await run.canUseTool('Read', { file_path: path.join(rbDir, 'RUNBOOK.md') })).behavior).toBe('allow')
    expect((await run.canUseTool('Read', { file_path: path.join(root, 'ops-audit', 'x') })).behavior).toBe('deny')
    expect((await run.canUseTool('Bash', { command: 'dir' })).behavior).toBe('deny')
    expect((await run.canUseTool('mcp__github__create_issue', {})).behavior).toBe('deny')
    // None of these are ops calls, so the ledger only has the start.
    expect(await kinds()).toEqual(['run.start'])
  })

  it('a malformed ops call is refused and still logged', async () => {
    const { fake, run } = await start()
    const v = await run.canUseTool('mcp__ops__script', { hostId: 'h1', name: 'check.sh', args: 'a; b' })
    expect(v.behavior).toBe('deny')
    expect(hostCalls(fake)).toEqual([])
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines[1].event).toMatchObject({ kind: 'call.decided', decision: 'deny', reason: 'args must be an array of strings' })
  })

  it('a stopped run refuses calls already approved', async () => {
    const { fake, run, abort } = await start()
    const input = { hostId: 'h1', cmd: 'systemctl status nginx' }
    expect((await run.canUseTool('mcp__ops__run', input)).behavior).toBe('allow')
    abort.abort()
    const res = await run.tools.run(input)
    expect(res.isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    await finishOpsRun(run.ctx, { ok: false, costUsd: 0, aborted: true })
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines.at(-1)?.event).toMatchObject({ kind: 'run.end', ok: false, aborted: true })
  })

  it('a sudo that wants a password tells the model to stop', async () => {
    const { run } = await start({ exec: () => ({ exitCode: 1, stderr: 'sudo: a password is required' }) }, async () => ({ allow: true }))
    const input = { hostId: 'h1', cmd: 'sudo systemctl reload nginx' }
    await run.canUseTool('mcp__ops__run', input)
    const res = await run.tools.run(input)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('sudo: a password is required')
    expect(res.content[0].text).toContain('Argos cannot supply sudo passwords yet')
  })
})

describe('plan first', () => {
  const PLAN = { steps: ['web-01: systemctl status nginx', 'web-01: sudo systemctl reload nginx'] }
  const STATUS = { hostId: 'h1', cmd: 'systemctl status nginx' }

  it('an ops call before any plan is denied and never reaches the backend; local reads stay open', async () => {
    const { fake, run } = await start({}, async () => ({ allow: true }), { plan: false })
    const v = await run.canUseTool('mcp__ops__run', STATUS)
    expect(v).toEqual({ behavior: 'deny', message: 'Refused: propose a plan first (mcp__ops__propose_plan).' })
    // Even called straight, the handler has no decision to run on.
    expect((await run.tools.run(STATUS)).isError).toBe(true)
    expect(hostCalls(fake)).toEqual([])
    expect((await run.canUseTool('Read', { file_path: path.join(rbDir, 'RUNBOOK.md') })).behavior).toBe('allow')
    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines[1].event).toMatchObject({
      kind: 'call.decided',
      decision: 'deny',
      reason: 'propose a plan first (mcp__ops__propose_plan)',
      argv: ['systemctl', 'status', 'nginx']
    })
  })

  it('an approved plan is asked with its steps, logged, and opens the ops tools', async () => {
    const asked: Parameters<OpsAskFn>[0][] = []
    const { fake, run } = await start(
      {},
      async (req) => {
        asked.push(req)
        return { allow: true }
      },
      { plan: false }
    )
    expect(await run.canUseTool('mcp__ops__propose_plan', PLAN)).toEqual({ behavior: 'allow', updatedInput: PLAN })
    expect(asked[0]).toEqual({
      tool: 'mcp__ops__propose_plan',
      input: PLAN,
      ops: {
        hostName: 'nginx-config-reload',
        hostAddress: '',
        tool: 'plan',
        planSteps: PLAN.steps,
        class: 'mutate',
        reason: 'plan approval',
        queuedBehind: 0,
        runbook: 'nginx-config-reload'
      }
    })
    expect(run.ctx.planText).toBe(PLAN.steps.join('\n'))
    expect((await run.tools.propose_plan(PLAN)).content[0].text).toBe('Plan approved. Proceed step by step.')

    expect((await run.canUseTool('mcp__ops__run', STATUS)).behavior).toBe('allow')
    expect((await run.tools.run(STATUS)).isError).toBe(false)
    expect(hostCalls(fake).map((c) => c.kind)).toEqual(['exec'])

    // A revised plan goes through the same approval and logs a second plan.approved.
    expect((await run.canUseTool('mcp__ops__propose_plan', { steps: ['web-01: nginx -t'] })).behavior).toBe('allow')
    expect(await kinds()).toEqual(['run.start', 'plan.approved', 'call.decided', 'call.started', 'call.finished', 'plan.approved'])
  })

  it('a rejected plan logs plan.rejected and the ops tools stay closed', async () => {
    const { fake, run } = await start({}, async () => ({ allow: false }), { plan: false })
    expect(await run.canUseTool('mcp__ops__propose_plan', PLAN)).toEqual({ behavior: 'deny', message: PLAN_REJECTED_MESSAGE })
    expect((await run.canUseTool('mcp__ops__run', STATUS)).behavior).toBe('deny')
    expect(hostCalls(fake)).toEqual([])
    expect(await kinds()).toEqual(['run.start', 'plan.rejected', 'call.decided'])
  })

  it('a malformed plan is refused without asking; stop on a plan aborts the run', async () => {
    let calls = 0
    const { run, abort } = await start(
      {},
      async () => {
        calls++
        return { allow: false, stop: true }
      },
      { plan: false }
    )
    expect((await run.canUseTool('mcp__ops__propose_plan', { steps: [] })).behavior).toBe('deny')
    expect((await run.canUseTool('mcp__ops__propose_plan', { steps: [''] })).behavior).toBe('deny')
    expect(calls).toBe(0)
    expect((await run.canUseTool('mcp__ops__propose_plan', PLAN)).behavior).toBe('deny')
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
    const { fake, run } = await start(sudoScript, async () => ({ allow: true }), {
      askSecret: async (req) => {
        asked.push(req)
        return 'hunter2'
      }
    })
    await run.canUseTool('mcp__ops__run', RELOAD)
    const res = await run.tools.run(RELOAD)
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toContain('reloaded')
    expect(asked).toEqual([{ hostId: 'h1', hostName: 'web-01', prompt: expect.stringContaining('sudo on web-01') }])
    expect(hostCalls(fake).map((c) => c.args)).toEqual([
      { argv: ['sudo', 'systemctl', 'reload', 'nginx'], stdin: undefined, timeoutMs: 60_000 },
      { argv: ['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'], stdin: 'hunter2\n', timeoutMs: 60_000 }
    ])

    const r = (await ledger.readRun('run-1')) as { ok: true; lines: OpsAuditLine[] }
    expect(r.lines.map((l) => `${l.event.kind}:${(l.event as { callId?: string }).callId ?? ''}`)).toEqual([
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
    expect(r.lines[7].event).toMatchObject({
      kind: 'call.decided',
      decision: 'ask',
      rule: '^sudo systemctl reload nginx$',
      reason: 'retry with sudo password'
    })
    expect(r.lines[9].event).toMatchObject({ exitCode: 0 })
    const raw = fs.readdirSync(ledgerDir).map((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf-8')).join('')
    expect(raw).not.toContain('hunter2')

    // A later sudo on the same host uses the kept password at once: no prompt, no -n.
    await run.canUseTool('mcp__ops__run', RELOAD)
    expect((await run.tools.run(RELOAD)).isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(hostCalls(fake).at(-1)?.args).toEqual({
      argv: ['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'],
      stdin: 'hunter2\n',
      timeoutMs: 60_000
    })

    await finishOpsRun(run.ctx, { ok: true, costUsd: 0 })
    expect(run.ctx.sudoPasswords.size).toBe(0)
  })

  it('a declined prompt returns the failure with a note and does not retry', async () => {
    const { fake, run } = await start(sudoScript, async () => ({ allow: true }), { askSecret: async () => null })
    await run.canUseTool('mcp__ops__run', RELOAD)
    const res = await run.tools.run(RELOAD)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('sudo: a password is required')
    expect(res.content[0].text).toContain('Operator declined to supply the sudo password.')
    expect(hostCalls(fake)).toHaveLength(1)
    expect(await kinds()).not.toContain('sudo.password-supplied')
  })
})
