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
import {
  buildLine,
  IMPORT_MANIFEST,
  IMPORTED_DIR,
  parseImportManifest,
  parseLedger,
  serializeImportManifest,
  sha256Hex,
  verifyDay,
  runEvents,
  runListItem,
  runTouchesHost,
  summarizeRun,
  type OpsLinkedRun,
  type OpsRunListItem,
  type OpsRunSummary,
  type OpsVerifyResult
} from './ops-audit-pure'
import { renderHandover } from './ops-handover-pure'
import { foldNotes, runHeadline } from './ops-notes-pure'
import {
  clientReportWarnings,
  hostSyslogWarnings,
  renderClientReport,
  renderInternalReport,
  type ClientReportOptions
} from './ops-report-pure'
import type { OpsAuditEvent, OpsAuditLine } from './ops-types'
import { makeT, type TFunction } from '../shared/i18n'

/** internal: ours, in English; client: the sanitised Relatório Técnico; handover: our pt-PT incident file. */
export type OpsReportKind = 'internal' | 'client' | 'handover'

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
  /**
   * Run summaries for the history list, newest first: every run that starts in the newest
   * SESSION_SCAN_FILES day files, only those about `hostId` when given, at most `limit`.
   */
  listRuns(opts?: { hostId?: string; limit?: number }): Promise<{ ok: true; runs: OpsRunListItem[] } | { ok: false; error: string }>
  report(
    runId: string,
    kind: OpsReportKind,
    opts?: ClientReportOptions
  ): Promise<{ ok: true; markdown: string; warnings: string[] } | { ok: false; error: string }>
  /**
   * The day's hash chain. A day imported from a profile archive is checked too but comes
   * back marked `imported`: consistent, origin not verifiable. With `runId`, only the file
   * that holds that run is checked when the day has both.
   */
  verify(date: string, runId?: string): Promise<OpsVerifyResult>
  info(): Promise<{ dir: string; files: number; bytes: number }>
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TAIL_CHUNK = 64 * 1024
/** How many day files readSession and listRuns look through, newest first. */
export const SESSION_SCAN_FILES = 30
/** listRuns' default and ceiling for `limit`. */
export const RUN_LIST_DEFAULT = 50
export const RUN_LIST_MAX = 500

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const dayOf = (at: Date): string => at.toISOString().slice(0, 10)
const dayBefore = (date: string): string => dayOf(new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000))
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/** A file's text, or null when it does not exist. */
async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8')
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
}

/**
 * Put one day file from a profile archive into `<dir>/imported/` and note it in the
 * manifest. Never overwrites or merges: a day this machine already has (locally or from an
 * earlier import) is left as it is. 'same' when the existing file is byte-identical, so a
 * re-import of one's own export is not reported; 'conflict' when it differs.
 */
export async function importLedgerDay(
  dir: string,
  date: string,
  text: string,
  archive: string,
  at = new Date()
): Promise<'imported' | 'same' | 'conflict'> {
  if (!DATE.test(date)) throw new Error(`not a ledger day: ${date}`)
  const local = await readIfExists(path.join(dir, `${date}.jsonl`))
  if (local !== null) return local === text ? 'same' : 'conflict'
  const importedDir = path.join(dir, IMPORTED_DIR)
  await fsp.mkdir(importedDir, { recursive: true })
  try {
    await fsp.writeFile(path.join(importedDir, `${date}.jsonl`), text, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
    return (await readIfExists(path.join(importedDir, `${date}.jsonl`))) === text ? 'same' : 'conflict'
  }
  const manifestFile = path.join(importedDir, IMPORT_MANIFEST)
  const manifest = parseImportManifest(await readIfExists(manifestFile))
  manifest[date] = { importedAt: at.toISOString(), archive, sha256: sha256Hex(text) }
  const tmp = `${manifestFile}.tmp`
  await fsp.writeFile(tmp, serializeImportManifest(manifest), 'utf-8')
  await fsp.rename(tmp, manifestFile)
  return 'imported'
}

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

/**
 * `t` words the errors and reasons handed back to the screen (absent: English). The
 * ledger's own lines are never translated.
 */
export function createLedger(dir: string, t: TFunction = makeT('en')): OpsLedger {
  const fileFor = (date: string): string => path.join(dir, `${date}.jsonl`)
  // Imported days: read with the rest, never appended to (doAppend only knows fileFor).
  const importedFor = (date: string): string => path.join(dir, IMPORTED_DIR, `${date}.jsonl`)
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
      return { ok: false, error: t('runbook.audit.appendFailed', { error: message(e) }) }
    }
  }

  /** A day's lines: the imported file's, then the local one's. A run lives in one of them. */
  async function readDay(date: string): Promise<OpsAuditLine[]> {
    const lines: OpsAuditLine[] = []
    for (const file of [importedFor(date), fileFor(date)]) {
      const text = await readIfExists(file)
      if (text !== null) lines.push(...parseLedger(text).lines)
    }
    return lines
  }

  async function dayNames(folder: string): Promise<string[]> {
    try {
      return (await fsp.readdir(folder)).filter((f) => DAY_FILE.test(f))
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }

  /** Every day with a local or an imported file, once, oldest first. */
  async function dayFiles(): Promise<string[]> {
    const names = new Set([...(await dayNames(dir)), ...(await dayNames(path.join(dir, IMPORTED_DIR)))])
    return [...names].sort()
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
        return { ok: false as const, error: t('runbook.audit.readFailed', { error: message(e) }) }
      }
    })
  }

  /** The day and task of each run `s` resumed or was related to; one that cannot be read is left out. */
  async function linkedRunsOf(s: OpsRunSummary): Promise<OpsLinkedRun[]> {
    const ids = [...new Set([...(s.resumesRunId ? [s.resumesRunId] : []), ...(s.relatedRunIds ?? [])])]
    const out: OpsLinkedRun[] = []
    for (const id of ids) {
      const r = await readRun(id, new Date(s.startedAt))
      const start = r.ok ? r.lines.find((l) => l.event.kind === 'run.start') : undefined
      if (start?.event.kind !== 'run.start') continue
      out.push({ runId: id, startedAt: start.at, ...(start.event.task ? { task: start.event.task } : {}) })
    }
    return out
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
          return { ok: false as const, error: t('runbook.audit.readFailed', { error: message(e) }) }
        }
      })
    },

    listRuns(opts = {}) {
      return enqueue(async () => {
        try {
          const limit =
            typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
              ? Math.min(Math.floor(opts.limit), RUN_LIST_MAX)
              : RUN_LIST_DEFAULT
          const files = (await dayFiles()).reverse().slice(0, SESSION_SCAN_FILES).reverse()
          // One pass groups the lines by run, so each run is folded from its own lines only.
          const byRun = new Map<string, OpsAuditLine[]>()
          const starts: { runId: string; appSessionId: string }[] = []
          for (const f of files) {
            for (const l of await readDay(f.slice(0, 10))) {
              const id = l.event.runId
              let group = byRun.get(id)
              if (!group) byRun.set(id, (group = []))
              group.push(l)
              if (l.event.kind === 'run.start') starts.push({ runId: id, appSessionId: l.event.appSessionId })
            }
          }
          const runs: OpsRunListItem[] = []
          for (const { runId, appSessionId } of starts) {
            const s = summarizeRun(byRun.get(runId) ?? [], runId)
            if (!s) continue
            if (opts.hostId !== undefined && !runTouchesHost(s, opts.hostId)) continue
            const f = foldNotes(byRun.get(runId) ?? [], runId)
            const headline = runHeadline(f)
            runs.push(runListItem(s, appSessionId, { ...(headline ? { headline } : {}), findings: f.findings.length, hypotheses: f.hypotheses.length, openHypotheses: f.hypotheses.filter((h) => h.status === 'open').length }))
          }
          runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
          return { ok: true as const, runs: runs.slice(0, limit) }
        } catch (e) {
          return { ok: false as const, error: t('runbook.audit.readFailed', { error: message(e) }) }
        }
      })
    },

    async report(runId, kind, opts) {
      const r = await readRun(runId)
      if (!r.ok) return r
      const summary = summarizeRun(r.lines, runId)
      if (!summary) return { ok: false, error: t('runbook.audit.noRunStart', { runId }) }
      const warnings = [...hostSyslogWarnings(summary), ...clientReportWarnings(summary)]
      if (kind === 'internal') return { ok: true, markdown: renderInternalReport(summary), warnings }
      // The pt-PT reports name earlier runs by day and task, which only those runs' own
      // starts hold. Unless the caller already looked them up, read them here.
      const linkedRuns = opts?.linkedRuns ?? (await linkedRunsOf(summary))
      // The handover is ours, not the client's: only the syslog warnings concern it.
      if (kind === 'handover') {
        return { ok: true, markdown: renderHandover(summary, r.lines, { hostGroups: {}, hosts: [], ...opts, linkedRuns }), warnings: hostSyslogWarnings(summary) }
      }
      // Without the policy's groups the hosts still get sanitised, as plain "[servidor]".
      const clientOpts = { ...(opts ?? { hostGroups: {}, hosts: summary.hosts }), linkedRuns }
      return { ok: true, markdown: renderClientReport(summary, clientOpts), warnings }
    },

    verify(date, runId) {
      return enqueue(async (): Promise<OpsVerifyResult> => {
        if (!DATE.test(date)) return { ok: false as const, reason: t('runbook.audit.badDate', { date }) }
        try {
          // No file is no entries, not a broken chain: the day simply has not been written to.
          let local = await readIfExists(fileFor(date))
          let imported = await readIfExists(importedFor(date))
          if (runId && local !== null && imported !== null) {
            const has = (text: string): boolean => parseLedger(text).lines.some((l) => l.event.runId === runId)
            if (has(local)) imported = null
            else if (has(imported)) local = null
          }
          const entry = imported === null ? undefined : parseImportManifest(await readIfExists(path.join(dir, IMPORTED_DIR, IMPORT_MANIFEST)))[date]
          return verifyDay(local, imported, entry)
        } catch (e) {
          return { ok: false as const, reason: t('runbook.audit.readDayFailed', { date, error: message(e) }) }
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
