/**
 * Quiet mode (docs/COMPANION_PLAN.md §3.3): the `shh` typed into the bubble, and the few
 * rules around it that need no Electron. v1 is manual only — the bubble, the tray and a
 * right-click on the pet; nothing here guesses at Focus Assist or a Teams call.
 *
 * A command is the WHOLE input, nothing else: "shh 1h" mutes, "shh, ligar ao Rui" is a
 * todo that happens to start with "shh". Anything this does not recognise returns null
 * and goes to the ordinary capture parser.
 */
import type { CompanionPetState } from './companion-types'

/** What a quiet command asks for: muted until an instant, or back on. */
export type QuietCommand = { untilMs: number } | { off: true }

export interface QuietContext {
  now: number
  /** "Até amanhã" means tomorrow at this hour (the companion's morning hour). */
  morningHour: number
}

/** `shh` with no duration. */
export const DEFAULT_QUIET_MS = 60 * 60_000
/** Longer than this reads as a typo rather than a wish; use "até amanhã" for a night. */
export const MAX_QUIET_MS = 24 * 60 * 60_000

const HOUR_MS = 60 * 60_000
const MINUTE_MS = 60_000

/** Lowercase, accents off, spaces collapsed, a trailing "." or "!" dropped. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trim()
}

/** The words that start a mute. "shh" takes any number of h's. */
const QUIET_HEAD = /^(sh+|chiu|silencio|quiet|mute|not now|nao agora|agora nao)(?: (.+))?$/
/** Back on, said on their own. */
const WAKE = new Set(['acorda', 'fala', 'podes falar', 'volta', 'wake up', 'wake', 'unmute'])
/** After a quiet word: "shh off", "silêncio desliga". */
const OFF_TAIL = new Set(['off', 'desliga', 'desligado', 'desligar', 'stop'])
const TOMORROW_TAIL = new Set(['ate amanha', 'amanha', 'until tomorrow', 'till tomorrow', 'tomorrow'])

/** Tomorrow at `hour`, local time (DST-safe: built from the calendar, not +24 h). */
export function tomorrowAt(now: number, hour: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, 0, 0, 0).getTime()
}

/** "1h", "30m", "2 horas", "1h30", "uma hora", "meia hora", "por 20 min" → ms; else null. */
export function parseDuration(tail: string): number | null {
  const s = tail.replace(/^(por|durante|for) /, '')
  if (/^(uma|1) hora$|^(an|one|1) hour$/.test(s)) return HOUR_MS
  if (/^meia hora$|^half an hour$/.test(s)) return 30 * MINUTE_MS
  const m = /^(\d+(?:[.,]\d+)?) ?(h|hr|hrs|hora|horas|hour|hours)(?: ?(\d+) ?(m|min|mins|minutos?|minutes?)?)?$/.exec(s)
  if (m) {
    const hours = Number(m[1].replace(',', '.'))
    const minutes = m[3] ? Number(m[3]) : 0
    return hours * HOUR_MS + minutes * MINUTE_MS
  }
  const mm = /^(\d+) ?(m|min|mins|minuto|minutos|minute|minutes)$/.exec(s)
  if (mm) return Number(mm[1]) * MINUTE_MS
  return null
}

/** The bubble's quiet command, or null when the line is anything else. */
export function parseQuietCommand(text: string, ctx: QuietContext): QuietCommand | null {
  const s = normalize(text)
  if (!s || s.length > 60) return null
  if (WAKE.has(s)) return { off: true }
  const head = QUIET_HEAD.exec(s)
  if (!head) return null
  const tail = head[2]
  if (!tail) return { untilMs: ctx.now + DEFAULT_QUIET_MS }
  if (OFF_TAIL.has(tail)) return { off: true }
  if (TOMORROW_TAIL.has(tail)) return { untilMs: tomorrowAt(ctx.now, ctx.morningHour) }
  const ms = parseDuration(tail)
  if (ms === null || ms <= 0 || ms > MAX_QUIET_MS) return null
  return { untilMs: ctx.now + ms }
}

/** Muted right now: `dndUntil` set and still ahead. */
export function isQuiet(dndUntil: number | null | undefined, now: number): boolean {
  return typeof dndUntil === 'number' && dndUntil > now
}

/** What the pet sits back to after anything else (a bubble, a walk, the happy beat): the crescent while muted. */
export function restingPetState(dndUntil: number | null | undefined, now: number): CompanionPetState {
  return isQuiet(dndUntil, now) ? 'shh' : 'idle'
}

/** Which day the end of a mute falls on, for "até 15:30" vs "até amanhã, 09:00". */
export function quietUntilDay(until: number, now: number): 'today' | 'tomorrow' | 'later' {
  const a = new Date(now)
  const b = new Date(until)
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(b) - day(a)) / (24 * HOUR_MS))
  return diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : 'later'
}
