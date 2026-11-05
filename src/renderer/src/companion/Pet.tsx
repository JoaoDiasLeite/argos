import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { CompanionPetFacing, CompanionPetSize, CompanionPetState } from '../types'
import { PET_SCALE } from '../../../shared/companion'
import { useT } from '../i18n'
import './pet.css'

// Argos on the desktop (docs/COMPANION_PLAN.md §2.3, §9.5, §13.1). The 128×152 pet
// window is transparent and click-through except over the dog: main hit-tests a 120×130
// rect at its bottom centre (companion-window-pure DOG_SIZE), so the sprite and every
// badge stay inside that rect.
//
// Each state is a horizontal PNG sheet of 96×96 frames played with CSS steps(). Every
// frame shares one alignment (paws on the same bottom line), so switching sheets never
// shifts the dog. pet.css carries what the frames don't: hops, breathing, the badges.

// Literal URLs, so Vite fingerprints each sheet into the build.
const SHEETS = {
  idle: new URL('./sprites/idle.png', import.meta.url).href,
  talking: new URL('./sprites/talking.png', import.meta.url).href,
  wag: new URL('./sprites/wag.png', import.meta.url).href,
  alert: new URL('./sprites/alert.png', import.meta.url).href,
  doze: new URL('./sprites/doze.png', import.meta.url).href,
  shh: new URL('./sprites/shh.png', import.meta.url).href,
  listen: new URL('./sprites/listen.png', import.meta.url).href,
  think: new URL('./sprites/think.png', import.meta.url).href,
  walk: new URL('./sprites/walk.png', import.meta.url).href,
  run: new URL('./sprites/run.png', import.meta.url).href,
  lean: new URL('./sprites/lean.png', import.meta.url).href,
  perch: new URL('./sprites/perch.png', import.meta.url).href,
  look: new URL('./sprites/look.png', import.meta.url).href,
  stretch: new URL('./sprites/stretch.png', import.meta.url).href,
  sleep: new URL('./sprites/sleep.png', import.meta.url).href
}

interface Sprite {
  /** A horizontal strip of 96×96 frames. */
  src: string
  frames: number
  fps: number
  /** Frames in the sheet when it holds more than are played (standing shows walk's first). */
  sheetFrames?: number
  /** With `frames: 1`, which frame of the sheet is held (0-based); the first otherwise. */
  frame?: number
}

const IDLE: Sprite = { src: SHEETS.idle, frames: 8, fps: 4 }

const SPRITES: Record<CompanionPetState, Sprite> = {
  idle: IDLE,
  // Closed, ajar, open, ajar, closed, "oh": reads as speech rather than a flapping jaw.
  talking: { src: SHEETS.talking, frames: 6, fps: 6 },
  // Tail up, middle, down, middle: two wags in the happy beat.
  happy: { src: SHEETS.wag, frames: 4, fps: 8 },
  alert: { src: SHEETS.alert, frames: 2, fps: 3 },
  dozing: { src: SHEETS.doze, frames: 2, fps: 1 },
  shh: { src: SHEETS.shh, frames: 1, fps: 1 },
  // One ear up, twitching.
  listening: { src: SHEETS.listen, frames: 2, fps: 3 },
  // Looking up for three beats, then a slow half-closed blink.
  thinking: { src: SHEETS.think, frames: 4, fps: 2 },
  // Drawn facing right; mirrored on the wrapper for a walk to the left (main moves the window).
  walking: { src: SHEETS.walk, frames: 4, fps: 8 },
  // A gallop: reach, push, all four paws off the ground, and back (five of the six drawn
  // frames; the generator smeared one, scripts/companion-sheet.py --keep left it out).
  running: { src: SHEETS.run, frames: 5, fps: 10 },
  // On his feet before and after a walk: the walk sheet's first frame, held.
  standing: { src: SHEETS.walk, frames: 1, fps: 1, sheetFrames: 4 },
  // Back to a side wall (drawn with the wall on the left), mirrored for the right wall.
  leaning: { src: SHEETS.lean, frames: 1, fps: 1 },
  // Turned toward the cursor (drawn looking right, mirrored for the left): a look, then a lean in.
  looking: { src: SHEETS.look, frames: 2, fps: 2 },
  // The day's routine (plan §13.4): the wag stands in for stretch.png, the doze for sleep.png.
  // The morning stretch: a play bow, a yawn, and sat again; the yawn alone at six.
  stretching: { src: SHEETS.stretch, frames: 3, fps: 1 },
  yawning: { src: SHEETS.stretch, frames: 1, fps: 1, sheetFrames: 3, frame: 1 },
  // Flat out for the night, one slow breath: two pairs of frames in the sheet, and Pet picks
  // one of them each time he lies down (SLEEP_PAIRS).
  sleeping: { src: SHEETS.sleep, frames: 2, fps: 1, sheetFrames: 4 },
  // A fidget (plan §13.4): the wag stands in for scratch.png.
  scratching: { src: SHEETS.wag, frames: 4, fps: 8 },
  // On a window's top edge: a look down over it, then straight ahead, slowly.
  perched: { src: SHEETS.perch, frames: 2, fps: 0.5 }
}

const FRAME = 96

/** Where each pair of sleeping frames starts in sleep.png. */
const SLEEP_PAIRS = [0, 2]

/** `happy` is a 1 s beat (two hops, two wags); then the pet sits back down. */
const HAPPY_MS = 1000

/** A pointer that travels further than this between down and up was a drag, not a click. */
const CLICK_SLOP = 4

/** Held down this long without moving: petting him, not a click and not a drag (plan §13.3, M5). */
const HOLD_MS = 600

const PET_STATES: readonly CompanionPetState[] = [
  'idle',
  'dozing',
  'listening',
  'thinking',
  'talking',
  'alert',
  'happy',
  'shh',
  'walking',
  'running',
  'standing',
  'leaning',
  'looking',
  'stretching',
  'yawning',
  'sleeping',
  'scratching',
  'perched'
]

/** Now and then while just sitting (plan §13.3, U3): a scratch, or a glance the other way. */
const FIDGET_MIN_MS = 20_000
const FIDGET_MAX_MS = 60_000
const FIDGET_MS = 1500
type Fidget = 'scratching' | 'glance'

/** The gaits: drawn facing right and mirrored for the left, never shown with reduced motion. */
const ON_THE_MOVE: readonly CompanionPetState[] = ['walking', 'running', 'standing']
/** Drawn facing right and mirrored for the left: the gaits, the lean (wall on the left), the look. */
const MIRRORABLE: readonly CompanionPetState[] = [...ON_THE_MOVE, 'leaning', 'looking']

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** Live prefers-reduced-motion; main also checks the OS setting before every walk. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches)
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION)
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

const api = window.electronAPI.companion

export default function Pet() {
  const t = useT()
  const [state, setState] = useState<CompanionPetState>('idle')
  const [facing, setFacing] = useState<CompanionPetFacing>('right')
  // The size setting: main sizes the window, this scales everything drawn in it to match.
  const [size, setSize] = useState<CompanionPetSize>('normal')
  const reducedMotion = useReducedMotion()
  const down = useRef<{ x: number; y: number } | null>(null)
  /** The hold timer while the pointer is down and still, and whether it went off. */
  const hold = useRef<number | null>(null)
  const held = useRef(false)

  const clearHold = (): void => {
    if (hold.current !== null) window.clearTimeout(hold.current)
    hold.current = null
  }
  useEffect(() => clearHold, [])

  useEffect(() => {
    const accept = (s: unknown): void => {
      if (PET_STATES.includes(s as CompanionPetState)) setState(s as CompanionPetState)
    }
    const acceptFacing = (f: unknown): void => {
      if (f === 'left' || f === 'right') setFacing(f)
    }
    const acceptSize = (s: unknown): void => {
      if (s === 'small' || s === 'normal' || s === 'large') setSize(s)
    }
    api
      .state()
      .then((s) => {
        acceptFacing(s.petFacing)
        acceptSize(s.prefs.size)
        accept(s.petState)
      })
      .catch(() => {})
    const offState = api.onPetState(accept)
    const offFacing = api.onPetFacing(acceptFacing)
    const offSize = api.onPetSize(acceptSize)
    return () => {
      offState()
      offFacing()
      offSize()
    }
  }, [])

  // Main sets `happy` and moves on; the return to idle is the pet's own.
  useEffect(() => {
    if (state !== 'happy') return
    const timer = setTimeout(() => setState((s) => (s === 'happy' ? 'idle' : s)), HAPPY_MS)
    return () => clearTimeout(timer)
  }, [state])

  // The fidgets are the renderer's own: only over a plain idle, never with reduced motion.
  const [fidget, setFidget] = useState<Fidget | null>(null)
  useEffect(() => {
    if (state !== 'idle' || reducedMotion) {
      setFidget(null)
      return
    }
    let timer = 0
    const schedule = (): void => {
      timer = window.setTimeout(
        () => {
          setFidget(Math.random() < 0.5 ? 'scratching' : 'glance')
          timer = window.setTimeout(() => {
            setFidget(null)
            schedule()
          }, FIDGET_MS)
        },
        FIDGET_MIN_MS + Math.random() * (FIDGET_MAX_MS - FIDGET_MIN_MS)
      )
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [state, reducedMotion])

  // With reduced motion a walk is never shown: he is drawn sitting (main does not walk then either).
  const base: CompanionPetState = ON_THE_MOVE.includes(state) && reducedMotion ? 'idle' : state
  const glancing = base === 'idle' && fidget === 'glance'
  const shown: CompanionPetState = base === 'idle' && fidget === 'scratching' ? 'scratching' : glancing ? 'looking' : base
  // Which pair of sleeping frames tonight: picked afresh whenever his state changes.
  const sleepPair = useMemo(() => SLEEP_PAIRS[Math.floor(Math.random() * SLEEP_PAIRS.length)], [state])
  const sprite: Sprite = shown === 'sleeping' ? { ...SPRITES.sleeping, frame: sleepPair } : SPRITES[shown]
  const animated = sprite.frames > 1
  // A glance is the other way from where he faces.
  const mirrored = glancing ? facing === 'right' : MIRRORABLE.includes(shown) && facing === 'left'

  // Screen coordinates: while main drags the window the dog stays under the cursor, so
  // client coordinates barely move even on a long drag.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    down.current = { x: e.screenX, y: e.screenY }
    held.current = false
    clearHold()
    hold.current = window.setTimeout(() => {
      hold.current = null
      held.current = true
      api.pet()
    }, HOLD_MS)
    api.dragStart()
  }
  // Moving further than a click's slop makes it a drag: no petting on the way.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const start = down.current
    if (!start || hold.current === null) return
    if (Math.hypot(e.screenX - start.x, e.screenY - start.y) > CLICK_SLOP) clearHold()
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const start = down.current
    down.current = null
    clearHold()
    if (!start) return
    api.dragEnd()
    if (!held.current && Math.hypot(e.screenX - start.x, e.screenY - start.y) <= CLICK_SLOP) api.summon()
  }
  const onPointerCancel = (): void => {
    clearHold()
    if (!down.current) return
    down.current = null
    api.dragEnd()
  }

  const scale = PET_SCALE[size]
  return (
    <div className={`pet pet-${shown}${scale !== 1 ? ' pet-scaled' : ''}`} style={{ '--pet-scale': scale } as CSSProperties}>
      <div
        className="pet-body"
        role="button"
        aria-label={t('companion.pet.label')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          api.petMenu()
        }}
      >
        {/* The mirror is on a wrapper so the sprite's own steps() animation keeps running. */}
        <div className={`pet-facing${mirrored ? ' pet-facing-left' : ''}`}>
          {/* Keyed by pose so each sheet starts on its first frame, in step with the
              walk's bob in pet.css, instead of carrying on from the last sheet's clock. */}
          <div
            key={shown}
            className={`pet-sprite${animated ? ' pet-sheet' : ''}`}
            style={{
              backgroundImage: `url("${sprite.src}")`,
              ...(sprite.sheetFrames ? { backgroundSize: `${sprite.sheetFrames * FRAME}px ${FRAME}px` } : {}),
              ...(sprite.frame ? { backgroundPosition: `${-sprite.frame * FRAME}px 0` } : {}),
              ...(animated
                ? {
                    backgroundSize: `${(sprite.sheetFrames ?? sprite.frames) * FRAME}px ${FRAME}px`,
                    ['--sheet-x' as string]: `${-(sprite.frame ?? 0) * FRAME}px`,
                    ['--sheet-w' as string]: `${sprite.frames * FRAME}px`,
                    ['--sheet-steps' as string]: sprite.frames,
                    ['--sheet-dur' as string]: `${sprite.frames / sprite.fps}s`
                  }
                : {})
            }}
          />
        </div>
      </div>
      <Badge state={shown} />
    </div>
  )
}

/** What sits over the head: z's, three dots, "!", the crescent. */
function Badge({ state }: { state: CompanionPetState }) {
  if (state === 'dozing' || state === 'sleeping') {
    return (
      <span className="pet-badge pet-zs" aria-hidden="true">
        <i>z</i>
        <i>z</i>
        <i>z</i>
      </span>
    )
  }
  if (state === 'thinking') {
    return (
      <span className="pet-badge pet-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    )
  }
  if (state === 'alert') {
    return (
      <span className="pet-badge pet-bang" aria-hidden="true">
        !
      </span>
    )
  }
  if (state === 'shh') {
    return (
      <span className="pet-badge pet-moon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      </span>
    )
  }
  return null
}
