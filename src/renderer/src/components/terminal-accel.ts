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
 * purpose: `Chat` and `LiveView` both `lazy()`-load `ChatTerminal` to keep xterm and its
 * addons out of the main chunk, and importing anything from `ChatTerminal.tsx` here would
 * drag all of that back into it.
 *
 * The default is `false` — every terminal that is not explicitly inside a provider (the Live
 * view's grid, a Remote Session's terminal) keeps the DOM renderer. That default is
 * load-bearing, not caution: Chromium caps live WebGL contexts per renderer process (~16),
 * and the Live view mounts one terminal per running pty, so accelerating by default would
 * hand out contexts until the cap evicted them and terminals started losing their context in
 * a cascade.
 */
export const TerminalAccelContext = createContext(false)
