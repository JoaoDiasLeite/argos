import { describe, it, expect } from 'vitest'
import {
  parsePolicy,
  resolveHostGroups,
  effectiveApproval,
  effectiveLimits,
  OPS_MAX_CONCURRENT_PER_HOST,
  OPS_MAX_READ_BYTES,
  type PolicyParseErr,
  type PolicyParseOk
} from './ops-policy-pure'
import {
  OPS_DEFAULT_OUTPUT_BYTES,
  OPS_DEFAULT_READ_BYTES,
  OPS_DEFAULT_TIMEOUT_MS,
  OPS_MAX_OUTPUT_BYTES,
  OPS_MAX_TIMEOUT_MS,
  type OpsHostRef,
  type OpsPolicy
} from './ops-types'

const RELOAD_SHA = 'a'.repeat(64)
const CHECK_SHA = 'b'.repeat(64)
const SCRIPT_HASHES = { 'reload.sh': RELOAD_SHA, 'check-config.sh': CHECK_SHA }

const HOSTS: OpsHostRef[] = [
  { id: 'h1', name: 'web-01', host: '10.0.0.1' },
  { id: 'h2', name: 'web-02', host: '10.0.0.2' },
  { id: 'h3', name: 'db-main', host: '10.0.0.3' }
]

/** The nginx example from plan §2, made valid (path patterns anchored with `.*$`). */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    strict: true,
    platform: 'cityfy',
    hosts: { web: ['web-01', 'web-02'], db: ['db-*'] },
    allow: [
      { hosts: ['web'], cmd: '^systemctl status [a-z0-9@.-]+$', class: 'read', title: 'Check service' },
      { hosts: ['web'], cmd: '^tail -n [0-9]{1,4} /var/log/nginx/[a-z.-]+\\.log$', class: 'read', title: 'Read log' },
      { hosts: ['web'], cmd: '^sudo systemctl reload nginx$', class: 'mutate', approval: 'ask', title: 'Reload nginx' }
    ],
    scripts: [
      {
        name: 'reload.sh',
        sha256: RELOAD_SHA,
        hosts: ['web'],
        class: 'mutate',
        approval: 'ask',
        title: 'Reload via script',
        args: { max: 1, pattern: '^[a-z0-9.-]+$' }
      }
    ],
    read: { paths: ['^/etc/nginx/.*$', '^/var/log/nginx/.*$'], maxBytes: 1000000 },
    write: { paths: ['^/etc/nginx/sites-available/.*$'], approval: 'ask', backup: true },
    limits: { timeoutMs: 60000, maxOutputBytes: 200000, concurrentPerHost: 1 },
    ...overrides
  }
}

/** One allow rule on top of the fixture, everything else unchanged. */
function withAllow(rule: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fixture({ allow: [{ hosts: ['web'], class: 'read', title: 't', ...rule }], ...overrides })
}

function withScript(rule: Record<string, unknown>): Record<string, unknown> {
  return fixture({
    scripts: [{ name: 'reload.sh', sha256: RELOAD_SHA, hosts: ['web'], class: 'read', title: 't', ...rule }]
  })
}

function parse(raw: unknown): PolicyParseOk | PolicyParseErr {
  return parsePolicy(raw, SCRIPT_HASHES, HOSTS)
}

function errorsOf(raw: unknown): string[] {
  const r = parse(raw)
  if (r.ok) throw new Error('expected the policy to be rejected')
  return r.errors
}

function ok(raw: unknown): PolicyParseOk {
  const r = parse(raw)
  if (!r.ok) throw new Error(`expected the policy to parse: ${r.errors.join(' | ')}`)
  return r
}

describe('parsePolicy — valid file', () => {
  it('accepts the complete nginx example with no errors or warnings', () => {
    const r = ok(fixture())
    expect(r.warnings).toEqual([])
    expect(r.policy.allow).toHaveLength(3)
    expect(r.policy.scripts[0].args).toEqual({ max: 1, pattern: '^[a-z0-9.-]+$' })
    expect(r.policy.read).toEqual({ paths: ['^/etc/nginx/.*$', '^/var/log/nginx/.*$'], maxBytes: 1000000 })
  })

  it('accepts a minimal file with empty allow and scripts', () => {
    const r = ok({ version: 1, strict: false, hosts: { web: ['web-01'] }, allow: [], scripts: [] })
    expect(r.policy).toEqual({ version: 1, strict: false, hosts: { web: ['web-01'] }, allow: [], scripts: [] })
  })

  it('returns a rebuilt policy, not the raw object', () => {
    const raw = fixture()
    const r = ok(raw)
    expect(r.policy).not.toBe(raw)
    expect(r.policy.allow).not.toBe(raw.allow)
  })

  it('collects every error rather than stopping at the first', () => {
    const errs = errorsOf(fixture({ version: 2, strict: 'yes', allow: [{ hosts: [], cmd: 'ls', class: 'write' }] }))
    expect(errs.length).toBeGreaterThanOrEqual(5)
  })

  it('rejects a non-object', () => {
    expect(errorsOf(null)).toHaveLength(1)
    expect(errorsOf([])).toHaveLength(1)
    expect(errorsOf('{}')).toHaveLength(1)
  })
})

describe('parsePolicy — rule 1: top-level shape', () => {
  it('rejects a version other than 1', () => {
    expect(errorsOf(fixture({ version: 2 }))).toEqual([expect.stringContaining('version')])
    expect(errorsOf(fixture({ version: '1' }))).toEqual([expect.stringContaining('version')])
  })

  it('rejects a non-boolean strict', () => {
    expect(errorsOf(fixture({ strict: 'true' }))).toEqual([expect.stringContaining('strict')])
  })

  it('rejects hosts that is not an object of string arrays, or has no groups', () => {
    expect(errorsOf(fixture({ hosts: [] })).some((e) => e.startsWith('hosts must be an object'))).toBe(true)
    expect(errorsOf(fixture({ hosts: {}, allow: [], scripts: [] }))).toEqual(['hosts must define at least one host group.'])
    expect(errorsOf(fixture({ hosts: { web: 'web-01', db: ['db-*'] }, allow: [], scripts: [] }))).toEqual([
      expect.stringContaining('hosts.web')
    ])
  })

  it('rejects allow or scripts that are not arrays', () => {
    expect(errorsOf(fixture({ allow: {} }))).toEqual(['allow must be an array (it may be empty).'])
    expect(errorsOf(fixture({ scripts: undefined }))).toEqual(['scripts must be an array (it may be empty).'])
  })
})

describe('parsePolicy — rule 2: command and argument patterns', () => {
  it('rejects a pattern of 512 characters or more', () => {
    const cmd = '^' + 'a'.repeat(510) + '$'
    expect(cmd.length).toBe(512)
    expect(errorsOf(withAllow({ cmd }))).toEqual([expect.stringContaining('under 512')])
  })

  it('rejects a pattern that does not compile', () => {
    expect(errorsOf(withAllow({ cmd: '^ls [a-$' }))).toEqual([expect.stringContaining('does not compile')])
  })

  it('rejects a pattern not anchored at the start', () => {
    expect(errorsOf(withAllow({ cmd: 'systemctl status nginx$' }))).toEqual([expect.stringContaining('allow[0].cmd')])
  })

  it('rejects a pattern not anchored at the end', () => {
    expect(errorsOf(withAllow({ cmd: '^systemctl' }))).toEqual([expect.stringContaining('anchored')])
  })

  it('rejects a pattern whose trailing $ is escaped', () => {
    expect(errorsOf(withAllow({ cmd: '^echo \\$' }))).toEqual([expect.stringContaining('unescaped')])
    // An escaped backslash before $ leaves the $ as an anchor.
    ok(withAllow({ cmd: '^echo \\\\$' }))
  })

  it('rejects top-level alternation, which unanchors an otherwise anchored pattern', () => {
    expect(errorsOf(withAllow({ cmd: '^systemctl status nginx|rm -rf /$' }))).toEqual([
      expect.stringContaining('outside a group')
    ])
    ok(withAllow({ cmd: '^systemctl (status|is-active) nginx$' }))
    ok(withAllow({ cmd: '^echo [|]$' }))
    ok(withAllow({ cmd: '^echo \\|$' }))
  })

  it('rejects a pattern containing a newline', () => {
    expect(errorsOf(withAllow({ cmd: '^ls\n$' }))).toEqual([expect.stringContaining('newline')])
    expect(errorsOf(withAllow({ cmd: '^ls\r$' }))).toEqual([expect.stringContaining('newline')])
    const lineSep = String.fromCharCode(0x2028)
    expect(errorsOf(withAllow({ cmd: `^ls${lineSep}$` }))).toEqual([expect.stringContaining('newline')])
  })

  it('rejects a non-string pattern', () => {
    expect(errorsOf(withAllow({ cmd: 42 }))).toEqual(['allow[0].cmd must be a string.'])
  })

  it('applies the same rules to scripts[i].args.pattern', () => {
    expect(errorsOf(withScript({ args: { max: 1, pattern: '[a-z]+' } }))).toEqual([
      expect.stringContaining('scripts[0].args.pattern')
    ])
  })
})

describe('parsePolicy — rule 3: read and write paths', () => {
  it('rejects an unanchored read path', () => {
    expect(errorsOf(fixture({ read: { paths: ['^/etc/nginx/'] } }))).toEqual([expect.stringContaining('read.paths[0]')])
  })

  it('rejects a path pattern that is not absolute', () => {
    expect(errorsOf(fixture({ write: { paths: ['^etc/nginx/.*$'] } }))).toEqual([
      expect.stringContaining('write.paths[0] must start with ^/')
    ])
  })

  it('rejects paths that are not an array', () => {
    expect(errorsOf(fixture({ read: { paths: '^/etc/.*$' } }))).toEqual(['read.paths must be an array of path patterns.'])
  })
})

describe('parsePolicy — rule 4: rule host groups', () => {
  it('rejects a rule naming a group that does not exist', () => {
    expect(errorsOf(withAllow({ cmd: '^ls$', hosts: ['wbe'] }))).toEqual([expect.stringContaining('"wbe"')])
  })

  it('rejects an empty hosts array', () => {
    expect(errorsOf(withScript({ hosts: [] }))).toEqual(['scripts[0].hosts is empty; name at least one host group.'])
  })
})

describe('parsePolicy — rule 5: class and approval values', () => {
  it('rejects an unknown class', () => {
    expect(errorsOf(withAllow({ cmd: '^ls$', class: 'write' }))).toEqual([expect.stringContaining('allow[0].class')])
  })

  it('rejects an unknown approval', () => {
    expect(errorsOf(withAllow({ cmd: '^ls$', approval: 'yes' }))).toEqual([expect.stringContaining('allow[0].approval')])
    expect(errorsOf(fixture({ write: { paths: ['^/tmp/.*$'], approval: 'never' } }))).toEqual([
      expect.stringContaining('write.approval')
    ])
  })
})

describe('parsePolicy — rule 6: mutate + auto only under strict', () => {
  it('rejects mutate+auto when strict is false', () => {
    const errs = errorsOf(withAllow({ cmd: '^sudo systemctl reload nginx$', class: 'mutate', approval: 'auto' }, { strict: false }))
    expect(errs).toEqual([expect.stringContaining('only allowed when strict is true')])
  })

  it('accepts mutate+auto when strict is true', () => {
    ok(withAllow({ cmd: '^sudo systemctl reload nginx$', class: 'mutate', approval: 'auto' }))
  })

  it('treats write approval auto as mutate+auto', () => {
    expect(errorsOf(fixture({ strict: false, write: { paths: ['^/tmp/.*$'], approval: 'auto' } }))).toEqual([
      expect.stringContaining('write is a mutate rule')
    ])
  })
})

describe('parsePolicy — rule 7: script names and hashes', () => {
  it.each(['', 'sub/reload.sh', 'sub\\reload.sh', '..', 'a..b', '-rf', 'x'.repeat(129)])(
    'rejects the script name %j',
    (name) => {
      expect(errorsOf(withScript({ name })).some((e) => e.startsWith('scripts[0].name'))).toBe(true)
    }
  )

  it('rejects a script that is not in scripts/', () => {
    expect(errorsOf(withScript({ name: 'gone.sh' }))).toEqual([expect.stringContaining('not found')])
  })

  it('rejects a changed script and shows both hashes', () => {
    const [err] = errorsOf(withScript({ name: 'check-config.sh', sha256: RELOAD_SHA }))
    expect(err).toContain(RELOAD_SHA)
    expect(err).toContain(CHECK_SHA)
  })

  it('rejects a malformed sha256', () => {
    expect(errorsOf(withScript({ sha256: 'A'.repeat(64) }))).toEqual([expect.stringContaining('lower-case hex')])
    expect(errorsOf(withScript({ sha256: 'a'.repeat(63) }))).toEqual([expect.stringContaining('lower-case hex')])
  })

  it('rejects the same script listed twice', () => {
    const s = { name: 'reload.sh', sha256: RELOAD_SHA, hosts: ['web'], class: 'read', title: 't' }
    expect(errorsOf(fixture({ scripts: [s, s] }))).toEqual([expect.stringContaining('more than once')])
  })
})

describe('parsePolicy — rule 8: script args', () => {
  it('requires a pattern when max is above 0', () => {
    expect(errorsOf(withScript({ args: { max: 2 } }))).toEqual(['scripts[0].args.pattern is required when args.max is above 0.'])
  })

  it('rejects max outside 0..16 or not an integer', () => {
    for (const max of [-1, 17, 1.5, '1']) {
      expect(errorsOf(withScript({ args: { max, pattern: '^a$' } }))).toEqual([expect.stringContaining('args.max')])
    }
  })

  it('accepts max 0 with no pattern', () => {
    ok(withScript({ args: { max: 0 } }))
  })
})

describe('parsePolicy — rule 9: limits', () => {
  it('rejects a limit that is not a positive integer', () => {
    expect(errorsOf(fixture({ limits: { timeoutMs: 0 } }))).toEqual([expect.stringContaining('limits.timeoutMs')])
    expect(errorsOf(fixture({ limits: { maxOutputBytes: 1.5 } }))).toEqual([expect.stringContaining('limits.maxOutputBytes')])
    expect(errorsOf(fixture({ read: { paths: [], maxBytes: -1 } }))).toEqual([expect.stringContaining('read.maxBytes')])
  })

  it('warns, and still parses, when a limit is above the ceiling', () => {
    const r = ok(fixture({ limits: { timeoutMs: OPS_MAX_TIMEOUT_MS + 1 } }))
    expect(r.warnings).toEqual([expect.stringContaining('limits.timeoutMs')])
  })
})

describe('parsePolicy — rule 10: platform', () => {
  it('rejects an unknown platform', () => {
    expect(errorsOf(fixture({ platform: 'wirething' }))).toEqual([expect.stringContaining('platform')])
  })

  it('accepts an absent platform', () => {
    const raw = fixture()
    delete raw.platform
    expect(ok(raw).policy.platform).toBeUndefined()
  })
})

describe('parsePolicy — rule 11: unknown keys', () => {
  it('rejects an unknown top-level key, so a typo never means "no rules"', () => {
    const raw = fixture({ alow: [] })
    expect(errorsOf(raw)).toEqual(['policy.json has an unknown key "alow".'])
  })

  it('rejects an unknown key inside a rule', () => {
    expect(errorsOf(withAllow({ cmd: '^ls$', aproval: 'ask' }))).toEqual(['allow[0] has an unknown key "aproval".'])
  })
})

describe('parsePolicy — warnings', () => {
  it('warns about a host group that matches no stored host', () => {
    const r = ok(fixture({ hosts: { web: ['web-01'], db: ['db-*'], staging: ['stg-*'] } }))
    expect(r.warnings).toEqual(['Host group "staging" matches none of the stored hosts.'])
  })

  it('warns about a rule with no title', () => {
    const r = ok(fixture({ allow: [{ hosts: ['web'], cmd: '^ls$', class: 'read' }] }))
    expect(r.warnings).toEqual([expect.stringContaining('allow[0] has no title')])
  })
})

describe('resolveHostGroups', () => {
  const policy: OpsPolicy = {
    version: 1,
    strict: true,
    hosts: { web: ['web-01', 'h2'], db: ['db-*'], all: ['*'], prod: ['web-01'] },
    allow: [],
    scripts: []
  }

  it('matches by exact name', () => {
    expect(resolveHostGroups(policy, HOSTS[0])).toContain('web')
  })

  it('matches by exact id', () => {
    expect(resolveHostGroups(policy, HOSTS[1])).toEqual(['web', 'all'])
  })

  it('matches by glob', () => {
    expect(resolveHostGroups(policy, HOSTS[2])).toEqual(['db', 'all'])
  })

  it('returns every group a host is in', () => {
    expect(resolveHostGroups(policy, HOSTS[0])).toEqual(['web', 'all', 'prod'])
  })

  it('is case-sensitive and treats regex characters literally', () => {
    const p: OpsPolicy = { ...policy, hosts: { a: ['DB-*'], b: ['web.01'], c: ['web-0?'] } }
    expect(resolveHostGroups(p, HOSTS[2])).toEqual([])
    expect(resolveHostGroups(p, HOSTS[0])).toEqual([])
  })

  it('does not match on the host address', () => {
    const p: OpsPolicy = { ...policy, hosts: { a: ['10.0.0.*'] } }
    expect(resolveHostGroups(p, HOSTS[0])).toEqual([])
  })
})

describe('effectiveApproval', () => {
  it('defaults to ask for mutate and auto for read', () => {
    expect(effectiveApproval({ class: 'mutate' })).toBe('ask')
    expect(effectiveApproval({ class: 'read' })).toBe('auto')
  })

  it('keeps an explicit value', () => {
    expect(effectiveApproval({ class: 'read', approval: 'ask' })).toBe('ask')
    expect(effectiveApproval({ class: 'mutate', approval: 'auto' })).toBe('auto')
  })
})

describe('effectiveLimits', () => {
  const base: OpsPolicy = { version: 1, strict: true, hosts: { web: ['web-01'] }, allow: [], scripts: [] }

  it('applies the defaults when nothing is set', () => {
    expect(effectiveLimits(base)).toEqual({
      timeoutMs: OPS_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: OPS_DEFAULT_OUTPUT_BYTES,
      concurrentPerHost: 1,
      readMaxBytes: OPS_DEFAULT_READ_BYTES
    })
  })

  it('keeps values under the ceilings', () => {
    const l = effectiveLimits({
      ...base,
      limits: { timeoutMs: 5000, maxOutputBytes: 1000, concurrentPerHost: 2 },
      read: { paths: [], maxBytes: 500 }
    })
    expect(l).toEqual({ timeoutMs: 5000, maxOutputBytes: 1000, concurrentPerHost: 2, readMaxBytes: 500 })
  })

  it('clamps values above the ceilings', () => {
    const l = effectiveLimits({
      ...base,
      limits: { timeoutMs: 1e9, maxOutputBytes: 1e9, concurrentPerHost: 99 },
      read: { paths: [], maxBytes: 1e9 }
    })
    expect(l).toEqual({
      timeoutMs: OPS_MAX_TIMEOUT_MS,
      maxOutputBytes: OPS_MAX_OUTPUT_BYTES,
      concurrentPerHost: OPS_MAX_CONCURRENT_PER_HOST,
      readMaxBytes: OPS_MAX_READ_BYTES
    })
  })

  it('falls back to the default for a nonsense value it was handed unvalidated', () => {
    expect(effectiveLimits({ ...base, limits: { timeoutMs: -5 } }).timeoutMs).toBe(OPS_DEFAULT_TIMEOUT_MS)
  })
})
