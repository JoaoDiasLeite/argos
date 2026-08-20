import { ModelInfo, ProviderId } from './config'

/** One entry as a live source (an API or a CLI) reports it. Pricing is never
 *  part of this: no provider exposes prices programmatically, so a discovered
 *  model carries ids/labels/context only and is flagged for the UI. */
export interface DiscoveredModel {
  id: string
  provider: ProviderId
  /** Human label from the source (Anthropic's `display_name`), if any. */
  label?: string
  /** Context window in tokens, if the source reports one. */
  maxInputTokens?: number
}

/** Render a context window the way the bundled catalog writes it ('1M', '200K').
 *  Unknown sizes render as '?' rather than a made-up number. */
export function formatContext(maxInputTokens?: number): string {
  if (!maxInputTokens || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return '?'
  if (maxInputTokens >= 1_000_000) {
    const m = maxInputTokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (maxInputTokens >= 1000) {
    const k = maxInputTokens / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
  }
  return String(maxInputTokens)
}

/**
 * Merge the three catalog sources, in precedence order:
 *   1. `bundled`   — curated defaults (ids, labels, pricing, context).
 *   2. `overrides` — the user's models.json; wins by id, adds unknown ids.
 *   3. `discovered`— live from an API/CLI; only ever *adds* ids nobody else
 *      knows about, flagged `discovered` with zero pricing, so a curated entry
 *      never loses its price to a source that has none.
 */
export function mergeCatalog(
  bundled: ModelInfo[],
  overrides: ModelInfo[],
  discovered: DiscoveredModel[]
): ModelInfo[] {
  const byId = new Map<string, ModelInfo>()
  for (const m of bundled) byId.set(m.id, { ...m })
  for (const m of overrides) byId.set(m.id, { ...m })

  for (const d of discovered) {
    if (!d?.id || byId.has(d.id)) continue
    byId.set(d.id, {
      id: d.id,
      label: d.label && d.label.trim() ? d.label : d.id,
      inputPrice: 0,
      outputPrice: 0,
      context: formatContext(d.maxInputTokens),
      provider: d.provider,
      discovered: true
    })
  }

  return [...byId.values()]
}
