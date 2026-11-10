import { useEffect, useState } from 'react'

/**
 * The runbooks shipped with Argos: the read-only despiste and the base intervention
 * (docs/BASE_INTERVENTION_PLAN.md). Their paths come from the main process once per
 * window (they never change while the app runs). Neither is ever a loose runbook, and
 * reports of their runs, like any other, go to the folders of Settings.
 */

let pending: Promise<{ path: string; intervention: string } | null> | null = null

function fetchBuiltins(): Promise<{ path: string; intervention: string } | null> {
  pending ??= window.electronAPI.opsBuiltinRunbook().catch(() => {
    pending = null
    return null
  })
  return pending
}

/** The despiste runbook's folder. */
export function fetchBuiltinRunbook(): Promise<string | null> {
  return fetchBuiltins().then((r) => r?.path ?? null)
}

/** The base intervention's folder. */
export function fetchBaseRunbook(): Promise<string | null> {
  return fetchBuiltins().then((r) => r?.intervention ?? null)
}

function useFetched(fetch: () => Promise<string | null>): string | null {
  const [dir, setDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetch().then((p) => !cancelled && setDir(p))
    return () => {
      cancelled = true
    }
  }, [fetch])
  return dir
}

/** The despiste runbook's folder, or `null` until it has arrived. */
export function useBuiltinRunbook(): string | null {
  return useFetched(fetchBuiltinRunbook)
}

/** The base intervention's folder, or `null` until it has arrived. */
export function useBaseRunbook(): string | null {
  return useFetched(fetchBaseRunbook)
}

const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

/** Same folder, ignoring slash direction, a trailing slash and case (paths here are Windows-first). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && norm(a) === norm(b)
}
