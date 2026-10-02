import { createContext } from 'react'

/**
 * Whether the terminals rendered below this point may use the GPU renderer.
 *
 * It exists because the decision is made by `PaneGrid` and acted on by `ChatTerminal`, and
 * the two are four components apart: PaneGrid → ChatPane → Chat → ChatTerminal. The two in
 * the middle have nothing to say about rendering, so threading an `accelerated` prop through
 * them would be noise in files that only forward it.
 *
 * It lives in a module of its own, rather than next to the component that reads it, on
 * purpose: `Chat` `lazy()`-loads `ChatTerminal` to keep xterm and its
 * addons out of the main chunk, and importing anything from `ChatTerminal.tsx` here would
 * drag all of that back into it.
 *
 * The default is `false` — every terminal that is not explicitly inside a provider (a Remote
 * Session's terminal) keeps the DOM renderer. That default is load-bearing, not caution:
 * Chromium caps live WebGL contexts per renderer process (~16), and terminals outside the
 * workspace panes have no such ceiling on their number, so accelerating by default would
 * hand out contexts until the cap evicted them and terminals started losing their context in
 * a cascade.
 */
export const TerminalAccelContext = createContext(false)
