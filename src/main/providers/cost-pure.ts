/**
 * Cache-write multipliers over the model's base input price. A 5-minute entry
 * costs 1.25×; a 1-hour entry costs 2×. Claude Code writes **1h** entries — every
 * `cache_creation` block a CLI/SDK run reports puts its tokens under
 * `ephemeral_1h_input_tokens` — so pricing every write at 1.25× understates the
 * real cost by 37%.
 */
export const CACHE_WRITE_5M = 1.25
export const CACHE_WRITE_1H = 2

/** Cache-read entries cost 0.1× the base input price, whatever their TTL. */
export const CACHE_READ = 0.1

/** The `usage` block on an assistant message, as far as cost is concerned. */
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  /** Legacy flat count: 5m-TTL only. Superseded by `cache_creation`. */
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

/**
 * Cache writes are reported either split by TTL (`cache_creation`, current) or as
 * one flat legacy count, which was 5m-only. One place decides which, so the two
 * cost paths (live provider runs, transcript aggregation) cannot disagree.
 */
export function splitCacheWrite(usage: RawUsage | undefined): {
  write5m: number
  write1h: number
} {
  const split = usage?.cache_creation
  if (split) {
    return {
      write5m: split.ephemeral_5m_input_tokens ?? 0,
      write1h: split.ephemeral_1h_input_tokens ?? 0
    }
  }
  return { write5m: usage?.cache_creation_input_tokens ?? 0, write1h: 0 }
}
