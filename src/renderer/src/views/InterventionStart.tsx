import { useEffect, useId, useMemo, useState } from 'react'
import { rich } from '../lib/t-rich'
import type { ReactNode } from 'react'
import type { OpsIntervention, OpsRunbookInfo, OpsRunListItem, OpsScope, SshHostPublic } from '../types'
import { writeLastRunbook } from '../lib/runbook-library'
import { readOnBase, writeOnBase } from '../lib/runbook-on-base'
import { samePath, useBaseRunbook, useBuiltinRunbook } from '../lib/builtin-runbook'
import OpsReportSheet from '../components/OpsReportSheet'
import { interventionLabel } from '../lib/intervention-label'
import { runNotes, runStatus } from '../lib/ops-run-status'
import { chainIsEmpty, chainsOf, type RunChain } from '../lib/ops-chains'
import { IvsDropdown, RunbookField, runbookHostProblem, useRunbookPicker, type InfoState } from '../components/RunbookPicker'
import { plural, type TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import './InterventionStart.css'

/**
 * Servers → Ops: the start of an intervention (docs/INTERVENTIONS_PLAN.md §4, wireframe B).
 * The servers are a rail on the left, each with its latest intervention; the right pane is
 * the chosen server: what a diagnosis (or the chosen runbook) allows in one line, the way to
 * start, and the server's history as a timeline where a resumed run joins the one it resumed.
 *
 * Runbooks are the runbooks folder of Settings (every subfolder that looks like one) and the
 * loose runbooks picked one by one, rescanned and re-read on mount: a runbook is a folder
 * someone edits, and a policy that stopped validating is exactly what must show here.
 *
 * The mode comes first: despiste (the read-only runbook shipped with Argos) is always the
 * default and is not remembered; an intervention with a runbook is chosen on purpose.
 */

const LAST_CLIENT_KEY = 'ops.lastClient'
/** Every run is fetched once; the rail groups them by server, the history shows the newest. */
const RUNS_FETCHED = 200
const HISTORY_LIMIT = 15
/** Rows of the Recent table on the start screen when no server is picked. */
/** Recent shows this many chains until "Show more" is pressed. */
const RECENT_LIMIT = 6

/** Task, ticket and client are hidden for now (2026-11-03): the operator says what is wrong
 *  in the terminal. Flip to bring the three fields back; everything behind them still works. */
const SHOW_DETAILS = false

// The history row's actions, as 14 px line icons (their names are in the tooltips).
const ICON_RESUME = ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5']
const ICON_REFER = ['M9 17H7A5 5 0 0 1 7 7h2', 'M15 7h2a5 5 0 1 1 0 10h-2', 'M8 12h8']
const ICON_REPORT = ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8']

function RunIcon({ d }: { d: string[] }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  )
}
/** The most earlier interventions a new one can be related to. */
const MAX_RELATED = 5

type DotState = 'checking' | 'ok' | 'error'
/** A stored host's id, or `null` until one is chosen. Every new intervention is on one
 *  server: the open scope ("any server this runbook allows") was taken off the screen
 *  (2026-11-03); resuming an older open run still works through main. */
type ServerChoice = string | null
/** Despiste (read-only, built in), the base intervention (built in, changes through Jarvis)
 *  or a runbook from the runbooks folder (docs/BASE_INTERVENTION_PLAN.md §4). */
type Mode = 'despiste' | 'base' | 'runbook'
const MODES: Mode[] = ['despiste', 'base', 'runbook']

/**
 * The names the built-in runbook's runs carry in the ledger: its folder name, and the one
 * it had before 2.9.0 shipped (`despiste`), so runs from then still map to it.
 */
const BUILTIN_NAMES = ['diagnosis', 'despiste']
/** The folder name of the base intervention's runs in the ledger. */
const BASE_NAME = 'intervention'

/** A pre-rename path of the built-in runbook, as an older run recorded it. */
const OLD_BUILTIN_PATH_RE = /[\\/]resources[\\/]runbooks[\\/]despiste[\\/]?$/i

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const hostAddress = (h: SshHostPublic) => `${h.username}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`

function readLastClient(): string {
  try {
    return localStorage.getItem(LAST_CLIENT_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeLastClient(client: string) {
  try {
    if (client) localStorage.setItem(LAST_CLIENT_KEY, client)
  } catch {
    /* storage unavailable: the client just isn't remembered */
  }
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: ReactNode[], t: TFunction): ReactNode[] {
  const out: ReactNode[] = []
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? t('ops.start.and') : ', ')
    out.push(item)
  })
  return out
}

function withStop(s: string): string {
  const t = s.trim()
  return /[.!?…:]$/.test(t) ? t : `${t}.`
}

function clock(iso: string, locale?: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function runWhen(iso: string, t: TFunction, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = clock(iso, locale)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff === 0) return t('ops.start.today', { time })
  if (diff === 1) return t('ops.start.yesterday')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

/** The timeline's dot: green for a run that finished, red for one that failed, grey otherwise
 *  (a stop is the operator's choice, not a failure). */
function dotTone(r: OpsRunListItem): 'ok' | 'bad' | 'muted' {
  // A stopped run is logged ok: false and aborted: true; the stop comes first.
  if (r.aborted) return 'muted'
  if (r.ok === false) return 'bad'
  if (r.ok === true) return 'ok'
  return 'muted'
}

/** Whether a run was about this host: its locked host, or (open and older runs) by name. */
function runOnHost(r: OpsRunListItem, h: SshHostPublic): boolean {
  if (r.scope?.kind === 'host') return r.scope.hostId === h.id
  return r.hostNames.includes(h.name)
}

interface TimelineRow {
  run: OpsRunListItem
  /** The run that resumed this one, when it is on the list. */
  resumedBy?: OpsRunListItem
  lineTop: boolean
  lineBottom: boolean
}

/**
 * Newest first, with the runs of one resume chain (A, then the run that resumed A, ...)
 * next to each other, newest of the chain on top, so a connector can join them.
 */
function buildTimeline(runs: OpsRunListItem[]): TimelineRow[] {
  return chainsOf(runs).flatMap(({ runs: chain }) =>
    chain.map((run, i) => ({ run, resumedBy: chain[i - 1], lineTop: i > 0, lineBottom: i < chain.length - 1 }))
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 4v16l13-8z" />
  </svg>
)
const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)
const ShieldIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)
const ChevronIcon = ({ className }: { className?: string }) => (
  <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

// ── The screen ───────────────────────────────────────────────────────────────

/** An intervention of this app run whose CLI is running, as the server rail shows it. */
export interface LiveIntervention {
  hostId: string
  /** Its task, or the server and mode as its tab names it. */
  title: string
  /** Back to its workspace. */
  open: () => void
}

interface Props {
  /** Preselects this SSH host (the Ops button on a Remote & WSL row). */
  initialHostId?: string
  onStart: (intervention: OpsIntervention) => void
  /** "Retomar" on a past run: open its intervention again as a new run that continues it. */
  onResume: (intervention: OpsIntervention) => void
  /** Interventions running on an SSH host right now (the LIVE badge and banner). */
  live?: LiveIntervention[]
  /** Where SSH hosts are managed (Remote & WSL). */
  onAddHost?: () => void
}

export default function InterventionStart({ initialHostId, onStart, onResume, live = [], onAddHost }: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [hosts, setHosts] = useState<SshHostPublic[] | null>(null)
  const [dots, setDots] = useState<Record<string, DotState>>({})
  const [server, setServer] = useState<ServerChoice>(initialHostId ?? null)

  /** Despiste on every mount, by decision: an intervention with a runbook is picked on purpose. */
  const [mode, setMode] = useState<Mode>('despiste')
  const [allowsOpen, setAllowsOpen] = useState(false)
  const builtin = useBuiltinRunbook()

  /** The runbooks folder, the loose runbooks and the runbook-mode choice. The choice survives
   *  a detour through despiste, and never holds the built-in path from a list. */
  const picker = useRunbookPicker({
    active: mode === 'runbook',
    hostId: server ?? undefined,
    builtin
  })
  const { listed, infos, runbookPath, loadRunbook } = picker
  const baseDir = useBaseRunbook()
  /** What the intervention starts with: a built-in runbook, or the runbook picked. */
  const activePath = mode === 'despiste' ? builtin : mode === 'base' ? baseDir : runbookPath

  /** "Somar à base" for the runbook picked: on by default, remembered per folder. Flipping
   *  it re-renders, and the stored choice is read again. */
  const [, setOnBaseFlips] = useState(0)
  const onBase = mode === 'runbook' && !!runbookPath && readOnBase(runbookPath)
  const setOnBase = (on: boolean) => {
    if (!runbookPath) return
    writeOnBase(runbookPath, on)
    setOnBaseFlips((n) => n + 1)
  }
  /** The picked runbook as it runs added to the base: what the panel shows and the start
   *  checks, since the hosts and the rules are those of the merge. */
  const [mergedInfos, setMergedInfos] = useState<Record<string, InfoState>>({})
  const ownInfo = runbookPath ? infos[runbookPath] : undefined
  useEffect(() => {
    if (!onBase || !runbookPath || !ownInfo || ownInfo === 'loading') return
    let cancelled = false
    setMergedInfos((prev) => ({ ...prev, [runbookPath]: 'loading' }))
    window.electronAPI
      .opsLoadRunbook(runbookPath, { onBase: true })
      .catch((e): OpsRunbookInfo => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => !cancelled && setMergedInfos((prev) => ({ ...prev, [runbookPath]: r })))
    return () => {
      cancelled = true
    }
    // ownInfo: the picker re-read the runbook, so the merge is read again too.
  }, [onBase, runbookPath, ownInfo])

  const [task, setTask] = useState('')
  const [ticket, setTicket] = useState('')
  const [client, setClient] = useState(readLastClient)

  const [runs, setRuns] = useState<{ ok: true; runs: OpsRunListItem[] } | { ok: false; error: string } | 'loading'>('loading')
  /** Earlier runs toggled with Refer: they go into onStart as relatedRunIds. */
  const [related, setRelated] = useState<OpsRunListItem[]>([])
  const [reportFor, setReportFor] = useState<{ runId: string; runbookPath?: string; appSessionId?: string } | null>(null)

  const runbookLabelId = useId()
  const allowsId = useId()
  const taskId = useId()
  const ticketId = useId()
  const clientId = useId()

  // Hosts, then a connection test of each so the list carries a live dot.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .sshList()
      .then((list) => {
        if (cancelled) return
        setHosts(list)
        setDots(Object.fromEntries(list.map((h) => [h.id, 'checking' as const])))
        for (const h of list) {
          window.electronAPI
            .sshTest(h.id)
            .then((res) => !cancelled && setDots((prev) => ({ ...prev, [h.id]: res.ok ? 'ok' : 'error' })))
            .catch(() => !cancelled && setDots((prev) => ({ ...prev, [h.id]: 'error' })))
        }
      })
      .catch(() => !cancelled && setHosts([]))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (builtin) void loadRunbook(builtin)
  }, [builtin, loadRunbook])
  useEffect(() => {
    if (baseDir) void loadRunbook(baseDir)
  }, [baseDir, loadRunbook])

  // Every run once: the rail's latest-per-server line and the history are both cut from it.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .opsRuns({ limit: RUNS_FETCHED })
      .then((res) => !cancelled && setRuns(res))
      .catch((e) => !cancelled && setRuns({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [])

  const scope: OpsScope | null =
    server === null ? null : { kind: 'host', hostId: server }
  const hostId = scope?.kind === 'host' ? scope.hostId : undefined
  const selectedHost = hostId ? hosts?.find((h) => h.id === hostId) : undefined

  /** The runs on the history: the chosen server's (none when no server is chosen). */
  const shownRuns = useMemo(() => {
    if (runs === 'loading' || !runs.ok || !hostId) return []
    return selectedHost ? runs.runs.filter((r) => runOnHost(r, selectedHost)) : []
  }, [runs, hostId, selectedHost])
  // A run that ended with no call and no note (a start and a stop) says nothing: such runs
  // are hidden behind one line unless asked for.
  const [showEmpty, setShowEmpty] = useState(false)
  const [showAllRecent, setShowAllRecent] = useState(false)
  const isEmptyRun = (r: OpsRunListItem): boolean => !!r.endedAt && r.calls === 0 && !r.headline && !r.findings && !r.hypotheses
  const emptyCount = useMemo(() => shownRuns.filter(isEmptyRun).length, [shownRuns])
  const timeline = useMemo(
    () => buildTimeline(showEmpty ? shownRuns : shownRuns.filter((r) => !isEmptyRun(r))).slice(0, HISTORY_LIMIT),
    [shownRuns, showEmpty]
  )

  // A run that is not on the newly chosen server's list is no longer one to refer to.
  useEffect(() => {
    const ids = new Set(shownRuns.map((r) => r.runId))
    setRelated((prev) => (prev.every((r) => ids.has(r.runId)) ? prev : prev.filter((r) => ids.has(r.runId))))
  }, [shownRuns])

  /** The latest run per server, for the rail. */
  const lastByHost = useMemo(() => {
    const out: Record<string, OpsRunListItem> = {}
    if (runs === 'loading' || !runs.ok || !hosts) return out
    for (const h of hosts) {
      const latest = runs.runs.filter((r) => runOnHost(r, h)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
      if (latest) out[h.id] = latest
    }
    return out
  }, [runs, hosts])

  /** Every run grouped into resume chains, newest first (the overview's two lists). */
  const chains = useMemo(() => (runs === 'loading' || !runs.ok ? [] : chainsOf(runs.runs)), [runs])
  const [filter, setFilter] = useState('')
  /** The Recent table's server filter: it narrows the table, it does not pick the server. */
  const [hostFilter, setHostFilter] = useState<string | null>(null)
  const filterLabelId = useId()

  const liveHere = hostId ? live.filter((l) => l.hostId === hostId) : []

  const info: InfoState | undefined = !activePath ? undefined : onBase ? mergedInfos[activePath] : infos[activePath]
  const loaded = info && info !== 'loading' ? info : undefined
  const okInfo = loaded?.ok ? loaded : undefined
  const summary = okInfo?.summary

  // ── Validation (inline) ────────────────────────────────────────────────────
  const hostProblem = runbookHostProblem(okInfo, scope, selectedHost?.name, t)

  const missing = [
    !scope && t('ops.start.needServer'),
    mode === 'runbook' && !runbookPath && t('ops.start.needRunbook')
  ].filter((m): m is string => !!m)
  // A built-in path (and a runbook's merge with the base) arrives on its own; until it has
  // loaded, it is loading.
  const blocked =
    !!hostProblem || (!!loaded && !loaded.ok) || info === 'loading' || (!!activePath && !info) || (mode !== 'runbook' && !activePath)
  const canStart = missing.length === 0 && !blocked

  const startHint = canStart
    ? t('ops.start.hintReady')
    : missing.length > 0
      ? t('ops.start.hintNeeded', {
          items: missing.length === 1
            ? missing[0]
            : t('ops.start.listAnd', { head: missing.slice(0, -1).join(', '), last: missing[missing.length - 1] })
        })
      : info === 'loading' || !info
        ? t('ops.start.hintLoading')
        : t('ops.start.hintFix')

  const start = () => {
    if (!canStart || !scope || !activePath) {
      return
    }
    // Hidden fields send nothing, not even the client remembered from the last start.
    const c = SHOW_DETAILS ? client.trim() : ''
    const tk = SHOW_DETAILS ? ticket.trim() : ''
    if (SHOW_DETAILS) writeLastClient(c)
    // The built-in runbooks are always one click away as the mode, so they are not remembered.
    if (mode === 'runbook' && !samePath(activePath, builtin) && !samePath(activePath, baseDir)) writeLastRunbook(activePath)
    onStart({
      runbookPath: activePath,
      scope,
      task: SHOW_DETAILS ? task.trim() : '',
      ...(tk ? { ticket: tk } : {}),
      ...(c ? { client: c } : {}),
      ...(related.length ? { relatedRunIds: related.map((r) => r.runId) } : {}),
      ...(onBase ? { onBase: true } : {})
    })
  }

  const openFile = (file: 'RUNBOOK.md' | 'policy.json') => {
    if (activePath) void window.electronAPI.opsOpenRunbookFile(activePath, file)
  }

  /**
   * The folder a past run belongs to, so its report can name the host roles: a listed one,
   * or the built-in runbook. A bare built-in name is the built-in one unless a listed
   * folder carries that name too.
   */
  const runbookDirFor = (r: OpsRunListItem): string | undefined => {
    if (/[\\/]/.test(r.runbook)) {
      return builtin && (samePath(r.runbook, builtin) || OLD_BUILTIN_PATH_RE.test(r.runbook)) ? builtin : r.runbook
    }
    if (BUILTIN_NAMES.includes(r.runbook) && builtin && !listed.some((d) => baseName(d) === r.runbook)) return builtin
    if (r.runbook === BASE_NAME && baseDir && !listed.some((d) => baseName(d) === r.runbook)) return baseDir
    return listed.find((d) => {
      const i = infos[d]
      return i && i !== 'loading' && i.ok && i.name === r.runbook
    })
  }

  const toggleRelated = (r: OpsRunListItem) =>
    setRelated((prev) => (prev.some((x) => x.runId === r.runId) ? prev.filter((x) => x.runId !== r.runId) : prev.length >= MAX_RELATED ? prev : [...prev, r]))

  /** Why a run cannot be resumed (shown as the button's tooltip), or undefined when it can. */
  const resumeProblem = (r: OpsRunListItem): string | undefined => {
    if (!r.runbookPath?.trim()) return t('ops.start.resumeNoRunbook')
    if (r.scope?.kind === 'host' && hosts && !hosts.some((h) => h.id === (r.scope as { hostId: string }).hostId)) {
      return t('ops.start.resumeNoHost')
    }
    // Greyed out, not hidden: the row keeps its shape and the tooltip says why.
    if (r.scope?.kind === 'host' && dots[r.scope.hostId] === 'error') return t('ops.start.resumeUnreachable')
    return undefined
  }
  const resume = (r: OpsRunListItem, dir: string | undefined) =>
    onResume({
      // The built-in runbooks move with the install: a run from an older path uses today's.
      runbookPath: dir && builtin && samePath(dir, builtin) ? builtin : dir && baseDir && samePath(dir, baseDir) ? baseDir : r.runbookPath,
      scope: r.scope ?? { kind: 'open' },
      task: r.task ?? '',
      ...(r.ticket ? { ticket: r.ticket } : {}),
      ...(r.client ? { client: r.client } : {}),
      resumesRunId: r.runId,
      // A run added to the base is resumed added to it again.
      ...(r.onBase ? { onBase: true } : {})
    })
  const relatedText = (r: OpsRunListItem) => `${runWhen(r.startedAt, t, locale)} · ${r.task || r.runbook}`

  // ── The overview (no server picked): ongoing interventions, then recent chains ──
  const chainHostId = (c: RunChain): string | undefined =>
    c.newest.scope?.kind === 'host' ? c.newest.scope.hostId : hosts?.find((h) => c.newest.hostNames.includes(h.name))?.id
  const chainTitle = (c: RunChain) =>
    `${c.hostName || '…'} · ${c.task || hostLabel(c.newest, runbookDirFor(c.newest)).tag}`
  const sessionsText = (c: RunChain) => plural(t, 'ops.start.sessions', c.sessions)

  const runningRows = live.map((l) => ({
    live: l,
    host: hosts?.find((h) => h.id === l.hostId),
    chain: chains.find((c) => !c.newest.endedAt && chainHostId(c) === l.hostId)
  }))
  const runningChains = new Set(runningRows.flatMap((r) => (r.chain ? [r.chain] : [])))
  // Ongoing is only what is running. A run the operator stopped is closed, even with a
  // hypothesis left open: it sits under Recent with Resume as its action.
  const needle = filter.trim().toLowerCase()
  const recentAll = chains.filter((c) => !runningChains.has(c) && !chainIsEmpty(c))
  const recent = recentAll
    .filter((c) => !hostFilter || chainHostId(c) === hostFilter)
    .filter((c) => !needle || [chainTitle(c), c.task, c.headline, c.hostName].some((x) => x?.toLowerCase().includes(needle)))
  const ongoingCount = runningRows.length
  const filterHost = hostFilter ? hosts?.find((h) => h.id === hostFilter) : undefined

  /** The rail dot's tooltip: it is the connection, not how the last intervention ended. */
  const dotTitle = (d: DotState | undefined): string =>
    d === 'ok' ? t('ops.start.conn.ok') : d === 'error' ? t('ops.start.conn.error') : t('ops.start.conn.checking')

  // ── Header ─────────────────────────────────────────────────────────────────
  const connState: DotState | undefined = selectedHost ? (dots[selectedHost.id] ?? 'checking') : undefined
  const connText = connState === 'ok' ? t('ops.start.conn.ok') : connState === 'error' ? t('ops.start.conn.error') : t('ops.start.conn.checking')
  const headTitle =
    selectedHost ? selectedHost.name : server && hosts ? t('ops.start.unknownServer') : t('ops.start.title')
  const headSub = selectedHost ? (
    <>
      <span className={`ivs-dot ${connState}`} aria-hidden="true" />
      {hostAddress(selectedHost)} · {connText}
    </>
  ) : server ? null : (
    t('ops.start.pickServer')
  )

  // ── The one-line summary ───────────────────────────────────────────────────
  const sumParts: string[] = []
  if (okInfo && summary) {
    if (mode === 'despiste') sumParts.push(t('ops.start.sum.readOnly'))
    sumParts.push(`${summary.autoReads} ${plural(t, 'ops.start.stat.auto', summary.autoReads)}`)
    if (mode !== 'despiste') {
      sumParts.push(`${summary.asks} ${plural(t, 'ops.start.stat.asks', summary.asks)}`)
      sumParts.push(`${summary.mutates} ${plural(t, 'ops.start.stat.mutates', summary.mutates)}`)
    }
    sumParts.push(summary.scripts === 0 ? t('ops.start.sum.noScripts') : plural(t, 'ops.start.sum.scripts', summary.scripts))
  }
  const sumText = !activePath
    ? mode !== 'runbook'
      ? t('common.loading')
      : t('ops.start.allowsChoose')
    : info === 'loading' || !info
      ? t('common.loading')
      : !okInfo
        ? t('ops.start.allowsFailed')
        : !summary
          ? plural(t, okInfo.strict ? 'ops.start.noSummaryStrict' : 'ops.start.noSummary', okInfo.hosts.length)
          : sumParts.join(' · ')

  const allowsTitle =
    mode === 'despiste'
      ? t('ops.start.despisteAllowsTitle')
      : mode === 'base'
        ? t('ops.start.baseAllowsTitle')
        : onBase
          ? t('ops.start.allowsTitleOnBase')
          : t('ops.start.allowsTitle')

  const fileLink = <span className="ivs-mono">RUNBOOK.md</span>

  const hostLabel = (r: OpsRunListItem, dir: string | undefined) =>
    interventionLabel(
      {
        runbook: r.runbook,
        builtin: samePath(dir, builtin),
        base: samePath(dir, baseDir),
        server: r.hostNames.length === 1 ? { kind: 'host', name: r.hostNames[0] } : { kind: 'open', reached: r.hostNames },
        task: r.task
      },
      t
    )

  return (
    <div className="view ivs">
      <nav className="ivs-rail" aria-label={t('ops.start.servers')}>
        <div className="ivs-eyebrow ivs-rail-head">{t('ops.start.servers')}</div>
        <div className="ivs-rail-list">
          {hosts && hosts.length === 0 && <p className="ivs-help ivs-rail-note">{t('ops.start.noSshHosts')}</p>}
          {(hosts ?? []).map((h) => {
            const last = lastByHost[h.id]
            const isLive = live.some((l) => l.hostId === h.id)
            return (
              <button
                key={h.id}
                type="button"
                className={`ivs-srv${server === h.id ? ' on' : ''}`}
                aria-pressed={server === h.id}
                onClick={() => setServer(h.id)}
              >
                <span className="ivs-srv-top">
                  <span className={`ivs-dot ${dots[h.id] ?? 'checking'}`} aria-hidden="true" title={dotTitle(dots[h.id])} />
                  <span className="ivs-srv-name">{h.name}</span>
                  {isLive && <span className="ivs-live">{t('ops.start.live')}</span>}
                </span>
                <span className="ivs-srv-last">
                  {runs === 'loading'
                    ? ' '
                    : last
                      ? `${runWhen(last.startedAt, t, locale)} · ${runStatus(last, t).label}`
                      : t('ops.start.noneYet')}
                  {dots[h.id] === 'error' && ` · ${t('ops.start.conn.error')}`}
                </span>
              </button>
            )
          })}
        </div>
        {onAddHost && (
          <button type="button" className="ivs-add" onClick={onAddHost}>
            {t('ops.start.addHost')}
          </button>
        )}
      </nav>

      <div className="ivs-main">
        <div className="ivs-pane">
          <div className="ivs-head">
            <div className="ivs-head-text">
              <h1 className="ivs-title">{headTitle}</h1>
              {headSub && <span className="ivs-sub">{headSub}</span>}
            </div>
            <span className="ivs-spacer" />
            {server !== null && (
              <>
            <div className="ivs-modes" role="radiogroup" aria-label={t('ops.start.modes')}>
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={`ivs-btn ivs-btn-mode${mode === m ? ' on' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'despiste' ? t('ops.start.mode.despiste') : m === 'base' ? t('ops.start.mode.base') : t('ops.start.mode.runbook')}
                </button>
              ))}
            </div>
            <button type="button" className="ivs-start" disabled={!canStart} onClick={start}>
              <PlayIcon />
              {mode === 'despiste' ? t('ops.start.startDespiste') : mode === 'base' ? t('ops.start.startBase') : t('ops.start.startButton')}
            </button>
              </>
            )}
          </div>

          {server === null ? (
            <>
              {ongoingCount > 0 && (
                <section className="ivs-ongoing" aria-label={t('ops.start.ongoing')}>
                  <div className="ivs-sec-head">
                    <h2 className="ivs-eyebrow">{t('ops.start.ongoing')}</h2>
                    <span className="ivs-sec-count">{ongoingCount}</span>
                  </div>
                  {runningRows.map(({ live: l, host, chain }, i) => (
                    <div key={`live-${i}`} className="ivs-ong running">
                      <span className="ivs-ong-dot" aria-hidden="true" />
                      <div className="ivs-ong-body">
                        <span className="ivs-ong-title">{l.title}</span>
                        <span className="ivs-ong-sub">
                          {[
                            host?.name,
                            ...(chain
                              ? [
                                  t('ops.start.sinceAt', { time: clock(chain.newest.startedAt, locale) }),
                                  plural(t, 'ops.start.calls', chain.newest.calls),
                                  ...(runNotes(chain.newest, t).length ? runNotes(chain.newest, t) : [t('ops.start.noNotesYet')])
                                ]
                              : [])
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      <span className="ivs-ong-state">{t('ops.start.running')}</span>
                      <button type="button" className="ivs-ong-btn" onClick={l.open}>
                        {t('ops.start.openIt')}
                      </button>
                    </div>
                  ))}
                </section>
              )}

              <section className="ivs-recent" aria-label={t('ops.start.recent')}>
                <div className="ivs-sec-head ivs-recent-head">
                  <h2 className="ivs-eyebrow">{t('ops.start.recent')}</h2>
                  <span className="ivs-spacer" />
                  <label className="ivs-filter">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.5-3.5" />
                    </svg>
                    <input
                      aria-label={t('ops.start.filterLabel')}
                      placeholder={t('ops.start.filterPlaceholder')}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <span className="ivs-recent-dd">
                    <span id={filterLabelId} hidden>
                      {t('ops.start.servers')}
                    </span>
                    <IvsDropdown
                      labelledBy={filterLabelId}
                      trigger={<span className="ivs-value">{filterHost ? filterHost.name : t('ops.start.allServers')}</span>}
                      items={[
                        {
                          kind: 'option',
                          key: 'all',
                          selected: !hostFilter,
                          onSelect: () => setHostFilter(null),
                          content: <span className="ivs-value">{t('ops.start.allServers')}</span>
                        },
                        ...(hosts ?? []).map((h) => ({
                          kind: 'option' as const,
                          key: h.id,
                          selected: hostFilter === h.id,
                          onSelect: () => setHostFilter(h.id),
                          content: <span className="ivs-value">{h.name}</span>
                        }))
                      ]}
                    />
                  </span>
                </div>
                {runs === 'loading' ? (
                  <p className="ivs-help">{t('common.loading')}</p>
                ) : !runs.ok ? (
                  <p className="ivs-error">{runs.error}</p>
                ) : recentAll.length === 0 ? (
                  ongoingCount === 0 && <p className="ivs-help">{t('ops.start.none')}</p>
                ) : recent.length === 0 ? (
                  <p className="ivs-help">{t('ops.start.noMatch')}</p>
                ) : (
                  <div className="ivs-table">
                    {(showAllRecent ? recent : recent.slice(0, RECENT_LIMIT)).map((c) => {
                      const problem = resumeProblem(c.newest)
                      return (
                        <div key={c.newest.runId} className="ivs-row">
                          <span className="ivs-row-when" title={new Date(c.newest.startedAt).toLocaleString(locale)}>
                            {runWhen(c.newest.startedAt, t, locale)}
                          </span>
                          <div className="ivs-row-body">
                            <span className="ivs-row-title" title={chainTitle(c)}>
                              {chainTitle(c)}
                            </span>
                            {c.headline && (
                              <span className="ivs-row-found" title={c.headline}>
                                <span className="ivs-row-check" aria-hidden="true">
                                  ✓
                                </span>{' '}
                                {c.headline}
                              </span>
                            )}
                          </div>
                          <span className="ivs-row-meta">
                            <span>{sessionsText(c)}</span>
                            {c.openHypotheses > 0 && (
                              <span className="ivs-row-open">
                                {t('ops.start.openHyps', { hyps: plural(t, 'ops.start.hypotheses', c.openHypotheses) })}
                              </span>
                            )}
                          </span>
                          <span className="ivs-row-actions">
                            <button
                              type="button"
                              className={`ivs-icon-btn${c.openHypotheses > 0 ? ' strong' : ''}`}
                              disabled={!!problem}
                              aria-label={t('ops.start.resume')}
                              title={problem ?? t('ops.start.resumeTitle')}
                              onClick={() => resume(c.newest, runbookDirFor(c.newest))}
                            >
                              <RunIcon d={ICON_RESUME} />
                            </button>
                            <button
                              type="button"
                              className="ivs-icon-btn"
                              aria-label={t('ops.start.handover')}
                              title={t('ops.start.handover')}
                              onClick={() => setReportFor({ runId: c.newest.runId, runbookPath: runbookDirFor(c.newest), appSessionId: c.newest.appSessionId })}
                            >
                              <RunIcon d={ICON_REPORT} />
                            </button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {recent.length > RECENT_LIMIT && (
                  <button type="button" className="ivs-empty-toggle" onClick={() => setShowAllRecent((v) => !v)}>
                    {showAllRecent ? t('ops.start.showLess') : t('ops.start.showMore', { n: recent.length - RECENT_LIMIT })}
                  </button>
                )}
              </section>
            </>
          ) : (
            <>
          <div className="ivs-below">
            {hostProblem ? (
              <span className="ivs-error" role="alert">
                {hostProblem}
              </span>
            ) : mode !== 'runbook' && loaded && !loaded.ok ? (
              <span className="ivs-error" role="alert">
                <strong>{mode === 'despiste' ? t('ops.start.despisteUnusable') : t('ops.start.baseUnusable')}</strong> {loaded.error}
              </span>
            ) : server !== null ? (
              <span className="ivs-help">{startHint}</span>
            ) : null}

            {related.length > 0 && (
              <div className="ivs-related">
                <span>{t('ops.start.related')}</span>
                {related.map((r) => (
                  <span key={r.runId} className="ivs-chip">
                    <span className="ivs-chip-text" title={relatedText(r)}>
                      {relatedText(r)}
                    </span>
                    <button
                      type="button"
                      className="ivs-chip-x"
                      aria-label={t('ops.start.relatedRemove', { what: relatedText(r) })}
                      onClick={() => toggleRelated(r)}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {mode === 'runbook' && (
            <div className="ivs-field">
              <span className="ivs-label" id={runbookLabelId}>
                {t('ops.start.runbook')}
              </span>
              <RunbookField picker={picker} labelledBy={runbookLabelId} />
              {runbookPath && (
                <label className="ivs-onbase">
                  <input type="checkbox" checked={onBase} onChange={(e) => setOnBase(e.target.checked)} />
                  <span>
                    <span className="ivs-onbase-title">{t('ops.start.onBase')}</span>
                    <span className="ivs-help">{t('ops.start.onBaseHelp')}</span>
                  </span>
                </label>
              )}
            </div>
          )}

          {SHOW_DETAILS && (
            <>
              <div className="ivs-field">
                <label className="ivs-label" htmlFor={taskId}>
                  {t('ops.start.task')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                </label>
                <textarea
                  id={taskId}
                  className="ivs-control ivs-textarea"
                  value={task}
                  placeholder={t('ops.start.taskPlaceholder')}
                  onChange={(e) => setTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      start()
                    }
                  }}
                />
              </div>

              <div className="ivs-pair">
                <div className="ivs-field">
                  <label className="ivs-label" htmlFor={ticketId}>
                    {t('ops.start.ticket')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                  </label>
                  <input id={ticketId} className="ivs-control ivs-input" value={ticket} onChange={(e) => setTicket(e.target.value)} spellCheck={false} />
                </div>
                <div className="ivs-field">
                  <label className="ivs-label" htmlFor={clientId}>
                    {t('ops.start.client')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                  </label>
                  <input id={clientId} className="ivs-control ivs-input" value={client} onChange={(e) => setClient(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <section className="ivs-allows" aria-label={allowsTitle}>
            <div className="ivs-allows-line">
              <span className="ivs-allows-sum">{sumText}</span>
              {okInfo && (
                <button
                  type="button"
                  className="ivs-disclose"
                  aria-expanded={allowsOpen}
                  aria-controls={allowsId}
                  onClick={() => setAllowsOpen((v) => !v)}
                >
                  {t('ops.start.itAllows')}
                  <ChevronIcon className={allowsOpen ? 'ivs-chev open' : 'ivs-chev'} />
                </button>
              )}
            </div>
            {okInfo && allowsOpen && (
              <div className="ivs-allows-body" id={allowsId}>
                <h2 className="ivs-eyebrow">{allowsTitle}</h2>
                {summary && (
                  <p className="ivs-panel-text">
                    {summary.guidelinesHead.trim()
                      ? rich(t('ops.start.guidelines'), { text: withStop(summary.guidelinesHead), file: fileLink })
                      : rich(t('ops.start.noGuidelines'), { file: fileLink })}
                    {mode === 'runbook' && summary.readPaths.length > 0 && (
                      <>
                        {' '}
                        {rich(t('ops.start.readsAllowed'), {
                          paths: joinAnd(
                            summary.readPaths.map((p) => (
                              <span key={p} className="ivs-mono">
                                {p}
                              </span>
                            )),
                            t
                          )
                        })}
                      </>
                    )}
                  </p>
                )}
                {mode !== 'runbook' && <p className="ivs-panel-text">{mode === 'despiste' ? t('ops.start.despisteLeftOut') : t('ops.start.baseLeftOut')}</p>}
                <div className="ivs-file-buttons">
                  <button type="button" className="ivs-btn" onClick={() => openFile('RUNBOOK.md')}>
                    <FileIcon />
                    RUNBOOK.md
                  </button>
                  <button type="button" className="ivs-btn" onClick={() => openFile('policy.json')}>
                    <ShieldIcon />
                    policy.json
                  </button>
                </div>
              </div>
            )}
          </section>

          {liveHere.map((l, i) => (
            <div key={i} className="ivs-live-banner">
              <span className="ivs-live-dot" aria-hidden="true" />
              <strong>{t('ops.start.running')}</strong>
              <span className="ivs-live-title">{l.title}</span>
              <span className="ivs-spacer" />
              <button type="button" className="ivs-open" onClick={l.open}>
                {t('ops.start.openIt')}
                <ChevronIcon />
              </button>
            </div>
          ))}

          <section className="ivs-history" aria-label={t('ops.start.history')}>
            <h2 className="ivs-eyebrow">{t('ops.start.history')}</h2>
            {runs === 'loading' ? (
              <p className="ivs-help">{t('common.loading')}</p>
            ) : !runs.ok ? (
              <p className="ivs-error">{runs.error}</p>
            ) : timeline.length === 0 ? (
              <p className="ivs-help">
                {selectedHost ? t('ops.start.noneOn', { name: selectedHost.name }) : t('ops.start.none')}
              </p>
            ) : (
              <div className="ivs-runs">
                {timeline.map(({ run: r, resumedBy, lineTop, lineBottom }) => {
                  const st = runStatus(r, t)
                  const problem = resumeProblem(r)
                  const referred = related.some((x) => x.runId === r.runId)
                  const dir = runbookDirFor(r)
                  const label = hostLabel(r, dir)
                  const calls = plural(t, 'ops.start.calls', r.calls)
                  return (
                    <div key={r.runId} className="ivs-run" role="group">
                      <span className="ivs-gutter" aria-hidden="true">
                        <span className={`ivs-line${lineTop ? ' on' : ''} top`} />
                        <span className={`ivs-ring ${dotTone(r)}`} />
                        <span className={`ivs-line${lineBottom ? ' on' : ''} bottom`} />
                      </span>
                      <span className="ivs-run-body">
                        <span className="ivs-run-top">
                          <span className="ivs-run-what" title={label.tooltip}>
                            {r.task || r.headline || label.title}
                          </span>
                          <span className="ivs-run-when" title={new Date(r.startedAt).toLocaleString(locale)}>
                            {runWhen(r.startedAt, t, locale)}
                          </span>
                        </span>
                        <span className="ivs-run-detail">
                          <span className={`ivs-run-status ${st.tone}`}>{st.label}</span> · {[calls, ...runNotes(r, t)].join(' · ')}
                          {resumedBy && ` · ${t('ops.start.resumedAt', { time: clock(resumedBy.startedAt, locale) })}`}
                        </span>
                      </span>
                      <span className="ivs-run-actions">
                        <button
                          type="button"
                          className="ivs-icon-btn"
                          disabled={!!problem}
                          aria-label={t('ops.start.resume')}
                          title={problem ?? t('ops.start.resumeTitle')}
                          onClick={() => resume(r, dir)}
                        >
                          <RunIcon d={ICON_RESUME} />
                        </button>
                        <button
                          type="button"
                          className="ivs-icon-btn"
                          aria-pressed={referred}
                          aria-label={t('ops.start.refer')}
                          disabled={!referred && related.length >= MAX_RELATED}
                          title={!referred && related.length >= MAX_RELATED ? t('ops.start.referFull', { n: MAX_RELATED }) : t('ops.start.referTitle')}
                          onClick={() => toggleRelated(r)}
                        >
                          <RunIcon d={ICON_REFER} />
                        </button>
                        <button
                          type="button"
                          className="ivs-icon-btn"
                          aria-label={t('ops.start.handover')}
                          title={t('ops.start.handover')}
                          onClick={() => setReportFor({ runId: r.runId, runbookPath: dir, appSessionId: r.appSessionId })}
                        >
                          <RunIcon d={ICON_REPORT} />
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            {emptyCount > 0 && (
              <button type="button" className="ivs-empty-toggle" onClick={() => setShowEmpty((v) => !v)}>
                {showEmpty ? t('ops.start.hideEmpty') : plural(t, 'ops.start.emptyHidden', emptyCount)}
              </button>
            )}
          </section>
            </>
          )}
        </div>
      </div>

      {reportFor && (
        <OpsReportSheet
          runId={reportFor.runId}
          appSessionId={reportFor.appSessionId}
          runbookPath={reportFor.runbookPath}
          onClose={() => setReportFor(null)}
        />
      )}
    </div>
  )
}
