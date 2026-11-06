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
  /** Repeats: ticking it done adds the next occurrence (companion-repeat-pure.ts). Needs dueAt. */
  repeat?: CompanionRepeat | null
  /** The occurrence added when this one was ticked, so un-ticking it takes that one back. */
  repeatNextId?: string | null
}

/** How often a todo comes back: every day, Monday to Friday, every week, every month. */
export type CompanionRepeatEvery = 'day' | 'weekday' | 'week' | 'month'

export interface CompanionRepeat {
  every: CompanionRepeatEvery
  /** For 'month': the day it falls on, kept so a 31st comes back after a shorter month. */
  monthDay?: number
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
  /** Pet position per display, keyed by display id: the window's top-left. */
  positions?: Record<string, { x: number; y: number }>
  /** 2 since the 128×152 window; absent means saved for the 220×220 one and shifted on read. */
  positionsVersion?: number
  /** When the week's summary was last said (plan §13.3, T1), so Friday says it once. */
  lastWeekSummaryAt?: number | null
}

/** The week in one line (plan §13.3, T1): the bubble's Friday word, and the panel's. */
export interface CompanionWeekSummary {
  /** Local midnight of the week's Monday, and of next Monday. */
  from: number
  to: number
  /** Ticked this week. */
  done: number
  /** Open and past their time. */
  late: number
  /** Open and still to come this week. */
  open: number
}

export const POSITIONS_VERSION = 2

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
  /** The date came from the model (layer 2), not the grammar: the receipt says so. */
  fromModel?: boolean
  /** "todos os dias", "todas as segundas": the todo repeats from `when`. */
  repeat?: CompanionRepeat | null
}

// ---- preferences -------------------------------------------------------------------

/** Which animal is drawn on the desktop. Same states and sheet layout for every one. */
export type CompanionCharacter = 'dog' | 'ferret'

export const COMPANION_CHARACTERS: readonly CompanionCharacter[] = ['dog', 'ferret']

export function isCompanionCharacter(v: unknown): v is CompanionCharacter {
  return COMPANION_CHARACTERS.includes(v as CompanionCharacter)
}

/** `config.companion`. */
/** How big Argos is on the desktop (plan §13.3, N2): the window and the sprite scale together. */
export type CompanionPetSize = 'small' | 'normal' | 'large'

/** The scale of the 128×152 window and its 96 px sprite for each size. */
export const PET_SCALE: Record<CompanionPetSize, number> = { small: 2 / 3, normal: 1, large: 4 / 3 }

export interface CompanionPrefs {
  /** The animal on the desktop. 'dog' by default. */
  character: CompanionCharacter
  /** "Ficar no ecrã": the pet stays up all day. Off = only when summoned or reminding. */
  stayOnScreen: boolean
  /** "Tamanho do Argos". */
  size: CompanionPetSize
  /** Preferred summon accelerator. '' = automatic (Ctrl+Alt+A with a fallback). */
  shortcut: string
  /** Minutes before a timed item that its reminder fires (plan §5.3). */
  leadMinutes: number
  /** Hour a day-precision item reminds at. */
  morningHour: number
  /** Keep the pet and its bubble out of screen shares and captures (plan §2.4). */
  hideFromCapture: boolean
  /** Push-to-talk dictation with the local Whisper model (plan §4.2). Off by default. */
  voice: boolean
  /** Preferred dictation accelerator. '' = automatic (Ctrl+Alt+S with a fallback). */
  voiceShortcut: string
  /** "Passear pelo ecrã": with stayOnScreen on, a short walk along the bottom now and then. */
  walk: boolean
  /** "Seguir-me entre ecrãs": with stayOnScreen on, he goes to the display the cursor has settled on. */
  follow: boolean
  /**
   * "Silêncio com o Assistente de Concentração" (plan §13.3, V): in Focus Assist, a
   * full-screen app or a presentation he keeps quiet, and reminders go as notifications.
   */
  focusAssist: boolean
  /**
   * "Perguntar ao modelo quando não percebo a data" (plan §5.1, layer 2): when the
   * grammar is unsure, that one line goes to the account's model. On by default.
   */
  askModel: boolean
  /** The Obsidian vault notes are also written to (plan §6.2). '' = no export, the default. */
  obsidianVault: string
  /** The folder inside the vault, '/'-separated; '' = the vault's root. */
  obsidianFolder: string
  /**
   * "Avisar quando um terminal acaba": with the pet on screen, a chat that finished or is
   * waiting on you (while the main window is away) is said in his bubble instead of a toast.
   */
  terminalAlerts: boolean
  /**
   * "Avisar quando o plano passa os 85 %": with the pet on screen, a plan window crossing
   * 85 % or 95 % (plan-alerts-pure.ts) is said in his bubble instead of a notification.
   */
  planAlerts: boolean
}

/** A plan window (5 h or week) of one account crossed a threshold (plan-alerts-pure.ts). */
export interface CompanionPlanAlert {
  /** `plan:<accountKey>:<windowKey>`: a newer word about the same window replaces the older one. */
  key: string
  /** The account's name, as the usage view shows it. */
  account: string
  /** Whole percent used. */
  pct: number
  /** "Week window 87% used · resets in 2h 10m", composed by main like the notification body. */
  detail: string
}

/** A chat terminal that finished its turn, or is waiting on an answer (an approval). */
export interface CompanionTerminalAlert {
  /** One per conversation: a newer word about the same chat replaces the older one. */
  key: string
  kind: 'finished' | 'waiting'
  /** The chat's name, or "[project] conversation" from the hook. */
  title: string
  /** What the CLI said, when it said something; '' otherwise. */
  detail: string
  /** An ops intervention's terminal (plan §13.3, T3): the bubble names it as one. */
  ops?: boolean
}

/**
 * The dictation accelerators tried after the preferred one, in order. Never one Teams
 * uses (Ctrl+Shift+M/A/S/E/K/O/D/H/B), nor the summon defaults.
 */
export const VOICE_SHORTCUT_DEFAULTS = ['Ctrl+Alt+S', 'Ctrl+Shift+Alt+S'] as const

// ---- voice -------------------------------------------------------------------------

/** Where the speech models were found (plan §4.2): meeting-notes' copy is reused read-only. */
export type CompanionVoiceModelSource = 'meeting-notes' | 'argos'

/** `companion:voice-status`, also pushed as `companion:voice-progress` while installing. */
export interface CompanionVoiceStatus {
  /** The engine loads and the models are present: dictation can run. */
  available: boolean
  /** The speech engine (sherpa-onnx) loads on this machine. */
  platformSupported: boolean
  modelPresent: boolean
  modelSource: CompanionVoiceModelSource | null
  /** The folder the models are read from, for Settings. */
  modelDir: string | null
  /** The recognizer is loaded and warm; when false the first dictation takes a few seconds more. */
  warm: boolean
  downloading: boolean
  /** While downloading: bytes so far of the whole download; 'extract' once it is unpacking. */
  progress: { received: number; total: number; phase: 'download' | 'extract' } | null
  /** The last install's failure, or why the engine does not load. */
  error: string | null
}

/** `companion:voice-transcribe`: the text, or why there is none. */
export type CompanionVoiceResult =
  | { ok: true; text: string; ms: number; noSpeech: boolean }
  | { ok: false; error: 'unavailable' | 'invalid' | 'too-long' | 'busy' | 'failed'; detail?: string }

/** What the bubble is doing with the microphone, so main can keep the bubble up and pose the pet. */
export type CompanionVoicePhase = 'idle' | 'recording' | 'transcribing'

// ---- IPC ---------------------------------------------------------------------------

/** What the pet is doing, which picks its pose (plan §2.3). */
export type CompanionPetState =
  | 'idle'
  | 'dozing'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'alert'
  | 'happy'
  | 'shh'
  | 'walking'
  /** The run gait (plan §13.1): following you to another screen, after the ball, a lap of joy. */
  | 'running'
  /** On his feet for a moment before a walk and after it (the walk sheet's first frame). */
  | 'standing'
  /** Docked against a side edge above the floor (plan §13.1): back to the wall. */
  | 'leaning'
  /** The cursor is near (plan §13.3, U1): sat, turned toward it. */
  | 'looking'
  /** The day's routine (plan §13.3, U2): a stretch at the morning hour, a yawn at six, asleep at night. */
  | 'stretching'
  | 'yawning'
  | 'sleeping'
  /** A fidget while idle (plan §13.3, U3), the renderer's own; main never sets it. */
  | 'scratching'
  /** Sat on the top edge of a window (plan §13.3, R). */
  | 'perched'

/** Which way the walk sheet faces; it is drawn facing right and mirrored for left. */
export type CompanionPetFacing = 'left' | 'right'

export type CompanionBubbleMode = 'input' | 'reminder' | 'catchup' | 'confirm' | 'terminal' | 'plan' | 'week'

/**
 * Where the bubble sits against the pet, so it can draw its tail: above the dog (or below,
 * when there is no room above), and `tailX`, the tail's distance in DIPs from the bubble
 * window's left edge to the point straight over the dog's centre.
 */
export interface CompanionBubbleAnchor {
  side: 'above' | 'below'
  tailX: number
}

/** One reminder as the bubble shows it (the scheduler's DueReminder). */
export interface CompanionReminder {
  todoId: string
  title: string
  at: number
  late: boolean
  lateMinutes: number
  /** How often it has been snoozed; at SNOOZE_CAP the bubble offers a new date instead. */
  snoozes: number
}

/** Snoozed this often, a reminder stops offering +10 min and asks for a day (plan §3.2). */
export const SNOOZE_CAP = 5

/** The payload of `companion:bubble-mode`, per mode. */
export type CompanionBubblePayload =
  /** Typing; with `query` it opens already answering one ("O que tenho hoje" from the tray or the pet's menu). */
  | { mode: 'input'; payload: null | { query: CompanionCaptureResult } }
  | { mode: 'reminder'; payload: { reminder: CompanionReminder; queued: number } }
  | { mode: 'catchup'; payload: { reminders: CompanionReminder[]; reason: 'launch' | 'dnd' } }
  | { mode: 'confirm'; payload: CompanionCaptureResult }
  | { mode: 'terminal'; payload: { alert: CompanionTerminalAlert } }
  | { mode: 'plan'; payload: { alert: CompanionPlanAlert } }
  | { mode: 'week'; payload: { summary: CompanionWeekSummary } }

export interface CompanionList {
  todos: CompanionTodo[]
  notes: CompanionNote[]
  /** Per promoted todo id: the sprint item it handed over to (plan §6.1), read-only. */
  sprintLinks?: Record<string, CompanionSprintLink>
  /** Where "Promover para o sprint" would put a todo now; null when no sprint is active. */
  activeSprint?: CompanionActiveSprint | null
  /** Quiet mode's end (state.json `dndUntil`), so the panel can say so; null when off. */
  dndUntil?: number | null
}

/** A promoted todo's sprint item as the panel shows it. 'missing': its sprint or item was deleted. */
export interface CompanionSprintLink {
  sprintId: string
  sprintName: string
  status: 'todo' | 'in-progress' | 'done' | 'missing'
}

export interface CompanionActiveSprint {
  id: string
  name: string
  /** "YYYY-MM-DD". */
  startDate: string
  /** "YYYY-MM-DD", inclusive. */
  endDate: string
}

/** `companion:promote`. */
export type CompanionPromoteResult =
  | { ok: true; sprintId: string; sprintItemId: string; sprintName: string }
  | { ok: false; reason: 'no-active-sprint' | 'not-found' | 'already' }

/**
 * What `companion:capture` did with a line of input. Nothing is saved for query and
 * needs-title, nor for 'cancelled' (Esc while the model was reading the date). 'quiet'
 * is a `shh` command (plan §3.3): quiet mode was set, nothing else.
 */
export interface CompanionCaptureResult {
  /** 'focus' (plan §13.3, T2): quiet until `quietUntil`, with `todo` the reminder that ends it. */
  kind: 'todo' | 'note' | 'query' | 'needs-title' | 'cancelled' | 'quiet' | 'focus'
  todo?: CompanionTodo
  note?: CompanionNote
  results?: CompanionTodo[]
  /** For 'quiet': muted until this instant, or null when it was switched off. */
  quietUntil?: number | null
  parsed: ParsedCapture
}

/** `companion:snooze`. "Tomorrow morning" takes its hour from the prefs. */
export type CompanionSnoozeRequest = { minutes: number } | { tomorrowMorning: true } | { at: number }

export interface CompanionStateView {
  dndUntil: number | null
  /** The summon accelerator that actually got registered ('' if none). */
  shortcut: string
  /** The dictation accelerator that got registered ('' if none, or voice is off). */
  voiceShortcut: string
  prefs: CompanionPrefs
  petState: CompanionPetState
  /** The way the pet faces while walking. */
  petFacing: CompanionPetFacing
  /** The bubble's current content, for a renderer that mounted after it was sent. */
  bubble: (CompanionBubblePayload & { anchor: CompanionBubbleAnchor }) | null
}

/** A rectangle in DIPs of the virtual screen: window bounds and work areas. */
export interface CompanionRect {
  x: number
  y: number
  width: number
  height: number
}
