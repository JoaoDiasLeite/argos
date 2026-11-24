import { useSyncExternalStore } from 'react'

// The hidden "experimental features" switch (config.json `labs`), as every component reads
// it. One store per window rather than a provider: the main window, the pop-outs and any
// other window that renders a gated component each hear `config:labs` on their own, and a
// component needs no wrapper to ask. Read once from the config, then followed, so turning it
// on or off in Settings shows or hides the gated UI everywhere without a restart.

let current = false
let started = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  if (!api) return
  api.onLabs((on) => set(on))
  api
    .getConfig()
    .then((config) => set(config.labs === true))
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): boolean => current

/** Whether the experimental features are on. False until the config has been read. */
export function useLabs(): boolean {
  return useSyncExternalStore(subscribe, snapshot)
}
