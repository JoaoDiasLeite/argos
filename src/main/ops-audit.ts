/**
 * The ops audit ledger on disk (docs/OPS_AGENT_PLAN.md §5): `<dir>/YYYY-MM-DD.jsonl`, one
 * file per UTC day, one event per line, each line chained to the previous by sha256
 * (format in ops-audit-pure.ts). No electron: the caller passes the directory
 * (`userData/ops-audit` in the app), so this is tested on a real temp folder.
 *
 * One writer per ledger. Appends go through a promise chain, so lines land in call
 * order and each `prev` is the line written just before it. The previous line is read
 * from the file's tail once, at first use and after a day change, then kept in memory.
 */
import { promises as fsp } from 'fs'
import * as path from 'path'
import { buildLine, parseLedger, runEvents, summarizeRun, verifyChain } from './ops-audit-pure'
import { clientReportWarnings, renderClientReport, renderInternalReport } from './ops-report-pure'
import type { OpsAuditEvent, OpsAuditLine, OpsHostRef } from './ops-types'

export interface OpsLedger {
  append(event: OpsAuditEvent, at?: Date): Promise<{ ok: true; raw: string } | { ok: false; error: string }>
  /**
   * All lines of this run. Looks in the day of `around` (default now) and the day before,
   * since a run that crosses midnight continues in the next file; when neither has the
   * run, every file is searched, so an old run's report still renders.
   */
  readRun(runId: string, around?: Date): Promise<{ ok: true; lines: OpsAuditLine[] } | { ok: false; error: string }>
  /**
   * Every line of every run of one chat (`run.start.appSessionId`), in file order, for a
   * reopened chat's timeline. Scans the newest SESSION_SCAN_FILES day files only.
   */
  readSession(appSessionId: string): Promise<{ ok: true; lines: OpsAuditLine[] } | { ok: false; error: string }>
  report(
    runId: string,
    kind: 'internal' | 'client',
    opts?: { hostGroups: Record<string, string[]>; hosts: OpsHostRef[] }
  ): Promise<{ ok: true; markdown: string; warnings: string[] } | { ok: false; error: string }>
  verify(date: string): Promise<{ ok: true; lines: number } | { ok: false; brokenAt?: number; reason: string }>
  info(): Promise<{ dir: string; files: number; bytes: number }>
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TAIL_CHUNK = 64 * 1024
/** How many day files readSession looks through, newest first. */
export const SESSION_SCAN_FILES = 30

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const dayOf = (at: Date): string => at.toISOString().slice(0, 10)
const dayBefore = (date: string): string => dayOf(new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000))
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * The last non-blank complete line of a file, read backwards in chunks so a large day
 * file is not loaded whole on startup. `partial` is true when the file ends without a
 * newline: an append was interrupted, and the next line must start on a fresh line.
 */
async function readTail(file: string): Promise<{ last: string | null; partial: boolean }> {
  let fh: fsp.FileHandle
  try {
    fh = await fsp.open(file, 'r')
  } catch (e) {
    if (isMissing(e)) return { last: null, partial: false }
    throw e
  }
  try {
    const size = (await fh.stat()).size
    let pos = size
    let acc = Buffer.alloc(0)
    while (pos > 0) {
      const n = Math.min(TAIL_CHUNK, pos)
      pos -= n
      const chunk = Buffer.alloc(n)
      await fh.read(chunk, 0, n, pos)
      acc = Buffer.concat([chunk, acc])
      const segments = acc.toString('utf-8').split('\n')
      const tail = segments.pop() as string
      // Before the start of the file the first segment may be cut mid-line (or mid-character).
      if (pos > 0) segments.shift()
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].trim() !== '') return { last: segments[i], partial: tail !== '' }
      }
      if (pos === 0) return { last: null, partial: tail !== '' }
    }
    return { last: null, partial: false }
  } finally {
    await fh.close()
  }
}

export function createLedger(dir: string): OpsLedger {
  const fileFor = (date: string): string => path.join(dir, `${date}.jsonl`)
  let queue: Promise<unknown> = Promise.resolve()
  let state: { date: string; prevRaw: string | null; needsNewline: boolean } | null = null

  /** Runs after every append queued so far, so a read sees all of them. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function doAppend(event: OpsAuditEvent, at: Date): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
    try {
      const date = dayOf(at)
      if (!state || state.date !== date) {
        await fsp.mkdir(dir, { recursive: true })
        const tail = await readTail(fileFor(date))
        state = { date, prevRaw: tail.last, needsNewline: tail.partial }
      }
      const { raw } = buildLine(state.prevRaw, event, at)
      // A cut-off last line stays in the file as evidence (verify reports it); we only make
      // sure our line does not fuse with it.
      await fsp.appendFile(fileFor(date), (state.needsNewline ? '\n' : '') + raw + '\n', { flag: 'a' })
      state.prevRaw = raw
      state.needsNewline = false
      return { ok: true, raw }
    } catch (e) {
      // We no longer know what the file ends with; read the tail again next time.
      state = null
      return { ok: false, error: `Could not append to the ops ledger: ${message(e)}` }
    }
  }

  async function readDay(date: string): Promise<OpsAuditLine[]> {
    try {
      return parseLedger(await fsp.readFile(fileFor(date), 'utf-8')).lines
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }

  async function dayFiles(): Promise<string[]> {
    try {
      return (await fsp.readdir(dir)).filter((f) => DAY_FILE.test(f)).sort()
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }

  async function readRun(
    runId: string,
    around = new Date()
  ): Promise<{ ok: true; lines: OpsAuditLine[] } | { ok: false; error: string }> {
    return enqueue(async () => {
      try {
        const today = dayOf(around)
        const near = [dayBefore(today), today]
        let lines: OpsAuditLine[] = []
        for (const d of near) lines.push(...runEvents(await readDay(d), runId))
        if (lines.length === 0) {
          lines = []
          for (const f of await dayFiles()) {
            const d = f.slice(0, 10)
            if (!near.includes(d)) lines.push(...runEvents(await readDay(d), runId))
          }
        }
        return { ok: true as const, lines }
      } catch (e) {
        return { ok: false as const, error: `Could not read the ops ledger: ${message(e)}` }
      }
    })
  }

  return {
    append(event, at = new Date()) {
      return enqueue(() => doAppend(event, at))
    },

    readRun,

    readSession(appSessionId) {
      return enqueue(async () => {
        try {
          // Newest first, so the cap keeps the recent days; a run that crossed midnight
          // has its start in an older file than its end, so every scanned file is kept
          // until the run ids are known.
          const files = (await dayFiles()).reverse().slice(0, SESSION_SCAN_FILES).reverse()
          const days: OpsAuditLine[][] = []
          const runIds = new Set<string>()
          for (const f of files) {
            const day = await readDay(f.slice(0, 10))
            days.push(day)
            for (const l of day) {
              if (l.event.kind === 'run.start' && l.event.appSessionId === appSessionId) runIds.add(l.event.runId)
            }
          }
          const lines = runIds.size === 0 ? [] : days.flat().filter((l) => runIds.has(l.event.runId))
          return { ok: true as const, lines }
        } catch (e) {
          return { ok: false as const, error: `Could not read the ops ledger: ${message(e)}` }
        }
      })
    },

    async report(runId, kind, opts) {
      const r = await readRun(runId)
      if (!r.ok) return r
      const summary = summarizeRun(r.lines, runId)
      if (!summary) return { ok: false, error: `No run.start for run ${runId} in the ledger.` }
      const warnings = clientReportWarnings(summary)
      if (kind === 'internal') return { ok: true, markdown: renderInternalReport(summary), warnings }
      // Without the policy's groups the hosts still get sanitised, as plain "[servidor]".
      const clientOpts = opts ?? { hostGroups: {}, hosts: summary.hosts }
      return { ok: true, markdown: renderClientReport(summary, clientOpts), warnings }
    },

    verify(date) {
      return enqueue(async () => {
        if (!DATE.test(date)) return { ok: false as const, reason: `Not a YYYY-MM-DD date: ${date}` }
        try {
          return verifyChain(await fsp.readFile(fileFor(date), 'utf-8'))
        } catch (e) {
          if (isMissing(e)) return { ok: false as const, reason: `No ledger file for ${date}.` }
          return { ok: false as const, reason: `Could not read the ledger for ${date}: ${message(e)}` }
        }
      })
    },

    async info() {
      let files = 0
      let bytes = 0
      try {
        for (const f of await dayFiles()) {
          const st = await fsp.stat(path.join(dir, f)).catch(() => null)
          if (!st) continue
          files++
          bytes += st.size
        }
      } catch {
        // An unreadable folder reports as empty; Settings shows the path either way.
      }
      return { dir, files, bytes }
    }
  }
}
