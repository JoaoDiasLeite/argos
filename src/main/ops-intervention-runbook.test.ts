/**
 * The base intervention shipped with Argos (resources/runbooks/intervention), built by
 * scripts/pin-intervention.mjs from the diagnosis and the Jarvis catalog. Three things:
 * the folder is exactly what the generator makes (no hand edit, no stale pin), it loads
 * through the real loader, and the real gate lets the catalog's commands through in the
 * shape the catalog writes them and nothing looser.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import { assembleRunbook, type LoadedRunbook } from './ops-runbook-pure'
import { classify } from './ops-gate-pure'
import { resolveHostGroups } from './ops-policy-pure'
import type { OpsHostRef } from './ops-types'
import { makeT } from '../shared/i18n'
import { buildInterventionPolicy, interactiveCommands, parseCatalog } from '../../scripts/intervention-pure.mjs'

const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, 'resources/runbooks/intervention')
const DIAGNOSIS = path.join(ROOT, 'resources/runbooks/diagnosis')
const CATALOG = readFileSync(path.join(ROOT, 'scripts/intervention/catalog.txt'), 'utf8')
const TITLES = JSON.parse(readFileSync(path.join(ROOT, 'scripts/intervention/titles.json'), 'utf8'))
const HOST: OpsHostRef = { id: 'h1', name: 'cm-tvedras-app', host: '10.0.0.5' }
const J = '/usr/local/sbin/jarvis run script'

function hashScripts(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(path.join(dir, 'scripts'), { withFileTypes: true })) {
    if (e.isFile()) out[e.name] = sha256Hex(readFileSync(path.join(dir, 'scripts', e.name)))
  }
  return out
}

function load(): LoadedRunbook {
  const r = assembleRunbook(
    {
      dir: DIR,
      runbookMd: readFileSync(path.join(DIR, 'RUNBOOK.md')),
      policyJson: readFileSync(path.join(DIR, 'policy.json')),
      scriptHashes: hashScripts(DIR),
      hosts: [HOST]
    },
    makeT('en')
  )
  if (!r.ok) throw new Error(`${r.error}\n${(r.errors ?? []).join('\n')}`)
  return r.runbook
}

const runbook = load()
const groups = resolveHostGroups(runbook.policy, HOST)
const run = (cmd: string): string => classify({ tool: 'run', hostId: HOST.id, cmd }, runbook.policy, HOST, groups).decision

describe('intervention runbook: in sync with its sources', () => {
  it('is exactly what scripts/pin-intervention.mjs builds (run npm run pin:intervention)', () => {
    const diagnosis = JSON.parse(readFileSync(path.join(DIAGNOSIS, 'policy.json'), 'utf8'))
    const built = buildInterventionPolicy(diagnosis, CATALOG, TITLES)
    expect(readFileSync(path.join(DIR, 'policy.json'), 'utf8')).toBe(JSON.stringify(built, null, 2) + '\n')
  })

  it('carries the diagnosis scripts byte for byte', () => {
    expect(hashScripts(DIR)).toEqual(hashScripts(DIAGNOSIS))
  })

  it('keeps every file LF-only, so the pinned hashes hold on every checkout', () => {
    for (const name of readdirSync(path.join(DIR, 'scripts'))) {
      expect(readFileSync(path.join(DIR, 'scripts', name)).includes(0x0d), name).toBe(false)
    }
    expect(readFileSync(path.join(DIR, 'policy.json')).includes(0x0d)).toBe(false)
    expect(readFileSync(path.join(DIR, 'RUNBOOK.md')).includes(0x0d)).toBe(false)
    expect(CATALOG.includes('\r')).toBe(false)
  })
})

describe('intervention runbook: loading', () => {
  const entries = parseCatalog(CATALOG)

  it('loads with no warnings, strict, on every host', () => {
    expect(runbook.warnings).toEqual([])
    expect(runbook.policy.strict).toBe(true)
    expect(groups).toEqual(['todos'])
    expect(runbook.policy.write).toBeUndefined()
  })

  it('has one rule per non-interactive catalog command, a change exactly when Jarvis says so', () => {
    const jarvisRules = runbook.policy.allow.filter((r) => r.cmd.includes('jarvis run script') && r.cmd.includes('--timing'))
    const runnable = entries.filter((e) => !e.interactive)
    expect(jarvisRules).toHaveLength(runnable.length)
    expect(jarvisRules.filter((r) => r.class === 'mutate')).toHaveLength(runnable.filter((e) => e.changes).length)
    expect(runbook.policy.allow.every((r) => r.approval === undefined && !!r.title)).toBe(true)
    expect(runbook.policy.allow.filter((r) => r.class === 'mutate').every((r) => r.cmd.includes('jarvis run script'))).toBe(true)
  })

  it('names every interactive command in RUNBOOK.md, so the model hands it to the operator', () => {
    const interactive = interactiveCommands(CATALOG).map((e) => e.name)
    expect(interactive.length).toBeGreaterThan(0)
    for (const name of interactive) expect(runbook.guidelines).toContain(`\`${name}\``)
  })

  it('opens RUNBOOK.md with one plain paragraph and no em or en dashes', () => {
    expect(runbook.guidelines.startsWith('# ')).toBe(true)
    expect(runbook.guidelines).not.toMatch(/[–—]/)
    expect(runbook.guidelines).toContain('Para correres na tua sessão SSH')
  })
})

describe('intervention runbook: gate', () => {
  it.each([
    'uptime',
    'tail -n 200 /var/log/nginx/error.log',
    `${J} diagnostics/installation_state`,
    `${J} backup/list`,
    `${J} app/test_rails`,
    `${J} diagnostics/update_steps --user=joao.leite`,
    `${J} diagnostics/update_checkup --version=10.14.0 --lane=next --verify_of=12 --timing=true`
  ])('allows the read %s', (cmd) => {
    expect(run(cmd)).toBe('allow')
  })

  it.each([
    `${J} app/restart`,
    `${J} app/reload --timing=true`,
    `${J} app/monitor_service --service=sidekiq`,
    `${J} backup/create --target_version=10.14.0 --step=3 --timing=true`,
    `${J} backup/create`,
    `${J} backup/restore --backup=update_backup.20261110-1200`,
    `${J} database/migrate --step=7b --timing=true`,
    `${J} release/get_files --version=10.14.0 --lane=current`,
    `${J} release/register_installation_version --user=joao.leite --version=10.14.0 --lane=next`,
    `sudo ${J} system/fix_permissions --mode=application`,
    `sudo ${J} ruby/install_build_packages --lane=next --step=4 --timing=true`
  ])('asks before the change %s', (cmd) => {
    expect(run(cmd)).toBe('ask')
  })

  it.each([
    // interactive: never run by the model
    `${J} update_app/production --user=joao`,
    `${J} accounts/migrate`,
    `sudo ${J} system/install_wmcp_server`,
    `sudo ${J} system/renew_postgresql_certificates`,
    // only as the catalog writes it
    `sudo ${J} app/restart`,
    `${J} system/fix_permissions --mode=all`,
    `sudo ${J} system/fix_permissions --mode=root`,
    `${J} app/monitor_service --service=nginx`,
    `${J} ruby/install --lane=previous`,
    `${J} app/restart --force`,
    `${J} app/restart --timing=false`,
    `${J} app/restart --timing=true --step=3`,
    `${J} backup/create --target_version=latest`,
    `${J} diagnostics/../app/restart`,
    `${J} app/unknown`,
    'jarvis run script app/restart',
    // what the base leaves to Jarvis or out altogether
    'sudo -n systemctl restart nginx',
    'systemctl restart pumactl_smile-saas',
    'sudo -n monit restart puma',
    'sudo -n nginx -s reload',
    'kill 123',
    'bundle exec rails runner \'puts 1\'',
    'curl -fsS https://jarvis.cityfy.pt/api/v3/wmcp/catalog',
    'sudo dnf -y install docker-ce'
  ])('refuses %s', (cmd) => {
    expect(run(cmd)).toBe('deny')
  })
})
