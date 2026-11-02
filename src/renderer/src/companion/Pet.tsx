import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { CompanionPetFacing, CompanionPetState } from '../types'
import { useT } from '../i18n'
import './pet.css'

// Argos on the desktop (docs/COMPANION_PLAN.md §2.3, §9.5). The 220×220 pet window is
// transparent and click-through except over the dog: main hit-tests a 120×130 rect at
// its bottom centre (companion-window-pure DOG_SIZE), so the sprite and every badge
// stay inside that rect.
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
  walk: new URL('./sprites/walk.png', import.meta.url).href
}

interface Sprite {
  /** A horizontal strip of 96×96 frames. */
  src: string
  frames: number
  fps: number
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
  walking: { src: SHEETS.walk, frames: 4, fps: 8 }
}

const FRAME = 96

/** `happy` is a 1 s beat (two hops, two wags); then the pet sits back down. */
const HAPPY_MS = 1000

/** A pointer that travels further than this between down and up was a drag, not a click. */
const CLICK_SLOP = 4

const PET_STATES: readonly CompanionPetState[] = [
  'idle',
  'dozing',
  'listening',
  'thinking',
  'talking',
  'alert',
  'happy',
  'shh',
  'walking'
]

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
  const reducedMotion = useReducedMotion()
  const down = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const accept = (s: unknown): void => {
      if (PET_STATES.includes(s as CompanionPetState)) setState(s as CompanionPetState)
    }
    const acceptFacing = (f: unknown): void => {
      if (f === 'left' || f === 'right') setFacing(f)
    }
    api
      .state()
      .then((s) => {
        acceptFacing(s.petFacing)
        accept(s.petState)
      })
      .catch(() => {})
    const offState = api.onPetState(accept)
    const offFacing = api.onPetFacing(acceptFacing)
    return () => {
      offState()
      offFacing()
    }
  }, [])

  // Main sets `happy` and moves on; the return to idle is the pet's own.
  useEffect(() => {
    if (state !== 'happy') return
    const timer = setTimeout(() => setState((s) => (s === 'happy' ? 'idle' : s)), HAPPY_MS)
    return () => clearTimeout(timer)
  }, [state])

  // With reduced motion a walk is never shown: he is drawn sitting (main does not walk then either).
  const shown: CompanionPetState = state === 'walking' && reducedMotion ? 'idle' : state
  const sprite = SPRITES[shown]
  const animated = sprite.frames > 1
  const mirrored = shown === 'walking' && facing === 'left'

  // Screen coordinates: while main drags the window the dog stays under the cursor, so
  // client coordinates barely move even on a long drag.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    down.current = { x: e.screenX, y: e.screenY }
    api.dragStart()
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const start = down.current
    down.current = null
    if (!start) return
    api.dragEnd()
    if (Math.hypot(e.screenX - start.x, e.screenY - start.y) <= CLICK_SLOP) api.summon()
  }
  const onPointerCancel = (): void => {
    if (!down.current) return
    down.current = null
    api.dragEnd()
  }

  return (
    <div className={`pet pet-${shown}`}>
      <div
        className="pet-body"
        role="button"
        aria-label={t('companion.pet.label')}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          api.petMenu()
        }}
      >
        {/* The mirror is on a wrapper so the sprite's own steps() animation keeps running. */}
        <div className={`pet-facing${mirrored ? ' pet-facing-left' : ''}`}>
          <div
            className={`pet-sprite${animated ? ' pet-sheet' : ''}`}
            style={{
              backgroundImage: `url("${sprite.src}")`,
              ...(animated
                ? {
                    backgroundSize: `${sprite.frames * FRAME}px ${FRAME}px`,
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
  if (state === 'dozing') {
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
