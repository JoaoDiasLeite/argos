import { execFile } from 'child_process'
import { ProcessIdentity } from './takeover-pure'

/**
 * What the operating system says about the process holding a pid right now.
 *
 * Only ever used to *refuse* things. Every failure path returns null, and null is
 * read by `verifyTakeover` as "unverifiable" — a refusal, never permission. That is
 * the whole contract: this module cannot authorise anything, it can only fail to
 * rule something out.
 *
 * Windows-only by design. `Get-Process` gives both facts in one call, and the start
 * time it reports is the same FILETIME the session registry records — verified
 * digit-for-digit against a live session. On any other platform this returns null,
 * so the takeover refuses rather than proceeding with one guard missing. That is not
 * a gap to fill in later without thought: the reuse guard has to be exact on
 * whatever platform it runs, and "good enough" is the failure mode it exists to
 * prevent.
 */

/** Long enough for a cold PowerShell start, short enough that the UI is not left hanging. */
const TIMEOUT_MS = 5000

export function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null)

  // The pid is interpolated only after the integer check above, and PowerShell is
  // invoked through execFile with an argument array — there is no shell to quote for.
  const script = `$ErrorActionPreference='Stop'; $p = Get-Process -Id ${pid}; "$($p.ProcessName)|$($p.StartTime.ToFileTime())"`

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        // A missing pid throws in PowerShell and lands here. So does a timeout, and
        // an access error. All three mean the same thing to the caller: we could not
        // establish what this process is, so it must not be signalled.
        if (err) return resolve(null)
        const [name, procStart] = String(stdout).trim().split('|')
        if (!name || !procStart || !/^\d+$/.test(procStart)) return resolve(null)
        resolve({ name, procStart })
      }
    )
  })
}
