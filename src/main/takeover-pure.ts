import { isSameDomain, RegistryEntry } from './live-sessions-pure'

/**
 * Whether it is safe to signal a `claude` process, decided with no side effects.
 *
 * This is the most dangerous thing Argos does. Every other destructive operation in
 * the app acts on a file it can name; this one acts on a *number*, and a number is
 * only meaningful next to the process that currently holds it. Get it wrong and the
 * app terminates something that has nothing to do with Claude Code — a database, an
 * editor with unsaved work, a build.
 *
 * So the guards are all here, in one function, with no `fs` and no `child_process`
 * anywhere near them, and they are exhaustively tested. The caller's only job is to
 * gather the three inputs honestly and to refuse to act on anything but `ok: true`.
 *
 * The refusals are separate values rather than one boolean because they mean
 * genuinely different things to the person reading them: "it already exited" needs a
 * refresh, "it is in a distro" will never work, and "the start time does not match"
 * means the pid was recycled and something else is wearing it right now.
 */

export type TakeoverRefusal =
  | 'not-found'
  | 'foreign'
  | 'pid-changed'
  | 'no-proc-start'
  | 'not-running'
  | 'unverifiable'
  | 'pid-reused'
  | 'not-claude'
  | 'failed'

/**
 * What the operating system says about the process that holds this pid *now*.
 *
 * `null` means we could not find out — which is not the same as "there is no such
 * process", and is treated as a refusal rather than as permission. See `verifyTakeover`.
 */
export interface ProcessIdentity {
  /** The executable's name, without extension: `claude` for the CLI. */
  name: string
  /** Start time as a Windows FILETIME decimal string, the same shape the registry writes. */
  procStart: string
}

export type TakeoverVerdict =
  | { ok: true; pid: number }
  | { ok: false; error: TakeoverRefusal }

/** The process name Claude Code's CLI runs under. */
export const CLAUDE_PROCESS_NAME = 'claude'

/**
 * Decide whether `entry` may be signalled.
 *
 * The order is deliberate — cheapest and most absolute first, so the expensive
 * identity read is never even reached for a session that was never eligible:
 *
 * 1. **Domain.** A pid from another PID space names an unrelated local process. This
 *    is first because it is the only refusal that can never be resolved by waiting or
 *    retrying, and because acting on it is the worst outcome available.
 * 2. **The pid the user saw.** `expectedPid` is what the UI displayed; `entry.pid` is
 *    what the registry says right now. If they differ, the session was restarted
 *    between the render and the click, and the click was aimed at a process that is
 *    already gone. Refuse and let them look again — this is the same "the list you
 *    acted on was stale" refusal the project delete makes.
 *
 *    Note the pid that would be signalled is `entry.pid`, read fresh from the
 *    registry — never `expectedPid`. The request names *which session*; it does not
 *    get to name the number.
 * 3. **A reuse guard must exist.** An entry with no `procStart` cannot be checked
 *    against the live process, so there is no way to know the pid was not recycled.
 *    Refuse rather than proceed without the guard — an unverifiable signal is exactly
 *    the one that lands on a stranger.
 * 4. **The process must still be there**, and we must have been able to read its
 *    identity. `null` is `unverifiable`, deliberately distinct from `not-running`:
 *    "I could not tell" must never be allowed to read as "yes".
 * 5. **The start time must match exactly**, compared as strings. This is what tells
 *    the session apart from an unrelated process that inherited its pid after it
 *    exited. Exact, because the value is exact — see `RegistryEntry.procStart` on why
 *    it is never parsed into a number.
 * 6. **The process must be `claude`.** Belt and braces over the reuse guard: even if
 *    a start time somehow collided, a process by another name is not a session.
 */
export function verifyTakeover(
  entry: RegistryEntry | null,
  expectedPid: number,
  ourDomain: string,
  identity: ProcessIdentity | null
): TakeoverVerdict {
  if (!entry) return { ok: false, error: 'not-found' }
  if (!isSameDomain(entry.pidDomain, ourDomain)) return { ok: false, error: 'foreign' }
  if (entry.pid !== expectedPid) return { ok: false, error: 'pid-changed' }
  if (!entry.procStart) return { ok: false, error: 'no-proc-start' }
  if (!identity) return { ok: false, error: 'unverifiable' }
  if (identity.procStart !== entry.procStart) return { ok: false, error: 'pid-reused' }
  if (identity.name.toLowerCase() !== CLAUDE_PROCESS_NAME) return { ok: false, error: 'not-claude' }
  return { ok: true, pid: entry.pid }
}
