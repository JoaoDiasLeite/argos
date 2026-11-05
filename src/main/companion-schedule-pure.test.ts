import { describe, it, expect } from 'vitest'
import type { CompanionTodo } from './companion-types'
import {
  markFired,
  nextWakeAt,
  pendingReminders,
  planDelivery,
  snooze,
  snoozeCount,
  type DeliveryInput
} from './companion-schedule-pure'

const now = new Date(2026, 10, 2, 10, 0).getTime()
const MIN = 60_000
const DAY = 24 * 60 * MIN

function todo(id: string, remindAt: number[], extra: Partial<CompanionTodo> = {}): CompanionTodo {
  return { id, title: `todo ${id}`, remindAt, done: false, createdAt: 0, source: 'text', ...extra }
}

function plan(input: Partial<DeliveryInput> & Pick<DeliveryInput, 'todos'>): ReturnType<typeof planDelivery> {
  return planDelivery({ now, state: {}, launchedAt: now - 60 * MIN, isFirstTick: false, ...input })
}

const ids = (items: { todoId: string }[] | null): string[] | null => items && items.map((r) => r.todoId)

describe('pendingReminders', () => {
  it('returns what has come round and nothing still to come', () => {
    const due = pendingReminders([todo('a', [now]), todo('b', [now + MIN]), todo('c', [now - 30_000])], now)
    expect(ids(due)).toEqual(['c', 'a'])
    expect(due[1]).toEqual({ todoId: 'a', title: 'todo a', at: now, late: false, lateMinutes: 0, snoozes: 0 })
  })

  it('carries how often the todo has been snoozed', () => {
    let t = markFired(todo('a', [now - 30 * MIN]), [now - 30 * MIN])
    t = snooze(t, now - 30 * MIN, { minutes: 10 })
    t = markFired(t, [now - 20 * MIN])
    t = snooze(t, now - 20 * MIN, { minutes: 10 })
    expect(pendingReminders([t], now)[0]).toMatchObject({ at: now - 10 * MIN, snoozes: 2 })
  })

  it('never returns a reminder that already fired', () => {
    const t = todo('a', [now - 5 * MIN, now - MIN], { firedAt: [now - 5 * MIN] })
    expect(pendingReminders([t], now).map((r) => r.at)).toEqual([now - MIN])
    expect(pendingReminders([markFired(t, [now - MIN])], now)).toEqual([])
  })

  it('skips done and promoted todos', () => {
    const todos = [
      todo('done', [now - MIN], { done: true }),
      todo('promoted', [now - MIN], { sprintId: 's1', sprintItemId: 'i1' }),
      todo('live', [now - MIN])
    ]
    expect(ids(pendingReminders(todos, now))).toEqual(['live'])
  })

  it('flags a reminder late only past two minutes', () => {
    const [onTime] = pendingReminders([todo('a', [now - 2 * MIN])], now)
    expect(onTime.late).toBe(false)
    const [late] = pendingReminders([todo('a', [now - 2 * MIN - 1])], now)
    expect(late).toMatchObject({ late: true, lateMinutes: 2 })
    expect(pendingReminders([todo('a', [now - 95 * MIN])], now)[0].lateMinutes).toBe(95)
  })
})

describe('nextWakeAt', () => {
  it('wakes at the next reminder when it is under the cap', () => {
    expect(nextWakeAt([todo('a', [now + 20_000, now + 40_000])], now)).toBe(now + 20_000)
  })

  it('is capped at a minute however far off the next one is', () => {
    expect(nextWakeAt([todo('a', [now + 14 * 60 * MIN])], now)).toBe(now + MIN)
    expect(nextWakeAt([], now)).toBe(now + MIN)
    expect(nextWakeAt([todo('a', [now + 20_000])], now, 10_000)).toBe(now + 10_000)
  })

  it('ignores past, fired, done and promoted reminders, and is always after now', () => {
    const todos = [
      todo('past', [now - MIN, now]),
      todo('fired', [now + 5_000], { firedAt: [now + 5_000] }),
      todo('done', [now + 6_000], { done: true }),
      todo('promoted', [now + 7_000], { sprintItemId: 'i1' })
    ]
    expect(nextWakeAt(todos, now)).toBe(now + MIN)
    expect(nextWakeAt([todo('a', [now + 1])], now)).toBe(now + 1)
  })
})

describe('planDelivery', () => {
  it('delivers due reminders one by one in a normal tick', () => {
    const p = plan({ todos: [todo('a', [now - MIN]), todo('b', [now])] })
    expect(ids(p.deliver)).toEqual(['a', 'b'])
    expect(p.catchUp).toBeNull()
    expect(p.catchUpReason).toBeNull()
    expect(p.missed).toEqual([])
  })

  it('marks reminders more than a week late as missed, never shown', () => {
    const p = plan({ todos: [todo('old', [now - 7 * DAY - 1]), todo('week', [now - 7 * DAY])] })
    expect(ids(p.missed)).toEqual(['old'])
    expect(ids(p.deliver)).toEqual(['week'])
  })

  it('collapses everything that passed while closed into one catch-up on the first tick', () => {
    const launchedAt = now - 10_000
    const todos = [
      todo('a', [now - 3 * 60 * MIN]),
      todo('b', [now - 2 * 60 * MIN]),
      todo('c', [now - 30 * MIN]),
      todo('since', [now - 5_000])
    ]
    const p = plan({ todos, launchedAt, isFirstTick: true })
    expect(ids(p.catchUp)).toEqual(['a', 'b', 'c'])
    expect(p.catchUpReason).toBe('launch')
    expect(ids(p.deliver)).toEqual(['since'])
  })

  it('has no catch-up on a first tick with nothing from before the launch', () => {
    const p = plan({ todos: [todo('since', [now - 5_000])], launchedAt: now - 10_000, isFirstTick: true })
    expect(p.catchUp).toBeNull()
    expect(ids(p.deliver)).toEqual(['since'])
  })

  it('keeps pre-launch reminders out of a catch-up after the first tick', () => {
    const p = plan({ todos: [todo('a', [now - 3 * 60 * MIN])], launchedAt: now - 10_000, isFirstTick: false })
    expect(p.catchUp).toBeNull()
    expect(p.deliver[0]).toMatchObject({ todoId: 'a', late: true, lateMinutes: 180 })
  })

  it('queues everything while do-not-disturb is on, and still drops the missed', () => {
    const todos = [todo('a', [now - 20 * MIN]), todo('b', [now - MIN]), todo('old', [now - 8 * DAY])]
    const p = plan({ todos, state: { dndUntil: now + 30 * MIN } })
    expect(p.deliver).toEqual([])
    expect(p.catchUp).toBeNull()
    expect(p.queuedForDnd).toBe(2)
    expect(ids(p.missed)).toEqual(['old'])
    // Nothing was marked, so they are still pending once it lifts.
    expect(pendingReminders(todos, now + 31 * MIN)).toHaveLength(3)
  })

  it('collapses what queued into one catch-up when do-not-disturb lifts', () => {
    const todos = [todo('a', [now - 20 * MIN]), todo('b', [now - MIN])]
    const p = plan({ todos, state: { dndUntil: now - 1 } })
    expect(p.deliver).toEqual([])
    expect(ids(p.catchUp)).toEqual(['a', 'b'])
    expect(p.catchUpReason).toBe('dnd')
  })

  it('delivers a single reminder normally when do-not-disturb lifts', () => {
    const p = plan({ todos: [todo('a', [now - MIN])], state: { dndUntil: now } })
    expect(ids(p.deliver)).toEqual(['a'])
    expect(p.catchUp).toBeNull()
  })

  it('reads a do-not-disturb that ran out while closed as a launch catch-up', () => {
    const todos = [todo('a', [now - 20 * MIN]), todo('b', [now - 5_000])]
    const p = plan({ todos, state: { dndUntil: now - 60 * MIN }, launchedAt: now - 10_000, isFirstTick: true })
    expect(ids(p.catchUp)).toEqual(['a', 'b'])
    expect(p.catchUpReason).toBe('launch')
  })
})

describe('markFired', () => {
  it('adds the instants deduplicated and sorted, leaving the input alone', () => {
    const t = todo('a', [1, 2, 3], { firedAt: [3] })
    const next = markFired(t, [1, 3, 1])
    expect(next.firedAt).toEqual([1, 3])
    expect(t.firedAt).toEqual([3])
    expect(markFired(todo('b', [5]), [5]).firedAt).toEqual([5])
  })
})

describe('snooze', () => {
  const fired = todo('a', [now - MIN], { firedAt: [now - MIN] })

  it('appends now + minutes, keeping the history', () => {
    const next = snooze(fired, now, { minutes: 10 })
    expect(next.remindAt).toEqual([now - MIN, now + 10 * MIN])
    expect(fired.remindAt).toEqual([now - MIN])
    expect(pendingReminders([next], now + 10 * MIN).map((r) => r.at)).toEqual([now + 10 * MIN])
  })

  it('appends an explicit instant', () => {
    expect(snooze(fired, now, { at: now + 3 * 60 * MIN }).remindAt.at(-1)).toBe(now + 3 * 60 * MIN)
  })

  it('lands tomorrow morning at the morning hour across the DST change', () => {
    // Europe/Lisbon leaves summer time in the night of 24 to 25 October 2026: that day
    // has 25 hours, so a fixed +24 h would land on 08:00. Asserted in local time so the
    // test holds in any timezone.
    const evening = new Date(2026, 9, 24, 22, 30).getTime()
    const at = new Date(snooze(fired, evening, { tomorrowMorning: true, morningHour: 9 }).remindAt.at(-1)!)
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 9, 25])
    expect([at.getHours(), at.getMinutes()]).toEqual([9, 0])
  })

  it('goes to the next day even when the morning hour has not passed yet', () => {
    const early = new Date(2026, 10, 2, 7, 0).getTime()
    const at = new Date(snooze(fired, early, { tomorrowMorning: true, morningHour: 9 }).remindAt.at(-1)!)
    expect([at.getDate(), at.getHours()]).toEqual([3, 9])
  })
})

describe('snoozeCount', () => {
  it('is zero until a reminder has fired', () => {
    expect(snoozeCount(todo('a', [now + MIN]))).toBe(0)
    expect(snoozeCount(todo('a', [now - MIN]))).toBe(0)
  })

  it('counts the entries appended after the first fired one', () => {
    let t = todo('a', [now - 30 * MIN])
    t = markFired(t, [now - 30 * MIN])
    expect(snoozeCount(t)).toBe(0)
    t = snooze(t, now - 30 * MIN, { minutes: 10 })
    t = markFired(t, [now - 20 * MIN])
    t = snooze(t, now - 20 * MIN, { minutes: 60 })
    expect(snoozeCount(t)).toBe(2)
  })
})
