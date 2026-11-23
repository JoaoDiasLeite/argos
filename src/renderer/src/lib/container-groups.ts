import type { RemoteContainerRow } from '../types'

/**
 * How the Containers pane (and the Servers screen's local containers) lays out a listing,
 * the way Docker Desktop does: one group per compose project, then the containers that
 * belong to none. Pure, so it is unit-testable.
 */

export interface ContainerGroup {
  project: string
  containers: RemoteContainerRow[]
  /** How many of them are running. */
  running: number
}

export interface GroupedContainers {
  groups: ContainerGroup[]
  /** Containers outside any compose project. */
  loose: RemoteContainerRow[]
}

export interface GroupOptions {
  /** Leave out what is not running. */
  runningOnly?: boolean
  /** Case-insensitive match on name, service, project or image. */
  query?: string
}

const byRunningThenName = (a: RemoteContainerRow, b: RemoteContainerRow): number =>
  Number(b.running) - Number(a.running) || (a.service ?? a.name).localeCompare(b.service ?? b.name)

export function groupContainers(rows: RemoteContainerRow[], opts: GroupOptions = {}): GroupedContainers {
  const q = opts.query?.trim().toLowerCase() ?? ''
  const shown = rows.filter((c) => {
    if (opts.runningOnly && !c.running) return false
    if (!q) return true
    return [c.name, c.service, c.project, c.image].some((v) => v?.toLowerCase().includes(q))
  })

  const byProject = new Map<string, RemoteContainerRow[]>()
  const loose: RemoteContainerRow[] = []
  for (const c of shown) {
    if (!c.project) {
      loose.push(c)
      continue
    }
    const list = byProject.get(c.project)
    if (list) list.push(c)
    else byProject.set(c.project, [c])
  }

  const groups = [...byProject].map(([project, containers]) => ({
    project,
    containers: [...containers].sort(byRunningThenName),
    running: containers.filter((c) => c.running).length
  }))
  // A project with something running first, then by name.
  groups.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.project.localeCompare(b.project))
  loose.sort(byRunningThenName)
  return { groups, loose }
}

export type HealthTone = 'ok' | 'warn' | 'bad'

/**
 * Splits a `Status` column into the words and a health or exit tag: `Up 2 days (healthy)`
 * gives `Up 2 days` and a green `healthy`; `Exited (1) 3 days ago` keeps its text and is
 * marked bad, since a non-zero exit is the one a stopped container is worth a look for.
 */
export function readStatus(status: string): { text: string; tag?: string; tone?: HealthTone } {
  const health = /\s*\((healthy|unhealthy|health: starting|starting)\)\s*$/i.exec(status)
  if (health) {
    const word = health[1].toLowerCase().replace('health: ', '')
    const tone: HealthTone = word === 'healthy' ? 'ok' : word === 'unhealthy' ? 'bad' : 'warn'
    return { text: status.slice(0, health.index).trim(), tag: word, tone }
  }
  const exited = /^exited \((\d+)\)/i.exec(status)
  if (exited && exited[1] !== '0') return { text: status, tone: 'bad' }
  return { text: status }
}
