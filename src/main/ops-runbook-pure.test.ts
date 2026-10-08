import { describe, it, expect } from 'vitest'
import { sha256Hex } from './ops-audit-pure'
import { assembleRunbook, OPS_MAX_RUNBOOK_FILE_BYTES, runbookForbiddenEntries, runbookForbiddenError, runbookName, scriptPinError, type RunbookFiles } from './ops-runbook-pure'

const SCRIPT = Buffer.from('#!/bin/sh\nnginx -t\n')
const SCRIPT_SHA = sha256Hex(SCRIPT)

const POLICY = {
  version: 1,
  strict: true,
  platform: '*Acme Portal*',
  hosts: { web: ['web-*'], db: ['db-01'] },
  allow: [{ hosts: ['web'], cmd: '^systemctl status nginx$', class: 'read', title: 'Verificação do serviço' }],
  scripts: [{ name: 'check.sh', sha256: SCRIPT_SHA, hosts: ['web'], class: 'read' }]
}

const HOSTS = [
  { id: 'a', name: 'web-01', host: '10.0.0.1' },
  { id: 'b', name: 'db-01', host: '10.0.0.2' },
  { id: 'c', name: 'mail', host: '10.0.0.3' }
]

function files(over: Partial<RunbookFiles> = {}): RunbookFiles {
  return {
    dir: '/repo/runbooks/nginx-config-reload',
    runbookMd: Buffer.from('# Reload\nFollow the steps.\n'),
    policyJson: Buffer.from(JSON.stringify(POLICY)),
    scriptHashes: { 'check.sh': SCRIPT_SHA },
    hosts: HOSTS,
    ...over
  }
}

describe('runbookName', () => {
  it('is the folder basename, with either separator and a trailing slash', () => {
    expect(runbookName('/repo/runbooks/pg-tls-check')).toBe('pg-tls-check')
    expect(runbookName('C:\\repo\\runbooks\\pg_tls.check\\')).toBe('pg_tls.check')
  })

  it('refuses names outside [A-Za-z0-9._-] and the dot names', () => {
    expect(runbookName('/repo/runbooks/with space')).toBeNull()
    expect(runbookName('/repo/runbooks/ação')).toBeNull()
    expect(runbookName('/repo/runbooks/..')).toBeNull()
    expect(runbookName('/')).toBeNull()
  })
})

describe('assembleRunbook', () => {
  it('builds the ref, guidelines and the hosts that belong to a group', () => {
    const r = assembleRunbook(files())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rb = r.runbook
    expect(rb.ref).toEqual({
      name: 'nginx-config-reload',
      path: '/repo/runbooks/nginx-config-reload',
      policySha256: sha256Hex(Buffer.from(JSON.stringify(POLICY))),
      runbookMdSha256: sha256Hex(Buffer.from('# Reload\nFollow the steps.\n')),
      platform: '*Acme Portal*'
    })
    expect(rb.guidelines).toBe('# Reload\nFollow the steps.\n')
    expect(rb.hosts).toEqual([
      { host: HOSTS[0], groups: ['web'] },
      { host: HOSTS[1], groups: ['db'] }
    ])
    expect(rb.policy.scripts[0].name).toBe('check.sh')
  })

  it('strips a UTF-8 BOM before parsing but hashes the bytes as they are', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(POLICY))])
    const r = assembleRunbook(files({ policyJson: bytes }))
    expect(r.ok && r.runbook.ref.policySha256).toBe(sha256Hex(bytes))
  })

  it('refuses invalid JSON, an invalid policy, and oversized files', () => {
    expect(assembleRunbook(files({ policyJson: Buffer.from('{') }))).toMatchObject({ ok: false, error: /not valid JSON/ })
    const bad = assembleRunbook(files({ policyJson: Buffer.from(JSON.stringify({ ...POLICY, strict: 'yes' })) }))
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.errors?.length).toBeGreaterThan(0)
    const big = Buffer.alloc(OPS_MAX_RUNBOOK_FILE_BYTES + 1, 0x20)
    expect(assembleRunbook(files({ runbookMd: big })).ok).toBe(false)
    expect(assembleRunbook(files({ policyJson: big })).ok).toBe(false)
  })

  it('refuses a script whose hash does not match, or that is missing', () => {
    expect(assembleRunbook(files({ scriptHashes: { 'check.sh': 'f'.repeat(64) } })).ok).toBe(false)
    expect(assembleRunbook(files({ scriptHashes: {} })).ok).toBe(false)
  })

  it('refuses a folder name outside the charset', () => {
    expect(assembleRunbook(files({ dir: '/repo/runbooks/bad name' })).ok).toBe(false)
  })
})

describe('scriptPinError', () => {
  const policy = (() => {
    const r = assembleRunbook(files())
    if (!r.ok) throw new Error('fixture')
    return r.runbook.policy
  })()

  it('passes the pinned hash and refuses a changed one with both hashes', () => {
    expect(scriptPinError(policy, 'check.sh', SCRIPT_SHA)).toBeNull()
    const err = scriptPinError(policy, 'check.sh', 'a'.repeat(64))
    expect(err).toContain(SCRIPT_SHA)
    expect(err).toContain('a'.repeat(64))
  })

  it('refuses a script the policy does not list', () => {
    expect(scriptPinError(policy, 'other.sh', SCRIPT_SHA)).toMatch(/not listed/)
  })
})

describe('runbookForbiddenEntries', () => {
  it('finds CLI config a runbook must not carry, whatever the case', () => {
    expect(runbookForbiddenEntries(['RUNBOOK.md', 'policy.json', 'scripts'])).toEqual([])
    expect(runbookForbiddenEntries(['RUNBOOK.md', '.claude', 'policy.json'])).toEqual(['.claude'])
    expect(runbookForbiddenEntries(['CLAUDE.md', 'Claude.Local.md', '.MCP.json'])).toEqual([
      'CLAUDE.md',
      'Claude.Local.md',
      '.MCP.json'
    ])
  })

  it('names every offending entry in the refusal', () => {
    const err = runbookForbiddenError(['.claude', 'CLAUDE.md'])
    expect(err).toContain('.claude')
    expect(err).toContain('CLAUDE.md')
  })
})
