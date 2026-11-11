import * as path from 'path'

/** True when `candidate` resolves to a path strictly inside `root` (not `root` itself,
 *  not a sibling sharing a prefix, not a `..` escape). Purely lexical: no symlink
 *  resolution. Case-insensitive where `path` is (win32). */
export function isStrictlyInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
