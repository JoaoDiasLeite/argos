import { useEffect, useRef } from 'react'
import { createDebouncedSaver, type DebouncedSaver } from '../lib/debounced-saver'

/**
 * Per-key debounced saver that flushes (never drops) pending saves when the component
 * unmounts or the window is hidden/closed. `save` and `onResult` may change between
 * renders; the latest ones are used.
 */
export function useDebouncedSaver<T>(opts: {
  delay: number
  save: (value: T) => Promise<unknown> | void
  onResult?: (error: unknown | null) => void
}): DebouncedSaver<T> {
  const latest = useRef(opts)
  latest.current = opts
  const ref = useRef<DebouncedSaver<T> | null>(null)
  if (!ref.current) {
    ref.current = createDebouncedSaver<T>({
      delay: opts.delay,
      save: (v) => latest.current.save(v),
      onResult: (e) => latest.current.onResult?.(e)
    })
  }
  const saver = ref.current
  useEffect(() => {
    const onHide = (): void => saver.flushAll()
    window.addEventListener('beforeunload', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('beforeunload', onHide)
      window.removeEventListener('pagehide', onHide)
      saver.flushAll()
    }
  }, [saver])
  return saver
}
