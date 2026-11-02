/**
 * What a line typed (or said) to the companion turns into, and how the list reads back
 * (docs/COMPANION_PLAN.md §5.3–5.4, §9.4). The `companion:capture` and `companion:list`
 * handlers in index.ts are this plus the store; kept apart so the rules are tested
 * without Electron or the disk.
 */
import type { CompanionNote, CompanionTodo, ParsedCapture } from './companion-types'

/** Done todos stay in the list this long after they were ticked. */
export const DONE_VISIBLE_MS = 7 * 24 * 60 * 60_000

export type CapturePlan =
  | { kind: 'todo'; todo: CompanionTodo; parsed: ParsedCapture }
  | { kind: 'note'; note: CompanionNote; parsed: ParsedCapture }
  | { kind: 'query'; results: CompanionTodo[]; parsed: ParsedCapture }
  /** A date with nothing to do ("amanhã às 14h"): nothing is saved, the bubble asks what. */
  | { kind: 'needs-title'; parsed: ParsedCapture }

export interface CaptureInput {
  text: string
  source: 'text' | 'voice'
  parsed: ParsedCapture
  /** The todos a query searches. */
  todos: CompanionTodo[]
  now: number
  newId: () => string
}

/** The instant a todo is "on": its due time, else its first reminder. */
function onAt(todo: CompanionTodo): number | null {
  return todo.dueAt ?? todo.remindAt[0] ?? null
}

/**
 * The answer to "what do I have" for [from, to): not-done todos in it, soonest first.
 * A range that holds `now` (today, this week) also brings what is overdue, first:
 * "o que tenho hoje" that leaves out yesterday's unfinished call is the wrong answer.
 */
export function todosFor(todos: CompanionTodo[], from: number, to: number, now: number): CompanionTodo[] {
  return todosInRange(todos, from <= now && now < to ? -Infinity : from, to)
}

/** Not-done todos that fall in [from, to), soonest first. */
export function todosInRange(todos: CompanionTodo[], from: number, to: number): CompanionTodo[] {
  return todos
    .filter((t) => {
      const at = onAt(t)
      return !t.done && at !== null && at >= from && at < to
    })
    .sort((a, b) => (onAt(a) ?? 0) - (onAt(b) ?? 0))
}

/**
 * "O que tenho hoje" from the tray or the pet's menu: the same answer as typing the
 * question into the bubble, without the typing — today's and overdue open todos.
 */
export function todayQuery(todos: CompanionTodo[], now: number): CapturePlan & { kind: 'query' } {
  const d = new Date(now)
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return {
    kind: 'query',
    results: todosFor(todos, from, to, now),
    parsed: {
      intent: 'query',
      title: '',
      when: null,
      remindAt: [],
      isExplicitReminder: false,
      confidence: 1,
      matchedSpan: null,
      queryRange: { from, to }
    }
  }
}

/** What to save, if anything, and what to answer. Saving is the caller's job. */
export function planCapture({ text, source, parsed, todos, now, newId }: CaptureInput): CapturePlan {
  if (parsed.intent === 'note') {
    const body = parsed.title.trim()
    if (!body) return { kind: 'needs-title', parsed }
    return { kind: 'note', note: { id: newId(), text: body, createdAt: now, source }, parsed }
  }
  if (parsed.intent === 'query') {
    const range = parsed.queryRange
    return { kind: 'query', results: range ? todosFor(todos, range.from, range.to, now) : [], parsed }
  }
  const title = parsed.title.trim()
  // A bare date, or nothing the parser could keep: never save an untitled todo.
  if (!title || !text.trim()) return { kind: 'needs-title', parsed }
  const todo: CompanionTodo = {
    id: newId(),
    title,
    dueAt: parsed.when?.at ?? null,
    ...(parsed.when ? { duePrecision: parsed.when.precision } : {}),
    remindAt: [...parsed.remindAt],
    done: false,
    createdAt: now,
    source
  }
  return { kind: 'todo', todo, parsed }
}

/**
 * The list as the bubble and the panel show it: open todos first, by due time (undated
 * last) then by when they were captured; then the ones ticked in the last week, most
 * recent first. Older done todos stay on disk but drop out. Notes newest first.
 */
export function listForView(
  todos: CompanionTodo[],
  notes: CompanionNote[],
  now: number
): { todos: CompanionTodo[]; notes: CompanionNote[] } {
  const open = todos
    .filter((t) => !t.done)
    .sort((a, b) => {
      const da = a.dueAt ?? Infinity
      const db = b.dueAt ?? Infinity
      if (da !== db) return da < db ? -1 : 1
      return a.createdAt - b.createdAt
    })
  const done = todos
    .filter((t) => t.done && now - (t.doneAt ?? 0) <= DONE_VISIBLE_MS)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  return { todos: [...open, ...done], notes: [...notes].sort((a, b) => b.createdAt - a.createdAt) }
}
