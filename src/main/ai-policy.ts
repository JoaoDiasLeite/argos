import { getConfig, providerFor, ProviderId } from './config'

/**
 * Least-privilege policy for every AI/SDK call in the app.
 *
 * Each call site declares a capability *profile* rather than assembling raw SDK
 * options ad-hoc. The profile decides four cost/safety levers centrally:
 *   1. which settings tiers load (user-tier plugin/skill marketplaces are the
 *      big per-turn context tax — headless work never loads them),
 *   2. which tools are reachable (mutating tools are stripped from context, not
 *      merely gated, so a bypassPermissions run cannot invoke them), and
 *   3. the model ceiling + turn cap (pure-reasoning utility calls must never
 *      burn Opus/Fable budget, and no headless run may loop unbounded), and
 *   4. whether Claude Code's own system prompt loads, and in its cache-stable
 *      form (see CLAUDE_CODE_PROMPT — user-facing chat wants it, headless
 *      utility calls must not pay for it).
 *
 * Strict by default: profiles grant the minimum. Callers opt into more via the
 * explicit `routine-full` / `interactive-*` profiles.
 */

export type AiProfile =
  /** User-facing chat. Keeps this project's settings/CLAUDE.md; drops the user tier. */
  | 'interactive-chat'
  /** User-facing chat in light mode: full isolation, no settings tiers. */
  | 'interactive-light'
  /** One-shot utility reasoning (summarize, standup, planner assist, suggestions). */
  | 'headless-reasoning'
  /** Scheduled routine, read-only intent: mutating tools removed from context. */
  | 'routine-readonly'
  /** Scheduled routine, full intent: the explicit opt-in to unrestricted tools. */
  | 'routine-full'
  /** Ask a question over configured MCP servers + read-only file tools. */
  | 'mcp-ask'

export interface ResolvePolicyInput {
  profile: AiProfile
  /**
   * Model the caller/user asked for (payload.model, run.model). Undefined falls
   * back to config.defaultModel. For `headless-reasoning` this is a ceiling, not
   * a guarantee — see clampToSonnet below.
   */
  requestedModel?: string
  /** `mcp-ask` only: MCP server names to expose as `mcp__<name>` tools. */
  mcpServerNames?: string[]
}

export interface ResolvedPolicy {
  model: string
  settingSources: ('user' | 'project' | 'local')[]
  /** Present only when the profile pins an explicit tool allowlist. */
  allowedTools?: string[]
  /** Present only when the profile removes tools from context. */
  disallowedTools?: string[]
  /** Present only when the profile caps agentic turns. */
  maxTurns?: number
  /** Present only when the profile wants Claude Code's own system prompt. */
  systemPrompt?: {
    type: 'preset'
    preset: 'claude_code'
    excludeDynamicSections?: boolean
  }
}

/**
 * Claude Code's own system prompt, minus the per-run dynamic sections (working
 * directory, auto-memory, **git status**). Two reasons, both measured in this repo:
 *
 *  1. Without it the SDK sends no Claude Code prompt at all — the chat runs on tool
 *     definitions alone and behaves unlike the CLI. It costs ~5.3k tokens, written
 *     to cache once.
 *  2. `excludeDynamicSections` is what makes that prefix *stable*. Git status lives
 *     inside the cached prefix, so one edited file invalidates ~7.7k tokens and
 *     forces a re-write at the 1h-TTL rate (2× input) on the next turn — which is
 *     most turns, in a coding session. Measured on a dirty tree: 7,711 tokens
 *     re-written per turn with it off, 0 with it on. The stripped context is
 *     re-injected as the first user message, so the model still sees it.
 *
 * Claude-only: the preset means nothing to the Codex/Gemini engines.
 */
const CLAUDE_CODE_PROMPT = {
  type: 'preset',
  preset: 'claude_code',
  excludeDynamicSections: true
} as const

/** Tools that mutate the filesystem or run commands. Stripped for read-only work. */
export const MUTATING_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'KillBash'
]

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']

/** Per-provider ceiling for utility reasoning — capable, but well below the
 * provider's flagship-tier cost. */
const CHEAP_CEILING: Record<ProviderId, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.6-luna',
  gemini: 'gemini-3-flash-preview'
}

// Turn caps. Reasoning calls use no tools, so they cannot exceed one assistant
// turn — the cap is belt-and-suspenders. Routines and MCP asks loop over tools,
// so the cap is the real backstop against runaway spend (alongside the timeout).
const REASONING_MAX_TURNS = 2
const ROUTINE_MAX_TURNS = 40
const MCP_ASK_MAX_TURNS = 15

/** Coarse model-family tier for ceiling comparisons, scoped per provider (each
 * provider's model-id conventions are unrelated). Higher = more expensive. */
function tierOf(providerId: ProviderId, model: string): number {
  if (providerId === 'claude') {
    if (model.startsWith('claude-haiku')) return 1
    if (model.startsWith('claude-sonnet')) return 2
    if (model.startsWith('claude-opus')) return 3
    if (model.startsWith('claude-fable')) return 4
    return 2 // unknown ids treated as Sonnet-equivalent
  }
  if (providerId === 'codex') {
    if (model.startsWith('gpt-5.4-mini') || model.startsWith('gpt-5.6-luna')) return 1
    if (model.startsWith('gpt-5.4') || model.startsWith('gpt-5.6-terra')) return 2
    return 3 // gpt-5.5, gpt-5.6-sol, and anything unrecognized
  }
  // gemini
  if (model.startsWith('gemini-3-flash')) return 1
  return 2 // gemini-3.1-pro-preview and anything unrecognized
}

/**
 * Resolve the requested model to a concrete id, clamping down to that
 * provider's cheap ceiling. Cheaper requests pass through untouched; pricier
 * ones are demoted.
 */
function clampToCheapTier(providerId: ProviderId, requested: string | undefined, fallback: string): string {
  const base = requested && requested.trim() ? requested.trim() : fallback
  const ceiling = CHEAP_CEILING[providerId]
  return tierOf(providerId, base) > tierOf(providerId, ceiling) ? ceiling : base
}

/** The caller's explicit model, or the configured default. No ceiling applied. */
function requestedOrDefault(requested: string | undefined, fallback: string): string {
  return requested && requested.trim() ? requested.trim() : fallback
}

export function resolvePolicy(input: ResolvePolicyInput): ResolvedPolicy {
  const fallback = getConfig().defaultModel
  const { requestedModel } = input
  const providerId = providerFor(requestedModel ?? fallback)

  switch (input.profile) {
    case 'interactive-chat':
      return {
        model: requestedOrDefault(requestedModel, fallback),
        settingSources: ['project', 'local'],
        ...(providerId === 'claude' ? { systemPrompt: CLAUDE_CODE_PROMPT } : {})
      }

    case 'interactive-light':
      return {
        model: requestedOrDefault(requestedModel, fallback),
        settingSources: [],
        ...(providerId === 'claude' ? { systemPrompt: CLAUDE_CODE_PROMPT } : {})
      }

    case 'headless-reasoning':
      return {
        model: clampToCheapTier(providerId, requestedModel, fallback),
        settingSources: [],
        allowedTools: [],
        maxTurns: REASONING_MAX_TURNS
      }

    case 'routine-readonly':
      return {
        model: requestedOrDefault(requestedModel, fallback),
        settingSources: ['project'],
        disallowedTools: MUTATING_TOOLS,
        maxTurns: ROUTINE_MAX_TURNS
      }

    case 'routine-full':
      return {
        model: requestedOrDefault(requestedModel, fallback),
        settingSources: ['project'],
        maxTurns: ROUTINE_MAX_TURNS
      }

    case 'mcp-ask':
      return {
        model: clampToCheapTier(providerId, requestedModel, fallback),
        settingSources: ['project', 'local'],
        allowedTools: [
          ...(input.mcpServerNames ?? []).map((n) => `mcp__${n}`),
          ...READ_ONLY_TOOLS
        ],
        maxTurns: MCP_ASK_MAX_TURNS
      }
  }
}
