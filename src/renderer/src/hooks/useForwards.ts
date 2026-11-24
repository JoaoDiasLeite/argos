import { useEffect, useState } from 'react'
import type { ForwardStatus } from '../types'

/**
 * The tunnels main knows about, kept current: the list on mount, then every
 * `ssh:forwards-changed`. Running ones have `active`; ones that stopped on their own stay
 * listed with the reason until started again or dismissed.
 */
export function useForwards(): ForwardStatus[] {
  const [list, setList] = useState<ForwardStatus[]>([])
  useEffect(() => {
    let live = true
    // An event that lands before the first list is newer than it.
    let heard = false
    const off = window.electronAPI.onForwardsChanged((next) => {
      heard = true
      if (live) setList(next)
    })
    window.electronAPI
      .forwardsList()
      .then((next) => {
        if (live && !heard) setList(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return list
}
