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
  defaultPetPosition,
  dockSide,
  dogRect,
  floorUnder,
  petHitTest,
  petStranded,
  petWindowSize,
  restoredPetPosition,
  snapToEdge,
  type Point,
  type Rect,
  type Size
} from './companion-window-pure'
import { voiceShortcutCandidates } from './companion-voice-pure'
import {
  WALK_ARRIVE_MS,
  WALK_STAND_MS,
  canWalk,
  nextWalkDelay,
  planLap,
  planRunTo,
  planWalk,
  speedOf,
  stepToward,
  type WalkPlan
} from './companion-walk-pure'
import { DOZE_AFTER_MS, canDoze, cursorNearPet, cursorSideOf, type DozeConditions } from './companion-doze-pure'
import { FOLLOW_POLL_MS, followUpdate, shouldFollow, type FollowWatch } from './companion-follow-pure'
import { ROUTINE_POSE_MS, dayKey, isNight, routineMoment, type RoutineMoment } from './companion-routine-pure'
import { fallY, isFall, type Fall } from './companion-fall-pure'
import { BALL_SIZE, ballAt, fetchX, planThrow, type Throw } from './companion-ball-pure'
import { PERCH_POLL_MS, isOverTitleBar, landingBelow, perchFollow, perchPosition } from './companion-perch-pure'
import { foregroundWindow, windowBounds, windowsOnScreen } from './companion-win32'
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
let ballWindow: BrowserWindow | null = null
/** Fetch (plan §13.3, P2): the throw in the air, then the run out to it and back home. */
let game: { phase: 'throw' | 'fetch' | 'return'; throw: Throw; startAt: number; homeX: number } | null = null
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
/** `onto`: the window whose top edge ends the fall; he perches on it on landing. */
let fall: (Fall & { x: number; startAt: number; onto?: unknown }) | null = null
/** Counts down to a doze while he sits idle (plan §13.3, M1). */
let dozeTimer: ReturnType<typeof setTimeout> | null = null
/** Perched on a window (plan §13.3, R): its handle, where it was last seen, and the watch on it. */
let perch: { hwnd: unknown; last: Rect } | null = null
let perchTimer: ReturnType<typeof setInterval> | null = null
/** The day's routine (plan §13.3, U2): the clock, and which moments are done today. */
let routineTimer: ReturnType<typeof setInterval> | null = null
const routineDone: Partial<Record<RoutineMoment, string>> = {}
const ROUTINE_POLL_MS = 30_000
/** "Follow me" (plan §13.3, O2): the cursor's whereabouts, and the display he is on his way to. */
let followTimer: ReturnType<typeof setInterval> | null = null
let followWatch: FollowWatch | null = null
let followingTo: number | null = null
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

/**
 * Move the pet window, always with its size. A bare setPosition on this transparent window
 * at a fractional display scale (125 %) lets Windows round the size on every move, and over
 * a drag's hundreds of moves the window grew to several times the dog. Everything here is
 * worked out from the window's bounds, so the dog, drawn at its size in the top-left corner,
 * then sat in mid-air or halfway down a window, and the hit area no longer covered him.
 */
function movePet(win: BrowserWindow, x: number, y: number): void {
  const size = petSize(appliedSize ?? undefined)
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: size.width, height: size.height })
}

/** The accelerator that actually got registered ('' if none was available). */
export function companionShortcut(): string {
  return registeredShortcut
}

function loadEntry(win: BrowserWindow, hash: 'pet' | 'bubble' | 'ball'): void {
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
  // Straight to the state, not setPetState: a doze ends no walk and starts no clock. At
  // night, with him up all day, he lies down properly (plan §13.3, U2).
  petState = isNight(Date.now(), prefs().morningHour) && prefs().stayOnScreen ? 'sleeping' : 'dozing'
  sendToPet('companion:pet-state', petState)
}

/** Dozing, or asleep for the night: both end the same way. */
const asleep = (): boolean => petState === 'dozing' || petState === 'sleeping'

// ─── The day's routine (plan §13.3, U2) ────────────────────────────────────────

function startRoutine(): void {
  stopRoutine()
  routineTimer = setInterval(routineTick, ROUTINE_POLL_MS)
}

function stopRoutine(): void {
  if (routineTimer) clearInterval(routineTimer)
  routineTimer = null
}

/** In the five minutes after the morning hour a stretch, after six a yawn, each once a day, when he is just sitting. */
function routineTick(): void {
  if (!alive(petWindow) || !petWindow.isVisible()) return
  if (walk || fall || drag || game || bubble || (petState !== 'idle' && petState !== 'looking')) return
  const now = Date.now()
  const moment = routineMoment(now, prefs().morningHour)
  if (!moment || routineDone[moment] === dayKey(now)) return
  routineDone[moment] = dayKey(now)
  const pose: CompanionPetState = moment === 'stretch' ? 'stretching' : 'yawning'
  setPetState(pose)
  setTimeout(() => {
    if (petState === pose) setPetState(restingState())
  }, ROUTINE_POSE_MS)
}

/**
 * The cursor near a sitting dog (plan §13.3, U1): he turns to face it, and turns back when
 * it goes. Only between idle and looking, so nothing else he is doing is cut short; the
 * doze clock keeps running underneath (canDoze says no while the cursor is near).
 */
function lookAtCursor(cursor: Point, b: Rect): void {
  if (drag || walk || fall || game) return
  const near = !petHitTest(cursor, b) && cursorNearPet(cursor, b)
  if (petState === 'idle' && near) {
    petState = 'looking'
    petFacing = cursorSideOf(cursor, b)
    sendToPet('companion:pet-facing', petFacing)
    sendToPet('companion:pet-state', petState)
  } else if (petState === 'looking') {
    if (!near) {
      petState = restingState()
      sendToPet('companion:pet-state', petState)
      scheduleDoze()
      return
    }
    const side = cursorSideOf(cursor, b)
    if (side !== petFacing) {
      petFacing = side
      sendToPet('companion:pet-facing', petFacing)
    }
  }
}

/** The cursor came near, or something happened: a dozing dog sits up, and the clock restarts. */
function wakePet(): void {
  if (!asleep()) return
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

/** The ball: as the pet window, but never takes a click. Made on the first throw. */
function createBallWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
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
  win.on('closed', () => {
    if (ballWindow === win) ballWindow = null
  })
  hardenWebContents(win)
  loadEntry(win, 'ball')
  ballWindow = win
  return win
}

// ─── Fetch (plan §13.3, P2) ────────────────────────────────────────────────────

/**
 * The pet's menu: throw the ball along the floor the roomier way. He stands and watches
 * it land, runs out to it, and brings it back to where he was, wagging. Nothing while he
 * is busy, docked up a side, or not allowed a walk.
 */
export function throwBall(): void {
  if (!alive(petWindow) || !petWindow.isVisible() || walk || fall || drag || game || bubble) return
  stopWalk()
  const b = petWindow.getBounds()
  if (!walkAllowed(false, true)) return
  const t = planThrow(b, screen.getAllDisplays().map((d) => d.workArea))
  if (!t) return
  const ball = alive(ballWindow) ? ballWindow : createBallWindow()
  game = { phase: 'throw', throw: t, startAt: Date.now(), homeX: b.x }
  petFacing = t.facing
  sendToPet('companion:pet-facing', petFacing)
  setPetState('standing')
  ball.setBounds({ x: t.fromX, y: t.fromY, width: BALL_SIZE, height: BALL_SIZE })
  ball.showInactive()
  startPolling(WALK_POLL_MS)
}

/** One poll tick while the ball flies; on landing he sets off after it. */
function stepThrow(): void {
  if (!game || game.phase !== 'throw' || !alive(petWindow)) return
  const { x, y, done } = ballAt(game.throw, Date.now() - game.startAt)
  if (alive(ballWindow)) ballWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: BALL_SIZE, height: BALL_SIZE })
  if (!done) return
  const b = petWindow.getBounds()
  const plan = planRunTo(b, screen.getAllDisplays().map((d) => d.workArea), fetchX(game.throw, b))
  if (!plan) {
    endGame()
    return
  }
  game.phase = 'fetch'
  startPlan(plan)
}

/** The run out or back ended: picked up, the ball goes and he runs home; home, a wag. */
function settleGame(arrived: boolean): void {
  if (!game || game.phase === 'throw') return
  if (!arrived || !alive(petWindow)) {
    endGame()
    return
  }
  if (game.phase === 'fetch') {
    if (alive(ballWindow)) ballWindow.hide()
    const plan = planRunTo(petWindow.getBounds(), screen.getAllDisplays().map((d) => d.workArea), game.homeX)
    if (!plan) {
      endGame(true)
      return
    }
    game.phase = 'return'
    // startPlan from inside stopWalk: the walk it clears is already null here.
    startPlan(plan)
    return
  }
  endGame(true)
}

/** The game is over, with a wag when he brought the ball back. */
function endGame(pleased = false): void {
  game = null
  if (alive(ballWindow)) ballWindow.hide()
  if (pleased && petState !== 'happy') setPetState('happy')
  else if (petState === 'standing') setPetState(restingState())
  if (pollTimer && !drag && !walk && !fall) startPolling(POLL_MS)
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
    movePet(petWindow, Math.round(x), Math.round(y))
    placeBubble()
    setIgnore(false)
    return
  }
  const b = petWindow.getBounds()
  const over = petHitTest(cursor, b)
  setIgnore(!over)
  if (asleep() && cursorNearPet(cursor, b)) wakePet()
  lookAtCursor(cursor, b)
  if (fall) stepFall(petWindow)
  else if (walk) stepWalk(petWindow, over)
  else if (game?.phase === 'throw') stepThrow()
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
  // Caught mid-air: the fall ends where he is, and so does the game; lifted off a window too.
  fall = null
  if (game) endGame()
  unperch()
  wakePet()
  cancelDoze()
  const [x, y] = petWindow.getPosition()
  drag = { cursor: screen.getCursorScreenPoint(), window: { x, y } }
  startPolling(DRAG_POLL_MS)
}

/** The companion's own windows, by native handle: nothing to land on or be hidden behind. */
function ownHandles(): bigint[] {
  const out: bigint[] = []
  for (const w of [petWindow, bubbleWindow, ballWindow]) {
    if (!alive(w)) continue
    const h = w.getNativeWindowHandle()
    out.push(h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0)))
  }
  return out
}

/** Drop: perch, dock to a side, or fall onto the first window below or the floor; remember it for the display. */
export function endPetDrag(): void {
  if (!drag) return
  drag = null
  startPolling(POLL_MS)
  if (!alive(petWindow)) return
  const b = petWindow.getBounds()
  // The display the dog was dropped on, by the window's centre; positions are clamped to
  // its work area, which also settles a drag across displays of different scale.
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  // Let go over the title bar of the window in front: he sits on its top edge (plan §13.3, R).
  const front = foregroundWindow()
  if (front && isOverTitleBar(b, front.bounds)) {
    startPerch(front.hwnd, front.bounds, b)
    return
  }
  const pos = snapToEdge({ x: b.x, y: b.y }, display.workArea, { width: b.width, height: b.height })
  // Falling (not docked to a side): the top edge of a window on the way down catches him.
  const windows = pos.y > b.y ? windowsOnScreen(ownHandles()) : []
  const landing = landingBelow(b, windows.map((w) => w.bounds), pos.y)
  if (landing) {
    const onto = windows[landing.index]
    const x = perchPosition(b, onto.bounds, { width: b.width, height: b.height }).x
    if (isFall(b.y, landing.y) && !reducedMotion()) {
      movePet(petWindow, x, b.y)
      fall = { fromY: b.y, toY: landing.y, x, startAt: Date.now(), onto: onto.hwnd }
      setPetState('standing')
      startPolling(WALK_POLL_MS)
      placeBubble()
    } else {
      startPerch(onto.hwnd, onto.bounds, { ...b, x })
    }
    return
  }
  if (isFall(b.y, pos.y) && !reducedMotion()) {
    // On his feet for the drop; stepFall sits him down on landing.
    movePet(petWindow, pos.x, b.y)
    fall = { fromY: b.y, toY: pos.y, x: pos.x, startAt: Date.now() }
    setPetState('standing')
    startPolling(WALK_POLL_MS)
  } else {
    movePet(petWindow, pos.x, pos.y)
    settlePose()
  }
  placeBubble()
  savePetPosition(display.id, pos)
  scheduleWalk()
  scheduleDoze()
}

// ─── Perching (plan §13.3, R) ──────────────────────────────────────────────────

/** Sit on the window's top edge and keep an eye on it. Nothing is saved: the place is the window's, not the display's. */
function startPerch(hwnd: unknown, bounds: Rect, b: Rect): void {
  unperch()
  if (!alive(petWindow)) return
  perch = { hwnd, last: bounds }
  const pos = perchPosition(b, bounds, { width: b.width, height: b.height })
  movePet(petWindow, pos.x, pos.y)
  placeBubble()
  setPetState('perched')
  perchTimer = setInterval(perchTick, PERCH_POLL_MS)
}

function unperch(): void {
  if (perchTimer) clearInterval(perchTimer)
  perchTimer = null
  perch = null
}

/** The window moved: along with it. Minimised, closed or hidden: down to the floor. */
function perchTick(): void {
  if (!perch || !alive(petWindow) || !petWindow.isVisible()) {
    unperch()
    return
  }
  if (drag) return
  const bounds = windowBounds(perch.hwnd)
  if (!bounds) {
    unperch()
    dropToFloor()
    return
  }
  if (bounds.x === perch.last.x && bounds.y === perch.last.y) return
  const [x, y] = petWindow.getPosition()
  const pos = perchFollow({ x, y }, perch.last, bounds)
  perch.last = bounds
  movePet(petWindow, pos.x, pos.y)
  placeBubble()
}

/** From wherever he is, down to the floor of his display (the window he sat on went). */
function dropToFloor(): void {
  if (!alive(petWindow)) return
  const b = petWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const pos = floorUnder({ x: b.x, y: b.y }, display.workArea, { width: b.width, height: b.height })
  if (isFall(b.y, pos.y) && !reducedMotion()) {
    movePet(petWindow, pos.x, b.y)
    fall = { fromY: b.y, toY: pos.y, x: pos.x, startAt: Date.now() }
    setPetState('standing')
    startPolling(WALK_POLL_MS)
  } else {
    movePet(petWindow, pos.x, pos.y)
    settlePose()
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
  movePet(win, fall.x, y)
  placeBubble()
  if (!done) return
  const onto = fall.onto
  fall = null
  if (!drag) startPolling(POLL_MS)
  if (onto) {
    // Landed on a window's top edge: sit on it, as if let go there. Gone meanwhile: on down.
    const bounds = windowBounds(onto)
    const b = win.getBounds()
    if (bounds) startPerch(onto, bounds, b)
    else dropToFloor()
    return
  }
  // Landed, maybe on another display: remember where, then sit (which rolls the next walk).
  const b = win.getBounds()
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  savePetPosition(display.id, { x: b.x, y: b.y })
  settleFollow()
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

/** Windows asked for quiet (plan §13.3, V1): Focus Assist, a full-screen app, a presentation. */
let systemQuiet = false

/** index.ts's watcher: on, he lies down with the crescent; off, he sits up unless muted himself. */
export function setSystemQuiet(on: boolean): void {
  if (on === systemQuiet) return
  systemQuiet = on
  if (on) {
    if (petState === 'idle' || petState === 'looking' || petState === 'leaning' || petState === 'perched' || asleep()) setPetState('shh')
  } else if (petState === 'shh') {
    setPetState(restingState())
  }
}

export function isSystemQuiet(): boolean {
  return systemQuiet
}

/**
 * What he sits back to after a bubble, a walk or the happy beat: the crescent while muted
 * (plan §3.3), his back to the wall while docked up a side edge (plan §13.1), else idle.
 */
function restingState(): CompanionPetState {
  let state: CompanionPetState = 'idle'
  try {
    state = restingPetState(companionStore().getState().dndUntil, Date.now())
  } catch {
    // unreadable state.json: not muted
  }
  if (systemQuiet) state = 'shh'
  if (state !== 'idle') return state
  if (perch) return 'perched'
  return leaningOn() ? 'leaning' : state
}

/** The wall he is docked against, if any; the lean faces away from it (the sheet has the wall on the left). */
function leaningOn(): 'left' | 'right' | null {
  if (!alive(petWindow)) return null
  const b = petWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  return dockSide({ x: b.x, y: b.y }, display.workArea, { width: b.width, height: b.height })
}

/** After a drop or a placement: lean if docked up a side, facing away from the wall, else sit. */
function settlePose(): void {
  const side = leaningOn()
  if (side) {
    petFacing = side === 'left' ? 'right' : 'left'
    sendToPet('companion:pet-facing', petFacing)
  }
  if (petState === 'idle' || petState === 'leaning' || petState === 'standing') setPetState(restingState())
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
  // The lane runs over every display whose floor lines up with his (plan §13.1). Not on
  // the floor (docked half way up a side): planWalk says null and he stays put.
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  const plan = walkAllowed(over, true) ? planWalk(b, areas) : null
  if (!plan) {
    scheduleWalk()
    return
  }
  startPlan(plan)
}

/** Set off on a walk or a run: up on his feet, then stepWalk moves him from the next poll. */
function startPlan(plan: WalkPlan): void {
  const now = Date.now()
  walk = { ...plan, x: plan.fromX, last: now, startAt: now + WALK_STAND_MS, arriveAt: null }
  petFacing = plan.facing
  sendToPet('companion:pet-facing', plan.facing)
  // He gets up first; stepWalk sets him going once WALK_STAND_MS has passed.
  setPetState('standing')
  startPolling(WALK_POLL_MS)
}

/** After a "done": one time in four, a short lap at a run (plan §13.1), if nothing says sit. */
function maybeLap(): void {
  if (!alive(petWindow) || walk || fall || drag) return
  const b = petWindow.getBounds()
  if (!walkAllowed(petHitTest(screen.getCursorScreenPoint(), b), true)) return
  const plan = planLap(b, screen.getAllDisplays().map((d) => d.workArea))
  if (plan) startPlan(plan)
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
    if (now >= walk.arriveAt) stopWalk(true)
    return
  }
  if (petState === 'standing') setPetState(walk.gait === 'run' ? 'running' : 'walking')
  // A stalled event loop resumes at pace instead of jumping.
  walk.x = stepToward(walk.x, walk.toX, Math.min(now - walk.last, 200), speedOf(walk.gait ?? 'walk'))
  walk.last = now
  const [, y] = win.getPosition()
  movePet(win, walk.x, y)
  if (walk.x === walk.toX) {
    // Over the edge of a lower display: down onto its floor, where stepFall sits him.
    if (walk.dropTo != null) {
      fall = { fromY: y, toY: walk.dropTo, x: Math.round(walk.x), startAt: now }
      walk = null
      setPetState('standing')
      return
    }
    walk.arriveAt = now + WALK_ARRIVE_MS
    setPetState('standing')
  }
}

/**
 * Sit down where he is, remember it for this display, and roll the next walk. `arrived`
 * says the plan ran its course (not a bubble or the cursor cutting it short), which is
 * when a follow that the lane could not finish hops the rest of the way.
 */
function stopWalk(arrived = false): void {
  if (!walk) return
  walk = null
  if (pollTimer && !drag) startPolling(POLL_MS)
  if (petState === 'walking' || petState === 'running' || petState === 'standing') setPetState(restingState())
  if (alive(petWindow)) {
    const b = petWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    savePetPosition(display.id, { x: b.x, y: b.y })
  }
  if (arrived) settleFollow()
  else followingTo = null
  settleGame(arrived)
  scheduleWalk()
}

// ─── Follow me (plan §13.3, O2) ────────────────────────────────────────────────

function stopFollowing(): void {
  if (followTimer) clearInterval(followTimer)
  followTimer = null
  followWatch = null
  followingTo = null
}

/** Watch the cursor while the pet is up all day with the preference on. */
function startFollowing(): void {
  stopFollowing()
  const p = prefs()
  if (!p.stayOnScreen || !p.follow || !isCompanionVisible()) return
  followTimer = setInterval(followTick, FOLLOW_POLL_MS)
}

/** One look at the cursor: note how long it has been elsewhere, and set off once it has settled. */
function followTick(): void {
  if (!alive(petWindow) || !petWindow.isVisible()) return
  // Busy, or already on his way: the clock starts over once he is sat again.
  if (walk || fall || drag || bubble) {
    followWatch = null
    return
  }
  const cursor = screen.getCursorScreenPoint()
  const b = petWindow.getBounds()
  const petDisplay = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const cursorDisplay = screen.getDisplayNearestPoint(cursor)
  const now = Date.now()
  followWatch = followUpdate(followWatch, cursorDisplay.id, petDisplay.id, now)
  if (!shouldFollow(followWatch, now) || !walkAllowed(petHitTest(cursor, b), true)) return
  followWatch = null
  followingTo = cursorDisplay.id
  // Along the lane toward that display's corner, as far as it goes; the rest is a hop on arrival.
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  const plan = planRunTo(b, areas, defaultPetPosition(cursorDisplay.workArea, { width: b.width, height: b.height }).x)
  if (plan) startPlan(plan)
  else settleFollow()
}

/** The run is over: if the lane did not reach the display he was going to, he hops there. */
function settleFollow(): void {
  const target = followingTo
  followingTo = null
  if (target == null || !alive(petWindow)) return
  const b = petWindow.getBounds()
  const here = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  if (here.id === target) return
  const display = screen.getAllDisplays().find((d) => d.id === target)
  if (!display) return
  const size = { width: b.width, height: b.height }
  const pos = restoredPetPosition(companionStore().getState().positions?.[String(display.id)], display.workArea, size)
  petWindow.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height })
  placeBubble()
  savePetPosition(display.id, pos)
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
  settlePose()
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
    startFollowing()
    startRoutine()
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
  if (game) endGame()
  // Quietly: nothing queued should pop the pet straight back up.
  hideBubbleWindow(false)
  if (alive(petWindow) && petWindow.isVisible()) {
    petWindow.hide()
    hooks.onVisibilityChanged?.()
  }
  cancelWalkTimer()
  cancelDoze()
  stopFollowing()
  stopRoutine()
  unperch()
  // Hidden while dozing: he comes back sitting up.
  if (asleep()) petState = restingState()
}

export function setPetState(state: CompanionPetState): void {
  petState = state
  // Anything else the pet is told to do ends a walk (and rolls the next one).
  if (state !== 'walking' && state !== 'running' && state !== 'standing') {
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
      maybeLap()
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
  if (petState !== 'idle' && petState !== 'looking' && petState !== 'leaning' && petState !== 'perched' && petState !== 'shh') return
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
  for (const win of [petWindow, bubbleWindow, ballWindow]) {
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
  startFollowing()
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
