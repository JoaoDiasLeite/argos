import { spawn } from 'child_process'
import { JsonRpcConnection } from './jsonrpc'
import { resolveCodex } from './cli-resolve'
import { costFromTokens } from './cost'
import { ZERO_USAGE } from './types'
import type { EngineMessage, EngineRequest } from './types'

const NOT_FOUND_MESSAGE = 'Codex CLI not found. Install with: npm install -g @openai/codex'

/**
 * Codex's real per-tool-approval hook — used only when `req.canUseTool` is set
 * (interactive chat in 'ask' mode). Everything else (headless reasoning,
 * routines, mcp-ask, and interactive chat in auto-approve mode) uses the
 * simpler `codex exec --json` path in `codex.ts`, which has no approval
 * callback at all.
 *
 * Ground-truthed against the installed CLI (0.144.6) via `codex app-server
 * generate-ts` (the binary's own protocol bindings — first-party, not
 * community docs) plus a live traced run: `initialize` → `thread/start` →
 * `turn/start`, observing the real `item/started`/`item/completed`/
 * `turn/started`/`turn/completed` notification sequence and confirming
 * newline-delimited JSON-RPC 2.0 framing (no LSP-style Content-Length
 * headers). The approval methods themselves (`execCommandApproval`/
 * `applyPatchApproval`) could not be triggered live — reaching them requires
 * the model to actually decide to run something, which needs working auth —
 * so their request/response shape is from the generated bindings, not a live
 * capture; worth a real approval-flow smoke test once login is restored.
 *
 * Unlike the plan's original sketch of a persistent app-server process kept
 * alive for a whole chat session, this spawns a fresh `codex app-server` per
 * turn and uses `thread/resume` on subsequent turns. `AiEngine.run(req)` is
 * stateless per call — there's no session-lifecycle hook today to know when a
 * chat ends and a persistent process should be torn down — so per-turn
 * reconnect is the simpler, still-correct fit for the existing interface. The
 * cost is a handshake per turn, not per-tool-call state loss.
 */
export async function* runCodexAppServer(
  req: EngineRequest,
  prompt: string,
  sandbox: 'read-only' | 'workspace-write',
  codexHome: string | undefined
): AsyncGenerator<EngineMessage> {
  if (!req.canUseTool) {
    yield { type: 'error', message: 'runCodexAppServer requires canUseTool.' }
    return
  }
  const canUseTool = req.canUseTool

  const { command, prefixArgs } = resolveCodex()
  const child = spawn(command, [...prefixArgs, 'app-server'], {
    cwd: req.cwd,
    env: { ...process.env, ...req.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal: req.abortController.signal
  })

  let spawnErr: NodeJS.ErrnoException | undefined
  let stderrBuf = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })
  child.on('error', (err) => {
    spawnErr = err as NodeJS.ErrnoException
  })

  const rpc = new JsonRpcConnection(child)

  // Bridges the connection's callback-style notifications into the pull-based
  // async generator this function yields — items pushed as they arrive,
  // consumed by the `for await` loop below.
  const queue: EngineMessage[] = []
  let queueWake: (() => void) | null = null
  let done = false
  const push = (m: EngineMessage) => {
    queue.push(m)
    if (queueWake) {
      const wake = queueWake
      queueWake = null
      wake()
    }
  }
  const finish = () => {
    done = true
    if (queueWake) {
      const wake = queueWake
      queueWake = null
      wake()
    }
  }

  let sessionId: string | undefined = req.resume
  let lastUsage = ZERO_USAGE

  rpc.onNotification('item/agentMessage/delta', (params) => {
    const p = params as { delta?: string }
    if (p.delta) push({ type: 'text-delta', text: p.delta })
  })
  rpc.onNotification('item/reasoning/textDelta', (params) => {
    const p = params as { delta?: string }
    if (p.delta) push({ type: 'thinking-delta', text: p.delta })
  })
  rpc.onNotification('thread/tokenUsage/updated', (params) => {
    const p = params as { tokenUsage?: { last?: Record<string, number> } }
    const u = p.tokenUsage?.last
    if (u) {
      lastUsage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cachedInputTokens ?? 0,
        cacheCreationTokens: 0
      }
    }
  })
  rpc.onNotification('turn/completed', (params) => {
    const p = params as { turn?: { status?: string; error?: { message?: string } } }
    const isError = p.turn?.status === 'failed'
    push({
      type: 'result',
      sessionId,
      isError,
      errorText: isError ? p.turn?.error?.message ?? 'Codex turn failed.' : undefined,
      costUsd: costFromTokens(req.model, lastUsage),
      usage: lastUsage
    })
    finish()
  })
  rpc.onNotification('error', (params) => {
    const p = params as { error?: { message?: string } }
    push({ type: 'error', message: p.error?.message ?? 'Codex error.' })
  })

  // Approval callbacks — the actual point of this whole module. No
  // MUTATING_TOOLS-style allowlist gate on this side: trust that codex only
  // ever raises these for genuinely risky operations in the first place.
  rpc.onRequest('execCommandApproval', async (params) => {
    const p = params as { command?: string[]; cwd?: string }
    const decision = await canUseTool('Bash', { command: (p.command ?? []).join(' '), cwd: p.cwd })
    return { decision: decision.behavior === 'allow' ? 'approved' : 'denied' }
  })
  rpc.onRequest('applyPatchApproval', async (params) => {
    const p = params as { fileChanges?: Record<string, unknown> }
    const decision = await canUseTool('Edit', { fileChanges: p.fileChanges ?? {} })
    return { decision: decision.behavior === 'allow' ? 'approved' : 'denied' }
  })

  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))

  ;(async () => {
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'argos', title: 'argos', version: '1' }
      })

      let threadId: string
      if (req.resume) {
        const res = (await rpc.request('thread/resume', {
          threadId: req.resume,
          cwd: req.cwd,
          model: req.model
        })) as { thread?: { id?: string } }
        threadId = res.thread?.id ?? req.resume
      } else {
        const res = (await rpc.request('thread/start', {
          cwd: req.cwd,
          model: req.model,
          approvalPolicy: 'on-request',
          sandbox
        })) as { thread?: { id?: string } }
        threadId = res.thread?.id ?? ''
      }
      sessionId = threadId
      push({ type: 'init', sessionId: threadId, tools: [] })

      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
      // The turn's actual completion arrives as a `turn/completed`
      // notification (handled above), not as this request's response — the
      // response above just acknowledges the turn started.
    } catch (err) {
      push({
        type: 'result',
        sessionId,
        isError: true,
        errorText: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        usage: ZERO_USAGE
      })
      finish()
    }
  })()

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as EngineMessage
        continue
      }
      if (done) break
      if (spawnErr) {
        const isNotFound = spawnErr.code === 'ENOENT'
        yield { type: 'error', message: isNotFound ? NOT_FOUND_MESSAGE : spawnErr.message }
        break
      }
      await new Promise<void>((resolve) => {
        queueWake = resolve
      })
    }
  } finally {
    rpc.dispose('Codex app-server process ending.')
    try {
      child.kill()
    } catch {
      // best-effort
    }
    await closed
    if (!done && stderrBuf.trim()) {
      yield {
        type: 'result',
        sessionId,
        isError: true,
        errorText: stderrBuf.trim(),
        costUsd: 0,
        usage: ZERO_USAGE
      }
    }
  }
}
