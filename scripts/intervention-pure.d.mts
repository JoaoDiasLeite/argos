export interface CatalogEntry {
  name: string
  what: string
  changes: boolean
  interactive: boolean
  command: string
}

export const INTERVENTION_LIMITS: { timeoutMs: number; maxOutputBytes: number; concurrentPerHost: number }
export function parseCatalog(text: string): CatalogEntry[]
export function ruleFor(
  entry: CatalogEntry,
  title: string
): { hosts: string[]; cmd: string; class: 'read' | 'mutate'; title: string }
export function buildInterventionPolicy(diagnosis: unknown, catalogText: string, titles: Record<string, string>): unknown
export function interactiveCommands(catalogText: string): CatalogEntry[]
