/**
 * One ops run of the SDK chat (docs/OPS_AGENT_PLAN.md §1, §4, §5): open the ops session
 * (ops-session.ts: runbook, reachability, `run.start`, the gate's canUseTool) and hand
 * the engine the three things it needs: the system-prompt append, the in-process `ops`
 * MCP server, and that canUseTool. `finishOpsRun` logs `run.end`.
 *
 * The terminal front end opens the same session through ops-bridge.ts instead, so the
 * gate, the ledger and the approvals are one code path whatever runs the model.
 *
 * No Electron here; index.ts injects what touches it. The test drives a whole run
 * against the fake backend and a ledger in a temp folder.
 */
import { buildOpsSystemAppend, OPS_PREAMBLE } from './ops-run-pure'
import { createOpsMcpServer, type OpsToolHandlers } from './ops-tools'
import { openOpsSession, type OpsRunContext, type OpsSessionOptions } from './ops-session'
import type { CanUseTool } from './providers/types'

export type { ApprovalOpsContext } from './ops-run-pure'
export {
  finishOpsRun,
  OPS_REACH_TIMEOUT_MS,
  type OpsAskFn,
  type OpsAskSecretFn,
  type OpsRunContext,
  type ReadScriptFn
} from './ops-session'

export interface PrepareOpsRunOptions extends OpsSessionOptions {
  /** Tests replace the SDK server (which needs the ESM SDK) with the bare handlers. */
  buildServer?: (ctx: OpsRunContext, handlers: OpsToolHandlers) => Promise<unknown>
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
  const { buildServer, ...sessionOpts } = opts
  const session = await openOpsSession(sessionOpts)
  if (!session.ok) return session
  const { ctx, canUseTool, tools } = session
  try {
    const mcpServer = await (buildServer ?? ((c, h) => createOpsMcpServer(c, h)))(ctx, tools)
    return {
      ok: true,
      ctx,
      systemAppend: buildOpsSystemAppend(OPS_PREAMBLE, ctx.runbook.guidelines, ctx.runbook.ref.name),
      mcpServer,
      canUseTool,
      tools
    }
  } catch (e) {
    return { ok: false, error: `Could not start the ops run: ${message(e)}` }
  }
}
