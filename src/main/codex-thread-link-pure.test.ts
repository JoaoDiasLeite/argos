import { describe, it, expect } from 'vitest'
import {
  pickThreadsForChats,
  titleForThread,
  LINK_SLACK_MS,
  type LinkableChat,
  type LinkableThread
} from './codex-thread-link-pure'

/**
 * The claim that lets a Codex terminal chat find its own conversation. What is worth
 * pinning down is mostly what it REFUSES to claim: a wrong link does not leave a chat
 * unnamed, it shows it someone else's conversation.
 */

const SECOND = 1000
/** A fixed, readable epoch so a test can talk in offsets from "the terminal opened". */
const T0 = 1_700_000_000_000

function chat(id: string, cwd: string, startedAtMs: number): LinkableChat {
  return { id, cwd, startedAt: startedAtMs }
}
/** Threads carry SECONDS, which is exactly the units mismatch this is guarding. */
function thread(id: string, cwd: string, createdAtMs: number, extra: Partial<LinkableThread> = {}): LinkableThread {
  return { id, cwd, preview: '', createdAt: Math.floor(createdAtMs / 1000), ...extra }
}

describe('pickThreadsForChats', () => {
  it('claims the thread recorded in the chat folder after the terminal came up', () => {
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 + 30 * SECOND)]
    expect(pickThreadsForChats(chats, threads)).toEqual({ c1: 't1' })
  })

  it('refuses a thread that predates the terminal', () => {
    // Whatever ran in that folder yesterday is not this chat's, and taking it would show
    // the chat a conversation it never had.
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 - 60 * SECOND)]
    expect(pickThreadsForChats(chats, threads)).toEqual({})
  })

  it('refuses a thread from another folder', () => {
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/other', T0 + 30 * SECOND)]
    expect(pickThreadsForChats(chats, threads)).toEqual({})
  })

  it('allows a thread stamped just before the terminal, within the slack', () => {
    // createdAt lands in whole seconds, so a thread started in the same second as the
    // terminal can report a moment earlier. Losing it would mean never naming the chat.
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 - (LINK_SLACK_MS - 500))]
    expect(pickThreadsForChats(chats, threads)).toEqual({ c1: 't1' })
  })

  it('keeps the slack tight enough to exclude the run just before', () => {
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 - (LINK_SLACK_MS + 5 * SECOND))]
    expect(pickThreadsForChats(chats, threads)).toEqual({})
  })

  it('hands two chats in one folder their own threads, in the order they opened', () => {
    // The ordering case that made this worth writing down: taking the newest match each
    // time would give the older chat the younger chat's conversation.
    const chats = [
      chat('second', 'C:/work/app', T0 + 100 * SECOND),
      chat('first', 'C:/work/app', T0)
    ]
    const threads = [
      thread('tB', 'C:/work/app', T0 + 130 * SECOND),
      thread('tA', 'C:/work/app', T0 + 30 * SECOND)
    ]
    expect(pickThreadsForChats(chats, threads)).toEqual({ first: 'tA', second: 'tB' })
  })

  it('leaves a chat unplaced when the only candidate is already claimed', () => {
    const chats = [chat('c1', 'C:/work/app', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 + 30 * SECOND)]
    expect(pickThreadsForChats(chats, threads, new Set(['t1']))).toEqual({})
  })

  it('never hands one thread to two chats in a single round', () => {
    const chats = [chat('c1', 'C:/work/app', T0), chat('c2', 'C:/work/app', T0 + SECOND)]
    const threads = [thread('t1', 'C:/work/app', T0 + 30 * SECOND)]
    // Only one thread exists, so exactly one chat may have it.
    expect(pickThreadsForChats(chats, threads)).toEqual({ c1: 't1' })
  })

  it('treats separator and case differences as the same folder', () => {
    // Argos stores the path the user picked; Codex records the one its own process saw.
    const chats = [chat('c1', 'C:\\work\\App\\', T0)]
    const threads = [thread('t1', 'C:/work/app', T0 + 30 * SECOND)]
    expect(pickThreadsForChats(chats, threads)).toEqual({ c1: 't1' })
  })

  it('places nothing when there is nothing to place', () => {
    expect(pickThreadsForChats([], [])).toEqual({})
    expect(pickThreadsForChats([chat('c1', 'C:/work/app', T0)], [])).toEqual({})
  })
})

describe('titleForThread', () => {
  it('prefers the title Codex settled on', () => {
    const t = thread('t1', 'C:/w', T0, { name: 'Fix the parser', preview: 'please fix the parser' })
    expect(titleForThread(t)).toBe('Fix the parser')
  })

  it('falls back to the first line of the opening message', () => {
    // The same name the chat would have got had the turn gone through Argos's composer.
    const t = thread('t1', 'C:/w', T0, { preview: 'make the tests pass\nand tidy up after' })
    expect(titleForThread(t)).toBe('make the tests pass')
  })

  it('cuts a long opening message to the length a chat name uses', () => {
    const t = thread('t1', 'C:/w', T0, { preview: 'x'.repeat(200) })
    expect(titleForThread(t)).toHaveLength(40)
  })

  it('returns nothing rather than a placeholder when the thread offers neither', () => {
    // "New chat" beats a name invented out of nothing.
    expect(titleForThread(thread('t1', 'C:/w', T0, { preview: '   ' }))).toBeNull()
    expect(titleForThread(thread('t1', 'C:/w', T0, { name: '  ', preview: '' }))).toBeNull()
  })
})
