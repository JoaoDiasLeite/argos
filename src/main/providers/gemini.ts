import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { costFromTokens } from './cost'
import { resolveGemini } from './cli-resolve'
import { ZERO_USAGE } from './types'
import type { AiEngine, EngineMessage, EngineRequest } from './types'

const NOT_FOUND_MESSAGE = 'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'

/**
 * Gemini engine — spawns `gemini --output-format stream-json` (with `--resume
 * <id>` for a follow-up turn) per call, streaming events as they arrive rather
 * than buffering the whole run — interactive chat needs messages to appear
 * live, not all at once after the process exits.
 *
 * Ground-truthed directly against the installed CLI (0.51.0): a fatal pre-flight
 * failure (e.g. no auth configured) prints PLAIN TEXT to stderr — not JSON — with
 * a distinct non-zero exit code, so the parser must tolerate non-JSON lines and
 * fall back to stderr for the error message. `--resume <uuid>` was confirmed to
 * compose with headless `--prompt`/`--output-format stream-json` (a fabricated
 * id reached a specific "no session found" error rather than an argument-parse
 * error). The success-path event shape (`message`/`result` with `delta`/`stats`
 * fields) is from the CLI's own docs and source, not captured live — this
 * machine has no Gemini login yet — so it needs a smoke test once that's set up.
 */

/**
 * Gemini's approval-mode is coarse (no per-tool-name gate like Claude's
 * allowedTools/disallowedTools):
 *   - interactive chat (neither allowedTools nor
 *     disallowedTools set) need full execution → 'yolo'.
 *   - mcp-ask (allowedTools set to the MCP-scoped list, AND servers configured)
 *     needs its MCP tools to actually run → 'yolo'. mcp-ask's Claude-side
 *     restriction to "MCP + read-only tools only" isn't mirrored here, since
 *     gemini has no "auto-approve only these servers" mode — known approximation.
 *   - headless-reasoning (allowedTools === []) and a disallowedTools request
 *     (regardless of whether MCP servers exist — read-only
 *     intent must not be overridden just because MCP happens to be configured
 *     for the project) both map to 'plan' (read-only, no tool execution).
 */
function approvalModeFor(req: EngineRequest): 'plan' | 'yolo' {
  const hasMcpServers = !!req.mcpServers && Object.keys(req.mcpServers).length > 0
  if (req.allowedTools === undefined && req.disallowedTools === undefined) return 'yolo'
  if (req.allowedTools !== undefined && hasMcpServers) return 'yolo'
  return 'plan'
}

/** Gemini's settings.json mcpServers schema uses command/args/env for stdio
 * (same shape Claude already stores), but `httpUrl` (not `url`+`type`) for
 * streamable HTTP — SSE keeps `url`. */
function toGeminiMcpServers(servers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = raw as { command?: string; args?: string[]; env?: unknown; url?: string; type?: string }
    if (cfg.command) {
      out[name] = { command: cfg.command, ...(cfg.args ? { args: cfg.args } : {}), ...(cfg.env ? { env: cfg.env } : {}) }
    } else if (cfg.url && cfg.type === 'http') {
      out[name] = { httpUrl: cfg.url }
    } else if (cfg.url) {
      out[name] = { url: cfg.url }
    }
  }
  return out
}

/**
 * MCP servers are registered via a temp file pointed to by
 * GEMINI_CLI_SYSTEM_SETTINGS_PATH — an override env var the CLI itself supports
 * for exactly this ("system settings" layer on top of the user's real config).
 * No auth copying needed (unlike Codex): this only overrides the mcpServers key,
 * the user's real login in ~/.gemini stays untouched and still applies.
 */
function prepareGeminiSystemSettings(mcpServers: Record<string, unknown> | undefined): {
  settingsPath?: string
  cleanup: () => void
} {
  const noop = { cleanup: () => {} }
  if (!mcpServers || Object.keys(mcpServers).length === 0) return noop

  const translated = toGeminiMcpServers(mcpServers)
  if (Object.keys(translated).length === 0) return noop

  const tempFile = path.join(os.tmpdir(), `gemini-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ mcpServers: translated }, null, 2))
  } catch {
    return noop
  }
  return {
    settingsPath: tempFile,
    cleanup: () => {
      try {
        fs.unlinkSync(tempFile)
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function buildArgs(req: EngineRequest): string[] {
  // Prompt comes in on stdin (see runGeminiProcess), not `--prompt`: a whole
  // transcript can exceed Windows' ~32 KB argv limit. In headless mode (non-TTY
  // stdin) Gemini reads the prompt from stdin, same as `echo … | gemini`.
  const args = ['--output-format', 'stream-json', '--approval-mode', approvalModeFor(req), '--skip-trust']
  if (req.model) args.push('-m', req.model)
  if (req.resume) args.push('--resume', req.resume)
  return args
}

async function* runGeminiProcess(req: EngineRequest, prompt: string): AsyncGenerator<EngineMessage> {
  const { settingsPath, cleanup } = prepareGeminiSystemSettings(req.mcpServers)
  const { command, prefixArgs } = resolveGemini()

  const child = spawn(command, [...prefixArgs, ...buildArgs(req)], {
    cwd: req.cwd,
    env: {
      ...process.env,
      ...req.env,
      ...(settingsPath ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath } : {})
    },
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
          // Fatal pre-flight failures print plain text, not JSON — ignore for
          // event purposes; stderr is the fallback error source once closed.
          continue
        }

        switch (obj.type) {
          case 'init':
            sessionId = obj.session_id
            yield { type: 'init', sessionId, tools: [] }
            break

          case 'message':
            if (obj.role === 'assistant' && typeof obj.content === 'string' && obj.content) {
              yield { type: 'text-delta', text: obj.content }
            }
            break

          case 'tool_use':
            if (obj.tool_id && obj.tool_name) {
              yield { type: 'tool-use', id: obj.tool_id, name: obj.tool_name, input: obj.parameters ?? {} }
            }
            break

          case 'tool_result':
            if (obj.tool_id) {
              yield {
                type: 'tool-result',
                toolUseId: obj.tool_id,
                content: typeof obj.output === 'string' ? obj.output.slice(0, 50000) : '',
                isError: obj.status !== 'success'
              }
            }
            break

          case 'result': {
            sawResult = true
            const usage = {
              inputTokens: obj.stats?.input_tokens ?? 0,
              outputTokens: obj.stats?.output_tokens ?? 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0
            }
            yield {
              type: 'result',
              sessionId,
              isError: obj.status !== 'success',
              errorText: obj.status !== 'success' ? (obj.error?.message ?? obj.status) : undefined,
              costUsd: costFromTokens(req.model, usage),
              usage
            }
            break
          }

          case 'error':
            yield { type: 'error', message: obj.message ?? 'Gemini error.' }
            break
        }
      }
    }
  } finally {
    const code = await closed
    cleanup()
    if (spawnErr) {
      const isNotFound = spawnErr.code === 'ENOENT'
      yield { type: 'error', message: isNotFound ? NOT_FOUND_MESSAGE : spawnErr.message }
    } else if (!sawResult) {
      yield {
        type: 'result',
        sessionId,
        isError: true,
        errorText: stderrBuf.trim() || `Gemini exited with code ${code}.`,
        costUsd: 0,
        usage: ZERO_USAGE
      }
    }
  }
}

export const geminiEngine: AiEngine = {
  id: 'gemini',
  async *run(req: EngineRequest) {
    if (typeof req.prompt !== 'string') {
      yield { type: 'error', message: 'Gemini engine only supports plain-text prompts right now.' }
      return
    }
    yield* runGeminiProcess(req, req.prompt)
  }
}
