import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UsageReport, UsageEntry, SourceInfo, UsageLimits, AccountPlanUsage, PlanUsageReport, PlanWindow } from '../types'
import { shortModel } from '../lib/model-id'
import './views.css'
import './UsageView.css'

// ── Formatting ──────────────────────────────────────────────────────────────

/** "2.1 M", "412 k", "8.4 k", "310". */
function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`
  if (n >= 1e4) return `${Math.round(n / 1e3)} k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`
  return String(Math.round(n))
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`

/** "$9" / "$0.42" for the chart's y label. */
const fmtAxis = (n: number): string => (n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

type RangeKey = '2d' | 'week' | 'month' | 'year' | 'all'
const RANGES: { key: RangeKey; label: string; days: number | null; caption: string }[] = [
  { key: '2d', label: '2 days', days: 2, caption: 'estimated cost these 2 days' },
  { key: 'week', label: 'Week', days: 7, caption: 'estimated cost this week' },
  { key: 'month', label: 'Month', days: 30, caption: 'estimated cost this month' },
  { key: 'year', label: 'Year', days: 365, caption: 'estimated cost this year' },
  { key: 'all', label: 'All', days: null, caption: 'estimated cost, all time' }
]

/** "resets 19:40" today, "resets Mon 09:00" on another day. */
function resetLabel(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? `resets ${hm}` : `resets ${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ts).toLocaleString()
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (dt: Date): string => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
const dayDate = (d: string): Date => new Date(`${d}T00:00:00`)
/** "Thu 2" */
const shortDay = (d: string): string => {
  const dt = dayDate(d)
  return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })} ${dt.getDate()}`
}
/** "Thu 2 Oct" */
const longDay = (d: string): string => `${shortDay(d)} ${dayDate(d).toLocaleDateString('en-GB', { month: 'short' })}`
/** "29 Sep" */
const dayMonth = (d: string): string => dayDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

// ── Plan windows ────────────────────────────────────────────────────────────

/** The row label: "Session · 5 hours", "Week · all models", "Week · Opus". */
function windowLabel(w: PlanWindow): string {
  return w.key === 'five_hour' ? 'Session · 5 hours' : w.label
}
/** The name in the tinted block's title: "Session window at 76 %". */
function windowTitle(w: PlanWindow): string {
  return w.key === 'five_hour' ? 'Session window' : w.label
}
/** Window length, for the pace estimate. */
function windowMs(key: string): number | null {
  if (key === 'five_hour') return 5 * 3600_000
  if (key.startsWith('seven_day')) return 7 * 86400_000
  return null
}

type Level = 'ok' | 'warn' | 'err'
const levelOf = (pct: number): Level => (pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok')

/** "Max 5x" from `max` + `default_claude_max_5x`. */
function planName(a: AccountPlanUsage): string {
  if (!a.subscriptionType) return ''
  const base = a.subscriptionType.charAt(0).toUpperCase() + a.subscriptionType.slice(1)
  const mult = a.rateLimitTier?.match(/(\d+x)\b/)?.[1]
  return mult ? `${base} ${mult}` : base
}

const worstOf = (a: AccountPlanUsage): number =>
  a.windows.reduce((m, w) => Math.max(m, w.utilization), -1)

/**
 * At the rate the window has filled so far, how long until it is full. Uses only the
 * utilization and the reset time, both of which the endpoint returns, so no extra data:
 * elapsed = length − time to reset, rate = used ÷ elapsed. Null when the window is too
 * young to say anything (under 10 minutes) or its length is unknown.
 */
function paceLine(w: PlanWindow): string | null {
  const len = windowMs(w.key)
  if (!len || !w.resetsAt) return null
  const toReset = new Date(w.resetsAt).getTime() - Date.now()
  if (!isFinite(toReset) || toReset <= 0) return null
  const elapsed = len - toReset
  if (elapsed < 10 * 60_000 || w.utilization <= 0) return null
  const toFull = ((100 - w.utilization) / w.utilization) * elapsed
  if (toFull >= toReset) return 'At this pace it lasts until the reset.'
  const mins = Math.max(1, Math.round(toFull / 60_000))
  const span = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${pad2(mins % 60)}` : ''}`
  return `About ${span} of the usual pace left.`
}

function statusHint(a: AccountPlanUsage): { text: string; err?: boolean } | null {
  switch (a.status) {
    case 'ok':
      return a.windows.length === 0
        ? { text: 'The usage endpoint reported no limit windows for this login (API keys and some plans have none).' }
        : null
    case 'unauthorized':
      return { text: 'No valid Claude Code token for this login. It refreshes the next time Claude runs here or in the CLI; then Refresh.' }
    case 'no-credentials':
      return { text: 'No Claude Code login found for this account.' }
    case 'rate-limited':
      return {
        text: a.stale
          ? 'Anthropic is rate-limiting the usage endpoint; showing the last numbers fetched.'
          : 'Anthropic is rate-limiting the usage endpoint; it retries in a couple of minutes.'
      }
    case 'error':
      return {
        text: `Could not reach the usage endpoint (${a.error ?? 'unknown error'})${a.stale ? '; showing the last numbers fetched.' : '.'}`,
        err: true
      }
  }
  return null
}

function Bar({ pct, level }: { pct: number; level: Level }) {
  return (
    <div className="us-bar">
      <span className={level} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

function LimitRow({ w }: { w: PlanWindow }) {
  const reset = resetLabel(w.resetsAt)
  return (
    <div className="us-limit">
      <div className="us-limit-head">
        <span className="us-limit-label">{windowLabel(w)}</span>
        <span className="us-muted">
          {w.utilization.toFixed(0)} %{reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <Bar pct={w.utilization} level={levelOf(w.utilization)} />
    </div>
  )
}

/** One account's limit rows and status hint, minus the window already in the tinted block. */
function AccountLimits({ acc, skip }: { acc: AccountPlanUsage; skip?: PlanWindow }) {
  const hint = statusHint(acc)
  return (
    <>
      {acc.windows
        .filter((w) => w !== skip)
        .map((w) => (
          <LimitRow key={w.key} w={w} />
        ))}
      {hint && <p className={`help${hint.err ? ' us-err' : ''}`}>{hint.text}</p>}
    </>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'spin' : ''} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="M8 17v-5M13 17V8M18 17v-9" />
    </svg>
  )
}

// ── Chart ───────────────────────────────────────────────────────────────────

type Bucket = { key: string; label: string; cost: number; from: string; to: string }

/**
 * Cost per day (per week past 92 days) as plain SVG bars, drawn in pixels against the
 * measured width so the 9 px labels stay 9 px. The highlighted bar (the selected one, or
 * the latest) is solid and its label carries its total.
 */
function CostChart({
  buckets,
  max,
  tickEvery,
  weekly,
  selected,
  onSelect
}: {
  buckets: Bucket[]
  max: number
  tickEvery: number
  weekly: boolean
  selected: string | null
  onSelect: (key: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = 130
  const base = 110
  const top = 16
  const left = 40
  const n = buckets.length
  const slot = n > 0 && width > left ? (width - left) / n : 0
  const barW = Math.max(1, Math.min(slot * 0.8, slot - 1, 72))
  const hi = selected ?? buckets[n - 1]?.key
  const hiIdx = buckets.findIndex((b) => b.key === hi)
  const cx = (i: number) => left + slot * i + slot / 2
  const hiX = hiIdx >= 0 ? cx(hiIdx) : 0
  const hiAnchor = hiX > width - 70 ? 'end' : hiX < left + 50 ? 'start' : 'middle'
  const labelOf = (b: Bucket) => (weekly ? dayMonth(b.from) : shortDay(b.from))

  return (
    <div className="us-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Cost by day">
          <line className="us-chart-base" x1={left} y1={base} x2={width} y2={base} />
          <text className="us-chart-label" x={0} y={top + 3}>{fmtAxis(max)}</text>
          <text className="us-chart-label" x={0} y={base}>$0</text>
          {buckets.map((b, i) => {
            const h = (b.cost / max) * (base - top)
            const x = left + slot * i + (slot - barW) / 2
            const tip = `${weekly ? `Week of ${dayMonth(b.from)}` : longDay(b.from)} · ${fmtUsd(b.cost)}`
            const pick = () => onSelect(b.key)
            return (
              <g
                key={b.key}
                className="us-chart-col"
                role="button"
                tabIndex={0}
                aria-label={tip}
                aria-pressed={selected === b.key}
                onClick={pick}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick())}
              >
                <title>{tip}</title>
                <rect className="us-chart-hit" x={left + slot * i} y={top} width={slot} height={base - top} />
                {b.cost > 0 && (
                  <rect className={`us-chart-bar${b.key === hi ? ' on' : ''}`} x={x} y={base - h} width={barW} height={Math.max(h, 1)} />
                )}
              </g>
            )
          })}
          {buckets.map((b, i) =>
            i % tickEvery === 0 && i !== hiIdx && Math.abs(cx(i) - hiX) > 80 ? (
              <text key={b.key} className="us-chart-label" x={cx(i)} y={H - 3} textAnchor="middle">
                {labelOf(b)}
              </text>
            ) : null
          )}
          {hiIdx >= 0 && (
            <text className="us-chart-label hi" x={hiAnchor === 'end' ? width : hiAnchor === 'start' ? left : hiX} y={H - 3} textAnchor={hiAnchor}>
              {labelOf(buckets[hiIdx])} · {fmtUsd(buckets[hiIdx].cost)}
            </text>
          )}
        </svg>
      )}
    </div>
  )
}

// ── View ────────────────────────────────────────────────────────────────────

type Agg = {
  cost: number
  inTok: number
  outTok: number
  cacheTok: number
  byModel: { model: string; costUsd: number; inputTokens: number; outputTokens: number }[]
  byProject: { project: string; costUsd: number; tokens: number; distros: string[] }[]
}

function aggregate(entries: UsageEntry[], srcMeta: Map<string, SourceInfo>): Agg {
  let cost = 0
  let inTok = 0
  let outTok = 0
  let cacheTok = 0
  const byModel = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>()
  const byProject = new Map<string, { costUsd: number; tokens: number; distros: Set<string> }>()
  for (const e of entries) {
    cost += e.costUsd
    inTok += e.inputTokens
    outTok += e.outputTokens
    cacheTok += e.cacheTokens
    const m = byModel.get(e.model) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 }
    m.costUsd += e.costUsd
    m.inputTokens += e.inputTokens
    m.outputTokens += e.outputTokens
    byModel.set(e.model, m)
    const p = byProject.get(e.project) ?? { costUsd: 0, tokens: 0, distros: new Set<string>() }
    p.costUsd += e.costUsd
    p.tokens += e.inputTokens + e.outputTokens
    const src = srcMeta.get(e.source)
    if (src?.kind === 'wsl') p.distros.add(src.distro ?? src.label)
    byProject.set(e.project, p)
  }
  return {
    cost,
    inTok,
    outTok,
    cacheTok,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    byProject: [...byProject.entries()]
      .map(([project, v]) => ({ project, costUsd: v.costUsd, tokens: v.tokens, distros: [...v.distros] }))
      .sort((a, b) => b.costUsd - a.costUsd)
  }
}

export default function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState<RangeKey>('week')
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set())
  const [limits, setLimits] = useState<UsageLimits>({ hourUsd: 10, sessionUsd: 25, weekUsd: 150 })
  const [editingLimits, setEditingLimits] = useState(false)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [planReport, setPlanReport] = useState<PlanUsageReport | null>(null)
  // 'all' or an accountKey: scopes the column AND the history on the page.
  const [accountFilter, setAccountFilter] = useState<string>('all')

  const apply = (rep: UsageReport, srcs: SourceInfo[], lim: UsageLimits) => {
    setReport(rep)
    setSources(srcs)
    setLimits(lim)
    setActiveSources((prev) => (prev.size ? prev : new Set(srcs.map((s) => s.id))))
  }

  // Recompute in the background (no full-screen spinner) and update in place.
  const refresh = async () => {
    setRefreshing(true)
    window.electronAPI.ccPlanUsage(true).then(setPlanReport).catch(() => {})
    const [rep, srcs, cfg] = await Promise.all([
      window.electronAPI.ccUsage(true),
      window.electronAPI.ccSources(),
      window.electronAPI.getConfig()
    ])
    apply(rep, srcs, cfg.limits)
    setRefreshing(false)
  }

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      window.electronAPI.ccPlanUsage(false).then((r) => { if (!cancelled) setPlanReport(r) }).catch(() => {})
      // Paint instantly from cache…
      const [rep, srcs, cfg] = await Promise.all([
        window.electronAPI.ccUsage(false),
        window.electronAPI.ccSources(),
        window.electronAPI.getConfig()
      ])
      if (cancelled) return
      apply(rep, srcs, cfg.limits)
      setLoading(false)
      // …then, if the cache is stale, silently refresh in the background.
      if (Date.now() - rep.generatedAt > 60_000) refresh()
    }
    init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live-update from the main-process watcher (every ~10 min and after IPC fetches).
  useEffect(() => window.electronAPI.onPlanUsage(setPlanReport), [])

  // A different range draws different bars; a day picked in the old one means nothing.
  useEffect(() => setSelectedDay(null), [range, accountFilter])

  const toggleSource = (id: string) => {
    setActiveSources((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveLimits = async (next: UsageLimits) => {
    setLimits(next)
    await window.electronAPI.setLimits(next)
  }

  // Accounts in the column: every login the poller knows, except ones with no login.
  const accounts = useMemo(
    () =>
      (planReport?.accounts ?? [])
        .filter((a) => !(a.status === 'no-credentials' && a.windows.length === 0))
        .sort((a, b) => (a.accountKey === planReport?.primary ? -1 : b.accountKey === planReport?.primary ? 1 : 0)),
    [planReport]
  )
  // An account that went away (logged out) drops the filter back to All.
  useEffect(() => {
    if (accountFilter !== 'all' && !accounts.some((a) => a.accountKey === accountFilter)) setAccountFilter('all')
  }, [accounts, accountFilter])

  // Which usage sources belong to an account: email match first. The env-name fallback
  // only applies to sources WITHOUT their own identity — otherwise an account whose
  // managed login lives locally would wrongly swallow another account's Local source.
  const sourcesFor = (acc: AccountPlanUsage | undefined): Set<string> => {
    const ids = new Set<string>()
    for (const s of sources) {
      if (acc?.email && s.account?.email === acc.email) ids.add(s.id)
      else if (!s.account?.email && acc?.envs?.includes(s.kind === 'wsl' ? s.label : 'Local')) ids.add(s.id)
    }
    return ids
  }

  const selectedAcc = accountFilter === 'all' ? undefined : accounts.find((a) => a.accountKey === accountFilter)
  const accountSources = selectedAcc ? sourcesFor(selectedAcc) : null
  // The sources the history uses: the chip toggles, within the selected account.
  const effectiveSources = accountSources
    ? new Set([...accountSources].filter((id) => activeSources.has(id)))
    : activeSources
  const shownSources = accountSources ? sources.filter((s) => accountSources.has(s.id)) : sources
  const srcMeta = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources])

  const view = useMemo(() => {
    if (!report) return null
    const days = RANGES.find((r) => r.key === range)?.days ?? null
    const cutoff = days ? ymd(new Date(Date.now() - (days - 1) * 86400_000)) : null
    const entries = report.entries.filter(
      (e) => effectiveSources.has(e.source) && e.day !== 'unknown' && (!cutoff || e.day >= cutoff)
    )
    const byDay = new Map<string, number>()
    for (const e of entries) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.costUsd)
    return { entries, byDay, total: aggregate(entries, srcMeta) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, range, activeSources, srcMeta, accountFilter, accounts])

  // A CONTINUOUS timeline (empty days at $0) over the range, clamped to the first active
  // day; past 92 days it buckets by week to stay legible.
  const chart = useMemo(() => {
    if (!view) return null
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const days = RANGES.find((r) => r.key === range)?.days ?? null
    const firstDay = [...view.byDay.keys()].sort()[0]
    let start: Date
    if (days) {
      start = new Date(today)
      start.setDate(start.getDate() - (days - 1))
    } else {
      start = firstDay ? dayDate(firstDay) : new Date(today)
    }
    if (firstDay && dayDate(firstDay) > start) start = dayDate(firstDay)
    if (start > today) start = new Date(today)
    const spanDays = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1
    const weekly = spanDays > 92
    const buckets: Bucket[] = []
    if (!weekly) {
      const cur = new Date(start)
      for (let i = 0; i < spanDays; i++) {
        const k = ymd(cur)
        buckets.push({ key: k, label: k, cost: view.byDay.get(k) ?? 0, from: k, to: k })
        cur.setDate(cur.getDate() + 1)
      }
    } else {
      const cur = new Date(start)
      cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7)) // align to Monday
      while (cur <= today) {
        let sum = 0
        for (let i = 0; i < 7; i++) {
          sum += view.byDay.get(ymd(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + i))) ?? 0
        }
        const end = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6)
        buckets.push({ key: ymd(cur), label: ymd(cur), cost: sum, from: ymd(cur), to: ymd(end) })
        cur.setDate(cur.getDate() + 7)
      }
    }
    const max = Math.max(...buckets.map((b) => b.cost), 0.0001)
    const tickEvery = Math.max(1, Math.ceil(buckets.length / 8))
    return { buckets, max, weekly, tickEvery }
  }, [view, range])

  const selBucket = chart?.buckets.find((b) => b.key === selectedDay) ?? null
  // The tables follow the selected bar; the numbers row stays on the whole range.
  const tables = useMemo(() => {
    if (!view) return null
    if (!selBucket) return view.total
    return aggregate(
      view.entries.filter((e) => e.day >= selBucket.from && e.day <= selBucket.to),
      srcMeta
    )
  }, [view, selBucket, srcMeta])

  // Per-account cost over the last 7 days, for the "Other accounts" rows.
  const weekCostFor = (acc: AccountPlanUsage): number | null => {
    if (!report) return null
    const ids = sourcesFor(acc)
    if (ids.size === 0) return null
    const cutoff = ymd(new Date(Date.now() - 6 * 86400_000))
    return report.entries.reduce((s, e) => (ids.has(e.source) && e.day >= cutoff ? s + e.costUsd : s), 0)
  }

  if (loading)
    return (
      <div className="view">
        <div className="us-state">
          <div className="view-spinner" />
          <p className="help">Reading usage from local and WSL…</p>
        </div>
      </div>
    )
  if (!report || !view || !chart || !tables)
    return (
      <div className="view">
        <div className="us-state">
          <span className="us-muted"><ChartIcon /></span>
          <p className="help">No usage data found. Start a chat and come back.</p>
        </div>
      </div>
    )

  const rangeInfo = RANGES.find((r) => r.key === range)!
  const t = view.total
  const cacheShare = t.inTok + t.cacheTok > 0 ? Math.round((t.cacheTok / (t.inTok + t.cacheTok)) * 100) : 0

  // ── Column: which accounts, and the one limit closest to its ceiling ──
  const inScope = selectedAcc ? [selectedAcc] : accounts
  const closest = inScope
    .flatMap((acc) => acc.windows.map((w) => ({ acc, w })))
    .reduce<{ acc: AccountPlanUsage; w: PlanWindow } | null>(
      (best, c) => (!best || c.w.utilization > best.w.utilization ? c : best),
      null
    )
  // Below 70 % nothing needs the operator, so nothing is tinted.
  const tinted = closest && closest.w.utilization >= 70 ? closest : null
  // With All, whatever needs attention sorts to the top: the tinted account, then by worst window.
  const blocks = [...inScope].sort((a, b) =>
    tinted?.acc === a ? -1 : tinted?.acc === b ? 1 : worstOf(b) - worstOf(a)
  )
  const others = selectedAcc ? accounts.filter((a) => a !== selectedAcc) : []
  const win = report.windows

  return (
    <div className="view">
      <div className="us-page">
        {/* ── Left: history ── */}
        <div className="us-main">
          <div className="us-head">
            <div className="us-head-text">
              <h1>Usage</h1>
              <p className="us-sub">
                Local and connected WSL distros · {refreshing ? 'refreshing…' : `updated ${relTime(report.generatedAt)}`} · local estimates, not billed
              </p>
            </div>
            <button className="btn-ghost us-icon-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh" title="Refresh">
              <RefreshIcon spinning={refreshing} />
            </button>
          </div>

          <div className="us-body">
            <div className="us-range-row">
              <div className="seg-control">
                {RANGES.map((r) => (
                  <button key={r.key} className={range === r.key ? 'on' : ''} onClick={() => setRange(r.key)}>
                    {r.label}
                  </button>
                ))}
              </div>
              <span className="us-grow" />
              {shownSources.length > 1 &&
                shownSources.map((s) => (
                  <button
                    key={s.id}
                    className={`chip us-src${activeSources.has(s.id) ? ' on' : ''}`}
                    onClick={() => toggleSource(s.id)}
                    aria-pressed={activeSources.has(s.id)}
                    title={s.account?.email}
                  >
                    {s.label}
                  </button>
                ))}
            </div>

            <div className="us-stats">
              <div className="us-stat">
                <span className="us-num">{fmtUsd(t.cost)}</span>
                <span className="us-cap">{rangeInfo.caption}</span>
              </div>
              <div className="us-stat">
                <span className="us-num">{fmtNum(t.inTok)}</span>
                <span className="us-cap">input tokens</span>
              </div>
              <div className="us-stat">
                <span className="us-num">{fmtNum(t.outTok)}</span>
                <span className="us-cap">output tokens</span>
              </div>
              <div className="us-stat">
                <span className="us-num">{fmtNum(t.cacheTok)}</span>
                <span className="us-cap">cache tokens · {cacheShare} % of input</span>
              </div>
            </div>

            <CostChart
              buckets={chart.buckets}
              max={chart.max}
              tickEvery={chart.tickEvery}
              weekly={chart.weekly}
              selected={selBucket?.key ?? null}
              onSelect={(k) => setSelectedDay((cur) => (cur === k ? null : k))}
            />
            <p className="help">
              {selBucket
                ? `Showing ${chart.weekly ? `the week of ${dayMonth(selBucket.from)}` : longDay(selBucket.from)} · click the bar again for the whole range.`
                : `Click a ${chart.weekly ? 'week' : 'day'} to see its models and projects below.`}
            </p>

            {tables.byModel.length === 0 ? (
              <p className="help us-tables-empty">No activity in this range.</p>
            ) : (
              <div className="us-tables">
                <table className="us-table">
                  <thead>
                    <tr><th>Model</th><th className="r">In</th><th className="r">Out</th><th className="r">Cost</th></tr>
                  </thead>
                  <tbody>
                    {tables.byModel.map((m) => (
                      <tr key={m.model}>
                        <td className="us-mono" title={m.model}>{shortModel(m.model)}</td>
                        <td className="r">{fmtNum(m.inputTokens)}</td>
                        <td className="r">{fmtNum(m.outputTokens)}</td>
                        <td className="r">{fmtUsd(m.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table className="us-table">
                  <thead>
                    <tr><th>Project</th><th className="r">Tokens</th><th className="r">Cost</th></tr>
                  </thead>
                  <tbody>
                    {tables.byProject.map((p) => (
                      <tr key={p.project}>
                        <td>
                          <span className="us-project">
                            <span className="us-project-name">{p.project}</span>
                            {p.distros.map((d) => (
                              <span key={d} className="chip">{d}</span>
                            ))}
                          </span>
                        </td>
                        <td className="r">{fmtNum(p.tokens)}</td>
                        <td className="r">{fmtUsd(p.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: what can stop you ── */}
        <aside className="us-side">
          <div className="us-sec us-side-head">
            <span className="us-t3">Plan usage</span>
            <span className="us-grow" />
            {accounts.length > 1 && (
              <div className="seg-control">
                <button className={accountFilter === 'all' ? 'on' : ''} onClick={() => setAccountFilter('all')}>
                  All
                </button>
                {accounts.map((a) => (
                  <button
                    key={a.accountKey}
                    className={accountFilter === a.accountKey ? 'on' : ''}
                    onClick={() => setAccountFilter(a.accountKey)}
                    title={a.email}
                  >
                    {a.accountName}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tinted && (() => {
            const level = levelOf(tinted.w.utilization)
            const reset = resetLabel(tinted.w.resetsAt)
            const pace = paceLine(tinted.w)
            const who = [tinted.acc.accountName, planName(tinted.acc)].filter(Boolean).join(' · ')
            return (
              <div className={`block ${level} us-tint`}>
                <div className="us-tint-head">
                  <span className={`us-tint-title ${level}`}>
                    {windowTitle(tinted.w)} at {tinted.w.utilization.toFixed(0)} %
                  </span>
                  {reset && <span className="us-muted">{reset}</span>}
                </div>
                <Bar pct={tinted.w.utilization} level={level} />
                <p className="help">
                  {pace && !selectedAcc && accounts.length > 1 ? `${tinted.acc.accountName} · ${pace}` : pace ?? who}
                </p>
              </div>
            )
          })()}

          <div className="us-sec">
            {accounts.length === 0 ? (
              <p className="help">No Claude Code login found. Sign in with Claude Code and Refresh.</p>
            ) : selectedAcc || accounts.length === 1 ? (
              (() => {
                const a = selectedAcc ?? accounts[0]
                const live = a.status === 'ok' && a.windows.length > 0
                return (
                  <>
                    <AccountLimits acc={a} skip={tinted?.acc === a ? tinted.w : undefined} />
                    {live && (
                      <p className="help">
                        {['Live from Anthropic', planName(a), a.email].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </>
                )
              })()
            ) : (
              blocks.map((a) => (
                <div key={a.accountKey} className="us-acct">
                  <div className="us-acct-head">
                    <span className="eyebrow">{a.accountName}</span>
                    {planName(a) && <span className="chip">{planName(a)}</span>}
                  </div>
                  <AccountLimits acc={a} skip={tinted?.acc === a ? tinted.w : undefined} />
                </div>
              ))
            )}
          </div>

          <div className="us-sec">
            <div className="us-sec-head">
              <span className="eyebrow">Budgets</span>
              <span className="us-grow" />
              <button className="btn-ghost small" onClick={() => setEditingLimits((v) => !v)}>
                {editingLimits ? 'Done' : 'Edit'}
              </button>
            </div>
            {editingLimits && (
              <div className="us-budget-edit">
                {(['hourUsd', 'sessionUsd', 'weekUsd'] as const).map((k) => (
                  <label key={k} className="us-budget-field">
                    <span>{k === 'hourUsd' ? 'Hour $' : k === 'sessionUsd' ? 'Session (5 h) $' : 'Week $'}</span>
                    <input
                      className="text-input"
                      type="number"
                      min={0}
                      placeholder="0 = off"
                      value={limits[k] || ''}
                      onChange={(e) => saveLimits({ ...limits, [k]: Number(e.target.value) || 0 })}
                    />
                  </label>
                ))}
              </div>
            )}
            {(
              [
                ['Last hour', win.hour.costUsd, limits.hourUsd],
                ['Last 5 hours', win.session.costUsd, limits.sessionUsd],
                ['Last 7 days', win.week.costUsd, limits.weekUsd]
              ] as const
            ).map(([label, cost, cap]) => {
              const pct = cap > 0 ? (cost / cap) * 100 : 0
              return (
                <div key={label} className="us-limit">
                  <div className="us-limit-head">
                    <span className="us-limit-label">{label}</span>
                    <span className="us-budget-figs">
                      <span className="us-mono">{fmtUsd(cost)}</span>
                      <span className="us-muted">{cap > 0 ? `of $${cap}` : 'no budget'}</span>
                    </span>
                  </div>
                  {cap > 0 && <Bar pct={pct} level={levelOf(pct)} />}
                </div>
              )
            })}
          </div>

          {others.length > 0 && (
            <div className="us-sec">
              <div className="divider-caption">Other accounts · {others.length}</div>
              {others.map((a) => {
                const worst = worstOf(a)
                const session = a.windows.find((w) => w.key === 'five_hour')
                const week = weekCostFor(a)
                const right = [
                  session ? `${session.utilization.toFixed(0)} % session` : null,
                  week !== null ? `${fmtUsd(week)} this week` : null
                ].filter(Boolean).join(' · ')
                return (
                  <button key={a.accountKey} className="us-other" onClick={() => setAccountFilter(a.accountKey)} title={a.email}>
                    <span className={`us-dot${worst >= 0 ? ` ${levelOf(worst)}` : ''}`} />
                    <span className="us-other-name">{[a.accountName, planName(a)].filter(Boolean).join(' · ')}</span>
                    {right && <span className="us-muted us-other-right">{right}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
