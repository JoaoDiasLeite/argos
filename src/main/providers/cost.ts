import { priceFor } from '../config'
import { CACHE_READ, CACHE_WRITE_1H, CACHE_WRITE_5M, RawUsage, splitCacheWrite } from './cost-pure'

export { splitCacheWrite } from './cost-pure'
export type { RawUsage } from './cost-pure'

/**
 * Codex/Gemini don't report a pre-computed USD cost the way the Claude Agent SDK
 * does (`total_cost_usd`) — only raw token counts. Same formula Claude transcript
 * parsing uses (see `costFromUsage`), templated for any provider's model.
 *
 * `cacheCreationTokens` is the 5m-TTL write count; pass `cacheCreation1hTokens`
 * separately when the provider distinguishes them (Claude does, via
 * `splitCacheWrite`). Providers with no TTL split leave it unset and are priced
 * at the 5m rate, which is what they bill.
 */
export function costFromTokens(
  modelId: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheCreation1hTokens?: number
  }
): number {
  const p = priceFor(modelId)
  return (
    (usage.inputTokens * p.inputPrice) / 1e6 +
    (usage.outputTokens * p.outputPrice) / 1e6 +
    (usage.cacheCreationTokens * p.inputPrice * CACHE_WRITE_5M) / 1e6 +
    ((usage.cacheCreation1hTokens ?? 0) * p.inputPrice * CACHE_WRITE_1H) / 1e6 +
    (usage.cacheReadTokens * p.inputPrice * CACHE_READ) / 1e6
  )
}

/** `costFromTokens` over a transcript's raw `usage` block, TTL split included. */
export function costFromUsage(modelId: string, usage: RawUsage): number {
  const { write5m, write1h } = splitCacheWrite(usage)
  return costFromTokens(modelId, {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: write5m,
    cacheCreation1hTokens: write1h
  })
}
