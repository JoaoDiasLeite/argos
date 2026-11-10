/**
 * "Add to Argos": the issue proposes what a runbook adds to the base, and nothing about
 * where it ran. The repo is public, so the leak checks matter as much as the diff.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'
import { baseProposal, issueUrl, ARGOS_ISSUES_URL, ISSUE_URL_MAX } from './ops-proposal-pure'
import type { OpsPolicy } from './ops-types'

const base = JSON.parse(readFileSync(path.resolve(__dirname, '../../resources/runbooks/intervention/policy.json'), 'utf8')) as OpsPolicy

const runbook: OpsPolicy = {
  version: 1,
  strict: true,
  hosts: { app: ['IPLisboa', 'cm-tvedras-*'] },
  allow: [
    // Already in the base: not proposed.
    { ...base.allow[0], hosts: ['app'] },
    { hosts: ['app'], cmd: '^last -F -s [0-9]{4}-[0-9]{2}-[0-9]{2}$', class: 'read', title: 'Consulta dos acessos ao servidor' },
    { hosts: ['app'], cmd: '^curl -sS -I https://iplisboa\\.example\\.pt/api$', class: 'read', title: 'Ligação a IPLisboa' },
    { hosts: ['app'], cmd: '^ping -c 1 10\\.20\\.30\\.40$', class: 'read', title: 'Ping a 10.20.30.40' }
  ],
  scripts: [
    { ...base.scripts[0], hosts: ['app'] },
    { name: 'db-query.sh', sha256: 'a'.repeat(64), hosts: ['app'], class: 'read', title: 'Consulta', args: { max: 2, pattern: '^[a-z_]+$' } }
  ],
  read: { paths: [...(base.read?.paths ?? []), '^/home/iplisboa/www(/[^/]+)*$'], deny: ['(^|/)tenants\\.yml$'] }
}

const input = {
  base,
  runbook,
  runbookName: 'trace-message-dispatch',
  usedRules: ['^last -F -s [0-9]{4}-[0-9]{2}-[0-9]{2}$', 'script:db-query.sh', 'uptime'],
  outcome: 'ok' as const,
  argosVersion: '3.6.0',
  hostWords: ['IPLisboa', '10.20.30.40', 'cm-tvedras-app', '10.0.0.5']
}

describe('baseProposal', () => {
  const p = baseProposal(input)!

  it('proposes only what the base lacks, marking what the run used', () => {
    expect(p.rules.map((r) => r.title)).toEqual(['Consulta dos acessos ao servidor', 'Ligação a <host>', 'Ping a <host>'])
    expect(p.rules.map((r) => r.used)).toEqual([true, false, false])
    expect(p.scripts).toHaveLength(1)
    expect(p.scripts[0]).toMatchObject({ name: 'db-query.sh', used: true })
    expect(p.readDeny).toEqual(['(^|/)tenants\\.yml$'])
    expect(p.title).toBe('runbook: add trace-message-dispatch to the base intervention')
  })

  it('never names a host, an address or a host group', () => {
    const all = `${p.title}\n${p.body}`
    for (const word of ['IPLisboa', 'iplisboa', '10.20.30.40', '10\\.20\\.30\\.40', 'cm-tvedras', '"hosts"', '"app"']) {
      expect(all.toLowerCase()).not.toContain(word.toLowerCase())
    }
    expect(p.rules[1].cmd).toBe('^curl -sS -I https://<host>\\.example\\.pt/api$')
    expect(p.rules[2].cmd).toBe('^ping -c 1 <host>$')
    expect(p.readPaths).toEqual(['^/home/<host>/www(/[^/]+)*$'])
  })

  it('is null when the runbook adds nothing to the base', () => {
    expect(baseProposal({ ...input, runbook: { ...base } })).toBeNull()
  })
})

describe('issueUrl', () => {
  it('carries title and body in the URL when they fit', () => {
    const { url, viaClipboard } = issueUrl({ title: 't', body: 'b c' }, 'note')
    expect(viaClipboard).toBe(false)
    expect(url).toBe(`${ARGOS_ISSUES_URL}?title=t&body=b%20c`)
  })

  it('points to the clipboard when the body is too long', () => {
    const { url, viaClipboard } = issueUrl({ title: 't', body: 'x'.repeat(ISSUE_URL_MAX) }, 'The body is on the clipboard.')
    expect(viaClipboard).toBe(true)
    expect(url).toBe(`${ARGOS_ISSUES_URL}?title=t&body=The%20body%20is%20on%20the%20clipboard.`)
  })
})
