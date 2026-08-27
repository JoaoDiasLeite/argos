/**
 * Tag filtering. Lives on the renderer side because filtering is a view concern —
 * the main process reads and writes tag sets, it never narrows a list by them.
 * Keeping it here rather than beside `normalizeTags` avoids a second copy that
 * would eventually disagree with this one.
 */

export type TagFilterMode = 'all' | 'any'

/**
 * Does a session's tag set satisfy the filter?
 *
 * `all` requires every selected tag; `any` requires one. An empty filter matches
 * everything, so the caller never has to special-case "no filter active".
 */
export function tagsSatisfy(sessionTags: string[], wanted: string[], mode: TagFilterMode): boolean {
  if (wanted.length === 0) return true
  const have = new Set(sessionTags)
  return mode === 'all' ? wanted.every((t) => have.has(t)) : wanted.some((t) => have.has(t))
}
