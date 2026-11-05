/**
 * Two more whole-line commands for the bubble (docs/COMPANION_PLAN.md §13.3, T2 and T5),
 * read before the capture parser like the quiet command is:
 *
 * - a focus span, "foca 25", "focus 25 min", "foco 1h": quiet until it ends, and a word
 *   from Argos when it does;
 * - a timer, "timer 5 min", "temporizador 10", "cronómetro 20 min": a reminder that
 *   many minutes from now, for the oven or the deploy.
 *
 * Both are the whole input: "foca na factura" is a todo. Anything unrecognised is null.
 */
import { normalize, parseDuration } from './companion-quiet-pure'

const MINUTE_MS = 60_000

/** A bare number after the word means minutes. */
export const DEFAULT_UNIT_MS = MINUTE_MS
/** Longer than this is not a focus span or a kitchen timer; use a todo with a time. */
export const MAX_SPAN_MS = 6 * 60 * 60_000

export interface SpanCommand {
  kind: 'focus' | 'timer'
  /** How long, in ms. */
  ms: number
}

const FOCUS_HEAD = /^(foca|foco|focar|focus|pomodoro)(?: (.+))?$/
const TIMER_HEAD = /^(timer|temporizador|cronometro|alarme em|alarm in)(?: (.+))?$/

/** "25", "25 min", "1h", "1h30" → ms; a bare number is minutes. */
function spanMs(tail: string | undefined, fallbackMs: number | null): number | null {
  if (!tail) return fallbackMs
  const s = tail.replace(/^(de|por|durante|for|of) /, '')
  if (/^\d+$/.test(s)) return Number(s) * DEFAULT_UNIT_MS
  return parseDuration(s)
}

/** "guarda isto", "save this", "guarda o clipboard": the clipboard becomes a note (plan §13.3, T4). */
export function isSaveThisCommand(text: string): boolean {
  const s = normalize(text)
  return /^(guarda|guardar|save|keep) (isto|this|o clipboard|the clipboard|clipboard)$/.test(s)
}

/** The focus or timer command the line is, or null when it is anything else. */
export function parseSpanCommand(text: string): SpanCommand | null {
  const s = normalize(text)
  if (!s || s.length > 60) return null
  const focus = FOCUS_HEAD.exec(s)
  const timer = focus ? null : TIMER_HEAD.exec(s)
  const head = focus ?? timer
  if (!head) return null
  // A focus with no span is the classic 25 minutes; a timer needs one.
  const ms = spanMs(head[2], focus ? 25 * MINUTE_MS : null)
  if (ms === null || ms <= 0 || ms > MAX_SPAN_MS) return null
  return { kind: focus ? 'focus' : 'timer', ms }
}
