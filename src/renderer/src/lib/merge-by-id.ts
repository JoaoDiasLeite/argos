/**
 * Append the items of `incoming` whose key is not in `current` yet, keeping `current` as
 * it is (and returning it unchanged when nothing is new, so a state setter can bail out).
 * Used to merge prompts pulled from main (`ops:pending`) into queues a live push may have
 * filled first.
 */
export function mergeById<T>(current: T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key))
  const added: T[] = []
  for (const item of incoming) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    added.push(item)
  }
  return added.length ? [...current, ...added] : current
}
