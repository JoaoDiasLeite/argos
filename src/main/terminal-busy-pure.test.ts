import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BusyTracker, BUSY_IDLE_MS, BUSY_ECHO_GRACE_MS } from './terminal-busy-pure'

/**
 * The state machine behind the sidebar's running dot for terminal-driven chats.
 *
 * Driven with fake timers rather than a real pty: what is worth pinning down here is when
 * a transition is announced and when it is deliberately not, and every one of those is a
 * question about time.
 */

/** Collects the transitions a tracker announces, so a test can assert on the sequence
 *  rather than on a final state that hides the churn along the way. */
function watched(): { tracker: BusyTracker; events: [string, boolean][] } {
  const tracker = new BusyTracker()
  const events: [string, boolean][] = []
  tracker.watch('t1', (id, isBusy) => events.push([id, isBusy]))
  return { tracker, events }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('BusyTracker', () => {
  it('reports busy on the first chunk and idle once the pty goes quiet', () => {
    const { tracker, events } = watched()
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
    expect(tracker.busyIds()).toEqual(['t1'])

    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
    expect(tracker.busyIds()).toEqual([])
  })

  it('announces each transition once, however many chunks arrive', () => {
    const { tracker, events } = watched()
    // A CLI streaming a turn emits continuously; the dot must not be re-announced per frame.
    for (let i = 0; i < 20; i++) {
      tracker.noteOutput('t1')
      vi.advanceTimersByTime(50)
    }
    expect(events).toEqual([['t1', true]])
  })

  it('stays busy across gaps shorter than the idle window', () => {
    const { tracker, events } = watched()
    tracker.noteOutput('t1')
    // Each chunk re-arms the timer, so a run of sub-threshold gaps is still one burst —
    // this is what keeps a slow turn from flickering the dot off between chunks.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(BUSY_IDLE_MS - 100)
      tracker.noteOutput('t1')
    }
    expect(events).toEqual([['t1', true]])

    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
  })

  it('ignores the echo of a keystroke the renderer just sent', () => {
    const { tracker, events } = watched()
    // Typing into an idle chat: every character comes straight back. Reading that as work
    // would flicker the dot on for as long as the prompt took to type.
    for (let i = 0; i < 10; i++) {
      tracker.noteWrite('t1')
      vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS - 50)
      tracker.noteOutput('t1')
      vi.advanceTimersByTime(50)
    }
    expect(events).toEqual([])
    expect(tracker.busyIds()).toEqual([])
  })

  it('reports busy for output that arrives after the echo grace has passed', () => {
    const { tracker, events } = watched()
    // Pressing Enter is a write too — the turn it starts must still register.
    tracker.noteWrite('t1')
    vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS + 1)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })

  it('treats a pty that has never been written to as capable of being busy', () => {
    const { tracker, events } = watched()
    // The CLI's own start-up banner arrives before any keystroke. A zero default for
    // "last written at" would be fine here, but an epoch-relative one would not be — the
    // guard has to key off "never", not off a timestamp that happens to be small.
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })

  it('ignores the paint that follows something we did to the pty', () => {
    const { tracker, events } = watched()
    // Spawning the CLI, or resizing the pty under a full-screen TUI, makes it repaint —
    // for as many chunks as the repaint takes. Counting that as work is what put a chat
    // you only opened and left on the pending bar, marked finished.
    tracker.noteRedraw('t1')
    for (let i = 0; i < 20; i++) {
      tracker.noteOutput('t1')
      vi.advanceTimersByTime(50)
    }
    expect(events).toEqual([])
    expect(tracker.busyIds()).toEqual([])
  })

  it('reports busy again once the paint it was told about has settled', () => {
    const { tracker, events } = watched()
    tracker.noteRedraw('t1')
    tracker.noteOutput('t1')
    // The burst is bounded by the pty going quiet, not by a duration — a redraw crossing a
    // WSL or SSH hop takes as long as it takes. Once it has, the next turn is a real one.
    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([])
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })

  it('clears a redraw that painted nothing at all', () => {
    const { tracker, events } = watched()
    // A resize the CLI ignores produces no output, so there is no chunk to end the burst.
    // Without the timer armed by noteRedraw itself, the next real turn would be swallowed.
    tracker.noteRedraw('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })

  it('keeps a working pty busy across a redraw', () => {
    const { tracker, events } = watched()
    tracker.noteOutput('t1')
    // Resizing a pane mid-turn (a splitter drag, a font-size change) must not read as the
    // turn ending — that would announce a finished run while the CLI is still going.
    tracker.noteRedraw('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS - 100)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
    expect(tracker.busyIds()).toEqual(['t1'])

    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
  })

  it('treats output after a keystroke as work even mid-redraw', () => {
    const { tracker, events } = watched()
    // Typing into a CLI that is still painting its start-up screen: what comes back is the
    // answer to the keystroke, which is a turn. (The echo grace still covers the keystroke
    // itself — this is output that arrives after it.)
    tracker.noteRedraw('t1')
    tracker.noteWrite('t1')
    vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS + 1)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })

  it('never reports a launched CLI busy until something is typed into it', () => {
    const { tracker, events } = watched()
    // Start-up has no bound in time: the CLI paints when it gets there, in as many pieces
    // as it likes, with gaps longer than the idle window in between. A timer around it is
    // a guess — what is certain is that a CLI nobody has typed into has nothing to do.
    tracker.noteLaunch('t1')
    for (let i = 0; i < 6; i++) {
      tracker.noteOutput('t1')
      vi.advanceTimersByTime(BUSY_IDLE_MS * 3)
    }
    expect(events).toEqual([])
    expect(tracker.busyIds()).toEqual([])
  })

  it('reports busy once the launched CLI is given something to do', () => {
    const { tracker, events } = watched()
    tracker.noteLaunch('t1')
    tracker.noteOutput('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 5)
    // The keystroke that starts the first turn is what ends the launch.
    tracker.noteWrite('t1')
    vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS + 1)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])

    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
  })

  it('treats a relaunched CLI as unprompted again', () => {
    const { tracker, events } = watched()
    tracker.noteWrite('t1')
    vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS + 1)
    tracker.noteOutput('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
    // Restart drops the pty to a bare shell and launches the CLI again — that start-up is
    // no more work than the first one was, whatever was typed into the CLI it replaced.
    tracker.noteLaunch('t1')
    tracker.noteOutput('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 3)
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
  })

  it('announces idle when a pty is forgotten mid-burst', () => {
    const { tracker, events } = watched()
    tracker.noteOutput('t1')
    tracker.forget('t1')
    // A chat killed while its CLI was working would otherwise keep its dot forever.
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
    expect(tracker.busyIds()).toEqual([])
  })

  it('says nothing when a pty that was already idle is forgotten', () => {
    const { tracker, events } = watched()
    tracker.forget('t1')
    expect(events).toEqual([])
  })

  it('fires no pending timer after a pty is forgotten', () => {
    const { tracker, events } = watched()
    tracker.noteOutput('t1')
    tracker.forget('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 2)
    // Exactly one busy and one idle: the armed timer must not deliver a second idle
    // against an id that has since been handed to a replacement pty.
    expect(events).toEqual([
      ['t1', true],
      ['t1', false]
    ])
  })

  it('tracks ptys independently', () => {
    const tracker = new BusyTracker()
    const events: [string, boolean][] = []
    const record = (id: string, isBusy: boolean) => events.push([id, isBusy])
    tracker.watch('a', record)
    tracker.watch('b', record)

    tracker.noteOutput('a')
    vi.advanceTimersByTime(600)
    tracker.noteOutput('b')
    expect(tracker.busyIds().sort()).toEqual(['a', 'b'])

    // 'a' has been quiet for 600ms longer, so it drops out first.
    vi.advanceTimersByTime(BUSY_IDLE_MS - 600 + 1)
    expect(tracker.busyIds()).toEqual(['b'])
    vi.advanceTimersByTime(600)
    expect(tracker.busyIds()).toEqual([])
    expect(events).toEqual([
      ['a', true],
      ['b', true],
      ['a', false],
      ['b', false]
    ])
  })

  it('keeps an unwatched pty out of the busy list without throwing', () => {
    const tracker = new BusyTracker()
    // A pty from the standalone terminal grid is tracked the same way, but nothing has
    // registered a callback for it. The absent notify must not be an error.
    expect(() => tracker.noteOutput('loose')).not.toThrow()
    expect(tracker.busyIds()).toEqual(['loose'])
  })
})
