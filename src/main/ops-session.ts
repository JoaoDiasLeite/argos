/**
 * One ops session (docs/OPS_AGENT_PLAN.md §1, §4, §5, §9 Phase 5): a terminal CLI reaches
 * it through ops-bridge.ts (a stdio relay over a local socket). One code path for runbook
 * load, reachability, `run.start`, the gate-and-log decision, the plan-first rule, the
 * sudo password, the approval and `run.end`.
 *
 * - `canUseTool` is the decision: it runs the gate and logs it BEFORE anything executes.
 *   The bridge calls it through `callOpsTool`.
 * - `tools` are the handlers that execute an allowed call and log its start and end.
 *
 * No Electron here: loading the runbook and re-reading scripts touch the stored-host
 * list (ssh.ts → electron), so index.ts injects them. The tests drive whole runs against
 * the fake backend and a ledger in a temp folder.
 */
import { randomUUID } from 'crypto'
import { classify } from './ops-gate-pure'
import {
  callKey,
  localToolVerdict,
  makeCallBook,
  mcpInputToOpsInput,
  OPS_PLAN_TOOL,
  opsHostsFor,
  opsToolFromSdkName,
  PLAN_FIRST_REASON,
  PLAN_REJECTED_MESSAGE,
  classifyPlanSteps,
  planApprovalContext,
  planStepsFrom,
  planTextFor,
  callPlanLine,
  planInputWithoutSkips,
  planSkips,
  skippedCommandLines,
  STEP_SKIPPED_REASON,
  toApprovalContext,
  type ApprovalOpsContext,
  type CallBook
} from './ops-run-pure'
import { createOpsToolHandlers, opsToolHosts, type OpsToolHandlers } from './ops-tools'
import { OPS_BRIDGE_TOOLS, type OpsBridgeTool } from './ops-tool-defs-pure'
import type { LoadedRunbook, LoadRunbookResult } from './ops-runbook-pure'
import type { OpsExecutor } from './ops-exec-pure'
import type { OpsLedger } from './ops-audit'
import { hostApprovalContext, hostDeniedReason, outOfScopeReason, scopeVerdict } from './ops-scope-pure'
import type { OpsAuditEvent, OpsAuditLine, OpsHostRef, OpsLoggedPlanStep, OpsScope, OpsToolName } from './ops-types'

export type { ApprovalOpsContext } from './ops-run-pure'

/** The gate's verdict on one tool call. */
export type CanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<CanUseToolResult>

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
}) => Promise<{ allow: boolean; stop?: boolean; skipSteps?: number[] }>

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
  /**
   * The steps the operator skipped when approving the last plan (0-based), and their
   * canonical command lines: a run or script matching one is refused. Replaced by the
   * next approved plan.
   */
  skippedSteps: number[]
  skippedCommands: Set<string>
  /** canUseTool parks each decided call's id here; the tool handler takes it. */
  calls: CallBook
  readScript: ReadScriptFn
  /** Append to the ledger and tell the live timeline. Never throws. */
  log: (event: OpsAuditEvent) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Set once run.end is written, so a result and a later catch do not both log it. */
  ended: boolean
  /** The intervention's scope (INTERVENTIONS_PLAN §2). Absent: every runbook host, no host prompt. */
  scope?: OpsScope
  /** Open scope: hosts the operator allowed or refused for this run, by id. */
  approvedHosts: Set<string>
  deniedHosts: Set<string>
  /** Open scope: the host prompt in flight per host, so two calls on a new host ask once. */
  hostAsks: Map<string, Promise<'allow' | 'deny' | 'stop' | 'none'>>
}

export interface OpsSessionOptions {
  /** The terminal's id: what `ops:event` and the ledger key on. */
  appSessionId: string
  runbookPath: string
  /** Which hosts this intervention may touch. Absent: every runbook host, as before interventions. */
  scope?: OpsScope
  /** The operator's description of the intervention, and its ticket and client; logged on run.start. */
  task?: string
  ticket?: string
  client?: string
  /** The CLI that runs the session (the ledger's `run.start.model`). */
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
  runId?: string
}

export interface OpsSession {
  ctx: OpsRunContext
  /** The gate's decision for one tool call, by its SDK name (`mcp__ops__run`, …). Logs before anything runs. */
  canUseTool: CanUseTool
  /** The functions that execute an allowed call; callOpsTool runs these after an allow. */
  tools: OpsToolHandlers
}

export type OpenOpsSessionResult = ({ ok: true } & OpsSession) | { ok: false; error: string }

/** The client-facing step title of a file call whose gate gave none (pt-PT, like the report). */
export const DEFAULT_FILE_TITLES: Partial<Record<OpsToolName, string>> = {
  read: 'Leitura de um ficheiro de configuração',
  list: 'Listagem de uma pasta',
  write: 'Alteração de um ficheiro de configuração'
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Load the runbook, check every host answers, and log `run.start`. A refusal comes back
 * as `{ ok: false }`; a host that does not answer is refused before anything is logged.
 */
export async function openOpsSession(opts: OpsSessionOptions): Promise<OpenOpsSessionResult> {
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
    // A locked intervention reaches and records only its host; the others stay known to
    // the gate so a call naming one is refused with the scope's reason, not as unknown.
    const scope = opts.scope
    const inReach = scope?.kind === 'host' ? runbook.hosts.filter((h) => h.host.id === scope.hostId) : runbook.hosts
    if (scope?.kind === 'host' && inReach.length === 0) {
      return { ok: false, error: `This host is not in any host group of runbook ${runbook.ref.name}; add it to a group in policy.json.` }
    }

    // Reachability before anything is logged or the model is called. Once, no retry: on a
    // client VPN a retry loop is a lockout waiting to happen.
    const reach = await Promise.all(
      inReach.map(async (h) => {
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
      hosts: inReach.map((h) => h.host),
      model: opts.model,
      ...(opts.account ? { account: opts.account } : {}),
      ...(opts.task?.trim() ? { task: opts.task.trim() } : {}),
      ...(opts.ticket?.trim() ? { ticket: opts.ticket.trim() } : {}),
      ...(opts.client?.trim() ? { client: opts.client.trim() } : {}),
      ...(scope ? { scope } : {})
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
      skippedSteps: [],
      skippedCommands: new Set(),
      calls: makeCallBook(runId),
      readScript: opts.readScript,
      log,
      ended: false,
      ...(scope ? { scope } : {}),
      approvedHosts: new Set(),
      deniedHosts: new Set(),
      hostAsks: new Map()
    }

    return { ok: true, ctx, canUseTool: makeOpsCanUseTool(ctx, opts), tools: createOpsToolHandlers(ctx) }
  } catch (e) {
    return { ok: false, error: `Could not start the ops run: ${message(e)}` }
  }
}

/**
 * One tool call from the terminal bridge: canUseTool's decision, then, when it allows,
 * the handler on the same input. `tool` is the bare name (`run`, `propose_plan`, …).
 */
export async function callOpsTool(
  session: OpsSession,
  tool: string,
  args: Record<string, unknown> | undefined
): Promise<{ text: string; isError: boolean }> {
  if (!(OPS_BRIDGE_TOOLS as readonly string[]).includes(tool)) return { text: `Refused: unknown ops tool ${tool}.`, isError: true }
  const name = tool as OpsBridgeTool
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  try {
    const verdict = await session.canUseTool(`mcp__ops__${name}`, input)
    if (verdict.behavior !== 'allow') return { text: verdict.message, isError: true }
    // The plan tool's allow carries the plan minus the skipped steps; the others pass the input through.
    const r = await session.tools[name](verdict.updatedInput)
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true }
  } catch (e) {
    return { text: `The ops tool failed: ${message(e)}`, isError: true }
  }
}

/**
 * The session as the terminal bridge sees it: what `hello` tells the relay (enough to
 * describe the tools) and the call pipeline.
 */
export function bridgeSessionFor(session: OpsSession): {
  hello(): { runbook: string; hosts: { id: string; name: string; groups: string[] }[]; tools: string[] }
  call(tool: string, args: Record<string, unknown> | undefined): Promise<{ text: string; isError: boolean }>
} {
  return {
    hello: () => ({ runbook: session.ctx.runbook.ref.name, hosts: opsToolHosts(session.ctx), tools: [...OPS_BRIDGE_TOOLS] }),
    call: (tool, args) => callOpsTool(session, tool, args)
  }
}

function makeOpsCanUseTool(ctx: OpsRunContext, opts: OpsSessionOptions): CanUseTool {
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
      // A locked scope is absolute, so it comes before the gate: another host is refused
      // whatever the policy says. A host outside the policy is left to the gate.
      if (entry && ctx.scope?.kind === 'host' && scopeVerdict(ctx.scope, parsed.hostId, ctx.approvedHosts) === 'deny') {
        const reason = outOfScopeReason(entry.host.name)
        await ctx.log({
          kind: 'call.decided',
          runId,
          callId: ctx.calls.fresh(),
          tool,
          hostId: parsed.hostId,
          host: entry.host.name,
          rawInput: input,
          class: 'mutate',
          decision: 'deny',
          reason
        })
        return deny(`Refused: ${reason}.`)
      }
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

      // A step the operator skipped stays skipped, whatever the rules would allow.
      const line = callPlanLine(parsed, gate)
      if (line !== undefined && ctx.skippedCommands.has(line)) {
        await ctx.log({
          kind: 'call.decided',
          runId,
          callId: ctx.calls.fresh(),
          tool,
          hostId: parsed.hostId,
          host: entry?.host.name ?? parsed.hostId,
          rawInput: input,
          ...(gate.argv ? { argv: gate.argv } : {}),
          class: gate.class,
          decision: 'deny',
          reason: STEP_SKIPPED_REASON
        })
        return deny(`Refused: ${STEP_SKIPPED_REASON}.`)
      }

      // Open scope: the first call on a host asks the operator once for the run. Not for a
      // call the gate refuses anyway, and not before the plan is approved (above).
      if (entry && ctx.scope?.kind === 'open' && gate.decision !== 'deny') {
        const verdict = await hostVerdict(ctx, opts, entry.host, parsed.hostId)
        if (verdict !== 'allow') {
          const reason = verdict === 'none' ? 'no operator is available to allow this host' : hostDeniedReason(entry.host.name)
          await ctx.log({
            kind: 'call.decided',
            runId,
            callId: ctx.calls.fresh(),
            tool,
            hostId: parsed.hostId,
            host: entry.host.name,
            rawInput: input,
            ...(gate.argv ? { argv: gate.argv } : {}),
            ...(gate.path ? { path: gate.path } : {}),
            class: gate.class,
            decision: 'deny',
            reason
          })
          if (verdict === 'stop') {
            ctx.abort.abort()
            return deny('Denied by the operator, who stopped the run.')
          }
          return deny(`Refused: ${reason}.`)
        }
      }

      const key = callKey(parsed)
      const callId = ctx.calls.open(key)
      // read/list/write rules carry no title, so the client report would have nothing but
      // a path to show; these say what the step is without naming it.
      const title = gate.title ?? DEFAULT_FILE_TITLES[tool]

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
        ...(title !== undefined ? { title } : {}),
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
 * Open scope: whether this run may touch a host, asking the operator the first time and
 * logging the answer (`host.approved` / `host.denied`). A refusal holds for the rest of
 * the run; a stop is a refusal that also ends the run. 'none': nobody to ask (no ask hook,
 * or the run is already stopping), which refuses this call without recording an answer.
 * Calls that arrive while the prompt is open wait for the same answer.
 */
async function hostVerdict(
  ctx: OpsRunContext,
  opts: OpsSessionOptions,
  host: OpsHostRef,
  hostId: string
): Promise<'allow' | 'deny' | 'stop' | 'none'> {
  if (!ctx.scope) return 'allow'
  const v = scopeVerdict(ctx.scope, hostId, ctx.approvedHosts, ctx.deniedHosts)
  if (v !== 'ask') return v
  const ask = opts.ask
  if (!ask || ctx.abort.signal.aborted) return 'none'
  let pending = ctx.hostAsks.get(hostId)
  if (!pending) {
    pending = (async () => {
      const address = opts.hostAddress ? opts.hostAddress(hostId) : host.host
      const answer = await ask({
        tool: 'mcp__ops__host',
        input: { hostId },
        ops: hostApprovalContext(host, address, ctx.runbook.ref.name)
      })
      // An answer that lands after a stop is not an approval.
      if (ctx.abort.signal.aborted && !answer.stop) return 'none' as const
      const allowed = answer.allow
      ;(allowed ? ctx.approvedHosts : ctx.deniedHosts).add(hostId)
      await ctx.log({ kind: allowed ? 'host.approved' : 'host.denied', runId: ctx.runId, hostId, host: host.name, by: 'user' })
      return allowed ? ('allow' as const) : answer.stop ? ('stop' as const) : ('deny' as const)
    })().finally(() => ctx.hostAsks.delete(hostId))
    ctx.hostAsks.set(hostId, pending)
  }
  return pending
}

/**
 * `mcp__ops__propose_plan` (plan §1.7): the whole plan goes to the operator through the
 * same approval pipeline as an `ask`. Approved → `plan.approved` and the other ops tools
 * open; rejected → `plan.rejected`, and they stay (or become) closed until a plan is
 * approved. A second proposal goes through the same path.
 */
async function decidePlan(
  ctx: OpsRunContext,
  opts: OpsSessionOptions,
  toolName: string,
  input: Record<string, unknown>
): Promise<CanUseToolResult> {
  const deny = (msg: string) => ({ behavior: 'deny' as const, message: msg })
  const steps = planStepsFrom(input)
  if (!Array.isArray(steps)) return deny(`Refused: ${steps.error}.`)
  // A preview of what the gate would say for each step: nothing runs or is logged here,
  // and every later call is still classified on its own.
  const plan = classifyPlanSteps(
    steps,
    ctx.runbook.policy,
    ctx.hosts.byId,
    ctx.scope ? { scope: ctx.scope, approvedHosts: ctx.approvedHosts, deniedHosts: ctx.deniedHosts } : undefined
  )

  let answer: { allow: boolean; stop?: boolean; skipSteps?: number[] } = { allow: false }
  if (opts.ask && !ctx.abort.signal.aborted) {
    answer = await opts.ask({ tool: toolName, input, ops: planApprovalContext(plan, ctx.runbook.ref.name) })
  }
  // The steps as the operator saw them go into the ledger with the decision, so the report
  // can show the plan (a terminal run has none at run.start).
  const planText = planTextFor(plan.steps)
  const logged: OpsLoggedPlanStep[] = plan.steps.map((s) => ({
    title: s.title,
    commands: [...s.commands],
    verdict: s.verdict,
    ...(s.hostName !== undefined ? { hostName: s.hostName } : {})
  }))
  if (answer.allow && !ctx.abort.signal.aborted) {
    const skips = planSkips(plan, answer.skipSteps)
    const ok = await ctx.log({
      kind: 'plan.approved',
      runId: ctx.runId,
      by: 'user',
      planText,
      steps: logged,
      ...(skips.length ? { skippedSteps: skips } : {})
    })
    if (!ok.ok) return deny('Refused: the ops ledger is unavailable, so the plan cannot be approved.')
    ctx.planApproved = true
    ctx.planText = planText
    // A new plan, new decisions: the earlier plan's skips go with it.
    ctx.skippedSteps = skips
    ctx.skippedCommands = skippedCommandLines(plan, skips)
    return { behavior: 'allow' as const, updatedInput: planInputWithoutSkips(input, skips) }
  }
  // A rejected revision does not leave the earlier plan standing: the operator has just
  // said no to where the run was going.
  ctx.planApproved = false
  await ctx.log({ kind: 'plan.rejected', runId: ctx.runId, by: 'user', planText, steps: logged })
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
