/**
 * Pure bookkeeping for the Remote Session terminal's shell channels (src/main/remote-shell.ts),
 * split out so it's unit-testable without ssh2 or `sftp.ts` -> `ssh.ts` -> electron.
 *
 * A shell id is either *pending* (its create is still waiting on the connection or the
 * channel) or *live* (the channel is open and wired). The id is reserved the moment a create
 * starts, so:
 *  - a kill that lands while the create is pending marks it killed; when the channel then
 *    opens, `adopt` refuses it and the caller closes it instead of registering an orphan that
 *    streams output to an unmounted terminal;
 *  - a second create for an id that is already pending shares the first one's result rather
 *    than opening a second channel (which doubled every byte of output).
 */

export interface CreateResult {
  ok: boolean
  error?: string
}

export interface CreateTicket {
  readonly killed: boolean
}

interface Pending {
  ticket: { killed: boolean }
  promise: Promise<CreateResult>
}

export type KillOutcome<C> = { kind: 'live'; channel: C } | { kind: 'pending' } | { kind: 'none' }

export class ShellRegistry<C> {
  private readonly live = new Map<string, C>()
  private readonly pending = new Map<string, Pending>()

  /** The live channel for `id`, if its create has finished and it hasn't been killed. */
  get(id: string): C | undefined {
    return this.live.get(id)
  }

  /**
   * Starts a create for `id`, or joins the one already under way. A live id resolves ok
   * without running anything (a benign re-create). `run` gets a ticket whose `killed` flips
   * if a kill arrives before it finishes; it must hand its channel to `adopt` with the same
   * ticket. A rejection from `run` resolves as `{ ok: false }`.
   */
  create(id: string, run: (ticket: CreateTicket) => Promise<CreateResult>): Promise<CreateResult> {
    if (this.live.has(id)) return Promise.resolve({ ok: true })
    const existing = this.pending.get(id)
    if (existing) return existing.promise

    const ticket = { killed: false }
    const promise = Promise.resolve()
      .then(() => run(ticket))
      .catch((e: unknown): CreateResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        if (this.pending.get(id)?.ticket === ticket) this.pending.delete(id)
      })
    this.pending.set(id, { ticket, promise })
    return promise
  }

  /**
   * Registers the channel a create opened. Returns false when that create was killed in the
   * meantime — the caller must then close the channel instead of wiring it.
   */
  adopt(id: string, ticket: CreateTicket, channel: C): boolean {
    if (ticket.killed) return false
    this.live.set(id, channel)
    return true
  }

  /**
   * Forgets `channel` when it closes on its own. Returns true when it was still the live
   * channel for `id` (the far end closed it); false when it had already been killed or
   * replaced, so the caller doesn't report an exit to a terminal that moved on.
   */
  release(id: string, channel: C): boolean {
    if (this.live.get(id) !== channel) return false
    this.live.delete(id)
    return true
  }

  /**
   * Kills `id`: hands back a live channel for the caller to end, or marks a pending create
   * as killed. Either way the id is free again straight away, so a fresh create (StrictMode
   * remount, restart) doesn't join the dying one.
   */
  kill(id: string): KillOutcome<C> {
    const channel = this.live.get(id)
    if (channel !== undefined) {
      this.live.delete(id)
      return { kind: 'live', channel }
    }
    const p = this.pending.get(id)
    if (p) {
      p.ticket.killed = true
      this.pending.delete(id)
      return { kind: 'pending' }
    }
    return { kind: 'none' }
  }

  /** Kills everything: returns the live channels to end and marks every pending create. */
  killAll(): C[] {
    const channels = [...this.live.values()]
    this.live.clear()
    for (const p of this.pending.values()) p.ticket.killed = true
    this.pending.clear()
    return channels
  }
}
