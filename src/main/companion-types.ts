/**
 * The companion's data model (docs/COMPANION_PLAN.md §6). No Electron here: the
 * renderer shares these through types.ts, and the pure modules test against them.
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
