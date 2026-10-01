/**
 * The in-process `ops` MCP server (docs/OPS_AGENT_PLAN.md §1.2): mcp__ops__run, script,
 * read, list and write, the model's only reach to a server. The gate's decision was
 * already taken and logged in canUseTool (ops-run.ts); each handler here runs the same
 * deterministic classify again and refuses a deny, so a call that somehow skipped
 * canUseTool still cannot run. Then it executes through the executor's per-host queue
 * and logs `call.started` before and `call.finished` after.
 *
 * Handlers never throw: the SDK would surface a throw as a tool error with a stack, and
 * the ledger would miss the call's end. Every path returns a CallToolResult.
 *
 * No Electron here. The SDK and zod are ESM, reached through the same runtime dynamic
 * import providers/claude.ts uses, and zod is loaded from the same module graph as the
 * SDK so its schemas are the instances the SDK expects.
 */
import type { createSdkMcpServer as CreateServerFn, tool as ToolFn } from '@anthropic-ai/claude-agent-sdk'
import type { z as ZodNs } from 'zod'
import { classify } from './ops-gate-pure'
import { effectiveLimits } from './ops-policy-pure'
import {
  execIsError,
  finishedEventFrom,
  listResultText,
  mcpInputToOpsInput,
  callKey,
  readResultText,
  refusedFinishedEvent,
  SUDO_PASSWORD_NOTE,
  sudoNeedsPassword,
  toolResultText,
  writeResultText
} from './ops-run-pure'
import { failedExec, type ExecResult } from './ops-exec-pure'
import type { OpsRunContext } from './ops-run'
import type { OpsGateResult, OpsToolInput, OpsToolName } from './ops-types'

/** The MCP tool result shape, kept local so this file needs no @modelcontextprotocol import. */
export interface OpsToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

export type OpsToolHandlers = Record<OpsToolName, (args: Record<string, unknown>) => Promise<OpsToolResult>>

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const text = (t: string, isError = false): OpsToolResult => ({ content: [{ type: 'text', text: t }], isError })

/** An ExecResult for a file operation, so read/list/write log the same call.finished shape as a command. */
function fileExec(ok: boolean, out: string, err: string, durationMs: number): ExecResult {
  return {
    ok: true,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    durationMs,
    stdout: out,
    stderr: err,
    stdoutBytes: Buffer.byteLength(out, 'utf-8'),
    stderrBytes: Buffer.byteLength(err, 'utf-8'),
    truncated: false
  }
}

/**
 * The five handlers as plain functions over a run context. Kept apart from the SDK
 * server so the whole gate + tool + ledger path is testable against the fake backend.
 */
export function createOpsToolHandlers(ctx: OpsRunContext): OpsToolHandlers {
  const { runId } = ctx
  const limits = effectiveLimits(ctx.runbook.policy)

  async function handle(tool: OpsToolName, args: Record<string, unknown>): Promise<OpsToolResult> {
    try {
      const input = mcpInputToOpsInput(tool, args)
      if ('error' in input) return text(`Refused: ${input.error}.`, true)

      const callId = ctx.calls.take(callKey(input))
      const entry = ctx.hosts.byId.get(input.hostId)
      const gate = classify(input, ctx.runbook.policy, entry?.host ?? null, entry?.groups ?? [])

      if (!callId) {
        // canUseTool decides and logs every call first; one that arrives here without that
        // record is not run, and the refusal is itself logged.
        const id = ctx.calls.fresh()
        await ctx.log({
          kind: 'call.decided',
          runId,
          callId: id,
          tool,
          hostId: input.hostId,
          host: entry?.host.name ?? input.hostId,
          rawInput: args,
          ...(gate.argv ? { argv: gate.argv } : {}),
          ...(gate.path ? { path: gate.path } : {}),
          class: gate.class,
          decision: 'deny',
          reason: 'the call reached the tool without a permission decision'
        })
        return text('Refused: this call was not approved through the ops gate.', true)
      }
      if (gate.decision === 'deny' || !entry) {
        await ctx.log(refusedFinishedEvent(runId, callId, `refused at execution: ${gate.reason}`))
        return text(`Refused: ${gate.reason}.`, true)
      }
      if (ctx.abort.signal.aborted) {
        await ctx.log(refusedFinishedEvent(runId, callId, 'the run was stopped'))
        return text('Refused: the run was stopped.', true)
      }

      return await ctx.executor.run(input.hostId, () => execute(input, gate, callId))
    } catch (e) {
      return text(`The ops tool failed: ${message(e)}`, true)
    }
  }

  async function execute(input: OpsToolInput, gate: OpsGateResult, callId: string): Promise<OpsToolResult> {
    try {
      // A call whose start cannot be recorded does not start.
      const started = await ctx.log({ kind: 'call.started', runId, callId })
      if (!started.ok) return text('Refused: the ops ledger is unavailable, so nothing was run.', true)
      if (ctx.abort.signal.aborted) {
        await ctx.log(refusedFinishedEvent(runId, callId, 'the run was stopped'))
        return text('Refused: the run was stopped.', true)
      }

      const opts = { timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes, signal: ctx.abort.signal }
      const backend = ctx.executor.backend
      const t0 = Date.now()

      switch (input.tool) {
        case 'run':
        case 'script': {
          if (!gate.argv || gate.argv.length === 0) {
            await ctx.log(refusedFinishedEvent(runId, callId, 'the gate produced no argv'))
            return text('Refused: the gate produced no command to run.', true)
          }
          let result: ExecResult
          if (input.tool === 'run') {
            result = await backend.exec(input.hostId, gate.argv, opts)
          } else {
            // Re-read and re-hash right before it runs: the load-time hash only proves what
            // the file was when the run started.
            const script = await ctx.readScript(ctx.runbook, input.name)
            if (!script.ok) {
              await ctx.log(refusedFinishedEvent(runId, callId, script.error, Date.now() - t0))
              return text(`Refused: ${script.error}`, true)
            }
            if (gate.scriptSha256 && script.sha256.toLowerCase() !== gate.scriptSha256.toLowerCase()) {
              const err = `Script ${input.name} changed: the gate approved ${gate.scriptSha256}, the file on disk is ${script.sha256}.`
              await ctx.log(refusedFinishedEvent(runId, callId, err, Date.now() - t0))
              return text(`Refused: ${err}`, true)
            }
            result = await backend.runScript(input.hostId, input.name, script.content, input.args, opts)
          }
          await ctx.log(finishedEventFrom(result, runId, callId))
          // sudo password prompting lands with the UI batch (plan §4); until then the model
          // gets the stderr and a plain instruction to stop.
          const note = sudoNeedsPassword(gate.argv, result) ? `\n${SUDO_PASSWORD_NOTE}` : ''
          return text(toolResultText(result) + note, execIsError(result))
        }

        case 'read': {
          const r = await backend.read(input.hostId, gate.path ?? input.path, limits.readMaxBytes)
          const shown = readResultText(r)
          await ctx.log(
            finishedEventFrom(
              shown.isError ? fileExec(false, '', shown.text, Date.now() - t0) : fileExec(true, shown.text, '', Date.now() - t0),
              runId,
              callId
            )
          )
          return text(shown.text, shown.isError)
        }

        case 'list': {
          const r = await backend.list(input.hostId, gate.path ?? input.path)
          const shown = listResultText(r)
          await ctx.log(
            finishedEventFrom(
              shown.isError ? fileExec(false, '', shown.text, Date.now() - t0) : fileExec(true, shown.text, '', Date.now() - t0),
              runId,
              callId
            )
          )
          return text(shown.text, shown.isError)
        }

        case 'write': {
          const p = gate.path ?? input.path
          const backup = ctx.runbook.policy.write?.backup === true
          const r = await backend.write(input.hostId, p, input.content, backup)
          if (r.ok && r.backupPath) {
            await ctx.log({
              kind: 'write.backup',
              runId,
              callId,
              path: p,
              backupPath: r.backupPath,
              beforeSha256: r.beforeSha256 ?? '',
              afterSha256: r.afterSha256
            })
          }
          const shown = writeResultText(r, p)
          await ctx.log(
            finishedEventFrom(
              shown.isError ? fileExec(false, '', shown.text, Date.now() - t0) : fileExec(true, shown.text, '', Date.now() - t0),
              runId,
              callId
            )
          )
          return text(shown.text, shown.isError)
        }
      }
    } catch (e) {
      const err = failedExec(message(e))
      await ctx.log(finishedEventFrom(err, runId, callId)).catch(() => undefined)
      return text(`The ops tool failed: ${message(e)}`, true)
    }
  }

  return {
    run: (a) => handle('run', a),
    script: (a) => handle('script', a),
    read: (a) => handle('read', a),
    list: (a) => handle('list', a),
    write: (a) => handle('write', a)
  }
}

// ─── SDK server ──────────────────────────────────────────────────────────────────

const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>

interface SdkParts {
  createSdkMcpServer: typeof CreateServerFn
  tool: typeof ToolFn
  z: typeof ZodNs
}

let sdkParts: SdkParts | null = null

async function loadSdkParts(): Promise<SdkParts> {
  if (!sdkParts) {
    const sdk = (await dynamicImport('@anthropic-ai/claude-agent-sdk')) as {
      createSdkMcpServer: typeof CreateServerFn
      tool: typeof ToolFn
    }
    const zod = (await dynamicImport('zod')) as { z: typeof ZodNs }
    sdkParts = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z }
  }
  return sdkParts
}

/** The hosts the model may name, in every tool description: the id is what it must send. */
function hostList(ctx: OpsRunContext): string {
  const rows = [...ctx.hosts.byId.values()].map((h) => `- ${h.host.name} (hostId: ${h.host.id}; groups: ${h.groups.join(', ')})`)
  return rows.length ? rows.join('\n') : '- (no hosts)'
}

const RULES =
  'One simple command only: no chaining (;, &&, ||), no pipes, redirections, subshells or variable assignments. ' +
  'Use the scripts the runbook provides for anything that needs more than one command. ' +
  'Every call is checked against the runbook policy and may be refused or need the operator\'s approval.'

/**
 * Build the `ops` server for `mcpServers: { ops: … }`. Returns the SDK's
 * McpSdkServerConfigWithInstance; typed as unknown at the seam because EngineRequest's
 * mcpServers is engine-agnostic.
 */
export async function createOpsMcpServer(ctx: OpsRunContext, handlers = createOpsToolHandlers(ctx)): Promise<unknown> {
  const { createSdkMcpServer, tool, z } = await loadSdkParts()
  const hosts = `Hosts in this runbook:\n${hostList(ctx)}`
  const as = (r: OpsToolResult) => r as never

  return createSdkMcpServer({
    name: 'ops',
    version: '1.0.0',
    instructions: `Remote operations for runbook ${ctx.runbook.ref.name}. ${RULES}\n${hosts}`,
    alwaysLoad: true,
    tools: [
      tool(
        'run',
        `Run one command on a runbook host over SSH and return its exit code, stdout and stderr. ${RULES}\n${hosts}`,
        { hostId: z.string(), cmd: z.string() },
        async (args) => as(await handlers.run(args))
      ),
      tool(
        'script',
        `Run one of the runbook's scripts (by file name, from its scripts/ folder) on a host, with arguments as separate strings. ${RULES}\n${hosts}`,
        { hostId: z.string(), name: z.string(), args: z.array(z.string()).default([]) },
        async (args) => as(await handlers.script(args))
      ),
      tool(
        'read',
        `Read a text file on a host. The path must be absolute and inside the runbook's read paths. ${RULES}\n${hosts}`,
        { hostId: z.string(), path: z.string() },
        async (args) => as(await handlers.read(args))
      ),
      tool(
        'list',
        `List a directory on a host. The path must be absolute and inside the runbook's read paths. ${RULES}\n${hosts}`,
        { hostId: z.string(), path: z.string() },
        async (args) => as(await handlers.list(args))
      ),
      tool(
        'write',
        `Write a text file on a host. The path must be absolute and inside the runbook's write paths; the previous file may be backed up first. ${RULES}\n${hosts}`,
        { hostId: z.string(), path: z.string(), content: z.string() },
        async (args) => as(await handlers.write(args))
      )
    ]
  })
}
