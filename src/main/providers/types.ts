import type { query as QueryFn } from '@anthropic-ai/claude-agent-sdk'

/**
 * Provider-neutral engine seam.
 *
 * Every AI run in the app is described by an `EngineRequest` and executed by an
 * `AiEngine`, which yields a stream of `EngineMessage`s. `EngineMessage` is a real
 * provider-neutral union — NOT derived from the Claude Agent SDK's own message
 * shape — so Codex/Gemini engines can emit into it without knowing anything about
 * Anthropic's Messages-API conventions (content blocks split across `assistant`/
 * `user` message types, `stream_event` deltas, etc). `claude.ts` is the one place
 * that SDK-shape knowledge lives; it maps SDK messages into this union.
 *
 * Only headless runs go through here now (planner assist, standup, sprint backfill,
 * MCP ask); interactive work runs in the terminal.
 */

export interface EngineUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export const ZERO_USAGE: EngineUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
}

export type EngineMessage =
  | { type: 'init'; sessionId?: string; tools: string[] }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'result'
      sessionId?: string
      isError: boolean
      errorText?: string
      costUsd: number
      usage: EngineUsage
    }
  | { type: 'error'; message: string }

// Derive the prompt/options types the Claude engine still needs from the SDK's own
// `query` signature, so that seam stays in lockstep with the installed SDK version
// without hand-maintaining a parallel type. Non-Claude engines only ever see the
// plain-string branch of `prompt` and treat `settingSources`/`permissionMode` as
// advisory (Claude-Code-specific concepts with no equivalent in other CLIs).
type SdkOptions = NonNullable<Parameters<typeof QueryFn>[0]['options']>
type SdkPrompt = Parameters<typeof QueryFn>[0]['prompt']

export interface EngineRequest {
  /** Plain string (fast path) or the structured streaming-input generator for images. */
  prompt: SdkPrompt
  model: string
  cwd: string
  env: Record<string, string | undefined>
  abortController: AbortController
  settingSources: NonNullable<SdkOptions['settingSources']>
  permissionMode: NonNullable<SdkOptions['permissionMode']>
  /** Explicit tool allowlist. Omit to leave tools unrestricted for the profile. */
  allowedTools?: string[]
  /** Extra working directories the engine may read/write beyond `cwd` (Claude --add-dir). */
  additionalDirectories?: string[]
  /** Tools removed from context entirely (cannot be invoked even under bypass). */
  disallowedTools?: string[]
  /** Agentic-turn cap. Omit for uncapped. */
  maxTurns?: number
  /** MCP servers to expose, keyed by name. Shape is engine-specific until each
   * engine's own MCP config translation lands. */
  mcpServers?: Record<string, unknown>
  systemPrompt?: SdkOptions['systemPrompt']
  /** Opaque resume token from a previous run's `EngineMessage` (type 'init'/'result')
   * `sessionId`. Each engine interprets its own token — a Claude Code session id, a
   * codex thread id, a gemini session id, etc. */
  resume?: string
}

export interface AiEngine {
  readonly id: string
  /** Execute the request, yielding normalized messages. */
  run(req: EngineRequest): AsyncIterable<EngineMessage>
}
