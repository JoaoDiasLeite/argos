import type { ModelInfo, ProviderId } from '../types'

/** The CLIs a terminal chat can run, in the order every picker shows them. */
export const CLI_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Antigravity' }
]

/**
 * The model id to record on a session so that it launches `provider`'s CLI.
 *
 * A session still carries `model`, not `provider`, and the model only decides which CLI
 * starts (the CLI's own /model picks the real one). So: `preferred` when it already
 * belongs to that provider, else the provider's first model in the catalog, else
 * `preferred` unchanged when the catalog has none.
 * TODO(B4): goes when Session carries `provider` directly.
 */
export function modelForProvider(models: ModelInfo[], provider: ProviderId, preferred?: string): string | undefined {
  const own = (id?: string) => !!id && models.some((m) => m.provider === provider && id.startsWith(m.id))
  if (own(preferred)) return preferred
  return models.find((m) => m.provider === provider)?.id ?? preferred
}
