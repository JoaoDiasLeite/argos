import { useEffect, useState } from 'react'
import type { VpnStatusEvent } from '../types'

export const vpnKey = (gatewayId: string, vpnId: string): string => `${gatewayId}\n${vpnId}`

/**
 * What main has seen of every gateway VPN, kept current: the known states on mount, then
 * every `vpn:changed`. Keyed by vpnKey. A VPN never checked has no entry (no dot).
 */
export function useVpnStates(): Record<string, VpnStatusEvent> {
  const [map, setMap] = useState<Record<string, VpnStatusEvent>>({})
  useEffect(() => {
    let live = true
    const off = window.electronAPI.onVpnChanged((ev) => {
      if (live) setMap((prev) => ({ ...prev, [vpnKey(ev.gatewayId, ev.vpnId)]: ev }))
    })
    window.electronAPI
      .vpnKnown()
      .then((list) => {
        if (!live) return
        // An event heard before the list arrived is newer than the list's entry.
        setMap((prev) => {
          const next = { ...prev }
          for (const ev of list) {
            const k = vpnKey(ev.gatewayId, ev.vpnId)
            if (!next[k] || next[k].at < ev.at) next[k] = ev
          }
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return map
}
