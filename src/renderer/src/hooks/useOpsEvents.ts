import { useEffect, useState } from 'react'
import type { OpsLiveEvent } from '../types'

// The live lines of every ops run seen since this module first loaded, per terminal (the
// terminal id is the ops session's appSessionId). Held at module level rather than in a
// component so leaving the workspace, or closing the report, does not lose a run's history:
// the subscription outlives any one mount. Lines from before this app start come from the
// ledger, merged in once per session.
const buffers = new Map<string, OpsLiveEvent[]>()
const listeners = new Set<(appSessionId: string) => void>()
// Sessions whose ledger history was already merged into the buffer (or is being fetched).
const historyState = new Map<string, Promise<void>>()
let subscribed = false

const eventKey = (e: OpsLiveEvent): string =>
  `${e.line?.prev}|${e.line?.at}|${e.line?.event?.kind}|${e.line?.event?.callId ?? ''}`

/** Fetches the session's past ledger lines once and puts them BEFORE any live ones. */
function loadHistory(appSessionId: string): Promise<void> {
  let p = historyState.get(appSessionId)
  if (!p) {
    p = window.electronAPI
      .opsSessionEvents(appSessionId)
      .then((res) => {
        if (!res.ok) return
        const seen = new Set(res.events.map(eventKey))
        const live = (buffers.get(appSessionId) ?? []).filter((e) => !seen.has(eventKey(e)))
        buffers.set(appSessionId, [...res.events, ...live])
        listeners.forEach((fn) => fn(appSessionId))
      })
      .catch(() => {
        historyState.delete(appSessionId)
      })
    historyState.set(appSessionId, p)
  }
  return p
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.electronAPI.onOpsEvent((data) => {
    if (!data || typeof data.appSessionId !== 'string') return
    const list = buffers.get(data.appSessionId) ?? []
    const key = eventKey(data)
    if (list.some((e) => eventKey(e) === key)) return
    buffers.set(data.appSessionId, [...list, data])
    listeners.forEach((fn) => fn(data.appSessionId))
  })
}

/** Every ledger line of one ops session (a terminal's runs), history first, then live. */
export function useOpsEvents(appSessionId: string | undefined): { events: OpsLiveEvent[]; loading: boolean } {
  const [events, setEvents] = useState<OpsLiveEvent[]>(() => (appSessionId ? buffers.get(appSessionId) ?? [] : []))
  const [loading, setLoading] = useState(!!appSessionId)
  useEffect(() => {
    if (!appSessionId) {
      setEvents([])
      setLoading(false)
      return
    }
    ensureSubscribed()
    setEvents(buffers.get(appSessionId) ?? [])
    let alive = true
    setLoading(true)
    void loadHistory(appSessionId).finally(() => {
      if (alive) setLoading(false)
    })
    const fn = (id: string) => {
      if (id === appSessionId) setEvents(buffers.get(appSessionId) ?? [])
    }
    listeners.add(fn)
    return () => {
      alive = false
      listeners.delete(fn)
    }
  }, [appSessionId])
  return { events, loading }
}
