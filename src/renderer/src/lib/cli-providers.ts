import type { ProviderId } from '../types'

/** The CLIs a terminal chat can run, in the order every picker shows them. */
export const CLI_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Antigravity' }
]
