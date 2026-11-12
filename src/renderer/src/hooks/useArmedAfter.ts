import { useEffect, useState } from 'react'

/** Delay before an approval's actions answer, so a click or key aimed at what was on screen
 *  a moment ago cannot answer a request the operator has not read. */
export const ARM_DELAY_MS = 400

/**
 * Whether the actions of the request `id` are armed: false for the first `ms` after the id
 * appears, true after. Re-arms (starts unarmed again) whenever `id` changes, including when
 * the next request takes the same spot without remounting. Derived from the id the timer
 * armed, so the render right after a change is already unarmed.
 */
export function useArmedAfter(id: string, ms: number = ARM_DELAY_MS): boolean {
  const [armedFor, setArmedFor] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setArmedFor(id), ms)
    return () => clearTimeout(timer)
  }, [id, ms])
  return armedFor === id
}
