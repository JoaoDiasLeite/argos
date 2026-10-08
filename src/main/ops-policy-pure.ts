/**
 * Parser and validator for a runbook's policy.json (docs/OPS_AGENT_PLAN.md §2).
 *
 * The one property that matters: an invalid file is refused, never read as "fewer rules".
 * So every error is collected (the owner fixes them in one pass), unknown keys are errors
 * (`alow` must not mean "no allow rules"), and the returned policy is rebuilt from known
 * fields only, so nothing the validator did not look at reaches the gate.
 *
 * Pure: no fs, no electron. The caller hashes scripts/ and passes the stored hosts in.
 */
import {
  OPS_DEFAULT_OUTPUT_BYTES,
  OPS_DEFAULT_READ_BYTES,
  OPS_DEFAULT_TIMEOUT_MS,
  OPS_MAX_OUTPUT_BYTES,
  OPS_MAX_TIMEOUT_MS,
  type OpsAllowRule,
  type OpsApproval,
  type OpsClass,
  type OpsHostRef,
  type OpsPolicy,
  type OpsScriptRule
} from './ops-types'

export interface PolicyParseOk {
  ok: true
  policy: OpsPolicy
  warnings: string[]
}

export interface PolicyParseErr {
  ok: false
  errors: string[]
}

export interface OpsEffectiveLimits {
  timeoutMs: number
  maxOutputBytes: number
  concurrentPerHost: number
  readMaxBytes: number
}

/**
 * ops-types has no ceiling for these two, so they live here. A read's bytes go back to the
 * model like command output, so they share the output ceiling; more than a few parallel
 * sessions per host is never what a runbook needs.
 */
export const OPS_MAX_READ_BYTES = OPS_MAX_OUTPUT_BYTES
export const OPS_MAX_CONCURRENT_PER_HOST = 4
export const OPS_DEFAULT_CONCURRENT_PER_HOST = 1

export const OPS_MAX_PATTERN_LENGTH = 512
export const OPS_MAX_SCRIPT_NAME_LENGTH = 128
export const OPS_MAX_SCRIPT_ARGS = 16

export const OPS_MAX_PLATFORM_LENGTH = 120

const TOP_KEYS = ['version', 'strict', 'platform', 'hosts', 'allow', 'scripts', 'read', 'write', 'limits']
const ALLOW_KEYS = ['hosts', 'cmd', 'class', 'approval', 'title']
const SCRIPT_KEYS = ['name', 'sha256', 'hosts', 'class', 'approval', 'title', 'args']
const ARGS_KEYS = ['max', 'pattern']
const READ_KEYS = ['paths', 'maxBytes']
const WRITE_KEYS = ['paths', 'approval', 'backup']
const LIMIT_KEYS = ['timeoutMs', 'maxOutputBytes', 'concurrentPerHost']

const SHA256_RE = /^[0-9a-f]{64}$/
/** JS treats these as line terminators too; spelled as code points so no editor eats them. */
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** Unknown keys inside a rule are as dangerous as at the top: `aproval` would silently default. */
function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string, errors: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where} has an unknown key "${k}".`)
  }
}

/**
 * True when `|` appears outside any group or character class. `^a|b$` passes a
 * first/last-character check yet matches "…b" anywhere, so top-level alternation
 * defeats the anchoring rule and is refused; `^(a|b)$` is fine.
 */
function hasTopLevelAlternation(src: string): boolean {
  let depth = 0
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && depth === 0) return true
  }
  return false
}

/** True when the trailing `$` is preceded by an odd number of backslashes (a literal dollar). */
function endsWithEscapedDollar(src: string): boolean {
  let n = 0
  for (let i = src.length - 2; i >= 0 && src[i] === '\\'; i--) n++
  return n % 2 === 1
}

/** Rule 2: a pattern the gate can trust to match the whole string and nothing more. */
function checkPattern(v: unknown, where: string, errors: string[], absolutePath = false): v is string {
  if (typeof v !== 'string') {
    errors.push(`${where} must be a string.`)
    return false
  }
  const before = errors.length
  if (v.length >= OPS_MAX_PATTERN_LENGTH) {
    errors.push(`${where} is ${v.length} characters; patterns must be under ${OPS_MAX_PATTERN_LENGTH}.`)
  }
  if (/[\n\r]/.test(v) || v.includes(LINE_SEP) || v.includes(PARA_SEP)) {
    errors.push(`${where} contains a newline character.`)
  }
  try {
    new RegExp(v)
  } catch (e) {
    errors.push(`${where} does not compile as a regular expression (${(e as Error).message}).`)
  }
  if (!v.startsWith('^') || !v.endsWith('$') || v.length < 2 || endsWithEscapedDollar(v)) {
    errors.push(`${where} must be anchored at both ends (start with ^ and end with an unescaped $): ${JSON.stringify(v)}.`)
  } else if (hasTopLevelAlternation(v)) {
    errors.push(`${where} uses | outside a group, which unanchors it; wrap the alternatives in (…): ${JSON.stringify(v)}.`)
  }
  if (absolutePath && !v.startsWith('^/')) {
    errors.push(`${where} must start with ^/ (an absolute POSIX path): ${JSON.stringify(v)}.`)
  }
  return errors.length === before
}

function checkClass(v: unknown, where: string, errors: string[]): v is OpsClass {
  if (v === 'read' || v === 'mutate') return true
  errors.push(`${where}.class must be "read" or "mutate", got ${JSON.stringify(v)}.`)
  return false
}

function checkApproval(v: unknown, where: string, errors: string[]): v is OpsApproval | undefined {
  if (v === undefined || v === 'auto' || v === 'ask') return true
  errors.push(`${where}.approval must be "auto" or "ask" when present, got ${JSON.stringify(v)}.`)
  return false
}

/** Rule 6: mutate+auto under non-strict would let unknowns ask while known writes run unseen. */
function checkMutateAuto(cls: unknown, approval: unknown, strict: unknown, where: string, errors: string[]): void {
  if (cls === 'mutate' && approval === 'auto' && strict !== true) {
    errors.push(`${where} is a mutate rule with approval "auto", which is only allowed when strict is true.`)
  }
}

function checkRuleHosts(v: unknown, groups: Set<string>, where: string, errors: string[]): v is string[] {
  if (!Array.isArray(v) || v.some((g) => typeof g !== 'string')) {
    errors.push(`${where}.hosts must be an array of host group names.`)
    return false
  }
  if (v.length === 0) {
    errors.push(`${where}.hosts is empty; name at least one host group.`)
    return false
  }
  let ok = true
  for (const g of v as string[]) {
    if (!groups.has(g)) {
      errors.push(`${where}.hosts names "${g}", which is not a group in policy.hosts.`)
      ok = false
    }
  }
  return ok
}

function checkScriptName(v: unknown, where: string, errors: string[]): v is string {
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(`${where}.name must be a non-empty string.`)
    return false
  }
  const bad =
    v.includes('/') ||
    v.includes('\\') ||
    v.includes('..') ||
    v.startsWith('-') ||
    v.length > OPS_MAX_SCRIPT_NAME_LENGTH ||
    /[\0\n\r]/.test(v)
  if (bad) {
    errors.push(
      `${where}.name ${JSON.stringify(v)} must be a plain file name: no / or \\, no .., no leading -, at most ${OPS_MAX_SCRIPT_NAME_LENGTH} characters.`
    )
    return false
  }
  return true
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`)
}

function entryMatches(entry: string, host: OpsHostRef): boolean {
  if (entry === host.name || entry === host.id) return true
  if (!entry.includes('*')) return false
  const re = globToRegExp(entry)
  return re.test(host.name) || re.test(host.id)
}

/** Host group names (keys of policy.hosts) whose entries match this host. */
export function resolveHostGroups(policy: OpsPolicy, host: OpsHostRef): string[] {
  return Object.keys(policy.hosts).filter((group) =>
    policy.hosts[group].some((entry) => entryMatches(entry, host))
  )
}

/** Effective approval for a rule: explicit value, else 'ask' for mutate and 'auto' for read. */
export function effectiveApproval(rule: { class: OpsClass; approval?: OpsApproval }): OpsApproval {
  if (rule.approval) return rule.approval
  return rule.class === 'mutate' ? 'ask' : 'auto'
}

function clampOr(v: unknown, fallback: number, max: number): number {
  return isPositiveInt(v) ? Math.min(v, max) : fallback
}

/** policy.limits with defaults applied and clamped to the app-wide ceilings. */
export function effectiveLimits(policy: OpsPolicy): OpsEffectiveLimits {
  const l = policy.limits ?? {}
  return {
    timeoutMs: clampOr(l.timeoutMs, OPS_DEFAULT_TIMEOUT_MS, OPS_MAX_TIMEOUT_MS),
    maxOutputBytes: clampOr(l.maxOutputBytes, OPS_DEFAULT_OUTPUT_BYTES, OPS_MAX_OUTPUT_BYTES),
    concurrentPerHost: clampOr(l.concurrentPerHost, OPS_DEFAULT_CONCURRENT_PER_HOST, OPS_MAX_CONCURRENT_PER_HOST),
    readMaxBytes: clampOr(policy.read?.maxBytes, OPS_DEFAULT_READ_BYTES, OPS_MAX_READ_BYTES)
  }
}

/** Rule 9: present limits are positive integers; over the ceiling is a warning (clamped later). */
function checkLimit(v: unknown, max: number, where: string, errors: string[], warnings: string[]): void {
  if (v === undefined) return
  if (!isPositiveInt(v)) {
    errors.push(`${where} must be a positive integer, got ${JSON.stringify(v)}.`)
  } else if (v > max) {
    warnings.push(`${where} is ${v}, above the app ceiling of ${max}; ${max} will be used.`)
  }
}

function checkPaths(v: unknown, where: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${where} must be an array of path patterns.`)
    return []
  }
  v.forEach((p, i) => checkPattern(p, `${where}[${i}]`, errors, true))
  return v as string[]
}

/**
 * Parse and validate a raw policy.json value. `scriptHashes` maps each file actually in
 * scripts/ to its sha256 hex; `hosts` are the stored SSH hosts, used only for warnings.
 */
export function parsePolicy(
  raw: unknown,
  scriptHashes: Record<string, string>,
  hosts: OpsHostRef[]
): PolicyParseOk | PolicyParseErr {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isObject(raw)) return { ok: false, errors: ['policy.json must be a JSON object.'] }

  checkKeys(raw, TOP_KEYS, 'policy.json', errors)

  if (raw.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(raw.version)}.`)
  if (typeof raw.strict !== 'boolean') errors.push(`strict must be true or false, got ${JSON.stringify(raw.strict)}.`)
  const strict = raw.strict

  if (
    raw.platform !== undefined &&
    (typeof raw.platform !== 'string' ||
      !raw.platform.trim() ||
      raw.platform.length > OPS_MAX_PLATFORM_LENGTH ||
      /[\r\n]/.test(raw.platform))
  ) {
    errors.push(
      `platform must be the product's name on one line, up to ${OPS_MAX_PLATFORM_LENGTH} characters, got ${JSON.stringify(raw.platform)}.`
    )
  }

  // Host groups.
  const groups = new Set<string>()
  if (!isObject(raw.hosts)) {
    errors.push('hosts must be an object mapping group names to arrays of host names or globs.')
  } else {
    const names = Object.keys(raw.hosts)
    if (names.length === 0) errors.push('hosts must define at least one host group.')
    for (const name of names) {
      const entries = raw.hosts[name]
      if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string' || e.length === 0)) {
        errors.push(`hosts.${name} must be an array of non-empty strings.`)
        continue
      }
      groups.add(name)
      const matched = hosts.some((h) => (entries as string[]).some((e) => entryMatches(e, h)))
      if (!matched) warnings.push(`Host group "${name}" matches none of the stored hosts.`)
    }
  }

  // Allow rules.
  if (!Array.isArray(raw.allow)) {
    errors.push('allow must be an array (it may be empty).')
  } else {
    raw.allow.forEach((rule, i) => {
      const where = `allow[${i}]`
      if (!isObject(rule)) {
        errors.push(`${where} must be an object.`)
        return
      }
      checkKeys(rule, ALLOW_KEYS, where, errors)
      checkRuleHosts(rule.hosts, groups, where, errors)
      checkPattern(rule.cmd, `${where}.cmd`, errors)
      checkClass(rule.class, where, errors)
      checkApproval(rule.approval, where, errors)
      checkMutateAuto(rule.class, rule.approval, strict, where, errors)
      if (rule.title !== undefined && typeof rule.title !== 'string') {
        errors.push(`${where}.title must be a string when present.`)
      }
      if (rule.title === undefined || rule.title === '') {
        warnings.push(`${where} has no title; the client report will fall back to a generic step name.`)
      }
    })
  }

  // Scripts.
  if (!Array.isArray(raw.scripts)) {
    errors.push('scripts must be an array (it may be empty).')
  } else {
    const seen = new Set<string>()
    raw.scripts.forEach((rule, i) => {
      const where = `scripts[${i}]`
      if (!isObject(rule)) {
        errors.push(`${where} must be an object.`)
        return
      }
      checkKeys(rule, SCRIPT_KEYS, where, errors)
      if (checkScriptName(rule.name, where, errors)) {
        const name = rule.name as string
        if (seen.has(name)) errors.push(`${where}.name "${name}" is listed more than once.`)
        seen.add(name)
        const pinned = rule.sha256
        if (typeof pinned !== 'string' || !SHA256_RE.test(pinned)) {
          errors.push(`${where}.sha256 must be 64 lower-case hex characters, got ${JSON.stringify(pinned)}.`)
        } else {
          const actual = Object.prototype.hasOwnProperty.call(scriptHashes, name)
            ? scriptHashes[name].toLowerCase()
            : undefined
          if (actual === undefined) {
            errors.push(`${where} "${name}" is pinned to ${pinned} but the file is not found in scripts/.`)
          } else if (actual !== pinned) {
            errors.push(`${where} "${name}" has changed: policy pins ${pinned}, file hashes to ${actual}.`)
          }
        }
      }
      checkRuleHosts(rule.hosts, groups, where, errors)
      checkClass(rule.class, where, errors)
      checkApproval(rule.approval, where, errors)
      checkMutateAuto(rule.class, rule.approval, strict, where, errors)
      if (rule.title !== undefined && typeof rule.title !== 'string') {
        errors.push(`${where}.title must be a string when present.`)
      }
      if (rule.title === undefined || rule.title === '') {
        warnings.push(`${where} has no title; the client report will fall back to a generic step name.`)
      }
      if (rule.args !== undefined) {
        if (!isObject(rule.args)) {
          errors.push(`${where}.args must be an object.`)
        } else {
          checkKeys(rule.args, ARGS_KEYS, `${where}.args`, errors)
          const max = rule.args.max
          if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > OPS_MAX_SCRIPT_ARGS)) {
            errors.push(`${where}.args.max must be an integer from 0 to ${OPS_MAX_SCRIPT_ARGS}, got ${JSON.stringify(max)}.`)
          }
          if (typeof max === 'number' && max > 0 && rule.args.pattern === undefined) {
            errors.push(`${where}.args.pattern is required when args.max is above 0.`)
          } else if (rule.args.pattern !== undefined) {
            checkPattern(rule.args.pattern, `${where}.args.pattern`, errors)
          }
        }
      }
    })
  }

  // read / write.
  if (raw.read !== undefined) {
    if (!isObject(raw.read)) {
      errors.push('read must be an object.')
    } else {
      checkKeys(raw.read, READ_KEYS, 'read', errors)
      checkPaths(raw.read.paths, 'read.paths', errors)
      checkLimit(raw.read.maxBytes, OPS_MAX_READ_BYTES, 'read.maxBytes', errors, warnings)
    }
  }
  if (raw.write !== undefined) {
    if (!isObject(raw.write)) {
      errors.push('write must be an object.')
    } else {
      checkKeys(raw.write, WRITE_KEYS, 'write', errors)
      checkPaths(raw.write.paths, 'write.paths', errors)
      checkApproval(raw.write.approval, 'write', errors)
      // A write is always a mutation, so the same strict-only rule applies to auto.
      checkMutateAuto('mutate', raw.write.approval, strict, 'write', errors)
      if (raw.write.backup !== undefined && typeof raw.write.backup !== 'boolean') {
        errors.push('write.backup must be true or false when present.')
      }
    }
  }

  // limits.
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) {
      errors.push('limits must be an object.')
    } else {
      checkKeys(raw.limits, LIMIT_KEYS, 'limits', errors)
      checkLimit(raw.limits.timeoutMs, OPS_MAX_TIMEOUT_MS, 'limits.timeoutMs', errors, warnings)
      checkLimit(raw.limits.maxOutputBytes, OPS_MAX_OUTPUT_BYTES, 'limits.maxOutputBytes', errors, warnings)
      checkLimit(raw.limits.concurrentPerHost, OPS_MAX_CONCURRENT_PER_HOST, 'limits.concurrentPerHost', errors, warnings)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // Rebuild from validated fields only.
  const hostsOut: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw.hosts as Record<string, string[]>)) hostsOut[k] = [...v]

  const allow: OpsAllowRule[] = (raw.allow as Record<string, unknown>[]).map((r) => ({
    hosts: [...(r.hosts as string[])],
    cmd: r.cmd as string,
    class: r.class as OpsClass,
    ...(r.approval !== undefined ? { approval: r.approval as OpsApproval } : {}),
    ...(r.title !== undefined ? { title: r.title as string } : {})
  }))

  const scripts: OpsScriptRule[] = (raw.scripts as Record<string, unknown>[]).map((r) => {
    const args = r.args as { max?: number; pattern?: string } | undefined
    return {
      name: r.name as string,
      sha256: r.sha256 as string,
      hosts: [...(r.hosts as string[])],
      class: r.class as OpsClass,
      ...(r.approval !== undefined ? { approval: r.approval as OpsApproval } : {}),
      ...(r.title !== undefined ? { title: r.title as string } : {}),
      ...(args !== undefined
        ? {
            args: {
              ...(args.max !== undefined ? { max: args.max } : {}),
              ...(args.pattern !== undefined ? { pattern: args.pattern } : {})
            }
          }
        : {})
    }
  })

  const policy: OpsPolicy = { version: 1, strict: strict as boolean, hosts: hostsOut, allow, scripts }
  if (typeof raw.platform === 'string') policy.platform = raw.platform.trim()
  if (isObject(raw.read)) {
    policy.read = { paths: [...(raw.read.paths as string[])] }
    if (raw.read.maxBytes !== undefined) policy.read.maxBytes = raw.read.maxBytes as number
  }
  if (isObject(raw.write)) {
    policy.write = { paths: [...(raw.write.paths as string[])] }
    if (raw.write.approval !== undefined) policy.write.approval = raw.write.approval as OpsApproval
    if (raw.write.backup !== undefined) policy.write.backup = raw.write.backup as boolean
  }
  if (isObject(raw.limits)) {
    const l = raw.limits
    policy.limits = {}
    if (l.timeoutMs !== undefined) policy.limits.timeoutMs = l.timeoutMs as number
    if (l.maxOutputBytes !== undefined) policy.limits.maxOutputBytes = l.maxOutputBytes as number
    if (l.concurrentPerHost !== undefined) policy.limits.concurrentPerHost = l.concurrentPerHost as number
  }

  return { ok: true, policy, warnings }
}

// ─── Summary (INTERVENTIONS_PLAN §3: "What this runbook allows") ────────────────

export interface OpsPolicySummary {
  /** Read rules that run without asking. */
  autoReads: number
  /** Rules, scripts and the write block that ask the operator each time. */
  asks: number
  /** Rules and scripts that change a host, plus the write block when there is one. */
  mutates: number
  scripts: number
  /** The read block's path patterns, as written. */
  readPaths: string[]
  /** The first paragraph of RUNBOOK.md after its title, whitespace collapsed. */
  guidelinesHead: string
}

export const GUIDELINES_HEAD_MAX = 300

/**
 * The first paragraph of a RUNBOOK.md after its H1: the first run of non-blank lines that
 * are not headings, on one line, at most GUIDELINES_HEAD_MAX characters (cut at a word,
 * with an ellipsis). Empty when the file has no such paragraph.
 */
export function guidelinesHead(markdown: string): string {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
  const h1 = lines.findIndex((l) => /^#\s/.test(l))
  const para: string[] = []
  for (const l of lines.slice(h1 + 1)) {
    if (l.trim() === '' || /^#{1,6}\s/.test(l)) {
      if (para.length) break
      continue
    }
    para.push(l.trim())
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= GUIDELINES_HEAD_MAX) return text
  const cut = text.slice(0, GUIDELINES_HEAD_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > GUIDELINES_HEAD_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

/** What a runbook allows, in counts the start screen can say in plain words. */
export function summarizePolicy(policy: OpsPolicy, guidelines: string): OpsPolicySummary {
  const writeAsks = policy.write ? effectiveApproval({ class: 'mutate', approval: policy.write.approval }) === 'ask' : false
  return {
    autoReads: policy.allow.filter((r) => r.class === 'read' && effectiveApproval(r) === 'auto').length,
    asks:
      policy.allow.filter((r) => effectiveApproval(r) === 'ask').length +
      policy.scripts.filter((r) => effectiveApproval(r) === 'ask').length +
      (writeAsks ? 1 : 0),
    mutates:
      policy.allow.filter((r) => r.class === 'mutate').length +
      policy.scripts.filter((r) => r.class === 'mutate').length +
      (policy.write ? 1 : 0),
    scripts: policy.scripts.length,
    readPaths: [...(policy.read?.paths ?? [])],
    guidelinesHead: guidelinesHead(guidelines)
  }
}
