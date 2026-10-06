import type { ProviderId } from '../types'

/** The CLIs a terminal chat can run, in the order every picker shows them. */
export const CLI_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Antigravity' }
]

/** Providers kept in the code but hidden from every picker. Antigravity (gemini) is
 *  parked for now. Main's twin is HIDDEN_PROVIDERS in src/main/config.ts. */
export const HIDDEN_PROVIDERS: readonly ProviderId[] = ['gemini']

export const isProviderHidden = (id: ProviderId): boolean => HIDDEN_PROVIDERS.includes(id)

/** The CLIs a new chat can start on. CLI_PROVIDERS stays complete so an existing chat
 *  on a hidden provider still shows its label. */
export const VISIBLE_CLI_PROVIDERS = CLI_PROVIDERS.filter((p) => !isProviderHidden(p.id))
