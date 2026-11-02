import { BrowserWindow, globalShortcut, screen, systemPreferences, type WebContents } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { getConfig } from './config'
import { companionStore } from './companion-store'
import {
  PET_SIZE,
  bubblePlacement,
  clampBubbleSize,
  petHitTest,
  restoredPetPosition,
  snapToEdge,
  type Point,
  type Rect,
  type Size
} from './companion-window-pure'
import { voiceShortcutCandidates } from './companion-voice-pure'
import { canWalk, nextWalkDelay, planWalk, stepToward, type WalkPlan } from './companion-walk-pure'
import { VOICE_SHORTCUT_DEFAULTS } from './companion-types'
import type {
  CompanionBubbleAnchor,
  CompanionBubblePayload,
  CompanionPetFacing,
  CompanionPetState,
  CompanionPrefs,
  CompanionVoicePhase
} from './companion-types'

// The desktop companion (docs/COMPANION_PLAN.md §9.1): two windows, both created on
// first show. The PET is small, transparent, never focusable and click-through except
// over the dog — main polls the cursor to decide, because `forward: true` mousemove
// cannot be relied on (§9.1 spike). The BUBBLE is a separate focusable window beside
// the dog's head, so text entry never touches the pet's hit-testing. The reminder
// queue and the IPC are in index.ts; this file is windows, placement and the shortcut.

/** How often the cursor is read while the pet is up, and while it is being dragged. */
const POLL_MS = 50
const DRAG_POLL_MS = 16
/** While walking the same poll moves the window, at about 30 fps. */
const WALK_POLL_MS = 33

/**
 * Test hook for the isolated visual check: ARGOS_COMPANION_WALK_SOON=1 makes every walk
 * come 3 s after the last instead of 3–8 min. Nothing else changes; unset in normal use.
 */
const WALK_SOON = process.env['ARGOS_COMPANION_WALK_SOON'] === '1'
const WALK_SOON_MS = 3000

/** `happy` is the renderer's 1 s beat (Pet.tsx HAPPY_MS); main counts it as idle after it. */
const HAPPY_MS = 1000

/** With "stay on screen" off, how long the pet lingers after its bubble closes. */
const IDLE_HIDE_MS = 4000

const DEFAULT_BUBBLE_SIZE: Size = { width: 320, height: 120 }

let petWindow: BrowserWindow | null = null
let bubbleWindow: BrowserWindow | null = null
let registeredShortcut = ''
let registeredVoiceShortcut = ''
/** What the bubble is doing with the microphone; while busy, a blur does not close it. */
let voicePhase: CompanionVoicePhase = 'idle'
/** A capture is waiting on the model for its date (plan §5.1, layer 2); a blur does not close the bubble. */
let captureThinking = false

let pollTimer: ReturnType<typeof setInterval> | null = null
let ignoring = true
/** The one extra element the renderer said should take clicks, in window DIPs. */
let extraHitRect: Rect | null = null
let drag: { cursor: Point; window: Point } | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

let petState: CompanionPetState = 'idle'
let petFacing: CompanionPetFacing = 'right'
let happyTimer: ReturnType<typeof setTimeout> | null = null
/** The walk under way (x kept fractional, the window gets the rounded value), and the next one's timer. */
let walk: (WalkPlan & { x: number; last: number }) | null = null
let walkTimer: ReturnType<typeof setTimeout> | null = null
let bubble: CompanionBubblePayload | null = null
let bubbleAnchor: CompanionBubbleAnchor = 'above-left'
let bubbleSize: Size = DEFAULT_BUBBLE_SIZE

export interface CompanionWindowHooks {
  /** The pet was shown or hidden (the tray's checkbox follows it). */
  onVisibilityChanged?: () => void
  /** The bubble closed, for whatever reason: the next queued reminder can go up. */
  onBubbleClosed?: (mode: CompanionBubblePayload['mode']) => void
  /** A reminder or catch-up is waiting for the bubble (the queue is index.ts's): no walking. */
  hasPendingAlerts?: () => boolean
}

let hooks: CompanionWindowHooks = {}

export function setCompanionWindowHooks(next: CompanionWindowHooks): void {
  hooks = next
}

const prefs = (): CompanionPrefs => getConfig().companion

const alive = (win: BrowserWindow | null): win is BrowserWindow => !!win && !win.isDestroyed()

/** The accelerator that actually got registered ('' if none was available). */
export function companionShortcut(): string {
  return registeredShortcut
}

function loadEntry(win: BrowserWindow, hash: 'pet' | 'bubble'): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/companion.html#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/companion.html'), { hash })
  }
}

/** Send once the renderer has loaded, with a grace period for React to subscribe. */
function send(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!alive(win)) return
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (alive(win)) win.webContents.send(channel, payload)
      }, 400)
    })
  } else {
    win.webContents.send(channel, payload)
  }
}

export function sendToPet(channel: string, payload?: unknown): void {
  send(petWindow, channel, payload)
}

export function sendToBubble(channel: string, payload?: unknown): void {
  send(bubbleWindow, channel, payload)
}

function createPetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never grab focus: the pet sits over whatever João is typing in.
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setContentProtection(prefs().hideFromCapture)
  win.setIgnoreMouseEvents(true, { forward: true })
  ignoring = true
  win.on('closed', () => {
    stopPolling()
    drag = null
    walk = null
    cancelWalkTimer()
    if (petWindow === win) petWindow = null
  })
  hardenWebContents(win)
  loadEntry(win, 'pet')
  petWindow = win
  return win
}

function createBubbleWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: bubbleSize.width,
    height: bubbleSize.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setContentProtection(prefs().hideFromCapture)
  // Typing dismisses like the quick launcher when focus moves on; a reminder stays put
  // until it is answered. Skipped while devtools are open (opening them blurs).
  win.on('blur', () => {
    // Nor while dictating: the recording goes on if João clicks elsewhere to look at something.
    if (bubble?.mode !== 'input' || voicePhase !== 'idle' || captureThinking || win.webContents.isDevToolsOpened()) return
    closeBubble()
  })
  win.on('closed', () => {
    if (bubbleWindow === win) bubbleWindow = null
  })
  hardenWebContents(win)
  loadEntry(win, 'bubble')
  bubbleWindow = win
  return win
}

// ─── Click-through and drag ────────────────────────────────────────────────────

function setIgnore(ignore: boolean): void {
  if (!alive(petWindow) || ignore === ignoring) return
  ignoring = ignore
  petWindow.setIgnoreMouseEvents(ignore, { forward: true })
}

function poll(): void {
  if (!alive(petWindow) || !petWindow.isVisible()) {
    stopPolling()
    return
  }
  const cursor = screen.getCursorScreenPoint()
  if (drag) {
    const x = drag.window.x + cursor.x - drag.cursor.x
    const y = drag.window.y + cursor.y - drag.cursor.y
    petWindow.setPosition(Math.round(x), Math.round(y))
    placeBubble()
    setIgnore(false)
    return
  }
  const over = petHitTest(cursor, petWindow.getBounds(), extraHitRect)
  setIgnore(!over)
  if (walk) stepWalk(petWindow, over)
}

function startPolling(ms = POLL_MS): void {
  stopPolling()
  pollTimer = setInterval(poll, ms)
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** The renderer's mousedown on the dog: follow the cursor until drag-end. */
export function startPetDrag(): void {
  if (!alive(petWindow) || !petWindow.isVisible()) return
  stopWalk()
  const [x, y] = petWindow.getPosition()
  drag = { cursor: screen.getCursorScreenPoint(), window: { x, y } }
  startPolling(DRAG_POLL_MS)
}

/** Drop: snap to the nearer side of that display and remember it for the display. */
export function endPetDrag(): void {
  if (!drag) return
  drag = null
  startPolling(POLL_MS)
  if (!alive(petWindow)) return
  const b = petWindow.getBounds()
  // The display the dog was dropped on, by the window's centre; positions are clamped to
  // its work area, which also settles a drag across displays of different scale.
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const pos = snapToEdge({ x: b.x, y: b.y }, display.workArea)
  petWindow.setPosition(pos.x, pos.y)
  placeBubble()
  savePetPosition(display.id, pos)
  scheduleWalk()
}

/** Remember where the pet is on this display (a drop, or the end of a walk). */
function savePetPosition(displayId: number, pos: Point): void {
  try {
    const positions = { ...(companionStore().getState().positions ?? {}), [String(displayId)]: pos }
    companionStore().setState({ positions })
  } catch (e) {
    console.error('[companion] could not save the pet position:', e)
  }
}

// ─── Walking (plan §11, batch L) ───────────────────────────────────────────────

function cancelWalkTimer(): void {
  if (walkTimer) clearTimeout(walkTimer)
  walkTimer = null
}

/** Re-roll the next walk: after each walk, and after any interaction. Off → no timer. */
function scheduleWalk(): void {
  cancelWalkTimer()
  const p = prefs()
  if (!p.stayOnScreen || !p.walk || !isCompanionVisible()) return
  walkTimer = setTimeout(tryWalk, WALK_SOON ? WALK_SOON_MS : nextWalkDelay())
}

function reducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

function dndOn(): boolean {
  try {
    const until = companionStore().getState().dndUntil
    return typeof until === 'number' && until > Date.now()
  } catch {
    return false
  }
}

/** `withDnd` reads state.json, so only when a walk starts; while walking dnd arrives as `shh`. */
function walkAllowed(cursorOverPet: boolean, withDnd: boolean): boolean {
  const p = prefs()
  return canWalk({
    stayOnScreen: p.stayOnScreen,
    walkPref: p.walk,
    visible: isCompanionVisible(),
    petState,
    bubbleOpen: bubble !== null,
    alertsPending: hooks.hasPendingAlerts?.() ?? false,
    dnd: withDnd ? dndOn() : false,
    cursorOverPet,
    dragging: drag !== null,
    voiceBusy: voicePhase !== 'idle',
    reducedMotion: reducedMotion()
  })
}

/** The walk timer: stand up and go, if nothing says sit; otherwise try again later. */
function tryWalk(): void {
  walkTimer = null
  if (!alive(petWindow) || walk) return
  const b = petWindow.getBounds()
  const over = petHitTest(screen.getCursorScreenPoint(), b, extraHitRect)
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  // Not on the floor (docked half way up a side): planWalk says null and he stays put.
  const plan = walkAllowed(over, true) ? planWalk(b, display.workArea) : null
  if (!plan) {
    scheduleWalk()
    return
  }
  walk = { ...plan, x: plan.fromX, last: Date.now() }
  petFacing = plan.facing
  sendToPet('companion:pet-facing', plan.facing)
  setPetState('walking')
  startPolling(WALK_POLL_MS)
}

/** One poll tick of a walk: stop if anything says sit, else move on, and sit on arrival. */
function stepWalk(win: BrowserWindow, cursorOverPet: boolean): void {
  if (!walk) return
  if (!walkAllowed(cursorOverPet, false)) {
    stopWalk()
    return
  }
  const now = Date.now()
  // A stalled event loop resumes at walking pace instead of jumping.
  walk.x = stepToward(walk.x, walk.toX, Math.min(now - walk.last, 200))
  walk.last = now
  const [, y] = win.getPosition()
  win.setPosition(Math.round(walk.x), y)
  if (walk.x === walk.toX) stopWalk()
}

/** Sit down where he is, remember it for this display, and roll the next walk. */
function stopWalk(): void {
  if (!walk) return
  walk = null
  if (pollTimer && !drag) startPolling(POLL_MS)
  if (petState === 'walking') setPetState('idle')
  if (alive(petWindow)) {
    const b = petWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    savePetPosition(display.id, { x: b.x, y: b.y })
  }
  scheduleWalk()
}

/** The renderer's extra hit area (a menu, a badge), in window DIPs; null clears it. */
export function setPetHitRect(rect: Rect | null): void {
  extraHitRect = rect
}

// ─── Showing and hiding ────────────────────────────────────────────────────────

function cancelIdleHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

function placePet(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const saved = companionStore().getState().positions?.[String(display.id)]
  const pos = restoredPetPosition(saved, display.workArea)
  win.setBounds({ x: pos.x, y: pos.y, width: PET_SIZE, height: PET_SIZE })
}

/** Show the pet without taking focus. Placed afresh only when it was hidden. */
function showPet(): BrowserWindow {
  cancelIdleHide()
  const win = alive(petWindow) ? petWindow : createPetWindow()
  if (!win.isVisible()) {
    placePet(win)
    win.setIgnoreMouseEvents(true, { forward: true })
    ignoring = true
    win.showInactive()
    startPolling()
    hooks.onVisibilityChanged?.()
    scheduleWalk()
  }
  return win
}

function hidePet(): void {
  cancelIdleHide()
  // Sits and saves first, while the window is still up.
  stopWalk()
  stopPolling()
  drag = null
  // Quietly: nothing queued should pop the pet straight back up.
  hideBubbleWindow(false)
  if (alive(petWindow) && petWindow.isVisible()) {
    petWindow.hide()
    hooks.onVisibilityChanged?.()
  }
  cancelWalkTimer()
}

export function setPetState(state: CompanionPetState): void {
  petState = state
  // Anything else the pet is told to do ends a walk (and rolls the next one).
  if (state !== 'walking') {
    stopWalk()
    scheduleWalk()
  }
  if (happyTimer) clearTimeout(happyTimer)
  happyTimer = null
  // The renderer sits him down after its beat on its own; main follows, so he can walk again.
  if (state === 'happy') {
    happyTimer = setTimeout(() => {
      happyTimer = null
      if (petState === 'happy') petState = 'idle'
    }, HAPPY_MS)
  }
  sendToPet('companion:pet-state', state)
}

export function currentPetFacing(): CompanionPetFacing {
  return petFacing
}

export function currentPetState(): CompanionPetState {
  return petState
}

export function isCompanionVisible(): boolean {
  return alive(petWindow) && petWindow.isVisible()
}

/** The pet up, and with `focusInput` the bubble open for typing. */
export function showCompanion(opts: { focusInput?: boolean } = {}): void {
  showPet()
  if (opts.focusInput) openBubble({ mode: 'input', payload: null })
}

/** Down, bubble and all, whatever "stay on screen" says. */
export function hideCompanion(): void {
  hidePet()
}

/**
 * The summon shortcut and the tray entry. Up → the pet with the bubble ready to type;
 * already up with the bubble open → the bubble closes, and the pet goes too unless it
 * is set to stay on screen.
 */
export function toggleCompanion(): void {
  if (isCompanionVisible() && bubble) {
    closeBubble()
    // Closing may have brought up the next queued reminder; that one stays.
    if (!bubble && !prefs().stayOnScreen) hidePet()
    return
  }
  showCompanion({ focusInput: true })
}

// ─── The bubble ────────────────────────────────────────────────────────────────

/** Next to the pet's head, from the pet's bounds and its display's work area. */
function placeBubble(): void {
  if (!alive(bubbleWindow) || !alive(petWindow) || !bubbleWindow.isVisible()) return
  positionBubble(bubbleWindow)
}

function positionBubble(win: BrowserWindow): void {
  if (!alive(petWindow)) return
  const pet = petWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 })
  const place = bubblePlacement(pet, bubbleSize, display.workArea)
  win.setBounds({ x: place.x, y: place.y, width: bubbleSize.width, height: bubbleSize.height })
  if (place.anchor !== bubbleAnchor) {
    bubbleAnchor = place.anchor
    send(win, 'companion:bubble-anchor', bubbleAnchor)
  }
}

/**
 * Open the bubble in a mode. Typing ('input') shows it focused and tells it to reset;
 * anything the pet says on its own shows it without taking focus from what João is in.
 */
export function openBubble(next: CompanionBubblePayload): void {
  // Sit down first, so the bubble is placed against where he stopped.
  stopWalk()
  showPet()
  const win = alive(bubbleWindow) ? bubbleWindow : createBubbleWindow()
  bubble = next
  positionBubble(win)
  send(win, 'companion:bubble-anchor', bubbleAnchor)
  send(win, 'companion:bubble-mode', next)
  if (next.mode === 'input') {
    win.show()
    win.focus()
    send(win, 'companion:shown')
    setPetState('listening')
  } else {
    win.showInactive()
  }
}

function hideBubbleWindow(notify = true): void {
  const mode = bubble?.mode
  bubble = null
  if (alive(bubbleWindow) && bubbleWindow.isVisible()) {
    bubbleWindow.hide()
    // A recording in progress is dropped: the microphone never stays open behind a hidden bubble.
    if (voicePhase !== 'idle') bubbleWindow.webContents.send('companion:bubble-hidden')
  }
  voicePhase = 'idle'
  if (mode && notify) hooks.onBubbleClosed?.(mode)
}

/** Close the bubble; with "stay on screen" off the pet follows after a few idle seconds. */
export function closeBubble(): void {
  if (!bubble) return
  hideBubbleWindow()
  // The hook may have opened the next reminder.
  if (bubble) return
  if (petState !== 'happy' && petState !== 'shh') setPetState('idle')
  if (!prefs().stayOnScreen && isCompanionVisible()) {
    cancelIdleHide()
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!bubble && !drag && !prefs().stayOnScreen) hidePet()
    }, IDLE_HIDE_MS)
  }
  scheduleWalk()
}

export function currentBubble(): (CompanionBubblePayload & { anchor: CompanionBubbleAnchor }) | null {
  return bubble ? { ...bubble, anchor: bubbleAnchor } : null
}

/** The renderer measured its content: resize, clamped, and re-place beside the head. */
export function setBubbleSize(size: Size): void {
  bubbleSize = clampBubbleSize(size)
  if (alive(bubbleWindow)) positionBubble(bubbleWindow)
}

// ─── Preferences and shortcut ──────────────────────────────────────────────────

/** Apply saved prefs to live windows: capture exclusion, and "stay on screen". */
export function applyCompanionPrefs(next: CompanionPrefs): void {
  for (const win of [petWindow, bubbleWindow]) {
    if (alive(win)) win.setContentProtection(next.hideFromCapture)
  }
  if (!next.walk || !next.stayOnScreen) stopWalk()
  if (next.stayOnScreen) {
    showPet()
  } else if (isCompanionVisible() && !bubble) {
    hidePet()
  }
  // On → the next walk is rolled; off → the timer goes (scheduleWalk reads the new prefs).
  scheduleWalk()
}

/**
 * Register the summon shortcut: `preferred` (from settings) first, then the defaults.
 * Never Ctrl+Shift+A — Teams takes it to accept a video call.
 */
export function registerCompanionShortcut(preferred?: string): string {
  const candidates = [preferred, 'Ctrl+Alt+A', 'Ctrl+Shift+Alt+A'].filter(
    (a, i, arr): a is string => !!a && arr.indexOf(a) === i
  )
  for (const accelerator of candidates) {
    try {
      if (globalShortcut.register(accelerator, toggleCompanion)) {
        registeredShortcut = accelerator
        return accelerator
      }
    } catch {
      // invalid/blocked accelerator — try the next one
    }
  }
  registeredShortcut = ''
  return ''
}

/** Unbind only our own accelerator, then register again (like the overlay's). */
export function reregisterCompanionShortcut(preferred?: string): string {
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      // ignore — best effort
    }
    registeredShortcut = ''
  }
  return registerCompanionShortcut(preferred)
}

// ─── Dictation (plan §4.2, "Push-to-talk, as built") ───────────────────────────

/** The one window allowed the microphone (index.ts's permission handlers ask this). */
export function isCompanionBubble(contents: WebContents): boolean {
  return alive(bubbleWindow) && bubbleWindow.webContents.id === contents.id
}

/** The bubble's recording phase: the pet listens while it records and thinks while it reads. */
export function setVoicePhase(phase: CompanionVoicePhase): void {
  voicePhase = phase
  if (phase === 'recording') setPetState('listening')
  else if (phase === 'transcribing') setPetState('thinking')
  // Done: back to listening while the bubble waits for Enter, idle once it has gone.
  else if (petState === 'listening' || petState === 'thinking') setPetState(bubble?.mode === 'input' ? 'listening' : 'idle')
}

/** The model is reading a capture's date: the pet thinks, and the bubble stays up through a blur. */
export function setCaptureThinking(on: boolean): void {
  captureThinking = on
  if (on) setPetState('thinking')
  else if (petState === 'thinking') setPetState(bubble?.mode === 'input' ? 'listening' : 'idle')
}

/**
 * The dictation shortcut. globalShortcut has no key-up, so it toggles: up → the bubble
 * opens for typing and starts recording; pressed again → the bubble stops. A reminder
 * that is up stays put, as it does for a click on the dog.
 */
export function toggleDictation(): void {
  if (bubble && bubble.mode !== 'input') return
  if (bubble && alive(bubbleWindow) && bubbleWindow.isVisible()) {
    bubbleWindow.focus()
    send(bubbleWindow, 'companion:voice-toggle')
    return
  }
  showCompanion({ focusInput: true })
  sendToBubble('companion:voice-toggle')
}

/** The dictation accelerator that got registered ('' if none, or voice is off). */
export function companionVoiceShortcut(): string {
  return registeredVoiceShortcut
}

/**
 * (Re)register the dictation shortcut: off → unbound; on → `preferred`, then Ctrl+Alt+S,
 * then Ctrl+Shift+Alt+S. Never one of Teams' Ctrl+Shift letters.
 */
export function registerVoiceShortcut(enabled: boolean, preferred?: string): string {
  if (registeredVoiceShortcut) {
    try {
      globalShortcut.unregister(registeredVoiceShortcut)
    } catch {
      // ignore — best effort
    }
    registeredVoiceShortcut = ''
  }
  if (!enabled) return ''
  for (const accelerator of voiceShortcutCandidates(preferred, VOICE_SHORTCUT_DEFAULTS)) {
    // Not the summon key: one press would do both.
    if (accelerator === registeredShortcut) continue
    try {
      if (globalShortcut.register(accelerator, toggleDictation)) {
        registeredVoiceShortcut = accelerator
        return accelerator
      }
    } catch {
      // invalid/blocked accelerator — try the next one
    }
  }
  return ''
}
