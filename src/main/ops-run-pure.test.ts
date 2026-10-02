import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import type { ExecResult } from './ops-exec-pure'
import type { LoadedRunbook } from './ops-runbook-pure'
import type { OpsGateResult } from './ops-types'
import {
  buildOpsSystemAppend,
  callKey,
  execIsError,
  finishedEventFrom,
  headBytes,
  insideDir,
  listResultText,
  localToolVerdict,
  makeCallBook,
  mcpInputToOpsInput,
  OPS_HEAD_BYTES,
  OPS_PREAMBLE,
  opsHostsFor,
  opsToolFromSdkName,
  readResultText,
  refusedFinishedEvent,
  sudoNeedsPassword,
  toApprovalContext,
  toolResultText,
  withSudoStdin,
  writeResultText,
  planApprovalContext,
  planStepsFrom
} from './ops-run-pure'

const exec = (over: Partial<ExecResult> = {}): ExecResult => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  durationMs: 12,
  stdout: 'active (running)',
  stderr: '',
  stdoutBytes: 16,
  stderrBytes: 0,
  truncated: false,
  ...over
})

describe('OPS_PREAMBLE', () => {
  it('carries every rule of plan §7', () => {
    expect(OPS_PREAMBLE).toContain('mcp__ops__*')
    expect(OPS_PREAMBLE).toContain('no local shell')
    expect(OPS_PREAMBLE).toContain('Follow RUNBOOK.md literally')
    expect(OPS_PREAMBLE).toMatch(/Before any mutate call, state what it changes and how it is reverted/)
    expect(OPS_PREAMBLE).toMatch(/Never chain commands/)
    expect(OPS_PREAMBLE).toMatch(/Use a script when the runbook provides one/)
    expect(OPS_PREAMBLE).toMatch(/non-zero exit code verbatim/)
    expect(OPS_PREAMBLE).toMatch(/failed verification step/)
    expect(OPS_PREAMBLE).toMatch(/formal European Portuguese, never Brazilian/)
  })

  it('has no em or en dashes of its own', () => {
    expect(OPS_PREAMBLE).not.toMatch(/[–—]/)
  })
})

describe('buildOpsSystemAppend', () => {
  it('puts the preamble first and the runbook verbatim in a named block', () => {
    const out = buildOpsSystemAppend('PRE', '# Steps\n1. Check nginx\n\n', 'nginx-config-reload')
    expect(out.startsWith('PRE\n\n')).toBe(true)
    expect(out).toContain('<runbook name="nginx-config-reload">\n# Steps\n1. Check nginx\n</runbook>')
  })

  it('says so when RUNBOOK.md is empty', () => {
    expect(buildOpsSystemAppend('PRE', '  \n', 'x')).toContain('(RUNBOOK.md is empty.)')
  })
})

describe('opsHostsFor', () => {
  it('indexes the runbook hosts by id with their groups', () => {
    const rb = {
      hosts: [
        { host: { id: 'h1', name: 'web-01', host: '10.0.0.1' }, groups: ['web'] },
        { host: { id: 'h2', name: 'db-01', host: '10.0.0.2' }, groups: ['db', 'all'] }
      ]
    } as unknown as LoadedRunbook
    const { byId } = opsHostsFor(rb)
    expect(byId.size).toBe(2)
    expect(byId.get('h2')).toEqual({ host: { id: 'h2', name: 'db-01', host: '10.0.0.2' }, groups: ['db', 'all'] })
    expect(byId.get('web-01')).toBeUndefined()
  })
})

describe('toApprovalContext', () => {
  it('carries what the gate decided plus the host and queue', () => {
    const gate: OpsGateResult = {
      decision: 'ask',
      class: 'mutate',
      reason: 'matched allow rule',
      rule: '^sudo systemctl reload nginx$',
      title: 'Recarregamento do serviço web',
      argv: ['sudo', 'systemctl', 'reload', 'nginx']
    }
    const ctx = toApprovalContext(gate, { id: 'h1', name: 'web-01', host: '10.0.0.1' }, 'ops@10.0.0.1:22', 'run', 'nginx', 2)
    expect(ctx).toEqual({
      hostName: 'web-01',
      hostAddress: 'ops@10.0.0.1:22',
      tool: 'run',
      class: 'mutate',
      reason: 'matched allow rule',
      rule: '^sudo systemctl reload nginx$',
      title: 'Recarregamento do serviço web',
      argv: ['sudo', 'systemctl', 'reload', 'nginx'],
      queuedBehind: 2,
      runbook: 'nginx'
    })
    // A copy, so the modal payload cannot alias the gate's argv.
    expect(ctx.argv).not.toBe(gate.argv)
  })

  it('includes path and script hash only when the gate set them', () => {
    const ctx = toApprovalContext(
      { decision: 'ask', class: 'mutate', reason: 'r', path: '/etc/nginx/a.conf', scriptSha256: 'f'.repeat(64) },
      { id: 'h1', name: 'web-01', host: 'x' },
      'x',
      'write',
      'rb',
      0
    )
    expect(ctx.path).toBe('/etc/nginx/a.conf')
    expect(ctx.scriptSha256).toBe('f'.repeat(64))
    expect('rule' in ctx).toBe(false)
    expect('argv' in ctx).toBe(false)
  })
})

describe('opsToolFromSdkName', () => {
  it('maps only the five ops tools', () => {
    expect(opsToolFromSdkName('mcp__ops__run')).toBe('run')
    expect(opsToolFromSdkName('mcp__ops__write')).toBe('write')
    expect(opsToolFromSdkName('mcp__ops__exec')).toBeNull()
    expect(opsToolFromSdkName('mcp__other__run')).toBeNull()
    expect(opsToolFromSdkName('Bash')).toBeNull()
  })
})

describe('mcpInputToOpsInput', () => {
  it('builds each tool input', () => {
    expect(mcpInputToOpsInput('run', { hostId: 'h1', cmd: 'df -h' })).toEqual({ tool: 'run', hostId: 'h1', cmd: 'df -h' })
    expect(mcpInputToOpsInput('script', { hostId: 'h1', name: 'a.sh', args: ['x'] })).toEqual({
      tool: 'script',
      hostId: 'h1',
      name: 'a.sh',
      args: ['x']
    })
    expect(mcpInputToOpsInput('read', { hostId: 'h1', path: '/etc/x' })).toEqual({ tool: 'read', hostId: 'h1', path: '/etc/x' })
    expect(mcpInputToOpsInput('list', { hostId: 'h1', path: '/etc' })).toEqual({ tool: 'list', hostId: 'h1', path: '/etc' })
    expect(mcpInputToOpsInput('write', { hostId: 'h1', path: '/etc/x', content: '' })).toEqual({
      tool: 'write',
      hostId: 'h1',
      path: '/etc/x',
      content: ''
    })
  })

  it('defaults missing script args to [] like the zod schema does', () => {
    expect(mcpInputToOpsInput('script', { hostId: 'h1', name: 'a.sh' })).toEqual({ tool: 'script', hostId: 'h1', name: 'a.sh', args: [] })
  })

  it('refuses wrong types instead of coercing them', () => {
    expect(mcpInputToOpsInput('run', { hostId: 1, cmd: 'df' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('run', { hostId: '', cmd: 'df' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('run', { hostId: 'h1', cmd: ['df'] })).toHaveProperty('error')
    expect(mcpInputToOpsInput('script', { hostId: 'h1', name: 'a.sh', args: 'x y' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('script', { hostId: 'h1', name: 'a.sh', args: ['x', 2] })).toHaveProperty('error')
    expect(mcpInputToOpsInput('script', { hostId: 'h1', name: '' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('read', { hostId: 'h1' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('write', { hostId: 'h1', path: '/x' })).toHaveProperty('error')
    expect(mcpInputToOpsInput('run', null as unknown as Record<string, unknown>)).toHaveProperty('error')
  })

  it('drops fields the tool does not take', () => {
    expect(mcpInputToOpsInput('run', { hostId: 'h1', cmd: 'df', sudo: true })).toEqual({ tool: 'run', hostId: 'h1', cmd: 'df' })
  })
})

describe('callKey and makeCallBook', () => {
  it('gives canUseTool and the handler the same key for the same call', () => {
    const fromSdk = mcpInputToOpsInput('script', { name: 'a.sh', hostId: 'h1' })
    const fromZod = mcpInputToOpsInput('script', { hostId: 'h1', name: 'a.sh', args: [] })
    expect(callKey(fromSdk as never)).toBe(callKey(fromZod as never))
  })

  it('keeps different calls apart', () => {
    const a = callKey({ tool: 'run', hostId: 'h1', cmd: 'df' })
    expect(callKey({ tool: 'run', hostId: 'h2', cmd: 'df' })).not.toBe(a)
    expect(callKey({ tool: 'read', hostId: 'h1', path: 'df' })).not.toBe(a)
  })

  it('numbers ids per run and hands out the same key FIFO', () => {
    const book = makeCallBook('r1')
    expect(book.open('k')).toBe('r1-1')
    expect(book.open('k')).toBe('r1-2')
    expect(book.open('j')).toBe('r1-3')
    expect(book.take('k')).toBe('r1-1')
    expect(book.take('k')).toBe('r1-2')
    expect(book.take('k')).toBeUndefined()
    expect(book.fresh()).toBe('r1-4')
    expect(book.take('j')).toBe('r1-3')
  })
})

describe('insideDir and localToolVerdict', () => {
  const dir = path.resolve('/repo/runbooks/nginx')

  it('accepts the folder and below, refuses outside and climbing', () => {
    expect(insideDir(dir, dir)).toBe(true)
    expect(insideDir(dir, 'RUNBOOK.md')).toBe(true)
    expect(insideDir(dir, path.join(dir, 'scripts', 'a.sh'))).toBe(true)
    expect(insideDir(dir, '../other/RUNBOOK.md')).toBe(false)
    expect(insideDir(dir, path.resolve('/repo/runbooks/nginx-evil/x'))).toBe(false)
    expect(insideDir(dir, path.resolve('/etc/passwd'))).toBe(false)
  })

  it('lets Read/Grep/Glob look only inside the runbook', () => {
    expect(localToolVerdict('Read', { file_path: path.join(dir, 'RUNBOOK.md') }, dir)).toEqual({ allow: true })
    expect(localToolVerdict('Grep', { pattern: 'nginx' }, dir)).toEqual({ allow: true })
    expect(localToolVerdict('Glob', { pattern: 'scripts/*.sh' }, dir)).toEqual({ allow: true })
    expect(localToolVerdict('Read', { file_path: path.resolve('/home/me/.ssh/id_ed25519') }, dir).allow).toBe(false)
    expect(localToolVerdict('Grep', { pattern: 'x', path: path.resolve('/') }, dir).allow).toBe(false)
    expect(localToolVerdict('Glob', { pattern: '../../**/*' }, dir).allow).toBe(false)
    expect(localToolVerdict('Glob', { pattern: path.resolve('/home/**') }, dir).allow).toBe(false)
    expect(localToolVerdict('Read', { file_path: 3 }, dir).allow).toBe(false)
  })

  it('refuses every other local tool', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'mcp__other__x', 'TodoWrite']) {
      expect(localToolVerdict(t, {}, dir).allow).toBe(false)
    }
  })
})

describe('finishedEventFrom', () => {
  it('hashes the captured text and keeps 4 KB heads', () => {
    const big = 'a'.repeat(OPS_HEAD_BYTES + 100)
    const e = finishedEventFrom(exec({ stdout: big, stdoutBytes: 50_000, stderr: 'warn', stderrBytes: 4 }), 'r1', 'r1-1')
    expect(e).toMatchObject({ kind: 'call.finished', runId: 'r1', callId: 'r1-1', exitCode: 0, timedOut: false, durationMs: 12 })
    expect(e.stdoutBytes).toBe(50_000)
    expect(e.stdoutSha256).toBe(sha256Hex(big))
    expect(e.stderrSha256).toBe(sha256Hex('warn'))
    expect(e.stdoutHead.length).toBe(OPS_HEAD_BYTES)
    expect(e.stderrHead).toBe('warn')
    expect('signal' in e).toBe(false)
  })

  it('records a timeout with its signal', () => {
    const e = finishedEventFrom(exec({ exitCode: null, timedOut: true, signal: 'TERM', stdout: '' }), 'r', 'c')
    expect(e.exitCode).toBeNull()
    expect(e.timedOut).toBe(true)
    expect(e.signal).toBe('TERM')
  })

  it('appends an executor error to the stderr head', () => {
    const e = finishedEventFrom(exec({ ok: false, exitCode: null, stdout: '', stderr: 'partial', error: 'connection lost' }), 'r', 'c')
    expect(e.stderrHead).toBe('partial\n[connection lost]')
    // The hash stays over what the host actually sent.
    expect(e.stderrSha256).toBe(sha256Hex('partial'))
  })

  it('refusedFinishedEvent carries the reason with no exit code', () => {
    const e = refusedFinishedEvent('r', 'c', 'Script a.sh changed')
    expect(e.exitCode).toBeNull()
    expect(e.stderrHead).toBe('Script a.sh changed')
    expect(e.stdoutSha256).toBe(sha256Hex(''))
  })
})

describe('headBytes', () => {
  it('never cuts a character in half', () => {
    const s = 'é'.repeat(3000) // 6000 bytes
    const h = headBytes(s, 4095)
    expect(Buffer.byteLength(h, 'utf-8')).toBeLessThanOrEqual(4095)
    expect(h).not.toContain('�')
    expect(h.length).toBe(2047)
  })
})

describe('toolResultText', () => {
  it('leads with the exit code, then both streams', () => {
    expect(toolResultText(exec({ exitCode: 3, stdout: 'out', stderr: 'err' }))).toBe('exit code 3\nstdout:\nout\nstderr:\nerr')
  })

  it('marks timeouts, signals and executor errors', () => {
    const t = toolResultText(exec({ ok: false, exitCode: null, timedOut: true, signal: 'TERM', stdout: '', error: 'aborted' }))
    expect(t).toContain('exit code: none')
    expect(t).toContain('signal TERM')
    expect(t).toContain('[timed out]')
    expect(t).toContain('[error: aborted]')
    expect(t).toContain('stdout:\n(empty)')
  })

  it('execIsError is false only for a clean zero exit', () => {
    expect(execIsError(exec())).toBe(false)
    expect(execIsError(exec({ exitCode: 1 }))).toBe(true)
    expect(execIsError(exec({ timedOut: true }))).toBe(true)
    expect(execIsError(exec({ ok: false }))).toBe(true)
  })
})

describe('file result texts', () => {
  it('read', () => {
    expect(readResultText({ ok: true, content: 'x' })).toEqual({ text: 'x', isError: false })
    expect(readResultText({ ok: true, tooLarge: true }).isError).toBe(true)
    expect(readResultText({ ok: true, binary: true }).isError).toBe(true)
    expect(readResultText({ ok: false, error: 'No such file' })).toEqual({ text: 'read failed: No such file', isError: true })
  })

  it('list', () => {
    const r = listResultText({
      ok: true,
      entries: [
        { name: 'conf.d', type: 'directory', size: 0, mtime: 0 },
        { name: 'nginx.conf', type: 'file', size: 42, mtime: 0 }
      ]
    })
    expect(r.isError).toBe(false)
    expect(r.text.split('\n')).toEqual([`d ${'0'.padStart(10)} conf.d`, `- ${'42'.padStart(10)} nginx.conf`])
    expect(listResultText({ ok: true, entries: [] }).text).toBe('(empty directory)')
  })

  it('write', () => {
    expect(writeResultText({ ok: true, afterSha256: 'abc', backupPath: '/x.bak' }, '/x').text).toBe(
      'Wrote /x (sha256 abc). Backup of the previous file: /x.bak.'
    )
    expect(writeResultText({ ok: false, error: 'denied' }, '/x')).toEqual({ text: 'write failed: denied', isError: true })
  })
})

describe('sudoNeedsPassword', () => {
  it('fires only for a sudo argv that failed asking for a password', () => {
    const r = exec({ exitCode: 1, stderr: 'sudo: a password is required' })
    expect(sudoNeedsPassword(['sudo', 'systemctl', 'reload', 'nginx'], r)).toBe(true)
    expect(sudoNeedsPassword(['systemctl', 'reload', 'nginx'], r)).toBe(false)
    expect(sudoNeedsPassword(['sudo', 'nginx', '-t'], exec({ exitCode: 1, stderr: 'syntax error' }))).toBe(false)
    expect(sudoNeedsPassword(['sudo', 'nginx', '-t'], exec())).toBe(false)
    expect(sudoNeedsPassword(undefined, r)).toBe(false)
  })
})

describe('withSudoStdin', () => {
  it('reads the password from stdin with an empty prompt', () => {
    expect(withSudoStdin(['sudo', 'systemctl', 'reload', 'nginx'])).toEqual(['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'])
  })

  it('removes -n, which forbids the prompt, and keeps -u, -g and -H', () => {
    expect(withSudoStdin(['sudo', '-n', 'systemctl', 'reload', 'nginx'])).toEqual(['sudo', '-S', '-p', '', 'systemctl', 'reload', 'nginx'])
    expect(withSudoStdin(['sudo', '-n', '-u', 'postgres', 'psql', '-c', 'select 1'])).toEqual([
      'sudo', '-S', '-p', '', '-u', 'postgres', 'psql', '-c', 'select 1'
    ])
    expect(withSudoStdin(['sudo', '-nu', 'postgres', 'psql'])).toEqual(['sudo', '-S', '-p', '', '-u', 'postgres', 'psql'])
    expect(withSudoStdin(['sudo', '-nHupostgres', 'psql'])).toEqual(['sudo', '-S', '-p', '', '-H', '-u', 'postgres', 'psql'])
    expect(withSudoStdin(['sudo', '-g', 'adm', '-H', 'ls'])).toEqual(['sudo', '-S', '-p', '', '-g', 'adm', '-H', 'ls'])
    expect(withSudoStdin(['sudo', '--non-interactive', '--user=app', '--set-home', 'id'])).toEqual([
      'sudo', '-S', '-p', '', '--user=app', '--set-home', 'id'
    ])
    expect(withSudoStdin(['sudo', '--user', 'app', 'id'])).toEqual(['sudo', '-S', '-p', '', '--user', 'app', 'id'])
  })

  it('replaces the model\'s own -S and -p, and leaves the command\'s flags alone', () => {
    expect(withSudoStdin(['sudo', '-S', '-p', 'pw:', 'nginx', '-t'])).toEqual(['sudo', '-S', '-p', '', 'nginx', '-t'])
    expect(withSudoStdin(['sudo', '--prompt=x', '--stdin', 'nginx', '-n'])).toEqual(['sudo', '-S', '-p', '', 'nginx', '-n'])
    expect(withSudoStdin(['sudo', '-n', '--', '-weird'])).toEqual(['sudo', '-S', '-p', '', '-weird'])
  })

  it('leaves a non-sudo argv unchanged', () => {
    expect(withSudoStdin(['systemctl', 'status', 'nginx'])).toEqual(['systemctl', 'status', 'nginx'])
  })
})

describe('plan', () => {
  it('planStepsFrom checks the steps like the schema does', () => {
    expect(planStepsFrom({ steps: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(planStepsFrom({ steps: [] })).toEqual({ error: 'steps must list at least one step' })
    expect(planStepsFrom({ steps: [''] })).toEqual({ error: 'every step must be a non-empty string' })
    expect(planStepsFrom({ steps: 'a' })).toEqual({ error: 'steps must be an array of strings' })
    expect(planStepsFrom({ steps: Array.from({ length: 41 }, () => 'x') })).toMatchObject({ error: expect.stringContaining('40') })
  })

  it('planApprovalContext names the runbook in place of a host', () => {
    expect(planApprovalContext(['a'], 'rb')).toEqual({
      hostName: 'rb',
      hostAddress: '',
      tool: 'plan',
      planSteps: ['a'],
      class: 'mutate',
      reason: 'plan approval',
      queuedBehind: 0,
      runbook: 'rb'
    })
  })

  it('the preamble tells the model to plan first', () => {
    expect(OPS_PREAMBLE).toContain('mcp__ops__propose_plan')
  })
})
