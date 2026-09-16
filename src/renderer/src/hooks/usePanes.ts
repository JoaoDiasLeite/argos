// React glue for `lib/panes.ts`: owns the `PaneState`, persists it to localStorage,
// and exposes the pure functions from the lib as stable callbacks. All decisions
// about what a state transition means live in the lib — this hook only wires
// `setState` to it and handles storage I/O (which the lib deliberately avoids).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  closePane as closePaneImpl,
  emptyState,
  normalize,
  openInFocused as openInFocusedImpl,
  insertPane as insertPaneImpl,
  openInNewPane as openInNewPaneImpl,
  setFocus as setFocusImpl,
  setLayout as setLayoutImpl,
  setSizes as setSizesImpl,
  type LayoutId,
  type PaneState
} from '../lib/panes'

const STORAGE_KEY = 'argos.panes.v1'
const PERSIST_DEBOUNCE_MS = 250

export function usePanes() {
  // Starts empty on purpose: restoring from localStorage needs the list of known
  // session ids, which only arrives once sessions have loaded (see `restore`).
  const [state, setState] = useState<PaneState>(emptyState)

  const openInFocused = useCallback((sessionId: string) => {
    setState((prev) => openInFocusedImpl(prev, sessionId))
  }, [])

  const openInNewPane = useCallback((sessionId: string) => {
    setState((prev) => openInNewPaneImpl(prev, sessionId))
  }, [])

  // The drag-and-drop sibling of `openInNewPane`: the gesture already decided the position
  // and the target layout, so this hook only forwards them (see `insertPane` in lib/panes.ts).
  const insertPane = useCallback((sessionId: string, index: number, layout: LayoutId) => {
    setState((prev) => insertPaneImpl(prev, sessionId, index, layout))
  }, [])

  const closePane = useCallback((sessionId: string) => {
    setState((prev) => closePaneImpl(prev, sessionId))
  }, [])

  const setFocus = useCallback((sessionId: string) => {
    setState((prev) => setFocusImpl(prev, sessionId))
  }, [])

  const setLayout = useCallback((layout: LayoutId) => {
    setState((prev) => setLayoutImpl(prev, layout))
  }, [])

  const setSizes = useCallback((sizes: { cols?: number[]; rows?: number[] }) => {
    setState((prev) => setSizesImpl(prev, sizes))
  }, [])

  // Reads the persisted state and applies it, filtered down to sessions that still
  // exist. Doesn't depend on the current pane state — it replaces it outright — so
  // it returns the restored state directly, letting the caller decide what to do
  // when restoration yields no panes (e.g. first run, or a wiped/invalid entry).
  const restore = useCallback((knownSessionIds: string[]): PaneState => {
    restored.current = true
    let raw: unknown = null
    try {
      const item = window.localStorage.getItem(STORAGE_KEY)
      raw = item ? JSON.parse(item) : null
    } catch {
      raw = null
    }
    const next = normalize(raw, knownSessionIds)
    setState(next)
    return next
  }, [])

  // Nothing may be written before `restore` has read: the state starts empty, the
  // caller only restores once sessions have loaded (several awaits later), and a
  // debounced write landing in that window would save an empty layout over the saved
  // one — which reads as "restoring is broken" when in fact the save destroyed it.
  const restored = useRef(false)

  // Debounced persistence: localStorage writes are cheap but not free, and pane
  // changes (e.g. dragging a resize handle) can fire in bursts.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!restored.current) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // localStorage can fail (private mode, storage full, disabled) — never let
        // that take the app down.
      }
    }, PERSIST_DEBOUNCE_MS)
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [state])

  return {
    panes: state.panes,
    layout: state.layout,
    focused: state.focused,
    sizes: state.sizes,
    openInFocused,
    openInNewPane,
    insertPane,
    closePane,
    setFocus,
    setLayout,
    setSizes,
    restore
  }
}
