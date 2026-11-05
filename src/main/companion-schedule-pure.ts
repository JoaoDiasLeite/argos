/**
 * What the companion should say now, and when to look again (docs/COMPANION_PLAN.md §3).
 *
 * The rules behind the one timer in companion-scheduler.ts, kept apart so they can be
 * tested without Electron: no timers, no fs, and `now` is always passed in. A reminder is
 * one entry of a todo's `remindAt`; it is due once `now` reaches it and it is not yet in
 * `firedAt`, and it fires once — the scheduler marks it fired as it hands it over, so a
 * restart, a resume or a second tick never repeats it.
 *
 * All calendar math is local time through Date setters, so "tomorrow morning" lands on
 * 09:00 on the day after a DST change, not 08:00 or 10:00.
 */
import type { CompanionState, CompanionTodo } from './companion-types'

/** Past this, a reminder is shown as late ("Atrasado 5 min") rather than on time. */
export const LATE_AFTER_MS = 2 * 60_000

/** Past this, a reminder is marked fired without being shown; it only stays in the list. */
export const MISSED_AFTER_MS = 7 * 24 * 60 * 60_000

/** The longest the scheduler sleeps between looks, whatever is due next. */
export const WAKE_CAP_MS = 60_000

/** One reminder that is due: a todo and the `remindAt` instant that came round. */
export interface DueReminder {
  todoId: string
  title: string
  /** The `remindAt` value, which is also what goes into `firedAt`. */
  at: number
  late: boolean
  /** Whole minutes past `at`; 0 when on time. */
  lateMinutes: number
  /** How often this todo has been snoozed so far (plan §3.2: at SNOOZE_CAP the bubble offers a new date). */
  snoozes: number
}

/** A todo the scheduler speaks for: not done, and not handed to a sprint item. */
function isLive(todo: CompanionTodo): boolean {
  // Once promoted the sprint item owns `done` (plan §6.1), so the companion keeps quiet.
  return !todo.done && !todo.sprintItemId
}

/** Every reminder that has come round and not yet fired, oldest first. */
export function pendingReminders(todos: CompanionTodo[], now: number): DueReminder[] {
  const due: DueReminder[] = []
  for (const todo of todos) {
    if (!isLive(todo)) continue
    const fired = new Set(todo.firedAt ?? [])
    // A Set too: the same instant listed twice is one reminder.
    for (const at of new Set(todo.remindAt)) {
      if (at > now || fired.has(at)) continue
      const past = now - at
      due.push({
        todoId: todo.id,
        title: todo.title,
        at,
        late: past > LATE_AFTER_MS,
        lateMinutes: Math.floor(past / 60_000),
        snoozes: snoozeCount(todo)
      })
    }
  }
  return due.sort((a, b) => a.at - b.at)
}

/**
 * When the scheduler should look again: the next reminder still to come, but never
 * further off than `capMs`, so sleep, clock changes and DST are caught within a minute
 * rather than trusted to one long timer. Always after `now`.
 */
export function nextWakeAt(todos: CompanionTodo[], now: number, capMs = WAKE_CAP_MS): number {
  let next = now + Math.max(1, capMs)
  for (const todo of todos) {
    if (!isLive(todo)) continue
    const fired = new Set(todo.firedAt ?? [])
    for (const at of todo.remindAt) {
      if (at > now && at < next && !fired.has(at)) next = at
    }
  }
  return next
}

export interface DeliveryInput {
  todos: CompanionTodo[]
  now: number
  state: CompanionState
  /** When this run of the app started; reminders before it passed while it was closed. */
  launchedAt: number
  /** The first look since launch: the one that gathers what passed while closed. */
  isFirstTick: boolean
}

export interface DeliveryPlan {
  /** Shown one by one. */
  deliver: DueReminder[]
  /** Shown together as one line ("3 lembretes passaram…"); null when there is none. */
  catchUp: DueReminder[] | null
  /** Why `catchUp` was gathered: the app was closed, or do-not-disturb just lifted. */
  catchUpReason: 'launch' | 'dnd' | null
  /** More than a week late: marked fired without being shown. */
  missed: DueReminder[]
  /** Held back by do-not-disturb; they stay unfired and come out when it lifts. */
  queuedForDnd: number
}

/**
 * What to do with everything due right now.
 *
 * Do-not-disturb holds every reminder back (still unfired). When it lifts with two or
 * more waiting they come out as one catch-up, and the caller then clears `dndUntil`;
 * a single one is just delivered. On the first look after launch, whatever came due
 * before the launch is one catch-up rather than a row of toasts at 08:30 (plan §3.1),
 * and anything that came due since is delivered as usual. Reminders over a week late
 * are `missed` in every case — do-not-disturb or not — so they never surface.
 */
export function planDelivery({ todos, now, state, launchedAt, isFirstTick }: DeliveryInput): DeliveryPlan {
  const pending = pendingReminders(todos, now)
  const missed = pending.filter((r) => now - r.at > MISSED_AFTER_MS)
  const live = pending.filter((r) => now - r.at <= MISSED_AFTER_MS)
  const dndUntil = state.dndUntil ?? null

  if (dndUntil !== null && dndUntil > now) {
    return { deliver: [], catchUp: null, catchUpReason: null, missed, queuedForDnd: live.length }
  }

  // Lifted (it may have run out while the app was closed, too): everything that waited
  // goes out together. A launch that is also a lift reads as a launch.
  if (dndUntil !== null && live.length >= 2) {
    return { deliver: [], catchUp: live, catchUpReason: isFirstTick ? 'launch' : 'dnd', missed, queuedForDnd: 0 }
  }

  if (isFirstTick) {
    const before = live.filter((r) => r.at < launchedAt)
    const since = live.filter((r) => r.at >= launchedAt)
    if (before.length > 0) {
      return { deliver: since, catchUp: before, catchUpReason: 'launch', missed, queuedForDnd: 0 }
    }
  }

  return { deliver: live, catchUp: null, catchUpReason: null, missed, queuedForDnd: 0 }
}

/** The todo with `ats` recorded as fired; the input is left as it was. */
export function markFired(todo: CompanionTodo, ats: number[]): CompanionTodo {
  const firedAt = [...new Set([...(todo.firedAt ?? []), ...ats])].sort((a, b) => a - b)
  return { ...todo, firedAt }
}

export type SnoozeOption =
  | { minutes: number }
  /** The next calendar day at `morningHour`:00, local time ("amanhã de manhã"). */
  | { tomorrowMorning: true; morningHour: number }
  | { at: number }

/** The instant a snooze option points at, from `now`. */
export function snoozeTarget(now: number, option: SnoozeOption): number {
  if ('at' in option) return option.at
  if ('minutes' in option) return now + option.minutes * 60_000
  // Date setters, not now + 24 h: on the night the clocks change a day is 23 or 25 hours.
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(option.morningHour, 0, 0, 0)
  return d.getTime()
}

/**
 * The todo reminding again at the snoozed instant. The instant is appended to
 * `remindAt` rather than replacing what was there, so the history of a nagging item
 * stays visible (plan §3.2). Not done, not fired: it is a new reminder.
 */
export function snooze(todo: CompanionTodo, now: number, option: SnoozeOption): CompanionTodo {
  return { ...todo, remindAt: [...todo.remindAt, snoozeTarget(now, option)] }
}

/**
 * How many times a todo has been snoozed, for the cap of five (plan §3.2).
 *
 * Counted from the order of `remindAt`, which is append-only: a snooze only ever follows
 * a reminder that fired, so every entry after the first one found in `firedAt` (in array
 * order, not by value) is a snooze. Entries before it were set when the todo was saved.
 * A todo that has never fired has never been snoozed.
 */
export function snoozeCount(todo: CompanionTodo): number {
  const fired = new Set(todo.firedAt ?? [])
  const first = todo.remindAt.findIndex((at) => fired.has(at))
  return first === -1 ? 0 : todo.remindAt.length - first - 1
}
