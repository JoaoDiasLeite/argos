/**
 * Debounced persistence with one pending save per key (a sprint id, a week start).
 * Saves for different keys never cancel each other, and a pending save can be flushed
 * (run now with the latest payload) instead of dropped — on unmount or page hide.
 */
export interface DebouncedSaver<T> {
  /** Queue `value` for `key`, replacing any pending payload for that key. */
  schedule: (key: string, value: T) => void
  /** Run the pending save for `key` now (no-op when none is pending). */
  flush: (key: string) => void
  /** Run every pending save now. */
  flushAll: () => void
  /** Drop a pending save without running it (e.g. the record was deleted). */
  discard: (key: string) => void
}

export function createDebouncedSaver<T>(opts: {
  delay: number
  save: (value: T) => Promise<unknown> | void
  onResult?: (error: unknown | null) => void
}): DebouncedSaver<T> {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: T }>()

  const run = (value: T): void => {
    try {
      const r = opts.save(value)
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        ;(r as Promise<unknown>).then(
          () => opts.onResult?.(null),
          (e) => opts.onResult?.(e ?? new Error('save failed'))
        )
      } else opts.onResult?.(null)
    } catch (e) {
      opts.onResult?.(e ?? new Error('save failed'))
    }
  }

  const flush = (key: string): void => {
    const p = pending.get(key)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(key)
    run(p.value)
  }

  return {
    schedule: (key, value) => {
      const prev = pending.get(key)
      if (prev) clearTimeout(prev.timer)
      pending.set(key, { value, timer: setTimeout(() => flush(key), opts.delay) })
    },
    flush,
    flushAll: () => {
      for (const key of [...pending.keys()]) flush(key)
    },
    discard: (key) => {
      const p = pending.get(key)
      if (p) clearTimeout(p.timer)
      pending.delete(key)
    }
  }
}
