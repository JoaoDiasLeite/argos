import { execFile } from 'child_process'
import { listLiveSessions } from './live-sessions'
import { localTerminalPids } from './terminal'
import { parsePidPairs, pickAdopted, type AdoptionCandidate } from './session-adoption-pure'

/**
 * Work out which live `claude` each of these chat terminals is running, for the chats
 * whose own session id names no live process.
 *
 * Read-only from end to end: one process-table read, then arithmetic on pid numbers.
 * Nothing here signals, starts or stops anything — the worst a wrong answer can do is
 * point a chat at the wrong transcript, which is why `pickAdopted` refuses to guess.
 *
 * Called only when there is something to resolve (see the renderer's adoption effect),
 * because the process-table read costs a PowerShell spawn and this must never become a
 * per-tick cost of having a terminal open.
 */

/** Long enough for a cold PowerShell start, short enough not to stack up behind a poll. */
const TIMEOUT_MS = 5000

/**
 * pid → ppid for every process on this machine.
 *
 * One spawn for the whole table rather than one per candidate: the walk needs arbitrary
 * parents, and asking about them one at a time would be a spawn per level per chat.
 */
function readProcessTable(): Promise<Map<number, number>> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ([
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation'
          ]
        ] as const)
      : (['ps', ['-eo', 'pid=,ppid=']] as const)

  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // A timeout, a missing `ps`, a locked-down PowerShell: all mean the same thing to
      // the caller — nothing gets adopted this round, and the chat keeps the id it has.
      if (err) return resolve(new Map())
      resolve(parsePidPairs(String(stdout)))
    })
  })
}

/**
 * For each terminal id, the session id of the `claude` running under it — omitted when
 * there is nothing to adopt, or nothing that can be told apart.
 *
 * Local shells only. `localTerminalPids` drops WSL and SSH terminals, whose CLI runs in
 * a PID space this machine's process table says nothing about: a pid number matching
 * there would be a coincidence, not a relationship.
 */
export async function adoptTerminalSessions(terminalIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!Array.isArray(terminalIds) || !terminalIds.length) return out

  const ptyPids = localTerminalPids(terminalIds)
  if (!ptyPids.size) return out

  // Same list the sidebar's running dot reads, so an adopted id is an id that list can
  // actually match. Foreign rows are dropped for the same reason WSL terminals are:
  // their pids are not numbers in this process table.
  const live = await listLiveSessions()
  const candidates: AdoptionCandidate[] = live
    .filter((l) => !l.foreign)
    .map((l) => ({ sessionId: l.sessionId, pid: l.pid }))
  if (!candidates.length) return out

  const parentOf = await readProcessTable()
  if (!parentOf.size) return out

  for (const [terminalId, ptyPid] of ptyPids) {
    const sessionId = pickAdopted(candidates, ptyPid, parentOf)
    if (sessionId) out[terminalId] = sessionId
  }
  return out
}
