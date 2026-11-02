/**
 * The companion's data model (docs/COMPANION_PLAN.md §6) and the shapes its IPC carries
 * (§9.4). No Electron here: main re-exports these from companion-types.ts, the renderer
 * from types.ts, and the pure modules test against them.
 */

export interface CompanionTodo {
  id: string
  title: string
  notes?: string | null
  /** Epoch ms. null = someday. */
  dueAt?: number | null
  /** 'day' when no time was given — the UI shows a date, not 09:00. */
  duePrecision?: 'day' | 'minute'
  /** Every time it should speak, oldest first; snoozes append. */
  remindAt: number[]
  /** How far each remindAt fired, so a restart doesn't repeat one. */
  firedAt?: number[]
  done: boolean
  doneAt?: number | null
  createdAt: number
  source: 'voice' | 'text' | 'argos'
  /** Set when promoted; the sprint item is then the source of truth for `done`. */
  sprintId?: string | null
  sprintItemId?: string | null
  projectPath?: string | null
}

export interface CompanionNote {
  id: string
  text: string
  createdAt: number
  source: 'voice' | 'text'
  tags?: string[]
  /** Set once exported, so a re-export doesn't duplicate the file. */
  obsidianPath?: string | null
}

/** state.json: what the pet remembers between runs that is neither a todo nor a preference. */
export interface CompanionState {
  /** Epoch ms do-not-disturb ends; null or absent = not muted. */
  dndUntil?: number | null
  /** When the last catch-up ran, so a wake from sleep only reports what it missed. */
  lastCatchUpAt?: number | null
  /** Pet position per display, keyed by display id. */
  positions?: Record<string, { x: number; y: number }>
}

export type CompanionIntent = 'todo' | 'note' | 'query'

/** What companion-nlu-pure.ts makes of one line of input (plan §5.1). */
export interface ParsedCapture {
  intent: CompanionIntent
  /** The input with the date/time span and filler ("tenho de", "lembra-me de") removed. */
  title: string
  /** The due time, or the remind time for an explicit "lembra-me". */
  when: { at: number; precision: 'minute' | 'day' } | null
  /** When to speak, per plan §5.3. */
  remindAt: number[]
  /** "lembra-me", "avisa-me", "remind me": `when` is the reminder itself, no lead. */
  isExplicitReminder: boolean
  /** 0..1. Below 0.6 the model gets a second look (plan §5.1, layer 2). */
  confidence: number
  /** From the first date/time span's start to the last one's end. */
  matchedSpan: [number, number] | null
  /** For 'query': the local day (or week) asked about, [from, to). */
  queryRange?: { from: number; to: number }
}

// ---- preferences -------------------------------------------------------------------

/** `config.companion`. */
export interface CompanionPrefs {
  /** "Ficar no ecrã": the pet stays up all day. Off = only when summoned or reminding. */
  stayOnScreen: boolean
  /** Preferred summon accelerator. '' = automatic (Ctrl+Alt+A with a fallback). */
  shortcut: string
  /** Minutes before a timed item that its reminder fires (plan §5.3). */
  leadMinutes: number
  /** Hour a day-precision item reminds at. */
  morningHour: number
  /** Keep the pet and its bubble out of screen shares and captures (plan §2.4). */
  hideFromCapture: boolean
}

// ---- IPC ---------------------------------------------------------------------------

/** What the pet is doing, which picks its pose (plan §2.3). */
export type CompanionPetState = 'idle' | 'dozing' | 'listening' | 'thinking' | 'talking' | 'alert' | 'happy' | 'shh'

export type CompanionBubbleMode = 'input' | 'reminder' | 'catchup' | 'confirm'

/** Which side of the pet's head the bubble sits on, so it can draw its tail. */
export type CompanionBubbleAnchor = 'above-left' | 'above-right' | 'below-left' | 'below-right'

/** One reminder as the bubble shows it (the scheduler's DueReminder). */
export interface CompanionReminder {
  todoId: string
  title: string
  at: number
  late: boolean
  lateMinutes: number
}

/** The payload of `companion:bubble-mode`, per mode. */
export type CompanionBubblePayload =
  | { mode: 'input'; payload: null }
  | { mode: 'reminder'; payload: { reminder: CompanionReminder; queued: number } }
  | { mode: 'catchup'; payload: { reminders: CompanionReminder[]; reason: 'launch' | 'dnd' } }
  | { mode: 'confirm'; payload: CompanionCaptureResult }

export interface CompanionList {
  todos: CompanionTodo[]
  notes: CompanionNote[]
}

/** What `companion:capture` did with a line of input. Nothing is saved for query and needs-title. */
export interface CompanionCaptureResult {
  kind: 'todo' | 'note' | 'query' | 'needs-title'
  todo?: CompanionTodo
  note?: CompanionNote
  results?: CompanionTodo[]
  parsed: ParsedCapture
}

/** `companion:snooze`. "Tomorrow morning" takes its hour from the prefs. */
export type CompanionSnoozeRequest = { minutes: number } | { tomorrowMorning: true } | { at: number }

export interface CompanionStateView {
  dndUntil: number | null
  /** The summon accelerator that actually got registered ('' if none). */
  shortcut: string
  prefs: CompanionPrefs
  petState: CompanionPetState
  /** The bubble's current content, for a renderer that mounted after it was sent. */
  bubble: (CompanionBubblePayload & { anchor: CompanionBubbleAnchor }) | null
}

/** A rectangle in the pet window's own DIPs (`companion:hit-rect`). */
export interface CompanionRect {
  x: number
  y: number
  width: number
  height: number
}
