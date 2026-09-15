/**
 * Matching a live `claude` back to the chat whose terminal started it, by descent.
 *
 * A chat names its Claude Code session before launching the CLI (see newSession), so
 * normally there is nothing to work out. The launch chain can still fall through to a
 * bare `claude` — a CLI too old to know `--session-id`, a `--resume` that half-succeeds,
 * a chat whose terminal was started by a build that predates the pinning — and then the
 * CLI invents an id nobody told the app about. The chat is left holding an id that names
 * no live process: no transcript, no title, and no running dot, permanently.
 *
 * Descent is the honest link. The pty is our own child, so a `claude` running under that
 * chat's terminal is a descendant of its pid, and nothing else is. This module owns the
 * rule; reading the process table is the caller's job.
 */

/** A live session that no chat currently claims, and the pid it is running as. */
export interface AdoptionCandidate {
  sessionId: string
  pid: number
}

/**
 * How far up a parent chain to look. A local launch is pty → shell → (cmd shim) →
 * claude, so three is the real depth; the ceiling is only here so a cyclic or
 * self-parenting table (pid reuse mid-read can produce one) cannot spin forever.
 */
export const MAX_ANCESTRY_DEPTH = 12

/** Does `pid` descend from `ancestor`, following ppid links? */
export function descendsFrom(
  pid: number,
  ancestor: number,
  parentOf: ReadonlyMap<number, number>
): boolean {
  let cur = pid
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const parent = parentOf.get(cur)
    if (parent === undefined) return false
    if (parent === ancestor) return true
    // A process that is its own parent, or a pid 0/1 root: the chain is over.
    if (parent === cur || parent === 0) return false
    cur = parent
  }
  return false
}

/**
 * The session this pty is running, or null.
 *
 * Null when none descends from it, and — deliberately — also when SEVERAL do. Two live
 * `claude` processes under one terminal means something is nested or half-exited, and
 * guessing between them writes the wrong conversation id onto the chat. Getting this
 * wrong is worse than the missing dot it is meant to fix: a chat pointed at someone
 * else's session shows their title, imports their transcript, and resumes them the next
 * time it opens. Nothing is a fine answer; the wrong thing is not.
 */
export function pickAdopted(
  candidates: readonly AdoptionCandidate[],
  ptyPid: number,
  parentOf: ReadonlyMap<number, number>
): string | null {
  if (!Number.isSafeInteger(ptyPid) || ptyPid <= 0) return null
  const under = candidates.filter((c) => descendsFrom(c.pid, ptyPid, parentOf))
  return under.length === 1 ? under[0].sessionId : null
}

/**
 * Parse `pid ppid` pairs into the map the two functions above read.
 *
 * Shared by both platforms' process-table readers — PowerShell's CSV and `ps` output
 * differ in everything except being two integers per line, so the parsing is written
 * once, here, where it can be tested without a process table.
 */
export function parsePidPairs(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^"?(\d+)"?[\s,]+"?(\d+)"?$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    out.set(pid, ppid)
  }
  return out
}
