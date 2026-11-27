import type { ContainerRuntime, RemoteContainer } from './remote-containers-pure'

/**
 * The last container listing main saw for each source (a host, or this computer). The
 * start / stop / restart and stats handlers take the runtime and sudo from here, never
 * from the renderer, and only act on a container or compose project this listing had.
 */
export interface KnownListing {
  runtime: ContainerRuntime
  sudo: boolean
  ids: string[]
  /** Each compose project's container count. */
  projects: Map<string, number>
  running: number
}

/** null is this computer. */
export type ContainerSourceKey = string | null

const listings = new Map<string, KnownListing>()

function key(source: ContainerSourceKey): string {
  return source === null ? 'local' : `host:${source}`
}

/** A listing that worked records what it found; anything else forgets the source, so an
 *  action never runs on a runtime main no longer knows to be there. */
export function rememberListing(
  source: ContainerSourceKey,
  listing: { runtime: ContainerRuntime; sudo: boolean; containers: RemoteContainer[] } | null
): void {
  if (!listing) {
    listings.delete(key(source))
    return
  }
  const projects = new Map<string, number>()
  for (const c of listing.containers) if (c.project) projects.set(c.project, (projects.get(c.project) ?? 0) + 1)
  listings.set(key(source), {
    runtime: listing.runtime,
    sudo: listing.sudo === true,
    ids: listing.containers.map((c) => c.id),
    projects,
    running: listing.containers.filter((c) => c.running).length
  })
}

export function knownListing(source: ContainerSourceKey): KnownListing | undefined {
  return listings.get(key(source))
}
