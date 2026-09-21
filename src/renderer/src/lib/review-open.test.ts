import { describe, it, expect } from 'vitest'
import { toggleReviewOpen } from './review-open'

describe('toggleReviewOpen', () => {
  it('opens a chat that was closed', () => {
    expect(toggleReviewOpen({}, 'a')).toEqual({ a: true })
  })

  it('closes a chat that was open, by removing it', () => {
    const next = toggleReviewOpen({ a: true }, 'a')
    expect(next).toEqual({})
    // Not `{ a: false }` — a record that only grows would keep a key for every chat
    // ever opened.
    expect('a' in next).toBe(false)
  })

  it('leaves the other chats alone', () => {
    expect(toggleReviewOpen({ a: true, b: true }, 'b')).toEqual({ a: true })
  })

  it('does not mutate the map it was given', () => {
    const before = { a: true }
    toggleReviewOpen(before, 'b')
    expect(before).toEqual({ a: true })
  })
})
