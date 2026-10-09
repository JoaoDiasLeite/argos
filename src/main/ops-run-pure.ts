/**
 * The decisions of an ops run that need no Electron, SDK or disk (docs/OPS_AGENT_PLAN.md
 * §3.4, §5): MCP input validation, the approval context the modal shows, the
 * `call.finished` event, and the text the model reads back. ops-session.ts and
 * ops-tools.ts wire these to the gate and the executor.
 */
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import type { LoadedRunbook } from './ops-runbook-pure'
import type { ExecResult, OpsListResult, OpsReadResult, OpsWriteResult } from './ops-exec-pure'
import { canonicalCommand, classify, parseSimpleCommand } from './ops-gate-pure'
import { hostDeniedReason, outOfScopeReason, scopeVerdict } from './ops-scope-pure'
import type { OpsAuditEvent, OpsGateResult, OpsHostRef, OpsPolicy, OpsScope, OpsToolInput, OpsToolName } from './ops-types'
import type { TFunction } from '../shared/i18n'

// ─── Hosts ────────────────────────────────────────────────────────────────────────

export interface OpsHosts {
  byId: Map<string, { host: OpsHostRef; groups: string[] }>
}

/** The runbook's hosts by stored-host id: the only ids the model can name. */
export function opsHostsFor(runbook: LoadedRunbook): OpsHosts {
  const byId = new Map<string, { host: OpsHostRef; groups: string[] }>()
  for (const h of runbook.hosts) byId.set(h.host.id, { host: h.host, groups: [...h.groups] })
  return { byId }
}

// ─── Approval context ─────────────────────────────────────────────────────────────

/** Mirrors the renderer's ApprovalOpsContext (types.ts); kept apart so main never imports renderer code. */
export interface ApprovalOpsContext {
  hostName: string
  hostAddress: string
  /** 'host': the first touch of a host in an open intervention; hostName/hostAddress are
   *  the host asked for. */
  tool: OpsToolName | 'plan' | 'host'
  /** For tool 'plan': the steps the model proposes for this run, each classified at plan time. */
  planSteps?: OpsPlanStep[]
  /** For tool 'plan': the totals the review sheet leads with. */
  planSummary?: OpsPlanSummary
  class: 'read' | 'mutate'
  reason: string
  rule?: string
  title?: string
  argv?: string[]
  path?: string
  scriptSha256?: string
  queuedBehind: number
  runbook: string
}

/** Mirrors the renderer's OpsPlanStep (types.ts). */
export interface OpsPlanStep {
  /** The model's words, or the matched rule's title when one rule covers the whole step. */
  title: string
  /** Stored host name, when the step names a host the runbook knows. */
  hostName?: string
  /** Canonical command lines, or `script <name> args…`, as the gate would run them. */
  commands: string[]
  verdict: 'runs' | 'asks' | 'denied' | 'unknown'
  class?: 'read' | 'mutate'
  reason?: string
  sudo?: boolean
}

export interface OpsPlanSummary {
  runs: number
  asks: number
  denied: number
  mutates: number
}

export function toApprovalContext(
  gate: OpsGateResult,
  host: OpsHostRef,
  hostAddress: string,
  tool: OpsToolName,
  runbookName: string,
  queuedBehind: number
): ApprovalOpsContext {
  return {
    hostName: host.name,
    hostAddress,
    tool,
    class: gate.class,
    reason: gate.reason,
    ...(gate.rule !== undefined ? { rule: gate.rule } : {}),
    ...(gate.title !== undefined ? { title: gate.title } : {}),
    ...(gate.argv ? { argv: [...gate.argv] } : {}),
    ...(gate.path !== undefined ? { path: gate.path } : {}),
    ...(gate.scriptSha256 !== undefined ? { scriptSha256: gate.scriptSha256 } : {}),
    queuedBehind,
    runbook: runbookName
  }
}

// ─── Plan (plan §1.7) ─────────────────────────────────────────────────────────────

/** The SDK name of the plan tool. Not an OpsToolName: the gate never sees it. */
export const OPS_PLAN_TOOL = 'mcp__ops__propose_plan'
export const OPS_PLAN_MAX_STEPS = 40

/** Why every other ops call is refused until a plan is approved. */
export const PLAN_FIRST_REASON = 'propose a plan first (mcp__ops__propose_plan)'
export const PLAN_REJECTED_MESSAGE = 'Plan rejected by the operator. Revise it or stop.'
export const PLAN_APPROVED_TEXT = 'Plan approved. Proceed step by step.'

/** Most commands one plan step may carry in `commands`. */
export const OPS_PLAN_MAX_STEP_COMMANDS = 8

/** One plan step as the model sent it, normalised. `commands` are the model's raw lines (`cmd` first). */
export interface PlanStepInput {
  title: string
  hostId?: string
  commands: string[]
  script?: { name: string; args: string[] }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** One object step, checked like the schema's object branch; a string is the refusal. */
function planStepObject(x: Record<string, unknown>): PlanStepInput | string {
  if (!nonEmpty(x.title)) return 'every step object needs a non-empty title'
  if (x.hostId !== undefined && typeof x.hostId !== 'string') return "a step's hostId must be a string"
  if (x.cmd !== undefined && !nonEmpty(x.cmd)) return "a step's cmd must be a non-empty string"
  if (x.script !== undefined && !nonEmpty(x.script)) return "a step's script must be a non-empty string"
  if (x.args !== undefined && !isStringArray(x.args)) return "a step's args must be an array of strings"
  if (x.commands !== undefined) {
    if (!Array.isArray(x.commands) || !x.commands.every(nonEmpty)) return "a step's commands must be an array of non-empty strings"
    if (x.commands.length > OPS_PLAN_MAX_STEP_COMMANDS) return `a step may list at most ${OPS_PLAN_MAX_STEP_COMMANDS} commands`
  }
  const commands = [...(x.cmd !== undefined ? [x.cmd as string] : []), ...((x.commands as string[] | undefined) ?? [])]
  return {
    title: x.title,
    ...(x.hostId !== undefined ? { hostId: x.hostId as string } : {}),
    commands,
    ...(x.script !== undefined ? { script: { name: x.script as string, args: [...((x.args as string[] | undefined) ?? [])] } } : {})
  }
}

/**
 * The steps of a propose_plan call, checked the way its zod schema checks them:
 * canUseTool sees the model's raw JSON before the schema does. A string step is a title
 * with no command; an object step carries the host and the exact command(s) or script.
 */
export function planStepsFrom(input: Record<string, unknown>): PlanStepInput[] | { error: string } {
  const steps = input && typeof input === 'object' ? input.steps : undefined
  if (!Array.isArray(steps)) return { error: 'steps must be an array' }
  if (steps.length === 0) return { error: 'steps must list at least one step' }
  if (steps.length > OPS_PLAN_MAX_STEPS) return { error: `steps may list at most ${OPS_PLAN_MAX_STEPS} entries` }
  const out: PlanStepInput[] = []
  for (const x of steps) {
    if (typeof x === 'string' && x.length > 0) {
      out.push({ title: x, commands: [] })
      continue
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: 'every step must be a non-empty string or a step object' }
    const step = planStepObject(x as Record<string, unknown>)
    if (typeof step === 'string') return { error: step }
    out.push(step)
  }
  return out
}

export interface ClassifiedPlan {
  steps: OpsPlanStep[]
  summary: OpsPlanSummary
}

type PlanVerdict = OpsPlanStep['verdict']
const VERDICT_RANK: Record<PlanVerdict, number> = { unknown: 0, runs: 1, asks: 2, denied: 3 }
const verdictOf = (g: OpsGateResult): PlanVerdict => (g.decision === 'allow' ? 'runs' : g.decision === 'ask' ? 'asks' : 'denied')

/** A command line in its canonical spelling; one that does not parse is shown as sent (it cannot run). */
function canonicalLine(cmd: string): string {
  const parsed = parseSimpleCommand(cmd)
  return parsed.ok ? canonicalCommand(parsed.argv) : cmd
}

const scriptLine = (name: string, args: string[]): string => `script ${canonicalCommand([name, ...args])}`

type HostEntry = { host: OpsHostRef; groups: string[] }

/** By id, as the gate resolves it; a stored name is accepted too, for the preview only. */
function planHost(hostsById: Map<string, HostEntry>, hostId: string | undefined): HostEntry | undefined {
  if (hostId === undefined || hostId === '') return undefined
  const byId = hostsById.get(hostId)
  if (byId) return byId
  for (const e of hostsById.values()) if (e.host.name === hostId) return e
  return undefined
}

/**
 * What the gate would decide for each step of a plan, before anything runs: a preview
 * for the review sheet. Nothing here executes or logs, and the real gate still runs on
 * every later call, so a step approved here can still be refused there. `t` words the
 * reasons this function writes itself (a step with no host or no command); the gate's
 * reasons stay as the gate gives them.
 */
export function classifyPlanSteps(
  steps: PlanStepInput[],
  policy: OpsPolicy,
  hostsById: Map<string, HostEntry>,
  t: TFunction,
  /** The intervention's scope: a step on a host it excludes is shown as denied. */
  scope?: { scope: OpsScope; approvedHosts?: ReadonlySet<string>; deniedHosts?: ReadonlySet<string> }
): ClassifiedPlan {
  const summary: OpsPlanSummary = { runs: 0, asks: 0, denied: 0, mutates: 0 }
  const out: OpsPlanStep[] = []
  for (const step of steps) {
    const entry = planHost(hostsById, step.hostId)
    const hasWork = step.commands.length > 0 || step.script !== undefined
    // Only a refusal shows here: a host still to be asked about asks on its first call.
    if (entry && scope && scopeVerdict(scope.scope, entry.host.id, scope.approvedHosts ?? new Set(), scope.deniedHosts) === 'deny') {
      const commands = [...step.commands.map(canonicalLine), ...(step.script ? [scriptLine(step.script.name, step.script.args)] : [])]
      const reason = scope.scope.kind === 'host' ? outOfScopeReason(entry.host.name) : hostDeniedReason(entry.host.name)
      out.push({ title: step.title, hostName: entry.host.name, commands, verdict: 'denied', reason })
      summary.denied++
      continue
    }
    if (!entry || !hasWork) {
      const commands = [...step.commands.map(canonicalLine), ...(step.script ? [scriptLine(step.script.name, step.script.args)] : [])]
      const reason = !hasWork
        ? t('runbook.plan.noCommand')
        : step.hostId === undefined || step.hostId === ''
          ? t('runbook.plan.noHost')
          : t('runbook.plan.unknownHost', { host: step.hostId })
      out.push({ title: step.title, ...(entry ? { hostName: entry.host.name } : {}), commands, verdict: 'unknown', reason })
      continue
    }
    const { host, groups } = entry
    const results: { gate: OpsGateResult; line: string }[] = []
    for (const cmd of step.commands) {
      const gate = classify({ tool: 'run', hostId: host.id, cmd }, policy, host, groups)
      results.push({ gate, line: gate.argv ? canonicalCommand(gate.argv) : canonicalLine(cmd) })
    }
    if (step.script) {
      const { name, args } = step.script
      const gate = classify({ tool: 'script', hostId: host.id, name, args: [...args] }, policy, host, groups)
      results.push({ gate, line: scriptLine(name, args) })
    }
    let verdict: PlanVerdict = 'unknown'
    for (const r of results) {
      const v = verdictOf(r.gate)
      if (VERDICT_RANK[v] > VERDICT_RANK[verdict]) verdict = v
    }
    const first = results[0].gate
    const firstNotRuns = results.find((r) => r.gate.decision !== 'allow')
    const reason = firstNotRuns ? firstNotRuns.gate.reason : first.title ?? first.reason
    // The rule's title is the client-facing wording, but only when that one rule covers
    // every command of the step. A script run with arguments keeps the model's title: the
    // script's title is the same for every argument, so a plan that runs one script step by
    // step would read as the same line over and over.
    const oneRule =
      !step.script?.args.length && first.rule !== undefined && results.every((r) => r.gate.rule === first.rule) ? first : undefined
    const mutate = results.some((r) => r.gate.class === 'mutate')
    const sudo = results.some((r, i) => i < step.commands.length && r.gate.argv?.[0] === 'sudo')
    out.push({
      title: oneRule?.title ?? step.title,
      hostName: host.name,
      commands: results.map((r) => r.line),
      verdict,
      class: mutate ? 'mutate' : 'read',
      reason,
      ...(sudo ? { sudo: true } : {})
    })
    if (verdict === 'runs') summary.runs++
    else if (verdict === 'asks') summary.asks++
    else if (verdict === 'denied') summary.denied++
    if (mutate) summary.mutates++
  }
  return { steps: out, summary }
}

/** The ledger's text for an approved plan: one line per step, with its canonical commands. */
export function planTextFor(steps: OpsPlanStep[]): string {
  return steps.map((s, i) => `${i + 1}. ${s.title}${s.commands.length ? ` — ${s.commands.join(' · ')}` : ''}`).join('\n')
}

/** The modal's context for a plan: no host, the runbook's name in its place. */
export function planApprovalContext(plan: ClassifiedPlan, runbookName: string): ApprovalOpsContext {
  return {
    hostName: runbookName,
    hostAddress: '',
    tool: 'plan',
    planSteps: plan.steps.map((s) => ({ ...s, commands: [...s.commands] })),
    planSummary: { ...plan.summary },
    class: 'mutate',
    reason: 'plan approval',
    queuedBehind: 0,
    runbook: runbookName
  }
}

// ─── MCP input ────────────────────────────────────────────────────────────────────

export const OPS_TOOL_NAMES: readonly OpsToolName[] = ['run', 'script', 'read', 'list', 'write']

/** `mcp__ops__run` → `run`; anything else → null. */
export function opsToolFromSdkName(toolName: string): OpsToolName | null {
  const m = /^mcp__ops__([a-z]+)$/.exec(toolName)
  if (!m) return null
  return (OPS_TOOL_NAMES as readonly string[]).includes(m[1]) ? (m[1] as OpsToolName) : null
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Turn the raw arguments of an MCP call into the gate's input. The zod schema already
 * shapes them inside the handler, but canUseTool sees the model's raw JSON first, so the
 * types are checked here too and anything off is a refusal, not a coercion. A missing
 * `args` on `script` is `[]`, matching the schema's default, so canUseTool and the
 * handler build the same input (and the same call key).
 */
export function mcpInputToOpsInput(toolName: OpsToolName, args: Record<string, unknown>): OpsToolInput | { error: string } {
  if (!args || typeof args !== 'object') return { error: 'tool input is not an object' }
  const { hostId } = args
  if (typeof hostId !== 'string' || hostId === '') return { error: 'hostId must be a non-empty string' }
  switch (toolName) {
    case 'run':
      if (typeof args.cmd !== 'string') return { error: 'cmd must be a string' }
      return { tool: 'run', hostId, cmd: args.cmd }
    case 'script': {
      if (typeof args.name !== 'string' || args.name === '') return { error: 'name must be a non-empty string' }
      const a = args.args === undefined ? [] : args.args
      if (!isStringArray(a)) return { error: 'args must be an array of strings' }
      return { tool: 'script', hostId, name: args.name, args: [...a] }
    }
    case 'read':
    case 'list':
      if (typeof args.path !== 'string') return { error: 'path must be a string' }
      return { tool: toolName, hostId, path: args.path }
    case 'write':
      if (typeof args.path !== 'string') return { error: 'path must be a string' }
      if (typeof args.content !== 'string') return { error: 'content must be a string' }
      return { tool: 'write', hostId, path: args.path, content: args.content }
    default:
      return { error: `unknown ops tool '${String(toolName)}'` }
  }
}

/**
 * A stable key for one call, from the normalised input with a fixed field order. The SDK
 * gives canUseTool no tool-use id, so this is how the handler finds the callId that
 * canUseTool logged for the same call.
 */
export function callKey(input: OpsToolInput): string {
  switch (input.tool) {
    case 'run':
      return JSON.stringify(['run', input.hostId, input.cmd])
    case 'script':
      return JSON.stringify(['script', input.hostId, input.name, input.args])
    case 'read':
    case 'list':
      return JSON.stringify([input.tool, input.hostId, input.path])
    case 'write':
      return JSON.stringify(['write', input.hostId, input.path, input.content])
  }
}

export interface CallBook {
  /** Allocate the next callId (`<runId>-<n>`) and park it under key. */
  open(key: string): string
  /** The oldest callId parked under key, removed; undefined when canUseTool never saw it. */
  take(key: string): string | undefined
  /** A callId for a call that never went through canUseTool. */
  fresh(): string
}

/**
 * FIFO per key: the model may send the same command twice in one turn, and the two
 * handler invocations must each take one of the two callIds, in order.
 */
export function makeCallBook(runId: string): CallBook {
  let n = 0
  const parked = new Map<string, string[]>()
  const fresh = (): string => `${runId}-${++n}`
  return {
    open(key) {
      const id = fresh()
      const list = parked.get(key) ?? []
      list.push(id)
      parked.set(key, list)
      return id
    },
    take(key) {
      const list = parked.get(key)
      if (!list || list.length === 0) return undefined
      const id = list.shift() as string
      if (list.length === 0) parked.delete(key)
      return id
    },
    fresh
  }
}

// ─── Local tools ─────────────────────────────────────────────────────────────────

/** True when p (absolute, or relative to dir) is dir itself or inside it. */
export function insideDir(dir: string, p: string, pathMod: typeof path = path): boolean {
  const abs = pathMod.resolve(dir, p)
  const rel = pathMod.relative(pathMod.resolve(dir), abs)
  if (rel === '') return true
  return !rel.startsWith('..') && !pathMod.isAbsolute(rel)
}

const LOCAL_READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/**
 * Read/Grep/Glob may look only inside the runbook folder (plan §1.3). Every path-like
 * field they take is checked; one outside, or a `..` in a Glob pattern, is a refusal.
 * Any other local tool is refused outright: the profile already removed them, this is
 * the second lock.
 */
export function localToolVerdict(toolName: string, input: Record<string, unknown>, runbookDir: string, pathMod: typeof path = path): { allow: true } | { allow: false; reason: string } {
  if (!LOCAL_READ_TOOLS.has(toolName)) return { allow: false, reason: `${toolName} is not available in an ops chat.` }
  for (const field of ['file_path', 'path', 'notebook_path']) {
    const v = input[field]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string') return { allow: false, reason: `${toolName}.${field} must be a string.` }
    if (!insideDir(runbookDir, v, pathMod)) return { allow: false, reason: `${toolName} may only look inside the runbook folder.` }
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    const pat = input.pattern
    if (pat.split(/[\\/]/).includes('..')) return { allow: false, reason: 'Glob patterns may not climb out of the runbook folder.' }
    if (pathMod.isAbsolute(pat) && !insideDir(runbookDir, pat.replace(/[*?[{].*$/, ''), pathMod)) {
      return { allow: false, reason: 'Glob may only look inside the runbook folder.' }
    }
  }
  return { allow: true }
}

// ─── Results ──────────────────────────────────────────────────────────────────────

export const OPS_HEAD_BYTES = 4096

/** The first `max` bytes of s as UTF-8, without a half character at the cut. */
export function headBytes(s: string, max = OPS_HEAD_BYTES): string {
  const buf = Buffer.from(s, 'utf-8')
  if (buf.length <= max) return s
  return buf.subarray(0, max).toString('utf-8').replace(/�$/, '')
}

/**
 * The ledger's `call.finished` for an exec. Hashes are over the captured text the model
 * also saw (the real stream may be longer; its byte count is recorded beside). An
 * executor error has no field of its own in the event, so it is appended to the stderr
 * head where the reports already look.
 */
export function finishedEventFrom(result: ExecResult, runId: string, callId: string): Extract<OpsAuditEvent, { kind: 'call.finished' }> {
  const errNote = !result.ok && result.error ? `${result.stderr ? '\n' : ''}[${result.error}]` : ''
  return {
    kind: 'call.finished',
    runId,
    callId,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutSha256: sha256Hex(result.stdout),
    stderrSha256: sha256Hex(result.stderr),
    stdoutHead: headBytes(result.stdout),
    stderrHead: headBytes(result.stderr + errNote)
  }
}

/** A `call.finished` for a call refused or failed before anything ran on the host. */
export function refusedFinishedEvent(runId: string, callId: string, error: string, durationMs = 0): Extract<OpsAuditEvent, { kind: 'call.finished' }> {
  return {
    kind: 'call.finished',
    runId,
    callId,
    exitCode: null,
    timedOut: false,
    durationMs,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: sha256Hex(''),
    stderrSha256: sha256Hex(''),
    stdoutHead: '',
    stderrHead: headBytes(error)
  }
}

/**
 * What the model reads back from run/script: the exit code first (the preamble makes it
 * report non-zero ones verbatim), then both streams as the executor capped them.
 */
export function toolResultText(result: ExecResult): string {
  const lines: string[] = []
  lines.push(result.exitCode === null ? 'exit code: none' : `exit code ${result.exitCode}`)
  if (result.signal) lines.push(`signal ${result.signal}`)
  if (result.timedOut) lines.push('[timed out]')
  if (!result.ok && result.error) lines.push(`[error: ${result.error}]`)
  lines.push('stdout:', result.stdout === '' ? '(empty)' : result.stdout)
  lines.push('stderr:', result.stderr === '' ? '(empty)' : result.stderr)
  if (!result.ok && isConnectionFailure(result.error)) lines.push(HOST_UNREACHABLE_NOTE)
  return lines.join('\n')
}

/**
 * Socket and handshake failures from ssh2/net: the host never ran anything, or the link
 * dropped mid-command. Told apart from a command's own failure because the right answer
 * is different: not the next step, not a retry, but stop and tell the operator.
 */
const CONNECTION_FAILURE =
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|EPIPE)\b|Timed out while waiting for handshake|connection closed before|Not connected|No response from server/i

export function isConnectionFailure(error: string | undefined): boolean {
  return typeof error === 'string' && CONNECTION_FAILURE.test(error)
}

export const HOST_UNREACHABLE_NOTE =
  '[The connection to the host failed: the server is down or unreachable (or the VPN is not connected). ' +
  'Stop now: run nothing else on this host and do not retry. Tell the operator the server appears to be ' +
  'unreachable; if the call was a step that changes the host, say its outcome is unknown.]'

/** `<what> failed: <error>`, with the unreachable note when the error is a connection failure. */
function fileFailureText(what: string, error: string): string {
  return isConnectionFailure(error) ? `${what} failed: ${error}\n${HOST_UNREACHABLE_NOTE}` : `${what} failed: ${error}`
}

/** A tool call is an error to the model when it did not run, timed out, or exited non-zero. */
export function execIsError(result: ExecResult): boolean {
  return !result.ok || result.timedOut || result.exitCode !== 0
}

export function readResultText(r: OpsReadResult): { text: string; isError: boolean } {
  if (!r.ok) return { text: fileFailureText('read', r.error), isError: true }
  if ('tooLarge' in r) return { text: 'read refused: the file is larger than the runbook allows.', isError: true }
  if ('binary' in r) return { text: 'read refused: the file is binary.', isError: true }
  return { text: r.content, isError: false }
}

export function listResultText(r: OpsListResult): { text: string; isError: boolean } {
  if (!r.ok) return { text: fileFailureText('list', r.error), isError: true }
  if (r.entries.length === 0) return { text: '(empty directory)', isError: false }
  const rows = r.entries.map((e) => `${e.type === 'directory' ? 'd' : '-'} ${String(e.size).padStart(10)} ${e.name}`)
  return { text: rows.join('\n'), isError: false }
}

export function writeResultText(r: OpsWriteResult, p: string): { text: string; isError: boolean } {
  if (!r.ok) return { text: fileFailureText('write', r.error), isError: true }
  const backup = r.backupPath ? ` Backup of the previous file: ${r.backupPath}.` : ''
  return { text: `Wrote ${p} (sha256 ${r.afterSha256}).${backup}`, isError: false }
}

/**
 * sudo on these boxes usually wants a password. Recognised so the run handler can ask
 * the operator for it once per host (plan §4, "Session-level sudo"), or, with no way to
 * ask, tell the model plainly to stop rather than to retry.
 */
export function sudoNeedsPassword(argv: string[] | undefined, result: ExecResult): boolean {
  return !!argv && argv[0] === 'sudo' && result.exitCode === 1 && /password/i.test(result.stderr)
}

export const SUDO_PASSWORD_NOTE =
  '[sudo asked for a password. Argos cannot supply sudo passwords yet. Stop and tell the operator; do not retry.]'

export const SUDO_DECLINED_NOTE = 'Operator declined to supply the sudo password.'

// The gate's sudo flag lists (ops-gate-pure.ts), split by what the stdin form keeps.
const SUDO_BARE_KEEP = new Set(['H'])
const SUDO_BARE_DROP = new Set(['n', 'S'])
const SUDO_VALUED = new Set(['u', 'g', 'p'])
const SUDO_LONG_BARE_KEEP = new Set(['--set-home'])
const SUDO_LONG_BARE_DROP = new Set(['--non-interactive', '--stdin'])
const SUDO_LONG_VALUED = new Set(['--user', '--group', '--prompt'])

/**
 * argv rewritten to read the password from stdin: `sudo -S -p '' <kept flags> <command>`.
 * `-n` goes (it forbids the prompt this needs), and so do the model's own `-S` and
 * `-p`, which the leading pair replaces. `-u user`, `-g group` and `-H` stay, one flag
 * per word, so `-nu root` becomes `-u root`. The first word that is not a flag the gate
 * accepts starts the command, which is kept verbatim. argv[0] must be `sudo`; anything
 * else comes back unchanged.
 */
export function withSudoStdin(argv: string[]): string[] {
  if (argv[0] !== 'sudo') return [...argv]
  const kept: string[] = []
  let i = 1
  scan: while (i < argv.length) {
    const w = argv[i]
    if (w === '--') {
      i++
      break
    }
    if (!w.startsWith('-') || w === '-') break
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq === -1 ? w : w.slice(0, eq)
      if (eq === -1 && SUDO_LONG_BARE_DROP.has(name)) {
        i++
      } else if (eq === -1 && SUDO_LONG_BARE_KEEP.has(name)) {
        kept.push(w)
        i++
      } else if (SUDO_LONG_VALUED.has(name)) {
        const words = eq !== -1 ? [w] : argv.slice(i, i + 2)
        if (name !== '--prompt') kept.push(...words)
        i += words.length
      } else break
      continue
    }
    // A short cluster: bare letters, optionally ending in one valued letter.
    const flags: string[] = []
    let consumedNext = false
    for (let j = 1; j < w.length; j++) {
      const f = w[j]
      if (SUDO_BARE_DROP.has(f)) continue
      if (SUDO_BARE_KEEP.has(f)) {
        flags.push(`-${f}`)
        continue
      }
      if (SUDO_VALUED.has(f)) {
        let value: string | undefined
        if (j + 1 < w.length) value = w.slice(j + 1)
        else if (i + 1 < argv.length) {
          value = argv[i + 1]
          consumedNext = true
        }
        if (value !== undefined && f !== 'p') flags.push(`-${f}`, value)
        break
      }
      break scan
    }
    kept.push(...flags)
    i += consumedNext ? 2 : 1
  }
  return ['sudo', '-S', '-p', '', ...kept, ...argv.slice(i)]
}

// ─── Skipped plan steps ───────────────────────────────────────────────────────────

/** Why a call that matches a step the operator skipped is refused. */
export const STEP_SKIPPED_REASON = 'step skipped by the operator'

/**
 * The operator's skips: whole-number indices into the plan's steps, sorted and without
 * repeats; anything else is dropped, not an error. Every skipped step counts, a
 * title-only one included ("restart the service" with no command yet): it is taken out
 * of the plan the model is told was approved and recorded in `plan.approved`, or the
 * model would run it anyway. Only the gate's refusal is per command (skippedCommandLines).
 */
export function planSkips(plan: ClassifiedPlan, raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const ok = raw.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < plan.steps.length)
  return [...new Set(ok)].sort((a, b) => a - b)
}

/**
 * The canonical command lines of the skipped steps, as the plan preview spelled them: what
 * the gate refuses later (callPlanLine). A title-only step adds nothing here; there is no
 * command to match, so honouring that skip rests on the model being told (planApprovedText)
 * and on the operator approving whatever it does instead.
 */
export function skippedCommandLines(plan: ClassifiedPlan, skips: number[]): Set<string> {
  return new Set(skips.flatMap((i) => plan.steps[i]?.commands ?? []))
}

/** The plan input without the skipped steps: what the model is told was approved. */
export function planInputWithoutSkips(input: Record<string, unknown>, skips: number[]): Record<string, unknown> {
  if (skips.length === 0 || !Array.isArray(input.steps)) return input
  const skip = new Set(skips)
  return { ...input, steps: (input.steps as unknown[]).filter((_, i) => !skip.has(i)) }
}

/**
 * What the model reads after an approval with skips. Steps are named by title and
 * command, never by number: on the first real run the model had numbered its own prose
 * "1, 2a, 2b, 2c" and could not tell which of three readings "steps 1, 2" meant, so it
 * stopped and asked. Both lists are given, so there is nothing left to infer.
 */
export function planApprovedText(steps: OpsPlanStep[], skips: number[]): string {
  if (skips.length === 0 || steps.length === 0) return PLAN_APPROVED_TEXT
  const skipped = new Set(skips)
  const line = (s: OpsPlanStep): string =>
    s.commands.length ? `- ${s.title}: ${s.commands.join(' ; ')}` : `- ${s.title}`
  const out: string[] = ['Plan approved with changes by the operator.', '', 'Skipped, do NOT run these:']
  steps.forEach((s, i) => {
    if (skipped.has(i)) out.push(line(s))
  })
  out.push('', 'Approved, run these in order, one command per call:')
  steps.forEach((s, i) => {
    if (!skipped.has(i)) out.push(line(s))
  })
  out.push('', 'Proceed step by step. If you need a skipped step after all, propose a new plan.')
  return out.join('\n')
}

/** A run or script call as a plan step line, so it can be matched against skipped steps. */
export function callPlanLine(input: OpsToolInput, gate: OpsGateResult): string | undefined {
  if (input.tool === 'run') return gate.argv ? canonicalCommand(gate.argv) : canonicalLine(input.cmd)
  if (input.tool === 'script') return scriptLine(input.name, input.args)
  return undefined
}
