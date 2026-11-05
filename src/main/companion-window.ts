import { BrowserWindow, globalShortcut, screen, systemPreferences, type Menu, type WebContents } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { getConfig } from './config'
import { companionStore } from './companion-store'
import {
  bubblePlacement,
  clampBubbleSize,
  clampToArea,
  dogRect,
  petHitTest,
  petStranded,
  petWindowSize,
  restoredPetPosition,
  snapToEdge,
  type Point,
  type Size
} from './companion-window-pure'
import { voiceShortcutCandidates } from './companion-voice-pure'
import { WALK_ARRIVE_MS, WALK_STAND_MS, canWalk, nextWalkDelay, planWalk, stepToward, type WalkPlan } from './companion-walk-pure'
import { DOZE_AFTER_MS, canDoze, cursorNearPet, type DozeConditions } from './companion-doze-pure'
import { fallY, isFall, type Fall } from './companion-fall-pure'
import { restingPetState } from './companion-quiet-pure'
import { PET_SCALE, POSITIONS_VERSION, VOICE_SHORTCUT_DEFAULTS } from './companion-types'
import type {
  CompanionBubbleAnchor,
  CompanionBubblePayload,
  CompanionPetFacing,
  CompanionPetSize,
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
let drag: { cursor: Point; window: Point } | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

let petState: CompanionPetState = 'idle'
let petFacing: CompanionPetFacing = 'right'
let happyTimer: ReturnType<typeof setTimeout> | null = null
/** The walk under way (x kept fractional, the window gets the rounded value), and the next one's timer. */
let walk: (WalkPlan & { x: number; last: number; startAt: number; arriveAt: number | null }) | null = null
let walkTimer: ReturnType<typeof setTimeout> | null = null
/** The drop under way after he was let go above the floor (plan §13.3, M4). */
let fall: (Fall & { x: number; startAt: number }) | null = null
/** Counts down to a doze while he sits idle (plan §13.3, M1). */
let dozeTimer: ReturnType<typeof setTimeout> | null = null
let bubble: CompanionBubblePayload | null = null
let bubbleAnchor: CompanionBubbleAnchor = { side: 'above', tailX: 0 }
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

/** The pet window for the size setting (plan §13.3, N2). */
const petSize = (size: CompanionPetSize = prefs().size): Size => petWindowSize(PET_SCALE[size])
/** The size the live window was built or last resized for. */
let appliedSize: CompanionPetSize | null = null

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
  const size = petSize()
  appliedSize = prefs().size
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
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
    fall = null
    cancelWalkTimer()
    if (petWindow === win) petWindow = null
  })
  hardenWebContents(win)
  loadEntry(win, 'pet')
  petWindow = win
  watchDisplays()
  return win
}

// ─── Dozing (plan §13.3, M1) ───────────────────────────────────────────────────

function cancelDoze(): void {
  if (dozeTimer) clearTimeout(dozeTimer)
  dozeTimer = null
}

/** Idle → the clock to a doze starts over; anything else → no clock. */
function scheduleDoze(): void {
  cancelDoze()
  if (petState !== 'idle' || !isCompanionVisible()) return
  dozeTimer = setTimeout(tryDoze, DOZE_AFTER_MS)
}

function dozeConditions(cursorNear: boolean): DozeConditions {
  return {
    visible: isCompanionVisible(),
    petState,
    bubbleOpen: bubble !== null,
    alertsPending: hooks.hasPendingAlerts?.() ?? false,
    dnd: dndOn(),
    cursorNear,
    dragging: drag !== null,
    voiceBusy: voicePhase !== 'idle'
  }
}

/** The doze timer: curl up if nothing is going on, else wait another while. */
function tryDoze(): void {
  dozeTimer = null
  if (!alive(petWindow)) return
  const near = cursorNearPet(screen.getCursorScreenPoint(), petWindow.getBounds())
  if (!canDoze(dozeConditions(near))) {
    scheduleDoze()
    return
  }
  // Straight to the state, not setPetState: a doze ends no walk and starts no clock.
  petState = 'dozing'
  sendToPet('companion:pet-state', petState)
}

/** The cursor came near, or something happened: a dozing dog sits up, and the clock restarts. */
function wakePet(): void {
  if (petState !== 'dozing') return
  petState = restingState()
  sendToPet('companion:pet-state', petState)
  scheduleDoze()
}

// ─── Displays coming and going (plan §13.3, M3) ────────────────────────────────

/** Metrics changes come in bursts (a dock, a scale change): one look after the last. */
const DISPLAY_SETTLE_MS = 300
let displayTimer: ReturnType<typeof setTimeout> | null = null
let displaysWatched = false

/** Once per process: a monitor unplugged, plugged in or rescaled re-places a stranded pet. */
function watchDisplays(): void {
  if (displaysWatched) return
  displaysWatched = true
  const onChange = (): void => {
    if (displayTimer) clearTimeout(displayTimer)
    displayTimer = setTimeout(settleDisplays, DISPLAY_SETTLE_MS)
  }
  screen.on('display-added', onChange)
  screen.on('display-removed', onChange)
  screen.on('display-metrics-changed', onChange)
}

/** The pet left nowhere by a display change goes to the display with the cursor. */
function settleDisplays(): void {
  displayTimer = null
  if (!alive(petWindow) || !petWindow.isVisible()) return
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  if (petStranded(petWindow.getBounds(), areas)) {
    stopWalk()
    drag = null
    fall = null
    placePet(petWindow)
  }
  placeBubble()
  scheduleWalk()
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
  const b = petWindow.getBounds()
  const over = petHitTest(cursor, b)
  setIgnore(!over)
  if (petState === 'dozing' && cursorNearPet(cursor, b)) wakePet()
  if (fall) stepFall(petWindow)
  else if (walk) stepWalk(petWindow, over)
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
  // Caught mid-air: the fall ends where he is.
  fall = null
  wakePet()
  cancelDoze()
  const [x, y] = petWindow.getPosition()
  drag = { cursor: screen.getCursorScreenPoint(), window: { x, y } }
  startPolling(DRAG_POLL_MS)
}

/** Drop: dock to a side or fall to the floor of that display, and remember it for the display. */
export function endPetDrag(): void {
  if (!drag) return
  drag = null
  startPolling(POLL_MS)
  if (!alive(petWindow)) return
  const b = petWindow.getBounds()
  // The display the dog was dropped on, by the window's centre; positions are clamped to
  // its work area, which also settles a drag across displays of different scale.
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const pos = snapToEdge({ x: b.x, y: b.y }, display.workArea, { width: b.width, height: b.height })
  if (isFall(b.y, pos.y) && !reducedMotion()) {
    // On his feet for the drop; stepFall sits him down on landing.
    petWindow.setPosition(pos.x, b.y)
    fall = { fromY: b.y, toY: pos.y, x: pos.x, startAt: Date.now() }
    setPetState('standing')
    startPolling(WALK_POLL_MS)
  } else {
    petWindow.setPosition(pos.x, pos.y)
  }
  placeBubble()
  savePetPosition(display.id, pos)
  scheduleWalk()
  scheduleDoze()
}

/** One poll tick of a fall: the window down the curve, and sit on landing. */
function stepFall(win: BrowserWindow): void {
  if (!fall) return
  const { y, done } = fallY(fall, Date.now() - fall.startAt)
  win.setPosition(fall.x, y)
  placeBubble()
  if (!done) return
  fall = null
  if (!drag) startPolling(POLL_MS)
  if (petState === 'standing') setPetState(restingState())
}

/** Remember where the pet is on this display (a drop, or the end of a walk). */
function savePetPosition(displayId: number, pos: Point): void {
  try {
    const positions = { ...(companionStore().getState().positions ?? {}), [String(displayId)]: pos }
    companionStore().setState({ positions, positionsVersion: POSITIONS_VERSION })
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
  return restingState() === 'shh'
}

/** What he sits back to after a bubble, a walk or the happy beat: the crescent while muted (plan §3.3). */
function restingState(): CompanionPetState {
  try {
    return restingPetState(companionStore().getState().dndUntil, Date.now())
  } catch {
    return 'idle'
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
  // Mid-fall the landing rolls the next walk.
  if (!alive(petWindow) || walk || fall) return
  const b = petWindow.getBounds()
  const over = petHitTest(screen.getCursorScreenPoint(), b)
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  // Not on the floor (docked half way up a side): planWalk says null and he stays put.
  const plan = walkAllowed(over, true) ? planWalk(b, display.workArea) : null
  if (!plan) {
    scheduleWalk()
    return
  }
  const now = Date.now()
  walk = { ...plan, x: plan.fromX, last: now, startAt: now + WALK_STAND_MS, arriveAt: null }
  petFacing = plan.facing
  sendToPet('companion:pet-facing', plan.facing)
  // He gets up first; stepWalk sets him walking once WALK_STAND_MS has passed.
  setPetState('standing')
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
  // Standing up, or standing on arrival: no steps.
  if (now < walk.startAt) {
    walk.last = now
    return
  }
  if (walk.arriveAt !== null) {
    if (now >= walk.arriveAt) stopWalk()
    return
  }
  if (petState === 'standing') setPetState('walking')
  // A stalled event loop resumes at walking pace instead of jumping.
  walk.x = stepToward(walk.x, walk.toX, Math.min(now - walk.last, 200))
  walk.last = now
  const [, y] = win.getPosition()
  win.setPosition(Math.round(walk.x), y)
  if (walk.x === walk.toX) {
    walk.arriveAt = now + WALK_ARRIVE_MS
    setPetState('standing')
  }
}

/** Sit down where he is, remember it for this display, and roll the next walk. */
function stopWalk(): void {
  if (!walk) return
  walk = null
  if (pollTimer && !drag) startPolling(POLL_MS)
  if (petState === 'walking' || petState === 'standing') setPetState(restingState())
  if (alive(petWindow)) {
    const b = petWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    savePetPosition(display.id, { x: b.x, y: b.y })
  }
  scheduleWalk()
}

// ─── Showing and hiding ────────────────────────────────────────────────────────

function cancelIdleHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

function placePet(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const saved = companionStore().getState().positions?.[String(display.id)]
  const size = petSize()
  const pos = restoredPetPosition(saved, display.workArea, size)
  win.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/**
 * The size setting changed: the window grows or shrinks around the dog's paws, so he
 * stays standing where he was, and the renderer scales the sprite to match.
 */
function resizePet(size: CompanionPetSize): void {
  if (appliedSize === size) return
  appliedSize = size
  if (!alive(petWindow)) return
  stopWalk()
  fall = null
  const b = petWindow.getBounds()
  const dog = dogRect(b)
  const feet = { x: dog.x + dog.width / 2, y: dog.y + dog.height }
  const next = petSize(size)
  const nextDog = dogRect({ x: 0, y: 0, ...next })
  const display = screen.getDisplayNearestPoint(feet)
  const pos = clampToArea({ x: feet.x - nextDog.width / 2 - nextDog.x, y: feet.y - nextDog.height - nextDog.y }, next, display.workArea)
  petWindow.setBounds({ x: pos.x, y: pos.y, width: next.width, height: next.height })
  sendToPet('companion:pet-size', size)
  if (petWindow.isVisible()) savePetPosition(display.id, pos)
  placeBubble()
  scheduleWalk()
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
    scheduleDoze()
  }
  return win
}

function hidePet(): void {
  cancelIdleHide()
  // Sits and saves first, while the window is still up.
  stopWalk()
  stopPolling()
  drag = null
  fall = null
  // Quietly: nothing queued should pop the pet straight back up.
  hideBubbleWindow(false)
  if (alive(petWindow) && petWindow.isVisible()) {
    petWindow.hide()
    hooks.onVisibilityChanged?.()
  }
  cancelWalkTimer()
  cancelDoze()
  // Hidden while dozing: he comes back sitting up.
  if (petState === 'dozing') petState = restingState()
}

export function setPetState(state: CompanionPetState): void {
  petState = state
  // Anything else the pet is told to do ends a walk (and rolls the next one).
  if (state !== 'walking' && state !== 'standing') {
    stopWalk()
    scheduleWalk()
  }
  if (happyTimer) clearTimeout(happyTimer)
  happyTimer = null
  // The renderer sits him down after its beat on its own; main follows, so he can walk again.
  // Muted, he goes back to the crescent rather than sitting idle: told a little after the
  // renderer's own return to idle, so this arrives last.
  if (state === 'happy') {
    happyTimer = setTimeout(() => {
      happyTimer = null
      if (petState !== 'happy') return
      petState = restingState()
      if (petState !== 'idle') sendToPet('companion:pet-state', petState)
      scheduleDoze()
    }, HAPPY_MS + 100)
  }
  sendToPet('companion:pet-state', state)
  scheduleDoze()
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

/**
 * The right-click menu on the dog (plan §3.3). The pet window never takes focus, so the
 * menu is not tied to it: Menu.popup on an unfocusable owner opens at the cursor all the
 * same (popup's default position), and a click elsewhere dismisses it.
 */
export function popupPetMenu(menu: Menu): void {
  if (!alive(petWindow) || !petWindow.isVisible()) return
  stopWalk()
  wakePet()
  menu.popup({ window: petWindow })
}

/**
 * A long press on the dog (plan §13.3, M5): a wag, as for a todo done, and nothing opens.
 * Not while he is busy with a bubble or saying something; a dozing dog wakes for it.
 */
export function petThePet(): void {
  if (!isCompanionVisible() || bubble) return
  wakePet()
  if (petState !== 'idle' && petState !== 'shh') return
  setPetState('happy')
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
  if (place.anchor.side !== bubbleAnchor.side || place.anchor.tailX !== bubbleAnchor.tailX) {
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
  if (petState !== 'happy') setPetState(restingState())
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
  resizePet(next.size)
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
  else if (petState === 'listening' || petState === 'thinking') setPetState(bubble?.mode === 'input' ? 'listening' : restingState())
}

/** The model is reading a capture's date: the pet thinks, and the bubble stays up through a blur. */
export function setCaptureThinking(on: boolean): void {
  captureThinking = on
  if (on) setPetState('thinking')
  else if (petState === 'thinking') setPetState(bubble?.mode === 'input' ? 'listening' : restingState())
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
