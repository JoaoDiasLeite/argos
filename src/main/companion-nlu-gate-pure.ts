/**
 * Layer 2 of the companion's date reading (docs/COMPANION_PLAN.md §5.1): when the grammar
 * in companion-nlu-pure.ts is unsure, the one line goes to the account's model. This file
 * is the pure half — when to ask, what to ask, and how the answer is checked and turned
 * into the same ParsedCapture the grammar makes. The call itself lives in index.ts,
 * shaped like `standup:generate`, and is not unit-tested (as elsewhere).
 *
 * Privacy (plan §8): only this path sends anything, and only the single line plus the
 * date context below. The `askModel` pref turns it off entirely.
 */
import { z } from 'zod'
import { parseCapture, remindersForWhen, type ParseOptions } from './companion-nlu-pure'
import type { ParsedCapture } from './companion-types'

/** Below this the grammar's own answer is a guess between two readings (plan §5.1). */
export const MODEL_CONFIDENCE_GATE = 0.6

/** How long a capture may wait for the model before it is saved from the local parse. */
export const MODEL_TIMEOUT_MS = 20_000

const B = String.raw`(?<![\p{L}\p{N}])`
const E = String.raw`(?![\p{L}\p{N}])`

/**
 * Date-ish phrases the grammar does not read (or reads only half of: "ao fim da tarde"
 * is 14:00 to it, with "ao fim" left in the title). A phrase only counts when the
 * grammar, given that phrase alone, does not turn all of it into a date — so a phrase it
 * learns later stops going to the model by itself. Kept small on purpose: each one costs
 * a model call, so only phrases that clearly carry a date belong here.
 */
export const DATEISH_PATTERNS: readonly string[] = [
  // pt-PT — parts of a month or week
  String.raw`(?:fim|final|in[íi]cio|princ[íi]pio|meio|meados)\s+d[oe]\s+m[êe]s`,
  String.raw`(?:fim|final|in[íi]cio|princ[íi]pio|meio)\s+da\s+semana`,
  String.raw`fim[\s-]+de[\s-]+semana`,
  // pt-PT — around meals and the end of a day part
  String.raw`(?:depois|antes)\s+d[oe]\s+(?:almo[çc]o|jantar|pequeno[\s-]almo[çc]o)`,
  String.raw`(?:hora|horas)\s+d[eo]\s+(?:almo[çc]o|jantar)`,
  String.raw`(?:fim|final|in[íi]cio|princ[íi]pio)\s+d[ao]\s+(?:tarde|manh[ãa]|noite|dia)`,
  String.raw`madrugada`,
  // pt-PT — relative weeks, months, years
  String.raw`semana\s+(?:a\s+seguir|seguinte)`,
  String.raw`(?:est[ae]|nest[ae])\s+(?:semana|m[êe]s|quinzena)`,
  String.raw`m[êe]s\s+(?:que\s+vem|a\s+seguir|seguinte)`,
  String.raw`pr[óo]xim[oa]\s+(?:m[êe]s|ano|quinzena)`,
  String.raw`ano\s+que\s+vem`,
  String.raw`dia\s+seguinte`,
  String.raw`quinzena`,
  // "daqui a uma semana e meia", "em duas semanas", "in 3 weeks": the grammar counts
  // minutes, hours and days only.
  String.raw`(?:daqui\s+a|dentro\s+de|em|in|within)\s+(?:\d+|uma|um|duas|dois|tr[êe]s|quatro|cinco|a|an|one|two|three|four|five)\s+(?:semanas?|m[êe]s|meses|anos?|weeks?|months?|years?)`,
  // English
  String.raw`(?:end|start|beginning|middle)\s+of\s+(?:the\s+)?(?:month|week|day)`,
  String.raw`mid[\s-]?(?:month|week)`,
  String.raw`(?:after|before)\s+(?:lunch|dinner|breakfast)`,
  String.raw`lunch\s?time`,
  String.raw`week\s?end`,
  String.raw`(?:next|this)\s+(?:month|year|fortnight)`,
  String.raw`this\s+week`,
  String.raw`week\s+after\s+next`,
  String.raw`fortnight`,
  String.raw`eod`
]

const DATEISH_RE = new RegExp(`${B}(?:${DATEISH_PATTERNS.join('|')})${E}`, 'giu')

/** The grammar reads this phrase on its own, all of it, as a date. */
function grammarReads(phrase: string): boolean {
  const p = parseCapture(phrase, { now: 0 })
  return p.when !== null && p.title === ''
}

/** The first date-ish phrase in the line that the grammar does not read, if any. */
export function unreadDateWords(text: string): string | null {
  for (const m of text.matchAll(DATEISH_RE)) {
    if (!grammarReads(m[0])) return m[0]
  }
  return null
}

/**
 * Whether this line should go to the model: a todo whose date the grammar found but is
 * unsure of (two readings, confidence below the gate), or one with date-ish words the
 * grammar did not consume ("pagar renda no fim do mês", "amanhã depois do almoço").
 * Notes carry no date and queries answer from the list, so neither is ever sent.
 */
export function needsModel(text: string, parsed: ParsedCapture): boolean {
  if (parsed.intent !== 'todo' || !text.trim()) return false
  if (parsed.when && parsed.confidence < MODEL_CONFIDENCE_GATE) return true
  return unreadDateWords(text) !== null
}

// ---- the prompt ------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')

/** "2026-11-02T10:00", local wall time. */
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "+00:00" / "+01:00" / "-03:30" for this instant in local time. */
export function utcOffset(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface WhenPromptInput {
  text: string
  now: Date | number
  /** The app's UI language: which language the line is most likely in. */
  language: 'en' | 'pt-PT'
  leadMinutes: number
  morningHour: number
}

/** One paragraph plus the line, asking for JSON only (plan §5.1, layer 2). */
export function buildWhenPrompt({ text, now, language, leadMinutes, morningHour }: WhenPromptInput): string {
  const d = new Date(now)
  const lang = language === 'pt-PT' ? 'European Portuguese (pt-PT), sometimes English' : 'English, sometimes European Portuguese (pt-PT)'
  return `You read one short line a person typed into a desktop to-do app and work out when it is for. It is now ${WEEKDAYS_EN[d.getDay()]} ${localStamp(d)} local time (UTC${utcOffset(d)}); the person writes in ${lang}. Rules: a time with "by" / "até" / "até às" is the due time; an explicit "lembra-me", "avisa-me" or "remind me" makes the time the reminder itself, so set "isExplicitReminder" to true; a day with no time of day has precision "day" and its "at" is that day at 00:00; "de manhã" / "in the morning" is ${pad(morningHour)}:00, "à tarde" / "in the afternoon" is 14:00 and "à noite" / "in the evening" is 20:00; the app reminds ${leadMinutes} minutes before a timed item by itself, so give the item's own time and never subtract that; a weekday, date or time with nothing else is the next one from now, never in the past; if the line has no date or time at all, "when" is null. The title is the line without its date and time words and without openers such as "tenho de", "lembra-me de" or "remind me to", in the line's own language, first letter capitalised, nothing invented. Answer with only this JSON, no prose and no code fences: {"title": string, "when": {"at": "YYYY-MM-DDTHH:MM" in local time, "precision": "minute" | "day"} | null, "isExplicitReminder": boolean}

Line: ${JSON.stringify(text)}`
}

// ---- the answer ------------------------------------------------------------------

const ModelAnswer = z.object({
  title: z.string(),
  when: z
    .object({
      at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      precision: z.enum(['minute', 'day'])
    })
    .nullable(),
  isExplicitReminder: z.boolean()
})

export type ModelAnswer = z.infer<typeof ModelAnswer>

/** How far ahead an answer may land before it reads as a hallucination. */
const MAX_YEARS_AHEAD = 5

/**
 * "YYYY-MM-DDTHH:MM" as a local wall-clock instant, through Date's local constructor so
 * a DST change never shifts it; null for a date that does not exist ("2026-02-30") or a
 * wall time a spring-forward skips.
 */
export function parseLocalStamp(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || h > 23 || mi > 59) return null
  const r = new Date(y, mo - 1, d, h, mi)
  if (r.getFullYear() !== y || r.getMonth() !== mo - 1 || r.getDate() !== d) return null
  if (r.getHours() !== h || r.getMinutes() !== mi) return null
  return r
}

/**
 * The model's JSON, checked and turned into a ParsedCapture, or null when anything is off
 * (wrong shape, a date that does not exist, one in the past or absurdly far ahead) — the
 * caller then keeps the local parse. Reminders follow the grammar's own rule.
 */
export function parsedFromModel(raw: unknown, local: ParsedCapture, opts: ParseOptions): ParsedCapture | null {
  const r = ModelAnswer.safeParse(raw)
  if (!r.success) return null
  const answer = r.data
  const now = new Date(opts.now)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const limit = new Date(now.getFullYear() + MAX_YEARS_AHEAD, now.getMonth(), now.getDate())

  let when: ParsedCapture['when'] = null
  if (answer.when) {
    const at = parseLocalStamp(answer.when.at)
    if (!at) return null
    if (answer.when.precision === 'day') {
      const day = new Date(at.getFullYear(), at.getMonth(), at.getDate())
      if (day < today || day > limit) return null
      when = { at: day.getTime(), precision: 'day' }
    } else {
      // A minute of slack: "daqui a 0 minutos" and a slow answer are not "the past".
      if (at.getTime() < now.getTime() - 60_000 || at > limit) return null
      when = { at: at.getTime(), precision: 'minute' }
    }
  }

  // A repeat is the grammar's to read ("todos os dias"); the model only places the date.
  // With none from the model, the repeat's own first day stands.
  if (!when && local.repeat) when = local.when
  const title = answer.title.replace(/\s+/g, ' ').trim().slice(0, 500) || local.title
  // The grammar's "lembra-me" check is exact; the model may add one it read in English.
  const isExplicitReminder = answer.isExplicitReminder || local.isExplicitReminder
  return {
    intent: 'todo',
    title,
    when,
    remindAt: remindersForWhen(when, isExplicitReminder, opts),
    isExplicitReminder,
    // Not the grammar's certainty: what the receipt shows is "read by the model, check it".
    confidence: 1,
    matchedSpan: null,
    fromModel: when !== null && when !== local.when,
    ...(local.repeat ? { repeat: local.repeat } : {})
  }
}
