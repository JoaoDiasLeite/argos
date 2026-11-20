/**
 * A small LRU keyed by file path and validated by mtime + size, so a transcript that has
 * not changed is not parsed again. A changed or rewritten file simply misses (the stamp
 * differs) and is overwritten; a deleted one is never asked for and ages out of the bound.
 */
export class StatCache<V> {
  private readonly map = new Map<string, { mtimeMs: number; size: number; value: V }>()

  constructor(private readonly max: number) {}

  get(file: string, mtimeMs: number, size: number): V | undefined {
    const hit = this.map.get(file)
    if (!hit) return undefined
    if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
      this.map.delete(file)
      return undefined
    }
    // Refresh recency: Map iterates in insertion order.
    this.map.delete(file)
    this.map.set(file, hit)
    return hit.value
  }

  set(file: string, mtimeMs: number, size: number, value: V): void {
    this.map.delete(file)
    this.map.set(file, { mtimeMs, size, value })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  delete(file: string): void {
    this.map.delete(file)
  }

  get size(): number {
    return this.map.size
  }
}
