/**
 * "Somar à base" (docs/BASE_INTERVENTION_PLAN.md §5): the real base intervention plus a
 * runbook built in memory that has every awkward part at once: its own host group, a
 * script named like one of the base's (trace-message-dispatch ships its own log-window.sh),
 * `strict: false`, read paths that open a folder holding secrets, and its own limits.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import { assembleRunbook, type LoadedRunbook } from './ops-runbook-pure'
import { classify } from './ops-gate-pure'
import { resolveHostGroups } from './ops-policy-pure'
import { planRequired } from './ops-run-pure'
import { mergePolicies, mergeRunbooks, scriptDir } from './ops-merge-pure'
import { renderInternalReport } from './ops-report-pure'
import { runListItem, type OpsRunSummary } from './ops-audit-pure'
import type { OpsHostRef, OpsToolInput } from './ops-types'
import { makeT } from '../shared/i18n'

const t = makeT('pt-PT')
const BASE_DIR = path.resolve(__dirname, '../../resources/runbooks/intervention')
const APP: OpsHostRef = { id: 'h1', name: 'cm-tvedras-app', host: '10.0.0.5' }
const OTHER: OpsHostRef = { id: 'h2', name: 'iplisboa-db', host: '10.0.0.9' }
const OWN_DIR = path.resolve('/runbooks/trace-dispatch')
const LOG_WINDOW = Buffer.from('#!/usr/bin/env bash\necho own log window\n')
const APP_CONTEXT = Buffer.from('#!/usr/bin/env bash\necho context\n')

function loadBase(): LoadedRunbook {
  const hashes: Record<string, string> = {}
  for (const name of readdirSync(path.join(BASE_DIR, 'scripts'))) {
    hashes[name] = sha256Hex(readFileSync(path.join(BASE_DIR, 'scripts', name)))
  }
  const r = assembleRunbook(
    {
      dir: BASE_DIR,
      runbookMd: readFileSync(path.join(BASE_DIR, 'RUNBOOK.md')),
      policyJson: readFileSync(path.join(BASE_DIR, 'policy.json')),
      scriptHashes: hashes,
      hosts: [APP, OTHER]
    },
    t
  )
  if (!r.ok) throw new Error(r.error)
  return r.runbook
}

const ownPolicy = {
  version: 1,
  strict: false,
  platform: '*WireMaze Cityfy Platform*',
  hosts: { app: ['cm-*'] },
  allow: [
    { hosts: ['app'], cmd: '^last -F -s [0-9]{4}-[0-9]{2}-[0-9]{2}$', class: 'read', title: 'Consulta dos acessos ao servidor' },
    { hosts: ['app'], cmd: '^sudo -u wiremaze touch /home/wiremaze/www/app/tmp/restart\\.txt$', class: 'mutate', title: 'Pedido de reinício' }
  ],
  scripts: [
    { name: 'log-window.sh', sha256: sha256Hex(LOG_WINDOW), hosts: ['app'], class: 'read', title: 'Janela própria', args: { max: 1, pattern: '^[a-z]+$' } },
    { name: 'app-context.sh', sha256: sha256Hex(APP_CONTEXT), hosts: ['app'], class: 'read', title: 'Contexto da aplicação' }
  ],
  read: { paths: ['^/home/wiremaze/www/app/config(/[^/]+)*$'], deny: ['(^|/)tenants\\.yml$'], maxBytes: 1500000 },
  limits: { timeoutMs: 60000, maxOutputBytes: 100000, concurrentPerHost: 3 }
}

function loadOwn(): LoadedRunbook {
  const r = assembleRunbook(
    {
      dir: OWN_DIR,
      runbookMd: Buffer.from('# Trace dispatch\n\nLê um envio.\n'),
      policyJson: Buffer.from(JSON.stringify(ownPolicy)),
      scriptHashes: { 'log-window.sh': sha256Hex(LOG_WINDOW), 'app-context.sh': sha256Hex(APP_CONTEXT) },
      hosts: [APP, OTHER]
    },
    t
  )
  if (!r.ok) throw new Error(`${r.error}\n${(r.errors ?? []).join('\n')}`)
  return r.runbook
}

const base = loadBase()
const own = loadOwn()
const merged = mergeRunbooks(base, own, t)
const J = '/usr/local/sbin/jarvis run script'

type ToolCall = OpsToolInput extends infer T ? (T extends OpsToolInput ? Omit<T, 'hostId'> : never) : never
function decide(input: ToolCall, host: OpsHostRef = APP): string {
  return classify({ ...input, hostId: host.id } as OpsToolInput, merged.policy, host, resolveHostGroups(merged.policy, host)).decision
}
const run = (cmd: string, host?: OpsHostRef): string => decide({ tool: 'run', cmd }, host)

describe('mergeRunbooks: identity', () => {
  it('is named after the runbook and records the base with its hashes', () => {
    expect(merged.ref.name).toBe('trace-dispatch')
    expect(merged.ref.path).toBe(OWN_DIR)
    expect(merged.ref.policySha256).toBe(own.ref.policySha256)
    expect(merged.ref.base).toEqual({
      name: 'intervention',
      path: BASE_DIR,
      policySha256: base.ref.policySha256,
      runbookMdSha256: base.ref.runbookMdSha256
    })
    expect(merged.ref.platform).toBe('*WireMaze Cityfy Platform*')
  })

  it('reaches only the hosts the runbook covers', () => {
    expect(merged.hosts.map((h) => h.host.id)).toEqual(['h1'])
    expect(Object.keys(merged.policy.hosts)).toEqual(['app'])
    expect(merged.policy.allow.every((r) => r.hosts.length === 1 && r.hosts[0] === 'app')).toBe(true)
  })

  it('puts the base guidelines first and the runbook under its own heading', () => {
    expect(merged.guidelines.startsWith('# Intervenção base')).toBe(true)
    const heading = merged.guidelines.indexOf('## Runbook somado à base: trace-dispatch')
    expect(heading).toBeGreaterThan(0)
    expect(merged.guidelines.indexOf('# Trace dispatch')).toBeGreaterThan(heading)
  })
})

describe('mergeRunbooks: gate', () => {
  it.each([
    'last -F -s 2026-11-01',
    'uptime',
    'tail -n 200 /var/log/nginx/error.log',
    `${J} diagnostics/services`
  ])('allows %s on the runbook host', (cmd) => {
    expect(run(cmd)).toBe('allow')
  })

  it.each([`${J} app/restart`, 'sudo -u wiremaze touch /home/wiremaze/www/app/tmp/restart.txt'])('asks before the change %s', (cmd) => {
    expect(run(cmd)).toBe('ask')
  })

  it('is strict even though the runbook alone is not', () => {
    expect(own.policy.strict).toBe(false)
    expect(merged.policy.strict).toBe(true)
    expect(run('systemctl restart nginx')).toBe('deny')
    expect(run('echo hello')).toBe('deny')
  })

  it('reaches no host outside the runbook, not even with the base rules', () => {
    expect(run('uptime', OTHER)).toBe('deny')
    expect(run(`${J} diagnostics/services`, OTHER)).toBe('deny')
  })

  it('keeps every deny of both sides above every read path', () => {
    expect(decide({ tool: 'read', path: '/home/wiremaze/www/app/config/settings.yml' })).toBe('allow')
    expect(decide({ tool: 'read', path: '/home/wiremaze/www/app/config/database.yml' })).toBe('deny')
    expect(decide({ tool: 'read', path: '/home/wiremaze/www/app/config/tenants.yml' })).toBe('deny')
    expect(decide({ tool: 'read', path: '/var/log/nginx/error.log' })).toBe('allow')
  })

  it('needs a plan, since the base can change the server', () => {
    expect(planRequired(merged.policy)).toBe(true)
  })
})

describe('mergeRunbooks: scripts', () => {
  it("lets the runbook's script replace the base's of the same name, and says so", () => {
    const lw = merged.policy.scripts.filter((s) => s.name === 'log-window.sh')
    expect(lw).toHaveLength(1)
    expect(lw[0].sha256).toBe(sha256Hex(LOG_WINDOW))
    expect(scriptDir(merged, 'log-window.sh')).toBe(own.scriptsDir)
    expect(merged.warnings).toEqual([
      'scripts "log-window.sh": o script do próprio runbook substitui o script com o mesmo nome da intervenção base.'
    ])
    expect(decide({ tool: 'script', name: 'log-window.sh', args: ['abc'] })).toBe('allow')
  })

  it('reads each script from the folder it came from', () => {
    expect(scriptDir(merged, 'app-context.sh')).toBe(own.scriptsDir)
    expect(scriptDir(merged, 'snapshot.sh')).toBe(base.scriptsDir)
    expect(decide({ tool: 'script', name: 'snapshot.sh', args: [] })).toBe('allow')
    expect(merged.policy.scripts.map((s) => s.name).sort()).toEqual(
      ['app-context.sh', 'app-status.sh', 'env-get.sh', 'log-rate.sh', 'log-window.sh', 'pg-health.sh', 'pg-query.sh', 'proc-inspect.sh', 'snapshot.sh', 'tls-check.sh']
    )
  })
})

describe('a run on the base, after it ends', () => {
  const summary: OpsRunSummary = {
    runId: 'run-9',
    startedAt: '2026-11-10T10:00:00.000Z',
    runbook: merged.ref,
    hosts: [APP],
    model: 'claude-opus',
    calls: []
  } as OpsRunSummary

  it('names the base in the internal report', () => {
    expect(renderInternalReport(summary)).toContain(`- Added to the base: \`intervention\` (policy sha256 \`${base.ref.policySha256}\`)`)
  })

  it('is resumed on the base again', () => {
    expect(runListItem(summary, 'app-1').onBase).toBe(true)
    expect(runListItem({ ...summary, runbook: own.ref }, 'app-1').onBase).toBeUndefined()
  })
})

describe('mergePolicies: limits and read', () => {
  it('takes the longer timeout and larger output, but the smaller concurrency', () => {
    expect(merged.policy.limits).toEqual({ timeoutMs: 600000, maxOutputBytes: 2097152, concurrentPerHost: 1 })
  })

  it('unions read paths and denies, with the larger read cap', () => {
    expect(merged.policy.read?.paths[0]).toBe('^/home/wiremaze/www/app/config(/[^/]+)*$')
    expect(merged.policy.read?.deny).toEqual(expect.arrayContaining(['(^|/)tenants\\.yml$', '(^|/)database\\.yml']))
    expect(merged.policy.read?.maxBytes).toBe(1500000)
  })

  it('leaves both inputs untouched', () => {
    const before = JSON.stringify(base.policy)
    mergePolicies(base.policy, own.policy)
    expect(JSON.stringify(base.policy)).toBe(before)
    expect(base.policy.allow.every((r) => r.hosts[0] === 'todos')).toBe(true)
  })

  it('joins write rules with the stricter approval', () => {
    const a = { ...own.policy, write: { paths: ['^/a$'], approval: 'auto' as const } }
    const b = { ...own.policy, write: { paths: ['^/b$'], approval: 'ask' as const, backup: true } }
    expect(mergePolicies(a, b).policy.write).toEqual({ paths: ['^/b$', '^/a$'], approval: 'ask', backup: true })
  })
})
