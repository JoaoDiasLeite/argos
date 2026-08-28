import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getSources } from './claude-data'
import { readJsonFile } from './json-file'
import { isSameDomain, parseRegistryEntry, pidDomainFor } from './live-sessions-pure'
import { readProcessIdentity } from './process-identity'
import { TakeoverRefusal, verifyTakeover } from './takeover-pure'

export type TakeoverResult =
  | { ok: true; pid: number }
  | { ok: false; error: TakeoverRefusal; detail?: string }

/**
 * Which `claude` processes are running right now, read from Claude Code's own
 * registry rather than inferred from the process table.
 *
 * The registry is a sibling of the `projects/` directory this app already reads:
 * one `<pid>.json` per live session, written by the CLI itself. That is the only
 * source of truth here — Argos never decides that some process "looks like" a
 * session, because the next step after knowing which process holds a conversation
 * is signalling it.
 *
 * Read-only, and it sends no signals. The one syscall it makes against a foreign
 * process is `process.kill(pid, 0)`, the existence probe, and even that is withheld
 * for entries from another PID space — see below.
 */

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  name: string
  status: 'busy' | 'idle' | 'unknown'
  kind: string
  version?: string
  startedAt: number
  updatedAt: number
  sourceId: string
  sourceLabel: string
  foreign: boolean
}

/**
 * This process's PID domain, in the registry's own shape.
 *
 * The identity half is the *machine* name, not the account name: the observed value
 * on this machine is `win32:joao-leite`, which is `os.hostname()` lower-cased —
 * `os.userInfo().username` is `JoãoLeite` and would never match. Worth stating,
 * because "pid domain" reads like it should be about the user.
 */
function ourPidDomain(): string {
  return pidDomainFor(process.platform, os.hostname())
}

/**
 * Does a process with this pid exist?
 *
 * Signal 0 performs the permission and existence checks without delivering anything.
 * `ESRCH` is the only answer that means gone: `EPERM` means the process is there and
 * owned by someone else, and reading that as "dead" would drop a real session off
 * the list.
 *
 * Only ever called for a pid in our own domain — see the caller.
 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The registry directory for a source, beside its `projects/`. */
function registryDir(projectsDir: string): string {
  return path.join(path.dirname(projectsDir), 'sessions')
}

function readEntries(dir: string): unknown[] {
  let files: string[]
  try {
    // `.json` only. The directory also holds `<pid>.<hash>.key` files belonging to
    // the CLI's messaging layer; they are not ours to read.
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    // No registry directory means no live sessions for this source, which is the
    // normal state for a machine that has never run the CLI from it.
    return []
  }
  const out: unknown[] = []
  for (const f of files) {
    try {
      out.push(readJsonFile(path.join(dir, f)))
    } catch {
      // A file being written as we read it, or one left half-flushed by a crash.
      // Skipping it costs one row on a list that refreshes every few seconds.
    }
  }
  return out
}

/**
 * Every live session across every configured source.
 *
 * **`procStart` is deliberately not verified here.** The registry records the
 * process's start time, which is what tells a live session apart from an unrelated
 * process that inherited its pid — but reading a process's real start time costs a
 * PowerShell spawn per pid, and this list refreshes on a timer. Being wrong here
 * shows a stale row for a few seconds, which is cheap. It is verified in the round
 * that signals a process, where being wrong is not cheap at all. The omission looks
 * like an oversight; it is a deliberate split between a cheap read and an expensive
 * guard, placed where each one is worth its cost.
 *
 * Never throws. A registry that cannot be read yields fewer rows, not a failed IPC
 * call — a status view that disappears because one file was mid-write is worse than
 * one that is briefly incomplete.
 */
export async function listLiveSessions(): Promise<LiveSession[]> {
  const ourDomain = ourPidDomain()
  const found = new Map<string, LiveSession>()

  let sources: Awaited<ReturnType<typeof getSources>>
  try {
    sources = await getSources()
  } catch {
    return []
  }

  for (const src of sources) {
    for (const raw of readEntries(registryDir(src.projectsDir))) {
      const entry = parseRegistryEntry(raw)
      if (!entry) continue

      const foreign = !isSameDomain(entry.pidDomain, ourDomain)
      // A foreign pid is never probed. In our PID space that same number belongs to
      // an unrelated process — probing it asks a question about the wrong thing, and
      // answering it would report a stranger as a live Claude session. A WSL source's
      // registry is readable over its UNC path precisely because it is right there,
      // which is what makes this the easy mistake to make. Such an entry is listed on
      // the strength of its own file, and can never be signalled.
      if (!foreign && !pidExists(entry.pid)) continue

      // Keyed by source too: two sources can hold entries for the same pid number,
      // and in different domains they are different processes.
      const key = `${src.id}:${entry.pid}`
      const existing = found.get(key)
      if (existing && existing.updatedAt >= entry.updatedAt) continue

      found.set(key, {
        pid: entry.pid,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        name: entry.name,
        status: entry.status,
        kind: entry.kind,
        version: entry.version,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        sourceId: src.id,
        sourceLabel: src.label,
        foreign
      })
    }
  }

  // Most recently active first: on a list of running things, the one that just did
  // something is the one being looked for.
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── Takeover ─────────────────────────────────────────────────────────────────

/**
 * Ask a `claude` process that is not our child to exit, so its conversation can be
 * resumed here instead. One conversation, one live `claude`: two instances on one
 * session id interleave turns and fork the `parentUuid` chain.
 *
 * The whole of the decision is in `verifyTakeover`, which is pure and exhaustively
 * tested. This function's only jobs are to gather its three inputs honestly and to
 * act on nothing but `ok: true`.
 *
 * **The pid comes from the registry, re-read here, never from the request.** The
 * caller names a session and states which pid it displayed; the second is used only
 * to refuse when the two disagree, which means the row was stale. A request that
 * could name the number would be a request that could name any number.
 *
 * **A terminate, never a kill.** SIGTERM lets the CLI write its transcript out and
 * clean up its registry entry; SIGKILL would leave both half-written, and the
 * transcript is the thing the user is trying to get back to. If it ignores the
 * signal, that is its right — Argos does not escalate. Escalation is how a "close
 * this" becomes data loss.
 */
export async function takeoverSession(
  sourceId: string,
  sessionId: string,
  expectedPid: number
): Promise<TakeoverResult> {
  const src = (await getSources()).find((s) => s.id === sourceId)
  if (!src) return { ok: false, error: 'not-found' }

  // Re-read rather than trusting anything the renderer holds: between the render and
  // the click the session may have exited, restarted under a new pid, or been taken
  // over from somewhere else.
  const entry =
    readEntries(registryDir(src.projectsDir))
      .map(parseRegistryEntry)
      .find((e): e is NonNullable<typeof e> => !!e && e.sessionId === sessionId) ?? null
  if (!entry) return { ok: false, error: 'not-found' }

  // Run the guards once with no identity first. Every refusal except `unverifiable`
  // is reachable without knowing anything about the live process, so this decides
  // whether the identity read happens at all — a foreign pid must never be probed,
  // and spawning a PowerShell to ask about a number in someone else's PID space is
  // both pointless and the first step of the mistake these guards exist to prevent.
  //
  // With `identity` null the verdict can never be `ok`, so `unverifiable` is exactly
  // "everything checkable so far has passed"; that is the one case worth paying for.
  const preflight = verifyTakeover(entry, expectedPid, ourPidDomain(), null)
  if (!preflight.ok && preflight.error !== 'unverifiable') return preflight

  const identity = await readProcessIdentity(entry.pid)
  const verdict = verifyTakeover(entry, expectedPid, ourPidDomain(), identity)
  if (!verdict.ok) return verdict

  try {
    process.kill(verdict.pid, 'SIGTERM')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ESRCH here means it exited in the moment between verification and signal —
    // the outcome the caller wanted, reached without us.
    if (code === 'ESRCH') return { ok: true, pid: verdict.pid }
    return { ok: false, error: 'failed', detail: (e as Error).message }
  }
  return { ok: true, pid: verdict.pid }
}
