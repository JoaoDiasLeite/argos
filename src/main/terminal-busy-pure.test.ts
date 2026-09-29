import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BusyTracker, BUSY_IDLE_MS, BUSY_ECHO_GRACE_MS, isMouseClick, isTerminalReport } from './terminal-busy-pure'

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

  it('keeps a launched CLI unprompted however much the mouse moves over it', () => {
    const { tracker, events } = watched()
    tracker.noteLaunch('t1')
    // The pointer crossing the chat on the way out, then a hint the CLI repaints later.
    tracker.noteReport('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 3)
    tracker.noteOutput('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 3)
    expect(events).toEqual([])
  })

  it('reads the paint that answers a report as a redraw', () => {
    const { tracker, events } = watched()
    tracker.noteWrite('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS * 2)
    // An idle chat you typed into earlier, repainting a hover.
    tracker.noteReport('t1')
    tracker.noteOutput('t1')
    vi.advanceTimersByTime(BUSY_IDLE_MS + 1)
    expect(events).toEqual([])
  })

  it('does not let a report right after a keystroke hide the turn it started', () => {
    const { tracker, events } = watched()
    tracker.noteWrite('t1')
    // The mouse moves while Enter is pressed; the CLI then works without a pause.
    tracker.noteReport('t1')
    vi.advanceTimersByTime(BUSY_ECHO_GRACE_MS + 1)
    tracker.noteOutput('t1')
    expect(events).toEqual([['t1', true]])
  })
})

describe('isTerminalReport', () => {
  it('recognises focus reports, alone or batched', () => {
    expect(isTerminalReport('\x1b[I')).toBe(true)
    expect(isTerminalReport('\x1b[O')).toBe(true)
    expect(isTerminalReport('\x1b[O\x1b[I')).toBe(true)
  })

  it('recognises mouse reports, which Claude Code asks for on every motion', () => {
    expect(isTerminalReport('\x1b[<35;40;12M')).toBe(true)
    expect(isTerminalReport('\x1b[<35;40;12M\x1b[<35;41;12M')).toBe(true)
    expect(isTerminalReport('\x1b[<0;10;5M\x1b[<0;10;5m')).toBe(true)
    expect(isTerminalReport('\x1b[<64;10;5M')).toBe(true)
    expect(isTerminalReport('\x1b[M #!')).toBe(true)
  })

  it("recognises xterm's answers to a CLI's queries", () => {
    expect(isTerminalReport('\x1b[?1;2c')).toBe(true)
    expect(isTerminalReport('\x1b[>0;276;0c')).toBe(true)
    expect(isTerminalReport('\x1b[12;40R')).toBe(true)
    expect(isTerminalReport('\x1b[0n')).toBe(true)
    expect(isTerminalReport('\x1b[?2026;2$y')).toBe(true)
    expect(isTerminalReport('\x1b[8;30;120t')).toBe(true)
    expect(isTerminalReport('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toBe(true)
    expect(isTerminalReport('\x1bP1$r0m\x1b\\')).toBe(true)
  })

  it('does not swallow real input that merely contains one', () => {
    expect(isTerminalReport('')).toBe(false)
    expect(isTerminalReport('I')).toBe(false)
    expect(isTerminalReport('\x1b[Ia')).toBe(false)
    expect(isTerminalReport('\x1b[<35;40;12Mx')).toBe(false)
    expect(isTerminalReport('\r')).toBe(false)
    expect(isTerminalReport('\x1b')).toBe(false)
    // Arrow keys and the like share the CSI prefix and must still count as typing.
    expect(isTerminalReport('\x1b[A')).toBe(false)
    expect(isTerminalReport('\x1b[1;5C')).toBe(false)
    expect(isTerminalReport('\x1b[3~')).toBe(false)
  })
})

describe('isMouseClick', () => {
  it('is true for a button press', () => {
    expect(isMouseClick('\x1b[<0;10;5M')).toBe(true)
    expect(isMouseClick('\x1b[<2;10;5M')).toBe(true)
    expect(isMouseClick('\x1b[<35;9;5M\x1b[<0;10;5M')).toBe(true)
  })

  it('is false for motion, the wheel, a release or anything else', () => {
    expect(isMouseClick('\x1b[<35;10;5M')).toBe(false)
    expect(isMouseClick('\x1b[<32;10;5M')).toBe(false)
    expect(isMouseClick('\x1b[<64;10;5M')).toBe(false)
    expect(isMouseClick('\x1b[<0;10;5m')).toBe(false)
    expect(isMouseClick('\x1b[I')).toBe(false)
    expect(isMouseClick('a')).toBe(false)
  })
})

