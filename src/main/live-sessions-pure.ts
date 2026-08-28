/**
 * The decisions behind reading Claude Code's live-session registry, with nothing that
 * touches the disk: what counts as a usable registry entry, and whether an entry's
 * `pid` is a number in *this* process's PID space.
 *
 * Split out because this is the half worth testing. The reading half is a directory
 * listing and a `readJsonFile`; the judgement is here, and every rule below is a case
 * that taken wrongly either hides a live session or — in round 2, which signals these
 * same records — points a terminate at an unrelated process.
 *
 * The registry lives at `<claude-root>/sessions/`, a sibling of the `projects/`
 * directory this app already reads, and holds one `<pid>.json` per live session.
 */

/** One registry file's contents, validated into something safe to act on. */
export interface RegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  name: string
  status: 'busy' | 'idle' | 'unknown'
  kind: string
  version?: string
  startedAt: number
  updatedAt: number
  /**
   * The process's start time, exactly as the registry wrote it — a Windows FILETIME
   * as an 18-digit decimal string, or `''` when the entry carries none.
   *
   * Kept unparsed on purpose. It is compared as a string against a value read the
   * same way, and `Number('134324039312837109')` loses the low digits to the float53
   * ceiling — which turns the PID-reuse guard from exact into "close enough", the one
   * thing it must never be.
   */
  procStart: string
  /** Which PID space `pid` belongs to, e.g. `win32:joao-leite`. */
  pidDomain: string
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function optionalString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function finiteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Parse one registry file's parsed JSON. Returns null for anything that is not a
 * usable entry.
 *
 * This rejects rather than coerces, because a coerced field here is a guess that
 * later code cannot tell apart from a fact:
 *
 * - `pid` must be a positive safe integer. A `pid` of 0 or -1 is a process-group
 *   wildcard to `process.kill`, and a non-integer is not a process at all.
 * - `sessionId` must be a non-empty string. It is how a row is matched to its
 *   transcript and how the UI hides "resume" over a conversation that is already
 *   live; an empty one would match every session that has none.
 * - `pidDomain` must be a non-empty string, and a missing one is a **rejection**, not
 *   a permissive default. An entry that will not say which PID space it belongs to is
 *   exactly the one that must never be signalled, and defaulting it to ours would
 *   quietly promote "unknown" to "mine".
 *
 * `procStart` is *not* a rejection: an entry without one is still worth listing, it is
 * only not safe to signal. It becomes `''`, and round 2 reads that as "this record
 * carries no reuse guard, so refuse" rather than as a guard that happens to match.
 *
 * The soft fields are the ones where a blank is honest: a missing `cwd` or `name`
 * becomes `''` and the UI shows nothing, and a missing or unrecognised `status`
 * becomes `'unknown'` — never `'idle'`, because "it has not said" and "it says it is
 * doing nothing" would otherwise read identically to someone deciding whether to
 * interrupt it. `status` is genuinely absent for some live entries on this machine.
 */
export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  const pid = r.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null

  const sessionId = nonEmptyString(r.sessionId)
  if (!sessionId) return null

  const pidDomain = nonEmptyString(r.pidDomain)
  if (!pidDomain) return null

  const rawStatus = r.status
  const status: RegistryEntry['status'] =
    rawStatus === 'busy' || rawStatus === 'idle' ? rawStatus : 'unknown'

  return {
    pid,
    sessionId,
    cwd: optionalString(r.cwd),
    name: optionalString(r.name),
    status,
    kind: optionalString(r.kind),
    version: typeof r.version === 'string' && r.version.length > 0 ? r.version : undefined,
    startedAt: finiteNumber(r.startedAt),
    updatedAt: finiteNumber(r.updatedAt),
    procStart: optionalString(r.procStart),
    pidDomain
  }
}

/**
 * This process's own PID domain, given its platform and the machine identity the
 * registry names.
 *
 * The shape matches the observed `win32:joao-leite`, and the identity half is
 * lower-cased — that is how the value on disk is written, and comparing an
 * as-reported identity against it would otherwise fail on nothing but case.
 *
 * Note on which identity: on this Windows machine the observed second half is the
 * *machine* name (`os.hostname()` → `JOAO-LEITE`), not the account name
 * (`os.userInfo().username` → `JoãoLeite`). The caller decides what to pass; this
 * function only fixes the shape.
 */
export function pidDomainFor(platform: string, username: string): string {
  return `${platform}:${username.toLowerCase()}`
}

/**
 * Whether an entry's pid is a number in THIS process's PID space.
 *
 * Plain equality, case-insensitively — and deliberately nothing cleverer, because the
 * stakes are one-sided. A pid from another domain (a WSL distro's, another user's on
 * another host) names an *unrelated* local process, or nothing at all. Treating "I
 * could not tell" as a match is the worst mistake this feature could make: it is how
 * a liveness probe reports a stranger's process as a live Claude session, and how
 * round 2's terminate lands on it.
 *
 * So an empty or absent domain on either side is never a match, and the only `true`
 * this returns is for two domains that actually say the same thing.
 */
export function isSameDomain(entryDomain: string, ourDomain: string): boolean {
  if (!entryDomain || !ourDomain) return false
  return entryDomain.toLowerCase() === ourDomain.toLowerCase()
}
