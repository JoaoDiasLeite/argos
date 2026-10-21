import { useEffect, useState } from 'react'

/**
 * The read-only despiste runbook shipped with Argos. Its path comes from the main process
 * once per window (it never changes while the app runs). It is never a recent runbook, and
 * reports of its runs are saved to `~/argos/reports` rather than beside it.
 */

let pending: Promise<string | null> | null = null

export function fetchBuiltinRunbook(): Promise<string | null> {
  pending ??= window.electronAPI
    .opsBuiltinRunbook()
    .then((r) => r.path)
    .catch(() => {
      pending = null
      return null
    })
  return pending
}

/** The built-in runbook's folder, or `null` until it has arrived. */
export function useBuiltinRunbook(): string | null {
  const [dir, setDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchBuiltinRunbook().then((p) => !cancelled && setDir(p))
    return () => {
      cancelled = true
    }
  }, [])
  return dir
}

const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

/** Same folder, ignoring slash direction, a trailing slash and case (paths here are Windows-first). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && norm(a) === norm(b)
}
