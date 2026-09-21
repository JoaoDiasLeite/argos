/**
 * Finding the notifications a provider CLI writes into its own pty.
 *
 * A CLI that wants the user back — a turn has finished, a command is waiting to be
 * approved — has one structured way to say so through a terminal: OSC 9, the
 * notification sequence. Codex emits it when launched with
 * `tui.notification_method=osc9`, which is why startCliInTerminal passes that in.
 *
 * Measured, not assumed. Against the real CLI, a finished turn notifies with the
 * assistant's own text, and a command waiting on the user notifies with
 * `Approval requested: "…"`. That prefix is the whole of the guesswork here: the
 * DETECTION is structured and survives any rewording, and only the split between
 * "it wants you" and "it is done" leans on the text. An unrecognised payload is
 * treated as a finish, which is the state the chat was already heading for.
 *
 * Why this is a parser and not an indexOf. Chunks off a pty break wherever the pipe
 * happened to break, so a sequence routinely arrives in pieces — the `ESC` at the end of
 * one chunk, the payload in the next. Anything examining chunks in isolation would miss
 * precisely the notifications that matter, and miss them intermittently, which is the
 * worst way to miss anything. An unterminated sequence is carried into the next chunk.
 */

const ESC = String.fromCharCode(27)
/** BEL, the usual OSC terminator. */
const BEL = String.fromCharCode(7)
/** ST (`ESC \\`), the other one — either may end a sequence, so both are honoured. */
const ST = ESC + '\\'
const OSC_OPEN = ESC + ']'

/** The OSC code carrying a desktop notification. */
export const OSC_NOTIFY_CODE = '9'

/**
 * How much of an unterminated sequence is carried into the next chunk before it is
 * abandoned. A real notification is far shorter than this; the cap is what stops a lone
 * `ESC ]` in a stream of binary junk from growing the carry without end.
 */
export const MAX_CARRY = 4096

/** What Codex puts in front of a notification raised because it is waiting on the user
 *  rather than because it has finished. */
export const APPROVAL_PREFIX = 'Approval requested:'

/**
 * Is this notification the CLI asking for something, rather than reporting a result?
 *
 * Only ever narrows a notification that has already been detected structurally, so the
 * cost of it being wrong is a chat marked finished instead of waiting — never a chat
 * that goes unmarked altogether.
 */
export function isApprovalNotification(payload: string): boolean {
  return payload.trimStart().startsWith(APPROVAL_PREFIX)
}

export class OscScanner {
  private readonly carry = new Map<string, string>()

  /**
   * Feed one chunk of a pty's output. Returns the notification payloads it completed —
   * usually none, occasionally one, and an array only because nothing rules out two.
   */
  feed(id: string, chunk: string): string[] {
    let buf = (this.carry.get(id) ?? '') + chunk
    const out: string[] = []

    for (;;) {
      const open = buf.indexOf(OSC_OPEN)
      if (open === -1) {
        // Nothing open. Keep a trailing ESC, which may be the start of a sequence whose
        // `]` is in the next chunk, and nothing else.
        this.carry.set(id, buf.endsWith(ESC) ? ESC : '')
        return out
      }

      const bodyAt = open + OSC_OPEN.length
      const bel = buf.indexOf(BEL, bodyAt)
      const st = buf.indexOf(ST, bodyAt)
      let end = -1
      let termLen = 0
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel
        termLen = BEL.length
      } else if (st !== -1) {
        end = st
        termLen = ST.length
      }

      if (end === -1) {
        // Still open. Carry it, unless it has outgrown the cap — whatever that is, it is
        // not a notification, and holding on to it would only cost memory.
        const rest = buf.slice(open)
        this.carry.set(id, rest.length > MAX_CARRY ? '' : rest)
        return out
      }

      const body = buf.slice(bodyAt, end)
      const semi = body.indexOf(';')
      if (semi !== -1 && body.slice(0, semi) === OSC_NOTIFY_CODE) {
        out.push(body.slice(semi + 1))
      }
      // Drop what has been consumed, so a long stream is not re-walked from the front on
      // every pass through this loop.
      buf = buf.slice(end + termLen)
    }
  }

  /** Drop a pty's carried state. Its next incarnation starts clean — a half-sequence left
   *  by a dead process must never be completed by a new one's first chunk. */
  forget(id: string): void {
    this.carry.delete(id)
  }
}
