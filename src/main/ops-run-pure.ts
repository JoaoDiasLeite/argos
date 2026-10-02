/**
 * The decisions of an ops run that need no Electron, SDK or disk (docs/OPS_AGENT_PLAN.md
 * §3.4, §5, §7): the fixed preamble, the system-prompt append, MCP input validation, the
 * approval context the modal shows, the `call.finished` event, and the text the model
 * reads back. ops-run.ts and ops-tools.ts wire these to the SDK and the executor.
 */
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import type { LoadedRunbook } from './ops-runbook-pure'
import type { ExecResult, OpsListResult, OpsReadResult, OpsWriteResult } from './ops-exec-pure'
import type { OpsAuditEvent, OpsGateResult, OpsHostRef, OpsToolInput, OpsToolName } from './ops-types'

// ─── System prompt ────────────────────────────────────────────────────────────────

/**
 * Plan §7, fixed. It is the same on every ops run so a test can assert it is there; the
 * runbook's own RUNBOOK.md follows it and may add rules, never remove these.
 */
export const OPS_PREAMBLE = [
  'You are operating servers for the operator through an Argos ops run.',
  '',
  '- Plan first. Before any other mcp__ops__* call, call mcp__ops__propose_plan once with the full list of steps you intend to run, one per entry, naming the host and the command or script. Nothing runs until the operator approves the plan.',
  '- Do not run a step that was not in the approved plan. If the work needs a step the plan did not list, call mcp__ops__propose_plan again with the revised full list and wait for its approval.',
  '- You operate servers through the mcp__ops__* tools only. You have no local shell, and the local machine is out of reach.',
  '- Follow RUNBOOK.md literally. If a step is not covered by it, say so and stop. Do not improvise an equivalent command.',
  '- Before any mutate call, state what it changes and how it is reverted.',
  '- Never chain commands. One simple command per call: no ;, &&, ||, pipes, redirections or subshells. Use a script when the runbook provides one.',
  '- Report every non-zero exit code verbatim before deciding what to do next.',
  '- A failed verification step (a read whose output the runbook says must match) ends the run. Do not proceed to a mutate step past a failed check, even if asked.',
  '- Write to the operator in formal European Portuguese, never Brazilian Portuguese, and never use em dashes or en dashes. Commands and output stay in code blocks, exactly as returned.'
].join('\n')

/**
 * What goes into `systemPrompt.append`: the preamble, then the runbook verbatim between
 * markers, so the model can tell the fixed rules from the runbook's own.
 */
export function buildOpsSystemAppend(preamble: string, guidelines: string, runbookName: string): string {
  const body = guidelines.trim() === '' ? '(RUNBOOK.md is empty.)' : guidelines.trimEnd()
  return `${preamble}\n\n<runbook name="${runbookName}">\n${body}\n</runbook>\n`
}

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
  tool: OpsToolName | 'plan'
  /** For tool 'plan': the steps the model proposes for this run. */
  planSteps?: string[]
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

/**
 * The steps of a propose_plan call, checked the way its zod schema checks them:
 * canUseTool sees the model's raw JSON before the schema does.
 */
export function planStepsFrom(input: Record<string, unknown>): string[] | { error: string } {
  const steps = input && typeof input === 'object' ? input.steps : undefined
  if (!Array.isArray(steps)) return { error: 'steps must be an array of strings' }
  if (steps.length === 0) return { error: 'steps must list at least one step' }
  if (steps.length > OPS_PLAN_MAX_STEPS) return { error: `steps may list at most ${OPS_PLAN_MAX_STEPS} entries` }
  if (!steps.every((x) => typeof x === 'string' && x.length > 0)) return { error: 'every step must be a non-empty string' }
  return [...(steps as string[])]
}

/** The modal's context for a plan: no host, the runbook's name in its place. */
export function planApprovalContext(steps: string[], runbookName: string): ApprovalOpsContext {
  return {
    hostName: runbookName,
    hostAddress: '',
    tool: 'plan',
    planSteps: [...steps],
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
  return lines.join('\n')
}

/** A tool call is an error to the model when it did not run, timed out, or exited non-zero. */
export function execIsError(result: ExecResult): boolean {
  return !result.ok || result.timedOut || result.exitCode !== 0
}

export function readResultText(r: OpsReadResult): { text: string; isError: boolean } {
  if (!r.ok) return { text: `read failed: ${r.error}`, isError: true }
  if ('tooLarge' in r) return { text: 'read refused: the file is larger than the runbook allows.', isError: true }
  if ('binary' in r) return { text: 'read refused: the file is binary.', isError: true }
  return { text: r.content, isError: false }
}

export function listResultText(r: OpsListResult): { text: string; isError: boolean } {
  if (!r.ok) return { text: `list failed: ${r.error}`, isError: true }
  if (r.entries.length === 0) return { text: '(empty directory)', isError: false }
  const rows = r.entries.map((e) => `${e.type === 'directory' ? 'd' : '-'} ${String(e.size).padStart(10)} ${e.name}`)
  return { text: rows.join('\n'), isError: false }
}

export function writeResultText(r: OpsWriteResult, p: string): { text: string; isError: boolean } {
  if (!r.ok) return { text: `write failed: ${r.error}`, isError: true }
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
