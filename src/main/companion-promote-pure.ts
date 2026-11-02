/**
 * Promoting a companion todo into the active sprint (docs/COMPANION_PLAN.md §6.1).
 *
 * One way only: the todo gets a SprintItem in the active sprint and keeps its id, and
 * from then on the sprint item owns `done`. Nothing here ever turns a sprint item into a
 * todo, and promoting twice never adds a second item. No Electron: the `companion:promote`
 * handler in index.ts loads and saves around these.
 */
import type { CompanionActiveSprint, CompanionSprintLink, CompanionTodo } from '../shared/companion'
import type { ItemStatus, Sprint, SprintItem } from './sprints'

/** "YYYY-MM-DD" of `at` in local time, the form Sprint.startDate/endDate are kept in. */
export function localYmd(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The sprint a promotion lands in: one whose status is 'active'. When several are, the one
 * whose date range holds today wins; among equals (or when none holds today) the most
 * recently updated, which is also the one the Sprint view opens on.
 */
export function activeSprint(sprints: Sprint[], now: number): Sprint | null {
  const active = sprints.filter((s) => s.status === 'active')
  if (active.length === 0) return null
  const today = localYmd(now)
  const byUpdated = (a: Sprint, b: Sprint): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  const current = active.filter((s) => s.startDate <= today && today <= s.endDate).sort(byUpdated)
  return current[0] ?? [...active].sort(byUpdated)[0]
}

/** The panel's view of the active sprint: enough for "Sprint 44 · 28 out – 8 nov". */
export function activeSprintView(sprint: Sprint | null): CompanionActiveSprint | null {
  return sprint ? { id: sprint.id, name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate } : null
}

/** The due as notes text: "2026-11-03 14:00", or "2026-11-03" for a day-precision due. */
export function dueText(todo: CompanionTodo): string | null {
  if (todo.dueAt == null) return null
  const d = new Date(todo.dueAt)
  if (todo.duePrecision === 'day') return localYmd(todo.dueAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${localYmd(todo.dueAt)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The sprint item a todo becomes: its title, its notes plus a due line when it had one,
 * unestimated, in To do — the same fields the Sprint view's own "add item" writes.
 */
export function buildSprintItem(
  todo: CompanionTodo,
  now: number,
  newId: () => string,
  opts: { dueLabel?: string } = {}
): SprintItem {
  const due = dueText(todo)
  const parts = [todo.notes?.trim() || '', due ? `${opts.dueLabel ?? 'Due'}: ${due}` : ''].filter(Boolean)
  return {
    id: newId(),
    title: todo.title.trim(),
    notes: parts.length ? parts.join('\n') : null,
    status: 'todo',
    points: null,
    createdAt: now,
    completedAt: null
  }
}

/** The item a promoted todo points at, if its sprint and the item are both still there. */
export function linkedItem(todo: CompanionTodo, sprints: Sprint[]): { sprint: Sprint; item: SprintItem } | null {
  if (!todo.sprintItemId) return null
  const sprint = sprints.find((s) => s.id === todo.sprintId)
  const item = sprint?.items.find((i) => i.id === todo.sprintItemId)
  return sprint && item ? { sprint, item } : null
}

/** The linked item's status; 'missing' once its sprint or item was deleted; null if never promoted. */
export function promotedStatus(todo: CompanionTodo, sprints: Sprint[]): ItemStatus | 'missing' | null {
  if (!todo.sprintItemId) return null
  return linkedItem(todo, sprints)?.item.status ?? 'missing'
}

export interface PromoteResult {
  sprint: Sprint
  todo: CompanionTodo
  /** False when the todo was already in this sprint: nothing to save. */
  changed: boolean
}

/**
 * Append the todo's item to `sprint` and link the todo to it. Idempotent: a todo whose
 * item is already in this sprint comes back unchanged, with no second item.
 */
export function promote(
  todo: CompanionTodo,
  sprint: Sprint,
  now: number,
  newId: () => string,
  opts: { dueLabel?: string } = {}
): PromoteResult {
  if (todo.sprintItemId && sprint.items.some((i) => i.id === todo.sprintItemId)) {
    return { sprint, todo, changed: false }
  }
  const item = buildSprintItem(todo, now, newId, opts)
  return {
    sprint: { ...sprint, items: [...sprint.items, item] },
    todo: { ...todo, sprintId: sprint.id, sprintItemId: item.id },
    changed: true
  }
}

/**
 * "Desligar": a todo whose sprint item was deleted becomes a plain todo again. Reminders
 * that came round while the sprint owned it are marked fired, so unlinking does not set
 * off a burst of late pops.
 */
export function unlink(todo: CompanionTodo, now: number): CompanionTodo {
  const fired = new Set(todo.firedAt ?? [])
  for (const at of todo.remindAt) if (at <= now) fired.add(at)
  return { ...todo, sprintId: null, sprintItemId: null, firedAt: [...fired].sort((a, b) => a - b) }
}

/** Per promoted todo, what the panel shows read-only: the sprint's name and the item's status. */
export function sprintLinks(todos: CompanionTodo[], sprints: Sprint[]): Record<string, CompanionSprintLink> {
  const links: Record<string, CompanionSprintLink> = {}
  for (const todo of todos) {
    if (!todo.sprintItemId) continue
    const found = linkedItem(todo, sprints)
    links[todo.id] = found
      ? { sprintId: found.sprint.id, sprintName: found.sprint.name, status: found.item.status }
      : { sprintId: todo.sprintId ?? '', sprintName: '', status: 'missing' }
  }
  return links
}

/**
 * The todos as the list shows them: a promoted one reads its `done` through from the
 * sprint item (plan §6.1), so ticking it in the Sprint view ticks it here. A broken link
 * keeps the todo's own `done`.
 */
export function withSprintDone(todos: CompanionTodo[], sprints: Sprint[], now: number): CompanionTodo[] {
  return todos.map((todo) => {
    const found = linkedItem(todo, sprints)
    if (!found) return todo
    const done = found.item.status === 'done'
    if (done === todo.done) return todo
    return { ...todo, done, doneAt: done ? (found.item.completedAt ?? now) : null }
  })
}
