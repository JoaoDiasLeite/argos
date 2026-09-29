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
 * `noteRedraw` is how terminal.ts declares such a burst ours, and `noteLaunch` covers the
 * one case a burst cannot be bounded by time at all — a CLI that has just been started.
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

/**
 * One report xterm writes to a pty on its own account rather than because a key was
 * pressed: a focus report, a mouse report, or its answer to a query the CLI sent.
 *
 * Read as keystrokes, these end the redraw of the resize that came with them and lift a
 * fresh CLI's launch guard, and the repaint the CLI answers with then counts as work: a
 * burst that ends after you have looked away is what the pending bar reports as a
 * finished run.
 *
 * Focus reports come from a CLI that turns on focus reporting (DECSET 1004, which Claude
 * Code does): `ESC [ I` when its terminal is focused and `ESC [ O` when it is blurred, so
 * opening a chat, or leaving it, writes to its pty without anyone having typed.
 *
 * Mouse reports come from Claude Code turning on any-motion mouse tracking
 * (DECSET 1003 with SGR encoding, 1006): merely moving the pointer across a chat — on the
 * way in, or on the way out to another one — writes a stream of `ESC [ < b ; x ; y M` to
 * its pty, so a phantom finished run needed no one to touch the keyboard at all.
 */
const TERMINAL_REPORT = new RegExp(
  [
    /\x1b\[[IO]/, // focus in / out
    /\x1b\[<\d+;\d+;\d+[Mm]/, // SGR mouse (1006)
    /\x1b\[M[\s\S]{3}/, // X10 / normal mouse
    /\x1b\[[?>][\d;]*c/, // device attributes (DA1 / DA2)
    /\x1b\[\??\d+;\d+R/, // cursor position
    /\x1b\[0n/, // device status
    /\x1b\[\??\d+;\d+\$y/, // mode report (DECRPM)
    /\x1b\[\d+;\d+;\d+t/, // window size reports
    /\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC answers (colours)
    /\x1bP[^\x1b]*\x1b\\/ // DCS answers (DECRQSS)
  ]
    .map((r) => r.source)
    .join('|')
)
const ONLY_REPORTS = new RegExp(`^(?:${TERMINAL_REPORT.source})+$`)

/**
 * Whether a write to a pty is only terminal reports (see TERMINAL_REPORT) — no keystroke
 * in it. Batched reports still qualify; anything typed alongside them does not.
 *
 * A modified F3 (`ESC [ 1 ; 2 R`) is indistinguishable from a cursor-position report and
 * is read as one. Erring that way costs nothing: the worst it does is not count a key.
 */
export function isTerminalReport(data: string): boolean {
  return ONLY_REPORTS.test(data)
}

/**
 * Whether a write is a mouse button being pressed — a click, as opposed to the pointer
 * moving or the wheel turning. A full-screen CLI lets you click an option to answer it,
 * so a click still takes an approval mark off even though it is not typing.
 */
export function isMouseClick(data: string): boolean {
  for (const m of data.matchAll(/\x1b\[<(\d+);\d+;\d+M/g)) {
    const b = Number(m[1])
    // Motion (32) and wheel (64+) carry flags on top of the button; a plain press is 0–2.
    if ((b & (32 | 64 | 128)) === 0 && (b & 3) !== 3) return true
  }
  return false
}

type Notify = (id: string, busy: boolean) => void

export class BusyTracker {
  private readonly busy = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly notify = new Map<string, Notify>()
  private readonly lastWriteAt = new Map<string, number>()
  /** Ptys whose current burst is a paint we asked for — see noteRedraw. */
  private readonly redrawing = new Set<string>()
  /** Ptys running a CLI that has not been typed into yet — see noteLaunch. */
  private readonly unprompted = new Set<string>()

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
    this.unprompted.delete(id)
  }

  /**
   * A CLI has just been launched in this pty and has been given nothing to do.
   *
   * Stronger than noteRedraw, and it has to be: start-up is the one paint with no bound in
   * time at all. It arrives whenever the CLI gets there — seconds later for `claude
   * --resume` on a long transcript, in dribs and drabs with gaps longer than the idle
   * window between them — so any timer drawn around it is a guess, and a guess that
   * expires mid-paint reads the rest as work. What is certain instead is that a CLI nobody
   * has typed into has nothing to work on: resuming a session replays it, it does not
   * carry on with it. So nothing this pty prints counts as work until it is written to,
   * however long that takes, which also covers the shell's own banner and the echo of the
   * launch command before the CLI even starts.
   *
   * Restoring a window full of chats is what this is really about: every one of them
   * relaunches its CLI at once, off screen, and each start-up paint used to raise and drop
   * the mark — which the pending bar then reported as that many chats having finished a
   * turn while you were away.
   */
  noteLaunch(id: string): void {
    this.unprompted.add(id)
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

  /**
   * xterm wrote a report to this pty (see isTerminalReport) — not a keystroke, so it lifts
   * no launch guard, and whatever the CLI paints in reply is a redraw.
   *
   * Except right after a real keystroke: the pointer moving while you press Enter would
   * otherwise open a redraw just as the turn starts, and a CLI that never goes quiet while
   * it works would never be announced busy at all.
   */
  noteReport(id: string, at: number = Date.now()): void {
    if (at - (this.lastWriteAt.get(id) ?? -Infinity) < BUSY_IDLE_MS) return
    this.noteRedraw(id)
  }

  /** A chunk came out of this pty. Marks it busy (announcing the change, if it is one) and
   *  re-arms the quiet timer that will mark it idle again. */
  noteOutput(id: string, at: number = Date.now()): void {
    if (at - (this.lastWriteAt.get(id) ?? -Infinity) < BUSY_ECHO_GRACE_MS) return
    // Nothing to end and no timer to arm: this one is ended by a keystroke, not by time.
    if (this.unprompted.has(id)) return
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
    this.unprompted.delete(id)
    if (this.busy.delete(id)) this.notify.get(id)?.(id, false)
    this.notify.delete(id)
  }

  /** The ptys currently producing output. The renderer only hears transitions from the
   *  moment it subscribes, so it seeds itself from this on mount. */
  busyIds(): string[] {
    return [...this.busy]
  }
}
