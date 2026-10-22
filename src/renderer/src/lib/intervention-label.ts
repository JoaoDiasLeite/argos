import type { TFunction } from '../../../shared/i18n'

/**
 * How an intervention is named on screen: its tab, the workspace header, the terminal
 * pane, Home's Running list and the start screen's earlier runs. The server is the name
 * (the built-in runbook is the default, so the runbook folder alone tells no two apart);
 * the mode rides beside it as a small tag. Reports and the ledger keep the folder name.
 */

/** Where the intervention runs: one locked server, or any server the runbook allows. */
export type InterventionServer =
  | { kind: 'host'; /** The server's name; unknown while the host list loads. */ name?: string }
  | { kind: 'open'; /** The servers reached so far, in order. */ reached?: string[] }

export interface InterventionLabelInput {
  /** The runbook folder (a path, or a bare folder name from the ledger). */
  runbook: string
  /** The runbook is the read-only one built into Argos. */
  builtin: boolean
  server: InterventionServer
  /** The runbook's policy has rules that change a server; unknown until it is loaded. */
  mutates?: boolean
  task?: string
  ticket?: string
  client?: string
  ended?: boolean
  waiting?: boolean
}

/** What only a mounted workspace learns about its intervention, reported up for its tab. */
export interface OpsLabelInfo {
  /** The servers an open intervention's current run reached. */
  reached: string[]
  /** The runbook's policy changes servers; absent until the runbook has loaded. */
  mutates?: boolean
}

export interface InterventionLabel {
  /** The server name, or the servers an open intervention reached. */
  title: string
  /** The mode: "Diagnosis" for the built-in runbook, otherwise the runbook folder's name. */
  tag: string
  tagTone: 'neutral' | 'warn'
  /** Server, mode or runbook, client, ticket and task, one per line. */
  tooltip: string
}

/** How many reached servers an open intervention's title names before "+N". */
const REACHED_SHOWN = 2

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function serverTitle(server: InterventionServer, t: TFunction): string {
  if (server.kind === 'host') return server.name || '…'
  const reached = server.reached ?? []
  if (reached.length === 0) return t('ops.label.severalServers')
  const shown = reached.slice(0, REACHED_SHOWN).join(', ')
  return reached.length > REACHED_SHOWN ? `${shown} +${reached.length - REACHED_SHOWN}` : shown
}

export function interventionLabel(input: InterventionLabelInput, t: TFunction): InterventionLabel {
  const { server, builtin } = input
  const title = serverTitle(server, t)
  const folder = baseName(input.runbook)
  const tag = builtin ? t('ops.start.mode.despiste') : folder
  const tagTone = !builtin && input.mutates ? 'warn' : 'neutral'

  const suffix = input.ended ? t('ops.tabs.stopped') : input.waiting ? t('ops.tabs.waiting') : ''
  const reached = server.kind === 'open' ? (server.reached ?? []) : []
  const serverLine =
    server.kind === 'host'
      ? t('ops.label.tipServer', { name: title })
      : reached.length > 0
        ? t('ops.label.tipServers', { names: reached.join(', ') })
        : t('ops.label.severalServers')
  const lines = [
    `${serverLine}${suffix}`,
    builtin ? t('ops.label.tipMode', { mode: tag }) : t('ops.label.tipRunbook', { name: folder }),
    input.client ? t('ops.label.tipClient', { name: input.client }) : '',
    input.ticket ? t('ops.label.tipTicket', { ticket: input.ticket }) : '',
    input.task ? t('ops.label.tipTask', { task: input.task }) : ''
  ]
  return { title, tag, tagTone, tooltip: lines.filter(Boolean).join('\n') }
}

/**
 * The titles to show for a list of labels in opening order: two with the same title and
 * tag are told apart by their ticket when they have one, then by " #2", " #3" by position.
 */
export function distinctTitles(items: { label: InterventionLabel; ticket?: string }[]): string[] {
  const keyOf = (title: string, tag: string) => `${title}\u0000${tag}`
  const count = (titles: string[]) => {
    const n = new Map<string, number>()
    titles.forEach((title, i) => n.set(keyOf(title, items[i].label.tag), (n.get(keyOf(title, items[i].label.tag)) ?? 0) + 1))
    return n
  }
  const first = items.map((it) => it.label.title)
  const clash = count(first)
  const withTicket = first.map((title, i) =>
    (clash.get(keyOf(title, items[i].label.tag)) ?? 0) > 1 && items[i].ticket ? `${title} · ${items[i].ticket}` : title
  )
  const still = count(withTicket)
  const seen = new Map<string, number>()
  return withTicket.map((title, i) => {
    const key = keyOf(title, items[i].label.tag)
    if ((still.get(key) ?? 0) < 2) return title
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n === 1 ? title : `${title} #${n}`
  })
}
