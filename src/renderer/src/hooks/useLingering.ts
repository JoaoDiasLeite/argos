import { useEffect, useRef, useState } from 'react'

/** How long a closing column keeps its content while its width animates away. */
export const COLUMN_SLIDE_MS = 160

/**
 * A value that outlives its own clearing for a moment. A detail column that is mounted
 * only while something is selected would otherwise vanish in one frame and the list
 * beside it would jump to the full width; with this, the column keeps showing what it
 * showed while CSS slides its width to zero, and only then unmounts.
 *
 * `shown` is the value to render (the last non-null one until the delay passes) and
 * `open` is whether the column should be at full width.
 */
export function useLingering<T>(value: T | null | undefined, ms = COLUMN_SLIDE_MS): { shown: T | null; open: boolean } {
  const [shown, setShown] = useState<T | null>(value ?? null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (value) {
      window.clearTimeout(timer.current)
      setShown(value)
      return
    }
    timer.current = window.setTimeout(() => setShown(null), ms)
    return () => window.clearTimeout(timer.current)
  }, [value, ms])
  return { shown, open: !!value }
}
