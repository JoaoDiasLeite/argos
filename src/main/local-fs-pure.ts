/**
 * Pure, dependency-free helpers for the local-fs IPC (src/main/local-fs.ts) — the guarded
 * write/mkdir/rename/delete backing the WSL "Connect" file browser (LocalBrowser), which
 * operates over a distro's Windows-side share (\\wsl.localhost\<distro>\…). Split out so
 * they're unit-testable without pulling in `fs`.
 */

/**
 * True for a path that a "delete" must never be allowed to hit: a drive root (C:\, C:),
 * a bare UNC host (\\host), a UNC share root (\\host\share, \\host\share\ — the root of a
 * WSL distro's share), or a POSIX root (/). Anything with a real path segment past the
 * root returns false.
 */
export function isRootPath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p === '/') return true
  const norm = p.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(norm)) return true // C:  or  C:\  /  C:/
  if (/^\\\\[^\\]+$/.test(norm)) return true // \\host
  if (/^\\\\[^\\]+\\[^\\]+$/.test(norm)) return true // \\host\share
  return false
}

/**
 * Map a WSL distro's POSIX path to its Windows-side UNC path — the path LocalBrowser's fs
 * calls actually operate on. Mirrors wsl.ts's uncToWslPath in reverse.
 */
export function posixToWslUnc(distro: string, posixPath: string): string {
  const clean = posixPath.startsWith('/') ? posixPath : `/${posixPath}`
  return `\\\\wsl.localhost\\${distro}${clean.replace(/\//g, '\\')}`
}
