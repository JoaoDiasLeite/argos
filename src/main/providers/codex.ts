import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { costFromTokens } from './cost'
import { resolveCodex } from './cli-resolve'
import { runCodexAppServer } from './codex-app-server'
import { ZERO_USAGE } from './types'
import type { AiEngine, EngineMessage, EngineRequest } from './types'

const NOT_FOUND_MESSAGE = 'Codex CLI not found. Install with: npm install -g @openai/codex'

/**
 * Codex engine — spawns `codex exec --json` (or `codex exec resume <id> --json`
 * for a follow-up turn) per call, streaming events as they arrive rather than
 * buffering the whole run — interactive chat needs messages to appear live, not
 * all at once after the process exits.
 *
 * Event shapes are ground-truthed against the installed CLI (0.144.6) for the
 * failure path (`thread.started`, `turn.started`, `error`, `turn.failed` were
 * all observed directly) and for `exec resume`'s flag set (confirmed via
 * `codex exec resume --help`: no `-s`/`-a` there — sandbox/approval are fixed at
 * thread creation and inherited on resume, not re-specifiable). The success path
 * (`item.completed` / `turn.completed`) could not be captured live — this
 * machine's Codex login expired mid-development — so it's written from the
 * best-documented shape and needs a smoke test once login is restored.
 */

/**
 * Sandbox level from the request's tool intent. Codex has no per-tool-name gate
 * like Claude's allowedTools/disallowedTools — this is an approximation:
 *   - allowedTools === [] (headless-reasoning) or set (mcp-ask, MCP-scoped)  → read-only
 *   - disallowedTools set (routine-readonly)                                 → read-only
 *   - neither set (routine-full, interactive chat)                          → workspace-write
 */
function sandboxFor(req: EngineRequest): 'read-only' | 'workspace-write' {
  if (req.disallowedTools && req.disallowedTools.length > 0) return 'read-only'
  if (req.allowedTools !== undefined) return 'read-only'
  return 'workspace-write'
}

function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** Codex's config.toml [mcp_servers.*] only supports stdio (command-based)
 * servers — remote (sse/http url-based) servers are skipped, not guessed at. */
function toCodexMcpToml(servers: Record<string, unknown>): string {
  const blocks: string[] = []
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = raw as { command?: string; args?: string[]; env?: Record<string, unknown> }
    if (!cfg?.command) continue
    const lines = [`[mcp_servers.${name}]`, `command = ${tomlString(cfg.command)}`]
    if (Array.isArray(cfg.args) && cfg.args.length) {
      lines.push(`args = [${cfg.args.map((a) => tomlString(String(a))).join(', ')}]`)
    }
    if (cfg.env && typeof cfg.env === 'object') {
      const envEntries = Object.entries(cfg.env).map(([k, v]) => `${tomlString(k)} = ${tomlString(String(v))}`)
      if (envEntries.length) lines.push(`env = { ${envEntries.join(', ')} }`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/**
 * MCP servers require a per-call config.toml, but codex only reads that from
 * CODEX_HOME — which also holds the login. So this stands up an isolated temp
 * CODEX_HOME with just the real auth.json copied in (mirrors accounts.ts's
 * CLAUDE_CONFIG_DIR-per-account trick) plus a config.toml containing only the
 * requested servers. Avoids both mutating the user's real config and passing
 * secrets (server env vars) through argv, which any local process could read.
 *
 * `sourceCodexHome` is the CODEX_HOME the caller would otherwise have used —
 * the selected account's own dir, or undefined for the machine default — so a
 * non-default Codex account's login still applies even when MCP servers force
 * this temp-home path.
 */
function prepareCodexHome(
  mcpServers: Record<string, unknown> | undefined,
  sourceCodexHome: string | undefined
): {
  codexHome?: string
  cleanup: () => void
} {
  const noop = { cleanup: () => {} }
  if (!mcpServers || Object.keys(mcpServers).length === 0) return noop

  const toml = toCodexMcpToml(mcpServers)
  if (!toml.trim()) return noop
  return prepareCodexHomeFromToml(toml, sourceCodexHome)
}

/**
 * The second half of prepareCodexHome, for a caller that already holds the complete
 * config.toml (the ops terminal, whose config main writes for it): an isolated temp
 * CODEX_HOME with the source home's auth.json copied in and `toml` as its config.
 *
 * `persistAuth` copies auth.json back to the source home on cleanup when the CLI
 * changed it. An interactive codex can run for hours and refresh its login meanwhile,
 * and a refresh rotates the refresh token: dropping the overlay's copy would leave the
 * real home holding a token the server no longer accepts.
 */
export function prepareCodexHomeFromToml(
  toml: string,
  sourceCodexHome: string | undefined,
  opts: { persistAuth?: boolean } = {}
): {
  codexHome?: string
  cleanup: () => void
} {
  const noop = { cleanup: () => {} }
  const authSrc = path.join(sourceCodexHome ?? path.join(os.homedir(), '.codex'), 'auth.json')
  let authBefore: string | null = null
  let tempHome: string
  try {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
    if (fs.existsSync(authSrc)) {
      fs.copyFileSync(authSrc, path.join(tempHome, 'auth.json'))
      if (opts.persistAuth) authBefore = fs.readFileSync(authSrc, 'utf8')
    }
    fs.writeFileSync(path.join(tempHome, 'config.toml'), toml)
  } catch {
    // Best-effort: if setup fails, run without the isolated home — MCP servers
    // just won't be registered for this call rather than failing it outright.
    return noop
  }
  return {
    codexHome: tempHome,
    cleanup: () => {
      if (opts.persistAuth) {
        try {
          const overlayAuth = path.join(tempHome, 'auth.json')
          if (fs.existsSync(overlayAuth)) {
            const after = fs.readFileSync(overlayAuth, 'utf8')
            if (after !== authBefore) fs.writeFileSync(authSrc, after)
          }
        } catch {
          // best-effort: the worst case is a re-login, never a broken run
        }
      }
      try {
        fs.rmSync(tempHome, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * `codex exec resume <id>` is a different subcommand than `codex exec` with a
 * different (smaller) flag set — no `-s`/`-a`, since those are fixed at thread
 * creation. Everything else (model, cwd, json) still applies.
 *
 * The prompt is passed as `-` (read from stdin), never as an argv positional:
 * chat/summarize prompts can be tens of KB (a whole transcript), and Windows'
 * CreateProcess caps a command line at ~32 KB — a long prompt on argv would fail
 * to spawn. `codex exec -` reading the prompt from stdin is the documented path.
 */
function buildArgs(req: EngineRequest): string[] {
  if (req.resume) {
    const args = ['exec', 'resume', req.resume, '--json', '--skip-git-repo-check']
    if (req.model) args.push('-m', req.model)
    args.push('-')
    return args
  }
  // No -a/--ask-for-approval here: that flag doesn't exist on `codex exec` (only
  // on `codex exec resume` and the interactive TUI) — confirmed via --help and a
  // real run (passing it produced "unexpected argument '-a' found"). `exec` mode
  // has no interactive approval loop to control in the first place; -s/--sandbox
  // alone governs what it's allowed to do.
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', req.cwd, '-s', sandboxFor(req)]
  if (req.model) args.push('-m', req.model)
  args.push('-')
  return args
}

async function* runCodexProcess(
  req: EngineRequest,
  prompt: string,
  codexHome: string | undefined
): AsyncGenerator<EngineMessage> {
  const { command, prefixArgs } = resolveCodex()

  const child = spawn(command, [...prefixArgs, ...buildArgs(req)], {
    cwd: req.cwd,
    env: { ...process.env, ...req.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal: req.abortController.signal
  })

  // Feed the prompt in on stdin (see buildArgs — argv can't hold a long prompt).
  child.stdin?.on('error', () => {
    /* EPIPE when the process never started — surfaced via the 'error' handler below. */
  })
  try {
    child.stdin?.write(prompt)
    child.stdin?.end()
  } catch {
    /* ignore — a spawn failure is reported through child.on('error') */
  }

  let sessionId: string | undefined = req.resume
  let sawResult = false
  let stderrBuf = ''
  let spawnErr: NodeJS.ErrnoException | undefined

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })
  child.on('error', (err) => {
    spawnErr = err as NodeJS.ErrnoException
  })
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))

  try {
    let buffer = ''
    for await (const chunk of child.stdout as NodeJS.ReadableStream) {
      buffer += (chunk as Buffer).toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        let obj: any
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }

        switch (obj.type) {
          case 'thread.started':
            sessionId = obj.thread_id
            yield { type: 'init', sessionId, tools: [] }
            break

          case 'item.completed':
            if (obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
              yield { type: 'text-delta', text: obj.item.text }
            }
            break

          case 'turn.completed': {
            sawResult = true
            const usage = {
              inputTokens: obj.usage?.input_tokens ?? 0,
              outputTokens: obj.usage?.output_tokens ?? 0,
              cacheReadTokens: obj.usage?.cached_input_tokens ?? 0,
              cacheCreationTokens: 0
            }
            yield {
              type: 'result',
              sessionId,
              isError: false,
              costUsd: costFromTokens(req.model, usage),
              usage
            }
            break
          }

          case 'turn.failed':
            sawResult = true
            yield {
              type: 'result',
              sessionId,
              isError: true,
              errorText: obj.error?.message ?? 'Codex run failed.',
              costUsd: 0,
              usage: ZERO_USAGE
            }
            break

          case 'error':
            yield { type: 'error', message: obj.message ?? 'Codex error.' }
            break
        }
      }
    }
  } finally {
    const code = await closed
    if (spawnErr) {
      const isNotFound = spawnErr.code === 'ENOENT'
      yield { type: 'error', message: isNotFound ? NOT_FOUND_MESSAGE : spawnErr.message }
    } else if (!sawResult) {
      yield {
        type: 'result',
        sessionId,
        isError: true,
        errorText: stderrBuf.trim() || `Codex exited with code ${code}.`,
        costUsd: 0,
        usage: ZERO_USAGE
      }
    }
  }
}

export const codexEngine: AiEngine = {
  id: 'codex',
  async *run(req: EngineRequest) {
    if (typeof req.prompt !== 'string') {
      yield { type: 'error', message: 'Codex engine only supports plain-text prompts right now.' }
      return
    }
    const { codexHome, cleanup } = prepareCodexHome(req.mcpServers, req.env.CODEX_HOME)
    try {
      // Per-tool approval (interactive 'ask' mode) needs codex's JSON-RPC
      // app-server protocol — the simple `exec --json` mode has no approval
      // callback at all. Everything else uses the simpler, one-shot path.
      if (req.canUseTool) {
        yield* runCodexAppServer(req, req.prompt, sandboxFor(req), codexHome)
      } else {
        yield* runCodexProcess(req, req.prompt, codexHome)
      }
    } finally {
      cleanup()
    }
  }
}
