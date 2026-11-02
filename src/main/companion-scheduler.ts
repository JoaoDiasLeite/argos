/**
 * The companion's one timer (docs/COMPANION_PLAN.md §3.1), in main so reminders keep
 * firing whether the pet window is shown, hidden or gone.
 *
 * Never one long setTimeout to a far-off reminder: a single timer to the next due
 * instant, capped at a minute, re-armed from the store on every tick, so sleep, clock
 * changes and DST are caught within a minute. A resume from sleep or an unlock looks
 * again at once, and so does poke(), which whoever saves a todo calls. What to say is
 * decided in companion-schedule-pure.ts; this only reads, delivers, records and re-arms.
 *
 * Start it inside app.whenReady(): powerMonitor cannot be used before the app is ready.
 */
import { powerMonitor } from 'electron'
import type { CompanionStore } from './companion-store'
import { markFired, nextWakeAt, planDelivery, WAKE_CAP_MS, type DueReminder } from './companion-schedule-pure'

export interface CompanionSchedulerDeps {
  store: CompanionStore
  now?: () => number
  /** Reminders to show one by one. */
  deliver: (items: DueReminder[]) => void
  /** Reminders to show as one line; `reason` says whether the app was closed or muted. */
  deliverCatchUp: (items: DueReminder[], reason: 'launch' | 'dnd') => void
  /** Quiet mode ran out (or was switched off) and was cleared, just before what it held back is delivered. */
  onDndLifted?: () => void
}

export interface CompanionScheduler {
  stop(): void
  /** Look again now, e.g. right after a todo was saved. */
  poke(): void
}

export function startCompanionScheduler(deps: CompanionSchedulerDeps): CompanionScheduler {
  const { store } = deps
  const now = deps.now ?? Date.now
  const launchedAt = now()
  let isFirstTick = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function arm(at: number): void {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, Math.max(0, at - now()))
  }

  function tick(): void {
    timer = null
    if (stopped) return
    let wakeAt = now() + WAKE_CAP_MS
    try {
      const t = now()
      const state = store.getState()
      let todos = store.listTodos()
      const plan = planDelivery({ todos, now: t, state, launchedAt, isFirstTick })
      isFirstTick = false

      // Recorded before anything is shown: a delivery that throws loses one reminder,
      // where the other order would repeat it on every tick.
      const fired = new Map<string, number[]>()
      for (const r of [...plan.deliver, ...(plan.catchUp ?? []), ...plan.missed]) {
        fired.set(r.todoId, [...(fired.get(r.todoId) ?? []), r.at])
      }
      todos = todos.map((todo) => {
        const ats = fired.get(todo.id)
        if (!ats) return todo
        const next = markFired(todo, ats)
        store.saveTodo(next)
        return next
      })

      const dndUntil = state.dndUntil ?? null
      if (dndUntil !== null && dndUntil <= t) {
        store.setState({ dndUntil: null })
        try {
          deps.onDndLifted?.()
        } catch (e) {
          console.error('[companion] dnd-lifted hook failed:', e)
        }
      }

      if (plan.deliver.length > 0) deps.deliver(plan.deliver)
      if (plan.catchUp && plan.catchUpReason) {
        deps.deliverCatchUp(plan.catchUp, plan.catchUpReason)
        store.setState({ lastCatchUpAt: t })
      }

      wakeAt = nextWakeAt(todos, t)
      // Wake when do-not-disturb ends, not up to a minute after.
      if (dndUntil !== null && dndUntil > t) wakeAt = Math.min(wakeAt, dndUntil)
    } catch (e) {
      console.error('[companion] scheduler tick failed:', e)
    }
    arm(wakeAt)
  }

  const poke = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    tick()
  }

  powerMonitor.on('resume', poke)
  powerMonitor.on('unlock-screen', poke)
  tick()

  return {
    poke,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      powerMonitor.removeListener('resume', poke)
      powerMonitor.removeListener('unlock-screen', poke)
    }
  }
}
