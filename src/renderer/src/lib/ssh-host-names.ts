import { useEffect, useState } from 'react'

/**
 * The saved SSH hosts' names by id, for naming an intervention by its server where only
 * the scope's host id is at hand (the tabs, Home's Running list). Fetched again whenever
 * an id asked for is not in the last list, so a host added since is picked up.
 */

let names: Record<string, string> = {}
let pending: Promise<void> | null = null

function refresh(): Promise<void> {
  pending ??= window.electronAPI
    .sshList()
    .then((list) => {
      names = Object.fromEntries(list.map((h) => [h.id, h.name]))
    })
    .catch(() => undefined)
    .finally(() => {
      pending = null
    })
  return pending
}

/** Names of the given hosts, as far as they are known; refetched when one is missing. */
export function useSshHostNames(ids: readonly string[]): Record<string, string> {
  const [known, setKnown] = useState(names)
  const missing = ids.filter((id) => !(id in known)).sort().join('\n')
  useEffect(() => {
    if (!missing) return
    let cancelled = false
    void refresh().then(() => !cancelled && setKnown(names))
    return () => {
      cancelled = true
    }
  }, [missing])
  return known
}
