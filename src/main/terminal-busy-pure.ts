/**
 * Whether the CLI inside a pty is working, inferred from what the pty emits.
 *
 * Claude Code publishes its own busy/idle status through the session registry that
 * `live-sessions.ts` reads, and for a long time that was the only thing that could tell
 * the sidebar a terminal-driven chat was busy. Nothing equivalent exists for codex or
 * Antigravity, and codex cannot even be handed a session id to look one up by — its CLI
 * has no `--session-id` — so a chat on either of them could never light up at all.
 *
 * Output is the one signal every provider shares, and it needs no identity link at all.
 * It was measured against both CLIs before being relied on: each emits a burst while
 * starting and then goes completely silent at its prompt — zero chunks over the following
 * fifteen seconds — so "has emitted recently" separates working from idle without a line
 * of per-provider parsing.
 *
 * The proxy holds only for output the CLI produced on its own account. Output it was made
 * to produce — the start-up paint of a CLI we just launched, the full redraw a pty emits
 * when it is resized — says nothing about work, and reading it as work shows up well
 * beyond the running dot: a burst that rises and falls while you are not looking at the
 * chat is what the pending bar reports as a run that finished (see App.tsx), so merely
 * opening a chat and leaving it announced a finished turn that never happened.
 * `noteRedraw` is how terminal.ts declares such a burst ours.
 *
 * Split out from terminal.ts so the state machine can be tested without a real pty: this
 * file holds every decision, and terminal.ts only feeds it events. Timers and the clock
 * are the ambient ones on purpose — the test drives them with vitest's fake timers rather
 * than through an injection seam that would exist for no other reason.
 */

/** Quiet for this long means the CLI has finished and is back at its prompt. Well above a
 *  frame of TUI redraw, well below the time any real turn takes. */
export const BUSY_IDLE_MS = 1200

/** Output this soon after a keystroke is that keystroke being echoed back, not the CLI
 *  working. Without it, typing a long prompt into an idle chat would flicker the running
 *  dot on for as long as it took to type. */
export const BUSY_ECHO_GRACE_MS = 350

type Notify = (id: string, busy: boolean) => void

export class BusyTracker {
  private readonly busy = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly notify = new Map<string, Notify>()
  private readonly lastWriteAt = new Map<string, number>()
  /** Ptys whose current burst is a paint we asked for — see noteRedraw. */
  private readonly redrawing = new Set<string>()

  /**
   * Start tracking a pty, and say how its transitions are reported.
   *
   * The callback is held per id rather than passed to each call because the two teardown
   * paths differ: a pty that exits is torn down from inside its own handler, which has the
   * callback to hand, but a killed one is torn down by `killTerminal`, which does not.
   */
  watch(id: string, onBusy: Notify): void {
    this.notify.set(id, onBusy)
  }

  /** The renderer wrote to this pty — remember when, so the echo that follows is not read
   *  as work. Ends a redraw as well: what the CLI paints after a keystroke of yours is its
   *  answer to it, and that is work. */
  noteWrite(id: string, at: number = Date.now()): void {
    this.lastWriteAt.set(id, at)
    this.redrawing.delete(id)
  }

  /**
   * We are about to make this pty paint — its CLI is being launched, or it has just been
   * resized and the CLI will redraw from scratch. The burst that follows is not work and
   * must not raise the mark.
   *
   * Bounded by the pty going quiet rather than by a duration: a redraw coming back from a
   * WSL distro or an SSH box takes as long as it takes, a CLI's start-up paint has no
   * fixed length at all, and "it has stopped painting" is the signal this class already
   * trusts for everything else. The quiet timer is armed here too, so a resize that paints
   * nothing still clears instead of swallowing the next real turn.
   *
   * A pty already marked busy stays busy — a resize in the middle of a turn is not the
   * turn ending. Only the announcement is held back, never the timer that ends the burst.
   */
  noteRedraw(id: string): void {
    this.redrawing.add(id)
    this.arm(id)
  }

  /** A chunk came out of this pty. Marks it busy (announcing the change, if it is one) and
   *  re-arms the quiet timer that will mark it idle again. */
  noteOutput(id: string, at: number = Date.now()): void {
    if (at - (this.lastWriteAt.get(id) ?? -Infinity) < BUSY_ECHO_GRACE_MS) return
    if (!this.busy.has(id) && !this.redrawing.has(id)) {
      this.busy.add(id)
      this.notify.get(id)?.(id, true)
    }
    this.arm(id)
  }

  /** (Re)arm the quiet timer that ends the current burst — the single place that says what
   *  "the pty went quiet" does, shared by output and by a redraw that paints nothing. */
  private arm(id: string): void {
    const prev = this.timers.get(id)
    if (prev) clearTimeout(prev)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.redrawing.delete(id)
        if (this.busy.delete(id)) this.notify.get(id)?.(id, false)
      }, BUSY_IDLE_MS)
    )
  }

  /** The pty is gone. Announces the drop if it died mid-burst — otherwise a chat killed
   *  while working would keep its running dot forever. */
  forget(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    this.lastWriteAt.delete(id)
    this.redrawing.delete(id)
    if (this.busy.delete(id)) this.notify.get(id)?.(id, false)
    this.notify.delete(id)
  }

  /** The ptys currently producing output. The renderer only hears transitions from the
   *  moment it subscribes, so it seeds itself from this on mount. */
  busyIds(): string[] {
    return [...this.busy]
  }
}
