import { describe, expect, it } from 'vitest'
import { FOLLOW_AFTER_MS, followUpdate, shouldFollow } from './companion-follow-pure'

const now = 1_000_000

describe('followUpdate', () => {
  it('is nothing while the cursor is on the pet display', () => {
    expect(followUpdate(null, 1, 1, now)).toBeNull()
    expect(followUpdate({ displayId: 2, since: now - 5000 }, 1, 1, now)).toBeNull()
  })

  it('starts a watch when the cursor moves to another display, and keeps it there', () => {
    const w = followUpdate(null, 2, 1, now)
    expect(w).toEqual({ displayId: 2, since: now })
    expect(followUpdate(w, 2, 1, now + 7000)).toBe(w)
  })

  it('starts over when the cursor moves to a third display', () => {
    const w = followUpdate(null, 2, 1, now)
    expect(followUpdate(w, 3, 1, now + 7000)).toEqual({ displayId: 3, since: now + 7000 })
  })
})

describe('shouldFollow', () => {
  it('waits the whole span, then goes', () => {
    const w = { displayId: 2, since: now }
    expect(shouldFollow(w, now + FOLLOW_AFTER_MS - 1)).toBe(false)
    expect(shouldFollow(w, now + FOLLOW_AFTER_MS)).toBe(true)
    expect(shouldFollow(null, now + FOLLOW_AFTER_MS)).toBe(false)
  })
})
