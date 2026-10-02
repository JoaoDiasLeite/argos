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
 *      burn Opus/Fable budget, and no headless run may loop unbounded).
 *
 * Strict by default: profiles grant the minimum. Interactive work runs in the
 * terminal, under the CLI's own settings, not through here.
 */

export type AiProfile =
  /** One-shot utility reasoning (standup, planner assist, sprint backfill). */
  | 'headless-reasoning'
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
  /** Present only when the profile caps agentic turns. */
  maxTurns?: number
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']

/** Per-provider ceiling for utility reasoning — capable, but well below the
 * provider's flagship-tier cost. */
const CHEAP_CEILING: Record<ProviderId, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.6-luna',
  gemini: 'gemini-3-flash-preview'
}

// Turn caps. Reasoning calls use no tools, so they cannot exceed one assistant
// turn — the cap is belt-and-suspenders. MCP asks loop over tools,
// so the cap is the real backstop against runaway spend (alongside the timeout).
const REASONING_MAX_TURNS = 2
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

export function resolvePolicy(input: ResolvePolicyInput): ResolvedPolicy {
  const fallback = getConfig().defaultModel
  const { requestedModel } = input
  const providerId = providerFor(requestedModel ?? fallback)

  switch (input.profile) {
    case 'headless-reasoning':
      return {
        model: clampToCheapTier(providerId, requestedModel, fallback),
        settingSources: [],
        allowedTools: [],
        maxTurns: REASONING_MAX_TURNS
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
