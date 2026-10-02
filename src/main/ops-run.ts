/**
 * One ops run (docs/OPS_AGENT_PLAN.md §1, §4, §5): load the runbook, check every host is
 * reachable, log `run.start`, and hand the engine three things: the system-prompt
 * append, the in-process `ops` MCP server, and the canUseTool that runs the gate and
 * logs its decision BEFORE anything executes. `finishOpsRun` logs `run.end`.
 *
 * No Electron here: loading the runbook and re-reading scripts touch the stored-host
 * list (ssh.ts → electron), so index.ts injects them. The test drives a whole run
 * against the fake backend and a ledger in a temp folder.
 */
import { randomUUID } from 'crypto'
import { classify } from './ops-gate-pure'
import {
  buildOpsSystemAppend,
  callKey,
  localToolVerdict,
  makeCallBook,
  mcpInputToOpsInput,
  OPS_PLAN_TOOL,
  OPS_PREAMBLE,
  opsHostsFor,
  opsToolFromSdkName,
  PLAN_FIRST_REASON,
  PLAN_REJECTED_MESSAGE,
  planApprovalContext,
  planStepsFrom,
  toApprovalContext,
  type ApprovalOpsContext,
  type CallBook
} from './ops-run-pure'
import { createOpsMcpServer, createOpsToolHandlers, type OpsToolHandlers } from './ops-tools'
import type { LoadedRunbook, LoadRunbookResult } from './ops-runbook-pure'
import type { OpsExecutor } from './ops-exec-pure'
import type { OpsLedger } from './ops-audit'
import type { OpsAuditEvent, OpsAuditLine } from './ops-types'
import type { CanUseTool, CanUseToolResult } from './providers/types'

export type { ApprovalOpsContext } from './ops-run-pure'

/** How long each host gets to answer before the run refuses to start (plan §4). */
export const OPS_REACH_TIMEOUT_MS = 15_000

export type ReadScriptFn = (
  runbook: LoadedRunbook,
  name: string
) => Promise<{ ok: true; content: Buffer; sha256: string } | { ok: false; error: string }>

export type OpsAskFn = (req: {
  tool: string
  input: Record<string, unknown>
  ops: ApprovalOpsContext
}) => Promise<{ allow: boolean; stop?: boolean }>

/** Ask the operator for a secret (the sudo password of a host). null = declined or stopped. */
export type OpsAskSecretFn = (req: { hostId: string; hostName: string; prompt: string }) => Promise<string | null>

export interface OpsRunContext {
  runId: string
  appSessionId: string
  runbook: LoadedRunbook
  executor: OpsExecutor
  ledger: OpsLedger
  hosts: ReturnType<typeof opsHostsFor>
  abort: AbortController
  /**
   * Per-host sudo passwords for this run, in memory only (plan §4, "Session-level
   * sudo"): asked once per host through `askSecret`, used on stdin with `sudo -S`, and
   * cleared by finishOpsRun. Never logged.
   */
  sudoPasswords: Map<string, string>
  /** The masked prompt for a sudo password. Absent → a sudo that wants one tells the model to stop. */
  askSecret?: OpsAskSecretFn
  /**
   * Set once the operator approves a `propose_plan` (plan §1.7). Until then every other
   * ops call is refused; a rejected later plan clears it again.
   */
  planApproved: boolean
  /** The last approved plan's steps, one per line. */
  planText?: string
  /** canUseTool parks each decided call's id here; the tool handler takes it. */
  calls: CallBook
  readScript: ReadScriptFn
  /** Append to the ledger and tell the live timeline. Never throws. */
  log: (event: OpsAuditEvent) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Set once run.end is written, so a result and a later catch do not both log it. */
  ended: boolean
}

export interface PrepareOpsRunOptions {
  appSessionId: string
  runbookPath: string
  model: string
  account?: string
  ledger: OpsLedger
  executor: OpsExecutor
  abort: AbortController
  loadRunbook: (dir: string) => Promise<LoadRunbookResult>
  readScript: ReadScriptFn
  /** The approval pipeline for `ask` decisions. Absent → every ask is a deny. */
  ask?: OpsAskFn
  /** The masked prompt for a host's sudo password. Absent → never asked. */
  askSecret?: OpsAskSecretFn
  /** `user@host:port` for the modal header. Default: the host's address. */
  hostAddress?: (hostId: string) => string
  /** Every ledger line written for this run, for the live `ops:event` timeline. */
  onEvent?: (line: OpsAuditLine) => void
  /** Tests replace the SDK server (which needs the ESM SDK) with the bare handlers. */
  buildServer?: (ctx: OpsRunContext, handlers: OpsToolHandlers) => Promise<unknown>
  runId?: string
}

export type PrepareOpsRunResult =
  | {
      ok: true
      ctx: OpsRunContext
      systemAppend: string
      mcpServer: unknown
      canUseTool: CanUseTool
      /** The same functions the MCP server calls; tests drive them directly. */
      tools: OpsToolHandlers
    }
  | { ok: false; error: string }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function prepareOpsRun(opts: PrepareOpsRunOptions): Promise<PrepareOpsRunResult> {
  try {
    const loaded = await opts.loadRunbook(opts.runbookPath)
    if (!loaded.ok) {
      const list = loaded.errors?.length ? `\n${loaded.errors.map((e) => `- ${e}`).join('\n')}` : ''
      return { ok: false, error: `${loaded.error}${list}` }
    }
    const runbook = loaded.runbook
    if (runbook.hosts.length === 0) {
      return { ok: false, error: `No stored SSH host belongs to any host group of runbook ${runbook.ref.name}.` }
    }

    // Reachability before anything is logged or the model is called. Once, no retry: on a
    // client VPN a retry loop is a lockout waiting to happen.
    const reach = await Promise.all(
      runbook.hosts.map(async (h) => {
        try {
          return { h, r: await opts.executor.backend.reachable(h.host.id, OPS_REACH_TIMEOUT_MS) }
        } catch (e) {
          return { h, r: { ok: false, message: message(e) } }
        }
      })
    )
    const down = reach.find((x) => !x.r.ok)
    if (down) return { ok: false, error: `${down.h.host.name} is unreachable. Is the VPN connected? ${down.r.message}` }

    const runId = opts.runId ?? randomUUID()
    const log: OpsRunContext['log'] = async (event) => {
      try {
        const r = await opts.ledger.append(event)
        if (!r.ok) return r
        if (opts.onEvent) {
          try {
            opts.onEvent(JSON.parse(r.raw) as OpsAuditLine)
          } catch {
            // The timeline is a view; the ledger line is already on disk.
          }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: message(e) }
      }
    }

    const started = await log({
      kind: 'run.start',
      runId,
      appSessionId: opts.appSessionId,
      runbook: runbook.ref,
      hosts: runbook.hosts.map((h) => h.host),
      model: opts.model,
      ...(opts.account ? { account: opts.account } : {})
    })
    if (!started.ok) return { ok: false, error: `The ops ledger is unavailable, so the run did not start: ${started.error}` }

    const ctx: OpsRunContext = {
      runId,
      appSessionId: opts.appSessionId,
      runbook,
      executor: opts.executor,
      ledger: opts.ledger,
      hosts: opsHostsFor(runbook),
      abort: opts.abort,
      sudoPasswords: new Map(),
      ...(opts.askSecret ? { askSecret: opts.askSecret } : {}),
      planApproved: false,
      calls: makeCallBook(runId),
      readScript: opts.readScript,
      log,
      ended: false
    }

    const tools = createOpsToolHandlers(ctx)
    const mcpServer = await (opts.buildServer ?? ((c, h) => createOpsMcpServer(c, h)))(ctx, tools)
    const canUseTool = makeOpsCanUseTool(ctx, opts)

    return {
      ok: true,
      ctx,
      systemAppend: buildOpsSystemAppend(OPS_PREAMBLE, runbook.guidelines, runbook.ref.name),
      mcpServer,
      canUseTool,
      tools
    }
  } catch (e) {
    return { ok: false, error: `Could not start the ops run: ${message(e)}` }
  }
}

function makeOpsCanUseTool(ctx: OpsRunContext, opts: PrepareOpsRunOptions): CanUseTool {
  const { runId } = ctx
  const deny = (msg: string) => ({ behavior: 'deny' as const, message: msg })

  return async (toolName, input) => {
    try {
      if (toolName === OPS_PLAN_TOOL) return await decidePlan(ctx, opts, toolName, input)

      const tool = opsToolFromSdkName(toolName)
      if (!tool) {
        const v = localToolVerdict(toolName, input, ctx.runbook.ref.path)
        return v.allow ? { behavior: 'allow' as const, updatedInput: input } : deny(v.reason)
      }

      const parsed = mcpInputToOpsInput(tool, input)
      if ('error' in parsed) {
        // Still logged in full: a malformed call is also something the model tried.
        const callId = ctx.calls.fresh()
        const hostId = typeof input?.hostId === 'string' ? input.hostId : ''
        await ctx.log({
          kind: 'call.decided',
          runId,
          callId,
          tool,
          hostId,
          host: ctx.hosts.byId.get(hostId)?.host.name ?? hostId,
          rawInput: input,
          class: 'mutate',
          decision: 'deny',
          reason: parsed.error
        })
        return deny(`Refused: ${parsed.error}.`)
      }

      const entry = ctx.hosts.byId.get(parsed.hostId)
      const gate = classify(parsed, ctx.runbook.policy, entry?.host ?? null, entry?.groups ?? [])

      if (!ctx.planApproved) {
        // Plan first (§1.7): nothing reaches a host before the operator has seen the
        // whole plan. Logged like any deny, with what the gate would have run.
        await ctx.log({
          kind: 'call.decided',
          runId,
          callId: ctx.calls.fresh(),
          tool,
          hostId: parsed.hostId,
          host: entry?.host.name ?? parsed.hostId,
          rawInput: input,
          ...(gate.argv ? { argv: gate.argv } : {}),
          ...(gate.path ? { path: gate.path } : {}),
          class: gate.class,
          decision: 'deny',
          reason: PLAN_FIRST_REASON
        })
        return deny(`Refused: ${PLAN_FIRST_REASON}.`)
      }

      const key = callKey(parsed)
      const callId = ctx.calls.open(key)

      // Logged before anything runs, so a crash mid-call still leaves the intent on disk.
      const decided = await ctx.log({
        kind: 'call.decided',
        runId,
        callId,
        tool,
        hostId: parsed.hostId,
        host: entry?.host.name ?? parsed.hostId,
        rawInput: input,
        ...(gate.argv ? { argv: gate.argv } : {}),
        ...(gate.path ? { path: gate.path } : {}),
        class: gate.class,
        decision: gate.decision,
        reason: gate.reason,
        ...(gate.rule !== undefined ? { rule: gate.rule } : {}),
        ...(gate.title !== undefined ? { title: gate.title } : {}),
        ...(gate.scriptSha256 !== undefined ? { scriptSha256: gate.scriptSha256 } : {}),
        ...(gate.denylist !== undefined ? { denylist: gate.denylist } : {})
      })
      if (!decided.ok) {
        ctx.calls.take(key)
        return deny('Refused: the ops ledger is unavailable, so no call can run.')
      }

      if (gate.decision === 'deny' || !entry) {
        ctx.calls.take(key)
        return deny(`Refused by the runbook policy: ${gate.reason}.`)
      }
      if (gate.decision === 'allow') return { behavior: 'allow' as const, updatedInput: input }

      // ask
      await ctx.log({ kind: 'call.asked', runId, callId })
      let answer: { allow: boolean; stop?: boolean } = { allow: false }
      if (opts.ask && !ctx.abort.signal.aborted) {
        const address = opts.hostAddress ? opts.hostAddress(parsed.hostId) : entry.host.host
        answer = await opts.ask({
          tool: toolName,
          input,
          ops: toApprovalContext(gate, entry.host, address, tool, ctx.runbook.ref.name, ctx.executor.queuedBehind(parsed.hostId))
        })
      }
      // The modal may not edit an ops call: the gate decided on this exact input, so
      // whatever runs is this input, and updatedInput is never taken.
      if (answer.allow && !ctx.abort.signal.aborted) {
        await ctx.log({ kind: 'call.answered', runId, callId, answer: 'allow' })
        return { behavior: 'allow' as const, updatedInput: input }
      }
      ctx.calls.take(key)
      if (answer.stop) {
        await ctx.log({ kind: 'call.answered', runId, callId, answer: 'stop' })
        ctx.abort.abort()
        return deny('Denied by the operator, who stopped the run.')
      }
      await ctx.log({ kind: 'call.answered', runId, callId, answer: 'deny' })
      return deny('Denied by the operator.')
    } catch (e) {
      return deny(`Refused: the ops gate failed: ${message(e)}`)
    }
  }
}

/**
 * `mcp__ops__propose_plan` (plan §1.7): the whole plan goes to the operator through the
 * same approval pipeline as an `ask`. Approved → `plan.approved` and the other ops tools
 * open; rejected → `plan.rejected`, and they stay (or become) closed until a plan is
 * approved. A second proposal goes through the same path.
 */
async function decidePlan(
  ctx: OpsRunContext,
  opts: PrepareOpsRunOptions,
  toolName: string,
  input: Record<string, unknown>
): Promise<CanUseToolResult> {
  const deny = (msg: string) => ({ behavior: 'deny' as const, message: msg })
  const steps = planStepsFrom(input)
  if (!Array.isArray(steps)) return deny(`Refused: ${steps.error}.`)

  let answer: { allow: boolean; stop?: boolean } = { allow: false }
  if (opts.ask && !ctx.abort.signal.aborted) {
    answer = await opts.ask({ tool: toolName, input, ops: planApprovalContext(steps, ctx.runbook.ref.name) })
  }
  if (answer.allow && !ctx.abort.signal.aborted) {
    const logged = await ctx.log({ kind: 'plan.approved', runId: ctx.runId, by: 'user' })
    if (!logged.ok) return deny('Refused: the ops ledger is unavailable, so the plan cannot be approved.')
    ctx.planApproved = true
    ctx.planText = steps.join('\n')
    return { behavior: 'allow' as const, updatedInput: input }
  }
  // A rejected revision does not leave the earlier plan standing: the operator has just
  // said no to where the run was going.
  ctx.planApproved = false
  await ctx.log({ kind: 'plan.rejected', runId: ctx.runId, by: 'user' })
  if (answer.stop) {
    ctx.abort.abort()
    return deny('Denied by the operator, who stopped the run.')
  }
  return deny(PLAN_REJECTED_MESSAGE)
}

/** Log `run.end` once. Safe to call from both the result and the error path. */
export async function finishOpsRun(
  ctx: OpsRunContext,
  result: {
    ok: boolean
    costUsd: number
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    aborted?: boolean
    error?: string
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  // The run's sudo passwords live no longer than the run.
  ctx.sudoPasswords.clear()
  if (ctx.ended) return { ok: true }
  ctx.ended = true
  return ctx.log({
    kind: 'run.end',
    runId: ctx.runId,
    ok: result.ok,
    costUsd: result.costUsd,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.aborted ? { aborted: true } : {}),
    ...(result.error ? { error: result.error } : {})
  })
}
