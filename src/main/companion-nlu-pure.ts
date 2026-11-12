/**
 * Text → intent + date for the companion (docs/COMPANION_PLAN.md §5.1, layer 1).
 *
 * A hand-written grammar for a closed set of forms, pt-PT first and basic English.
 * chrono-node was tried and rejected (7 of 25 real phrases, several silently wrong), so
 * there is no dependency here and no network: this answers in well under a millisecond
 * and is fully unit-tested.
 *
 * How it works: a list of rules, each one regex plus a reader, runs in priority order
 * over the original text. A match that overlaps a span an earlier rule already claimed
 * is skipped, so "às 2 da tarde" is one clock time and not a time plus a day part. The
 * pieces found (an absolute instant, a day, a clock time, a day part) are then combined,
 * and their spans are cut out of the text to leave the title.
 *
 * All date math is local time through Date setters: no UTC, and no fixed 24-hour
 * offsets across days, so a DST change never shifts a date by an hour.
 */
import type { CompanionIntent, ParsedCapture } from './companion-types'
import { findIntervals, findRepeat, firstOccurrence, maskIntervals, maskRepeat } from './companion-repeat-pure'

export type { CompanionIntent, ParsedCapture } from './companion-types'

export interface ParseOptions {
  now: Date | number
  /** Minutes before a timed item that its reminder fires. Default 10. */
  leadMinutes?: number
  /** Hour a day-precision item reminds at, and what "de manhã" means. Default 9. */
  morningHour?: number
}

type Part = 'morning' | 'afternoon' | 'night'

type Body =
  /** An exact instant: "daqui a 20 minutos". */
  | { kind: 'abs'; at: number }
  /** A local day at 00:00; `week` for "na próxima semana" (its Monday). */
  | { kind: 'day'; date: Date; week?: boolean }
  /**
   * A clock time. `bare` when the hour came with no ":" or "h" ("às 2"), which is what
   * makes it open to the pm guess; `meridiem` from "am" / "pm"; `part` from "da manhã" /
   * "da tarde" / "da noite", kept apart from am/pm because "12 da noite" is midnight
   * where "12 pm" is noon.
   */
  | {
      kind: 'time'
      h: number
      m: number
      bare: boolean
      guessPm: boolean
      meridiem: 'am' | 'pm' | null
      part?: Part
      nextDay?: boolean
    }
  /** A day part on its own: "de manhã", "à tarde", "à noite". */
  | { kind: 'part'; part: Part }

type Comp = Body & { start: number; end: number }

interface Ctx {
  now: Date
  today: Date
  morningHour: number
}

interface Rule {
  re: RegExp
  read: (g: Record<string, string | undefined>, ctx: Ctx) => Body[] | null
}

// ---- building blocks ------------------------------------------------------------

// Word boundaries that know about accented letters (`\b` treats "ã" as a non-word char).
const B = String.raw`(?<![\p{L}\p{N}])`
const E = String.raw`(?![\p{L}\p{N}])`
// Around a number: not glued to "#", a dot, a colon or a slash, so ticket numbers,
// versions ("2.9"), IPs ("10.0.0.5") and ports stay whole and unmatched.
const NB = String.raw`(?<![\p{L}\p{N}#.:/,])`
const NE = String.raw`(?![\p{L}\p{N}]|[.,:/]\d)`

const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, doze: 12, quinze: 15, vinte: 20, 'vinte e cinco': 25,
  trinta: 30, quarenta: 40, 'quarenta e cinco': 45, cinquenta: 50, noventa: 90,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15,
  twenty: 20, thirty: 30, 'forty-five': 45, 'forty five': 45
}

/** Hours said as words: "à uma", "às duas da tarde", "at two pm". */
const HOUR_WORDS_PT: Record<string, number> = {
  uma: 1, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
  nove: 9, dez: 10, onze: 11, doze: 12
}
const HOUR_WORDS_EN: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12
}
const HOUR_WORDS: Record<string, number> = { ...HOUR_WORDS_PT, ...HOUR_WORDS_EN }

const MONTHS_PT: Record<string, number> = {
  janeiro: 0, fevereiro: 1, 'março': 2, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6,
  agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11
}
const MONTHS_EN: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11
}
const MONTHS: Record<string, number> = { ...MONTHS_PT, ...MONTHS_EN }

/** getDay() numbering: Sunday 0. */
const WEEKDAYS: Record<string, number> = {
  segunda: 1, 'terça': 2, terca: 2, quarta: 3, quinta: 4, sexta: 5, 'sábado': 6, sabado: 6,
  domingo: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sunday: 0
}

/**
 * Longest first, so "vinte e cinco" wins over "vinte". Spaces match any whitespace.
 * The words are plain letters, hyphens and spaces (a `\-` escape is a syntax error
 * under the `u` flag, so none is attempted).
 */
function alt(words: string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/ /g, String.raw`\s+`))
    .join('|')
}

const NUMW = alt(Object.keys(NUMBER_WORDS))
const HOURW = alt(Object.keys(HOUR_WORDS))
const MONTH = alt(Object.keys(MONTHS))
const MONTH_EN = alt(Object.keys(MONTHS_EN))
const WD = alt(Object.keys(WEEKDAYS))
const AMPM = String.raw`a\.?m\.?|p\.?m\.?`
const DAYPART = String.raw`manh[ãa]|tarde|noite|morning|afternoon|evening|night`
/** Optional lead-in words a date may carry ("até dia 12", "no dia 12", "by 12/11"). */
const DATE_PRE = String.raw`(?:(?:no\s+dia|no|até\s+ao|até|para\s+o|para|em|a|on|by|until)\s+)?`

function rx(src: string): RegExp {
  return new RegExp(src, 'giu')
}

function key(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ')
}

// ---- date helpers (local time only) --------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function addMinutes(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  r.setMinutes(r.getMinutes() + n)
  return r
}

/** A real calendar date, or null for "31/11" and friends. */
function makeDate(y: number, mo: number, d: number): Date | null {
  const r = new Date(y, mo, d)
  return r.getFullYear() === y && r.getMonth() === mo && r.getDate() === d ? r : null
}

/** The next day-month on or after today; an explicit year is taken as given. */
function dayMonth(day: number, mo: number, year: number | undefined, today: Date): Date | null {
  if (year !== undefined) return makeDate(year < 100 ? 2000 + year : year, mo, day)
  // Eight years covers 29 February.
  for (let y = today.getFullYear(); y <= today.getFullYear() + 8; y++) {
    const d = makeDate(y, mo, day)
    if (d && d >= today) return d
  }
  return null
}

/** "dia 12": this month if the 12th is today or still ahead, else the next month that has one. */
function dayOfMonth(day: number, today: Date): Date | null {
  for (let i = 0; i <= 12; i++) {
    const first = new Date(today.getFullYear(), today.getMonth() + i, 1)
    const d = makeDate(first.getFullYear(), first.getMonth(), day)
    if (d && d >= today) return d
  }
  return null
}

/** The next given weekday strictly after today. */
function nextWeekday(target: number, today: Date): Date {
  return addDays(today, (target - today.getDay() + 7) % 7 || 7)
}

/** The given weekday in next calendar week (weeks start on Monday). */
function weekdayNextWeek(target: number, today: Date): Date {
  const monday = addDays(today, (8 - today.getDay()) % 7 || 7)
  return addDays(monday, (target + 6) % 7)
}

// ---- the rules, in priority order ----------------------------------------------

function dayPart(word: string): Part {
  return /^(manh|morning)/i.test(word) ? 'morning' : /^(tarde|afternoon)/i.test(word) ? 'afternoon' : 'night'
}

function clock(g: Record<string, string | undefined>, allowBare: boolean): Body[] | null {
  const h = g.hw ? HOUR_WORDS[key(g.hw)] : Number(g.h)
  const m = g.mi ? Number(g.mi) : 0
  const bare = !g.sep && !g.hh
  let meridiem: 'am' | 'pm' | null = null
  if (g.ap) meridiem = g.ap.toLowerCase().startsWith('a') ? 'am' : 'pm'
  const part = !g.ap && g.dp ? dayPart(g.dp) : undefined
  if (bare && !meridiem && !part && !allowBare) return null
  if (h === undefined || m > 59 || h > 23 || ((meridiem || part) && (h < 1 || h > 12))) return null
  // "às 2" and "às 2h" are open to the pm guess; "às 2:00" was written as a clock.
  return [{ kind: 'time', h, m, bare, guessPm: g.sep !== ':', meridiem, ...(part ? { part } : {}) }]
}

/**
 * A 12-hour reading under a day part, as pt-PT says it: "12 da manhã" and "12 da tarde"
 * are noon, "1 da tarde" is 13:00, "12 da noite" is the midnight that ends the day (like
 * "meia-noite"), "8 da noite" is 20:00, and "2 da noite" the small hours.
 */
function partHour(h: number, part: Part): { h: number; nextDay: boolean } {
  if (part === 'morning') return { h, nextDay: false }
  if (part === 'afternoon') return { h: h === 12 ? 12 : h + 12, nextDay: false }
  if (h === 12) return { h: 0, nextDay: true }
  return { h: h <= 5 ? h : h + 12, nextDay: false }
}

const RULES: Rule[] = [
  // "daqui a 20 minutos", "em 15 minutos", "dentro de duas horas", "in half an hour", "daqui a 3 dias"
  {
    re: rx(
      String.raw`${B}(?:daqui\s+a|dentro\s+de|em|in|within)\s+(?:(?<n>\d{1,3}|${NUMW})\s*(?<u>minutos?|minutes?|mins?|horas?|hours?|hrs?|h|dias?|days?)|(?<half>meia\s+hora|half\s+an\s+hour))${E}`
    ),
    read: (g, ctx) => {
      if (g.half) return [{ kind: 'abs', at: addMinutes(ctx.now, 30).getTime() }]
      const n = /^\d/.test(g.n!) ? Number(g.n) : NUMBER_WORDS[key(g.n!)]
      if (!n) return null
      const u = g.u!.toLowerCase()
      if (u.startsWith('min')) return [{ kind: 'abs', at: addMinutes(ctx.now, n).getTime() }]
      if (/^(dia|day)/.test(u)) return [{ kind: 'day', date: addDays(ctx.today, n) }]
      return [{ kind: 'abs', at: addMinutes(ctx.now, n * 60).getTime() }]
    }
  },
  // "12/11", "até 12/11/2027"
  {
    re: rx(String.raw`${B}${DATE_PRE}${NB}(?<d>\d{1,2})/(?<mo>\d{1,2})(?:/(?<y>\d{4}|\d{2}))?${NE}`),
    read: (g, ctx) => {
      const d = dayMonth(Number(g.d), Number(g.mo) - 1, g.y ? Number(g.y) : undefined, ctx.today)
      return d ? [{ kind: 'day', date: d }] : null
    }
  },
  // "dia 12", "no dia 5 de dezembro", "até dia 3 de março de 2027"
  {
    re: rx(
      String.raw`${B}(?:(?:no|até\s+ao|até|para\s+o|para|a)\s+)?dia\s+(?<d>\d{1,2})(?:\s+(?:de\s+)?(?<mo>${MONTH}))?(?:\s+(?:de\s+)?(?<y>\d{4}))?${NE}`
    ),
    read: (g, ctx) => {
      const day = Number(g.d)
      const d = g.mo
        ? dayMonth(day, MONTHS[key(g.mo)], g.y ? Number(g.y) : undefined, ctx.today)
        : dayOfMonth(day, ctx.today)
      return d ? [{ kind: 'day', date: d }] : null
    }
  },
  // "12 de novembro", "12 novembro 2027", "12th november"
  {
    re: rx(
      String.raw`${B}${DATE_PRE}${NB}(?<d>\d{1,2})(?:º|st|nd|rd|th)?\s+(?:de\s+)?(?<mo>${MONTH})(?:,?\s+(?:de\s+)?(?<y>\d{4}))?${E}`
    ),
    read: (g, ctx) => {
      const d = dayMonth(Number(g.d), MONTHS[key(g.mo!)], g.y ? Number(g.y) : undefined, ctx.today)
      return d ? [{ kind: 'day', date: d }] : null
    }
  },
  // "november 12", "on november 12th, 2027"
  {
    re: rx(
      String.raw`${B}(?:(?:on|by|until)\s+)?(?<mo>${MONTH_EN})\s+(?<d>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?<y>\d{4}))?${NE}`
    ),
    read: (g, ctx) => {
      const d = dayMonth(Number(g.d), MONTHS[key(g.mo!)], g.y ? Number(g.y) : undefined, ctx.today)
      return d ? [{ kind: 'day', date: d }] : null
    }
  },
  // "hoje", "amanhã", "depois de amanhã", "today", "tomorrow", "the day after tomorrow"
  {
    re: rx(
      String.raw`${B}(?:(?:para|até|for|by|until)\s+)?(?<w>depois\s+de\s+amanh[ãa]|(?:the\s+)?day\s+after\s+tomorrow|amanh[ãa]|hoje|tomorrow|today)${E}`
    ),
    read: (g, ctx) => {
      const w = key(g.w!)
      const n = /depois|after/.test(w) ? 2 : /amanh|tomorrow/.test(w) ? 1 : 0
      return [{ kind: 'day', date: addDays(ctx.today, n) }]
    }
  },
  // "sexta", "na sexta-feira", "segunda que vem", "próxima terça", "next friday", "on monday"
  {
    re: rx(
      String.raw`${B}(?:(?:na|no|à|ao|até\s+à|até\s+ao|até|para|on|by|until)\s+)?(?:(?<mod>pr[óo]xim[ao]|est[ae]|next|this)\s+)?(?<wd>${WD})(?:-feira|\s+feira)?(?!\s+vez)(?:\s+(?<after>que\s+vem|da\s+pr[óo]xima\s+semana|da\s+semana\s+que\s+vem))?${E}`
    ),
    read: (g, ctx) => {
      const target = WEEKDAYS[key(g.wd!)]
      // "sexta que vem" / "próxima sexta" is simply the next friday, like a bare "sexta";
      // only "sexta da próxima semana" names next calendar week's.
      const nextWeek = g.after && /semana/i.test(g.after)
      return [{ kind: 'day', date: nextWeek ? weekdayNextWeek(target, ctx.today) : nextWeekday(target, ctx.today) }]
    }
  },
  // "na próxima semana", "para a semana", "semana que vem", "next week" → next Monday
  {
    re: rx(
      String.raw`${B}(?:(?:(?:na|para\s+a|para|a|até\s+à|on|for|by)\s+)?(?:pr[óo]xima\s+semana|semana\s+que\s+vem|next\s+week)|para\s+a\s+semana)${E}`
    ),
    read: (_g, ctx) => [{ kind: 'day', date: nextWeekday(1, ctx.today), week: true }]
  },
  // "ao meio-dia", "at noon"
  {
    re: rx(String.raw`${B}(?:(?:ao|até\s+ao|para\s+o|at|by)\s+)?(?:meio[-\s]dia|noon|midday)${E}`),
    read: () => [{ kind: 'time', h: 12, m: 0, bare: false, guessPm: false, meridiem: null }]
  },
  // "à meia-noite", "at midnight" — the 00:00 that ends the day
  {
    re: rx(String.raw`${B}(?:(?:à|até\s+à|para\s+a|at|by)\s+)?(?:meia[-\s]noite|midnight)${E}`),
    read: () => [{ kind: 'time', h: 0, m: 0, bare: false, guessPm: false, meridiem: null, nextDay: true }]
  },
  // "às 14h", "às 14:30", "até às 14h", "às 2 da tarde", "at 2pm", "at 14:00", bare "às 2",
  // and the hour as a word: "à uma da tarde", "às duas", "at two pm".
  // A bare hour only after "às" / "pelas" / "at": "as 3 propostas" is an article. "à"
  // (singular) only before one o'clock, the one hour pt-PT says with it.
  {
    re: rx(
      String.raw`${B}(?:(?:até|by|until)\s+)?(?<p>[àá]s|[àá]|as|pelas|at|by|until|até)\s+(?:${NB}(?<h>\d{1,2})(?:(?<sep>[:h])(?<mi>\d{2})|(?<hh>h)|\s*horas?)?|(?<hw>${HOURW})(?:\s+horas?)?)(?:\s*(?<ap>${AMPM})|\s+(?:da|de|pela|in\s+the|at)\s+(?<dp>${DAYPART}))?${NE}`
    ),
    read: (g) => {
      const p = g.p!.toLowerCase()
      const hour = g.hw ? HOUR_WORDS[key(g.hw)] : Number(g.h)
      if ((p === 'à' || p === 'á') && hour !== 1) return null
      // A bare English word ("at one point") is not a time; a bare pt-PT one ("às duas") is.
      const english = !!g.hw && key(g.hw) in HOUR_WORDS_EN
      return clock(g, !english && /^([àá]s?|pelas|at)$/.test(p))
    }
  },
  // "14h30", "9h", "14:30", "2:30pm", "2pm", "9 da manhã" — no lead-in word
  {
    re: rx(
      String.raw`${B}${NB}(?<h>\d{1,2})(?:(?:(?<sep>[:h])(?<mi>\d{2})|(?<hh>h))(?:\s*(?<ap>${AMPM}))?|\s*(?<ap2>${AMPM})|\s+(?:da|de)\s+(?<dp>manh[ãa]|tarde|noite))${NE}`
    ),
    read: (g) => clock({ ...g, ap: g.ap ?? g.ap2 }, false)
  },
  // "de manhã", "à tarde", "à noite", "esta tarde", "in the morning", "tonight"
  {
    re: rx(
      String.raw`${B}(?:(?<this>esta|this)\s+(?<p1>manh[ãa]|tarde|noite|morning|afternoon|evening)|(?:de|da|à|á|pela|in\s+the)\s+(?<p2>${DAYPART})|(?<tonight>tonight))${E}`
    ),
    read: (g, ctx) => {
      const w = (g.p1 ?? g.p2 ?? 'night').toLowerCase()
      const part: Part = /^(manh|morning)/.test(w) ? 'morning' : /^(tarde|afternoon)/.test(w) ? 'afternoon' : 'night'
      const out: Body[] = [{ kind: 'part', part }]
      if (g.this || g.tonight) out.push({ kind: 'day', date: ctx.today })
      return out
    }
  }
]

function scan(text: string, ctx: Ctx): Comp[] {
  const comps: Comp[] = []
  const taken = (s: number, e: number): boolean => comps.some((c) => s < c.end && e > c.start)
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text))) {
      const start = m.index
      const end = start + m[0].length
      if (taken(start, end)) continue
      const bodies = rule.read(m.groups ?? {}, ctx)
      if (bodies) for (const b of bodies) comps.push({ ...b, start, end })
    }
  }
  return comps.sort((a, b) => a.start - b.start)
}

// ---- intent, title ---------------------------------------------------------------

const NOTE_RE = /^\s*(?:nota|note|anota|anotar)\s*:\s*/iu
const QUERY_RE = /^\s*(?:o\s+que\s+(?:é\s+que\s+)?tenho|que\s+tenho|what\s+do\s+i\s+have|what(?:'s|\s+is)\s+on)(?![\p{L}])/iu
const REMIND_RE = /(?<![\p{L}])(?:lembra-me|lembra\s+me|lembrar-me|avisa-me|avisa\s+me|remind\s+me)(?![\p{L}])/iu
/** Openers that carry no content: they go, and so does a connective right after them. */
const FILLER_RE =
  /^(?:lembra-me|lembra\s+me|lembrar-me|avisa-me|avisa\s+me|remind\s+me|tenho\s+de|tenho\s+que|preciso\s+de|não\s+esquecer\s+de|i\s+need\s+to|i\s+have\s+to|need\s+to|have\s+to)(?![\p{L}])\s*(?:(?:de|que|para|to|about)(?![\p{L}])\s*)?/iu
/** Prepositions a cut span leaves dangling at the end ("ligar ao joão na"). */
const TRAILING_RE = /\s+(?:na|no|à|ao|a|para|até|de|em|e|on|at|by|for|and|to|until)$/iu

function finishTitle(s: string): string {
  let t = s.replace(/\s+/g, ' ').replace(/^[\s,;:.!?-]+/, '').replace(/[\s,;:.!?-]+$/, '')
  for (;;) {
    const next = t.replace(TRAILING_RE, '').replace(/[\s,;:.!?-]+$/, '')
    if (next === t) break
    t = next
  }
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function titleFrom(text: string, comps: Comp[]): string {
  let t = ''
  let at = 0
  for (const c of comps) {
    if (c.start < at) continue
    t += text.slice(at, c.start) + ' '
    at = c.end
  }
  t += text.slice(at)
  t = t.replace(/\s+/g, ' ').trim().replace(/^[,;:-]+\s*/, '')
  for (;;) {
    const next = t.replace(FILLER_RE, '')
    if (next === t) break
    t = next
  }
  return finishTitle(t)
}

// ---- combining -------------------------------------------------------------------

function sameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime()
}

interface Resolved {
  when: { at: number; precision: 'minute' | 'day' } | null
  confidence: number
  /** Set for "na próxima semana": the query range is the week, not the day. */
  week: Date | null
}

function resolve(comps: Comp[], ctx: Ctx): Resolved {
  if (comps.length === 0) return { when: null, confidence: 0, week: null }
  let confidence = 1
  const abs = comps.filter((c) => c.kind === 'abs')
  const days = comps.filter((c) => c.kind === 'day')
  const times = comps.filter((c) => c.kind === 'time')
  const parts = comps.filter((c) => c.kind === 'part')

  if (abs.length) {
    // "daqui a 20 minutos" next to any other date is two answers to one question.
    if (abs.length > 1 || days.length || times.length) confidence = 0.5
    return { when: { at: abs[0].at, precision: 'minute' }, confidence, week: null }
  }

  const day = days[0]
  if (days.some((d) => !sameDay(d.date, day.date))) confidence = 0.5
  const part = parts[0]?.part
  if (parts.some((p) => p.part !== part)) confidence = 0.5

  let h: number
  let m = 0
  let nextDay = false
  const time = times[0]
  if (time) {
    if (times.some((t) => t.h !== time.h || t.m !== time.m)) confidence = 0.5
    h = time.h
    m = time.m
    nextDay = !!time.nextDay
    if (time.meridiem === 'pm' && h < 12) h += 12
    else if (time.meridiem === 'am' && h === 12) h = 0
    else if (time.part) {
      const r = partHour(h, time.part)
      h = r.h
      nextDay = nextDay || r.nextDay
    } else if (!time.meridiem && time.guessPm) {
      // A day part elsewhere settles a bare hour ("amanhã à tarde às 3"); without one,
      // 1–7 is read as afternoon — nobody books a call at 3 in the morning by typing "às 3".
      if ((part === 'afternoon' || part === 'night') && h < 12) h += 12
      else if (part !== 'morning' && h >= 1 && h <= 7) {
        h += 12
        confidence = Math.min(confidence, 0.7)
      }
    }
  } else if (part) {
    h = part === 'morning' ? ctx.morningHour : part === 'afternoon' ? 14 : 20
  } else {
    return { when: { at: day.date.getTime(), precision: 'day' }, confidence, week: day.week ? day.date : null }
  }

  const base = day ? day.date : ctx.today
  let at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (nextDay ? 1 : 0), h, m)
  // A time with no date is the next one: today if still ahead, else tomorrow.
  if (!day && at <= ctx.now) at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (nextDay ? 2 : 1), h, m)
  return { when: { at: at.getTime(), precision: 'minute' }, confidence, week: null }
}

function remindersFor(
  when: Resolved['when'],
  explicit: boolean,
  ctx: Ctx,
  leadMinutes: number
): number[] {
  if (!when) return []
  if (when.precision === 'day') {
    const d = new Date(when.at)
    const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate(), ctx.morningHour)
    return morning > ctx.now ? [morning.getTime()] : []
  }
  if (explicit) return [when.at]
  const lead = addMinutes(new Date(when.at), -leadMinutes).getTime()
  return lead > ctx.now.getTime() ? [lead] : [when.at]
}

/**
 * The reminders a todo with this `when` gets (plan §5.3): a day reminds at the morning
 * hour, a time `leadMinutes` before, an explicit "lembra-me" at the time itself. Shared
 * with the model's answer (companion-nlu-gate-pure.ts), so both layers follow one rule.
 */
export function remindersForWhen(
  when: ParsedCapture['when'],
  explicit: boolean,
  opts: ParseOptions
): number[] {
  const now = new Date(opts.now)
  const ctx: Ctx = { now, today: startOfDay(now), morningHour: opts.morningHour ?? 9 }
  return remindersFor(when, explicit, ctx, opts.leadMinutes ?? 10)
}

// ---- entry -----------------------------------------------------------------------

export function parseCapture(text: string, opts: ParseOptions): ParsedCapture {
  const now = new Date(opts.now)
  const ctx: Ctx = { now, today: startOfDay(now), morningHour: opts.morningHour ?? 9 }
  const leadMinutes = opts.leadMinutes ?? 10

  const note = NOTE_RE.exec(text)
  if (note) {
    return {
      intent: 'note',
      title: finishTitle(text.slice(note[0].length)),
      when: null,
      remindAt: [],
      isExplicitReminder: false,
      confidence: 1,
      matchedSpan: null
    }
  }

  const intent: CompanionIntent = QUERY_RE.test(text) || text.trim().endsWith('?') ? 'query' : 'todo'
  // "todos os dias", "todas as segundas": masked out before the grammar runs (same length,
  // so its spans still index `text`), and the date it reads is then aligned to the rule.
  const repeatMatch = intent === 'todo' ? findRepeat(text) : null
  const scanned = repeatMatch ? maskRepeat(text, repeatMatch) : text
  // "de 2 em 2 horas" has no repeat to become (see findIntervals): hidden from the grammar
  // so it is not read as "em 2 horas", and left whole in the title for João to see.
  const intervals = intent === 'todo' ? findIntervals(scanned) : []
  const comps = scan(intervals.length ? maskIntervals(scanned, intervals) : scanned, ctx)
  const resolved = resolve(comps, ctx)
  let repeat: ParsedCapture['repeat'] = null
  if (repeatMatch) {
    const first = firstOccurrence(repeatMatch, resolved.when, now.getTime())
    resolved.when = first.when
    repeat = first.repeat
    // "todos os dias" alone is a whole date: today, then every day.
    if (comps.length === 0) resolved.confidence = 1
  }
  const spans = repeatMatch ? [...comps.map((c) => [c.start, c.end]), [repeatMatch.start, repeatMatch.end]] : comps.map((c) => [c.start, c.end])
  const matchedSpan: [number, number] | null = spans.length
    ? [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))]
    : null
  const title = titleFrom(scanned, comps)

  if (intent === 'query') {
    const from = resolved.week ?? startOfDay(resolved.when ? new Date(resolved.when.at) : now)
    const to = addDays(from, resolved.week ? 7 : 1)
    return {
      intent,
      title,
      when: resolved.when,
      remindAt: [],
      isExplicitReminder: false,
      confidence: resolved.confidence,
      matchedSpan,
      queryRange: { from: from.getTime(), to: to.getTime() }
    }
  }

  const isExplicitReminder = REMIND_RE.test(text)
  return {
    intent,
    title,
    when: resolved.when,
    remindAt: remindersFor(resolved.when, isExplicitReminder, ctx, leadMinutes),
    isExplicitReminder,
    confidence: resolved.confidence,
    matchedSpan,
    ...(repeat ? { repeat } : {})
  }
}
