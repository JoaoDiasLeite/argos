import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import './views.css'
import './HomeView.css'

export interface HomeAttention {
  id: string
  kind: 'approval' | 'routine'
  title: string
  detail: string
  mono?: boolean
  context?: string
  since?: number
  actionLabel: string
}

export interface HomeRunning {
  id: string
  kind: 'chat' | 'cli'
  name: string
  detail?: string
  startedAt?: number
  attention?: boolean
}

export interface HomeRepo {
  key: string
  name: string
  branch?: string
  fileCount: number
  loading?: boolean
  error?: string
}

export interface HomePlan {
  accountKey: string
  accountName: string
  percent: number | null
  resetsAt?: string
  stale?: boolean
}

export interface HomeSpend {
  today: number
  days: { day: string; costUsd: number }[]
}

export interface HomeRoutine {
  id: string
  name: string
  nextRunAt?: number
  cadence: string
}

export interface HomeRecent {
  id: string
  name: string
  projectName?: string
  updatedAt: number
  preview: string
}

export interface HomeStart {
  projectPath?: string
  projectName?: string
  modelId?: string
  modelLabel?: string
  accountId?: string
  accountName?: string
}

export interface HomeStartChoice {
  projectPath?: string
  modelId?: string
  accountId?: string
}

export interface HomeStartOptions {
  projects: { path: string; name: string }[]
  models: { id: string; label: string }[]
  accounts: { id: string; name: string }[]
}

interface Props {
  attention: HomeAttention[]
  running: HomeRunning[]
  repos: HomeRepo[]
  plans: HomePlan[]
  spend: HomeSpend | null
  routines: HomeRoutine[]
  recent: HomeRecent[]
  start: HomeStart
  startOptions: HomeStartOptions
  onAct: (id: string) => void
  onStart: (prompt: string, choice: HomeStartChoice) => void
  onPickFolder: () => Promise<string | null>
  onOpenSession: (id: string) => void
  onOpenRepo: (key: string) => void
  onOpenUsage: () => void
  onOpenScheduled: () => void
}

/** Own copy on purpose — see LiveView's `timeAgo` for why this isn't shared across
 *  files (convention 1: no cross-file coupling to save a few lines). */
function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** How long a run has been going, from `startedAt`. Own copy — see LiveView's
 *  `duration` and ProjectsView's own version, this file's is the third by convention. */
function duration(startedAt: number): string {
  if (!startedAt) return ''
  const diff = Math.max(0, Date.now() - startedAt)
  const m = Math.floor(diff / 60000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/** "resets in 3h 12m" / "resets Mon 14:00" for a plan window's reset timestamp. Own
 *  copy of UsageView's formatter by the same convention as `timeAgo` above — the raw
 *  ISO string is unreadable on a card, and the two views are free to diverge. */
function fmtReset(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
  const mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'resets soon'
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  const d = new Date(t)
  return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** "waiting 40s" / "waiting 4m" for how long an attention item has been sitting there. */
function waitingFor(since?: number): string {
  if (!since) return ''
  const diff = Math.max(0, Date.now() - since)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `waiting ${s}s`
  return `waiting ${Math.floor(s / 60)}m`
}

/** "in 2h" / "tomorrow 03:00" / "overdue" for a routine's next run. */
function nextRun(ts?: number): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return 'overdue'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return `in ${hours}h`
  const d = new Date(ts)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, tomorrow)) {
    return `tomorrow ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function formatDollars(v: number): string {
  return `$${v.toFixed(2)}`
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ScheduleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

/** Inline SVG mini bar chart for the last N days of spend — no charting library, just
 *  a percentage-based viewBox so it scales with the card regardless of rendered width. */
function SpendChart({ days }: { days: HomeSpend['days'] }) {
  if (days.length === 0) return null
  const max = Math.max(1e-6, ...days.map((d) => d.costUsd))
  const n = days.length
  const slot = 100 / n
  const barW = slot * 0.6
  return (
    <svg
      className="home-spend-chart"
      viewBox="0 0 100 26"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Daily spend, last ${n} days`}
    >
      {days.map((d, i) => {
        // A zero-cost day still gets a 1px sliver so the bar doesn't vanish from the row.
        const h = Math.max(1, (d.costUsd / max) * 26)
        const x = i * slot + (slot - barW) / 2
        const isLast = i === n - 1
        return (
          <rect
            key={d.day}
            x={x}
            y={26 - h}
            width={barW}
            height={h}
            rx={0.6}
            fill={isLast ? 'var(--accent)' : 'var(--bg-3)'}
          />
        )
      })}
    </svg>
  )
}

function AttentionIcon({ kind, mono }: { kind: HomeAttention['kind']; mono?: boolean }) {
  if (mono) return <TerminalIcon />
  if (kind === 'routine') return <AlertIcon />
  return <DocIcon />
}

interface PillItem {
  key: string
  label: string
}

// Where the (portaled) menu should sit, in viewport coordinates. Anchored to the
// pill's left edge, opens upward when there isn't enough room below — same scheme
// as ModelPicker, so menus never get clipped by the view's scroll container.
interface MenuPos {
  top?: number
  bottom?: number
  left: number
  maxHeight: number
}

/** The house picker pattern (see ModelPicker): a button that portals a fixed-position
 *  menu to <body>, closes on outside click / Escape / scroll / resize, and returns
 *  focus to the button on close so keyboard use isn't stranded in a detached portal. */
function PillPicker({
  buttonLabel,
  ariaLabel,
  items,
  selectedKey,
  onSelect,
  footerLabel,
  onFooter
}: {
  buttonLabel: string
  ariaLabel: string
  items: PillItem[]
  selectedKey: string | undefined
  onSelect: (key: string) => void
  footerLabel?: string
  onFooter?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) btnRef.current?.focus()
  }

  const toggle = () => {
    if (open) {
      close(false)
      return
    }
    const anchor = btnRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - 12
    const openUp = spaceBelow < 200 && r.top > spaceBelow
    setMenuPos({
      left: Math.max(8, r.left),
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: Math.max(160, (openUp ? r.top : spaceBelow) - 8)
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      close(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(true)
      }
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      close(false)
    }
    const onResize = () => close(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const moveFocus = (dir: 1 | -1) => {
    const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.home-pill-item') ?? [])
    if (focusable.length === 0) return
    const idx = focusable.indexOf(document.activeElement as HTMLButtonElement)
    const next = idx === -1 ? 0 : (idx + dir + focusable.length) % focusable.length
    focusable[next]?.focus()
  }

  return (
    <div className="home-pill-wrap">
      <button
        ref={btnRef}
        type="button"
        className="home-start-chip home-start-chip--btn"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {buttonLabel}
        <ChevronIcon />
      </button>
      {open &&
        menuPos &&
        createPortal(
          <div
            className="home-pill-menu"
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              top: menuPos.top,
              bottom: menuPos.bottom,
              left: menuPos.left,
              maxHeight: menuPos.maxHeight,
              overflowY: 'auto'
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                moveFocus(e.key === 'ArrowDown' ? 1 : -1)
              }
            }}
          >
            {items.length === 0 && <div className="home-pill-empty">Nothing yet</div>}
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                className={`home-pill-item ${it.key === selectedKey ? 'selected' : ''}`}
                role="menuitemradio"
                aria-checked={it.key === selectedKey}
                onClick={() => {
                  onSelect(it.key)
                  close(true)
                }}
              >
                <span className="home-pill-item-label">{it.label}</span>
                {it.key === selectedKey && <CheckIcon />}
              </button>
            ))}
            {footerLabel && onFooter && (
              <>
                <div className="home-pill-sep" />
                <button
                  type="button"
                  className="home-pill-item home-pill-item--action"
                  role="menuitem"
                  onClick={() => {
                    onFooter()
                    close(true)
                  }}
                >
                  {footerLabel}
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

export default function HomeView({
  attention,
  running,
  repos,
  plans,
  spend,
  routines,
  recent,
  start,
  startOptions,
  onAct,
  onStart,
  onPickFolder,
  onOpenSession,
  onOpenRepo,
  onOpenUsage,
  onOpenScheduled
}: Props) {
  const [prompt, setPrompt] = useState('')

  // Local choice, seeded from `start`. Each field tracks whether the user has
  // touched it (`touchedRef`): an untouched field keeps following `start` as it
  // changes underneath (e.g. the active session changes, bringing new defaults),
  // but a field the user already picked must NOT be clobbered by that — the sync
  // effect below only overwrites fields still marked untouched.
  const [choice, setChoice] = useState<HomeStartChoice>({
    projectPath: start.projectPath,
    modelId: start.modelId,
    accountId: start.accountId
  })
  const touchedRef = useRef({ projectPath: false, modelId: false, accountId: false })

  useEffect(() => {
    setChoice((prev) => ({
      projectPath: touchedRef.current.projectPath ? prev.projectPath : start.projectPath,
      modelId: touchedRef.current.modelId ? prev.modelId : start.modelId,
      accountId: touchedRef.current.accountId ? prev.accountId : start.accountId
    }))
  }, [start.projectPath, start.modelId, start.accountId])

  function pick(key: keyof HomeStartChoice, value: string) {
    touchedRef.current[key] = true
    setChoice((prev) => ({ ...prev, [key]: value }))
  }

  // Folders picked via "New project…" this session, so they show up in the list
  // (and stay selected) even though they're not in `startOptions.projects` yet.
  const [extraProjects, setExtraProjects] = useState<{ path: string; name: string }[]>([])

  async function handleNewProject() {
    const path = await onPickFolder()
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    setExtraProjects((prev) => (prev.some((p) => p.path === path) ? prev : [...prev, { path, name }]))
    touchedRef.current.projectPath = true
    setChoice((prev) => ({ ...prev, projectPath: path }))
  }

  const projectItems = useMemo<PillItem[]>(() => {
    const seen = new Set<string>()
    const out: PillItem[] = []
    for (const p of [...startOptions.projects, ...extraProjects]) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      out.push({ key: p.path, label: p.name })
    }
    return out
  }, [startOptions.projects, extraProjects])

  const modelItems = useMemo<PillItem[]>(
    () => startOptions.models.map((m) => ({ key: m.id, label: m.label })),
    [startOptions.models]
  )
  const accountItems = useMemo<PillItem[]>(
    () => startOptions.accounts.map((a) => ({ key: a.id, label: a.name })),
    [startOptions.accounts]
  )

  const projectLabel =
    projectItems.find((p) => p.key === choice.projectPath)?.label ?? start.projectName ?? 'Project'
  const modelLabel = modelItems.find((m) => m.key === choice.modelId)?.label ?? start.modelLabel ?? 'Model'
  const accountLabel =
    accountItems.find((a) => a.key === choice.accountId)?.label ?? start.accountName ?? 'Account'

  const nothing =
    attention.length === 0 &&
    running.length === 0 &&
    repos.length === 0 &&
    plans.length === 0 &&
    spend === null &&
    routines.length === 0 &&
    recent.length === 0

  const dirtyCount = repos.filter((r) => !r.loading && !r.error && r.fileCount > 0).length
  const todayLabel = new Date().toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  function submitStart() {
    const trimmed = prompt.trim()
    if (!trimmed) return
    onStart(trimmed, choice)
    // The choice itself is kept on purpose — someone who just picked a project is
    // likely about to start something else in the same one.
    setPrompt('')
  }

  // Header chips jump to their section and give it a brief highlight, so "N need
  // you" etc. actually lead somewhere instead of just naming a count.
  const attentionSectionRef = useRef<HTMLElement>(null)
  const runningSectionRef = useRef<HTMLElement>(null)
  const reposSectionRef = useRef<HTMLElement>(null)
  const [flash, setFlash] = useState<'attention' | 'running' | 'dirty' | null>(null)
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimeout.current) clearTimeout(flashTimeout.current)
    }
  }, [])

  function jumpTo(section: 'attention' | 'running' | 'dirty', ref: { current: HTMLElement | null }) {
    ref.current?.scrollIntoView({ block: 'nearest' })
    if (flashTimeout.current) clearTimeout(flashTimeout.current)
    setFlash(section)
    flashTimeout.current = setTimeout(() => setFlash(null), 1500)
  }

  const attentionPhrase =
    attention.length === 1 ? 'One item needs you' : `${attention.length} items need you`
  const runningPhrase =
    running.length === 1 ? 'One session is running' : `${running.length} sessions are running`
  const dirtyPhrase =
    dirtyCount === 1 ? 'One project has uncommitted changes' : `${dirtyCount} projects have uncommitted changes`

  return (
    <div className="view">
      <div className="view-header home-header">
        <div>
          <h1>Home</h1>
          <p className="view-sub">{todayLabel}</p>
        </div>
        <div className="home-header-chips">
          {attention.length > 0 && (
            <button
              type="button"
              className="home-chip home-chip--warn home-chip--link"
              onClick={() => jumpTo('attention', attentionSectionRef)}
              title={attentionPhrase}
              aria-label={attentionPhrase}
            >
              {attention.length === 1 ? '1 needs you' : `${attention.length} need you`}
            </button>
          )}
          {running.length > 0 && (
            <button
              type="button"
              className="home-chip home-chip--link"
              onClick={() => jumpTo('running', runningSectionRef)}
              title={runningPhrase}
              aria-label={runningPhrase}
            >
              {running.length === 1 ? '1 running' : `${running.length} running`}
            </button>
          )}
          {dirtyCount > 0 && (
            <button
              type="button"
              className="home-chip home-chip--link"
              onClick={() => jumpTo('dirty', reposSectionRef)}
              title={dirtyPhrase}
              aria-label={dirtyPhrase}
            >
              {dirtyCount === 1 ? '1 with changes' : `${dirtyCount} with changes`}
            </button>
          )}
        </div>
      </div>

        <div className="view-scroll">
          <div className="home-start">
            <textarea
              aria-label="What are we doing?"
              className="home-start-input"
              placeholder="What are we doing?"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submitStart()
                }
              }}
            />
            <div className="home-start-row">
              <div className="home-start-chips">
                <PillPicker
                  buttonLabel={projectLabel}
                  ariaLabel="Project"
                  items={projectItems}
                  selectedKey={choice.projectPath}
                  onSelect={(key) => pick('projectPath', key)}
                  footerLabel="New project…"
                  onFooter={handleNewProject}
                />
                {startOptions.models.length > 0 && (
                  <PillPicker
                    buttonLabel={modelLabel}
                    ariaLabel="Model"
                    items={modelItems}
                    selectedKey={choice.modelId}
                    onSelect={(key) => pick('modelId', key)}
                  />
                )}
                {startOptions.accounts.length > 0 && (
                  <PillPicker
                    buttonLabel={accountLabel}
                    ariaLabel="Account"
                    items={accountItems}
                    selectedKey={choice.accountId}
                    onSelect={(key) => pick('accountId', key)}
                  />
                )}
              </div>
              <button
                className="btn-primary home-start-btn"
                disabled={!prompt.trim()}
                onClick={submitStart}
              >
                Start
              </button>
            </div>
          </div>

          {nothing ? (
            <div className="view-empty">
              <span className="view-empty-msg">
                Nothing running, nothing waiting. Start something above.
              </span>
            </div>
          ) : (
          <div className="home-grid">
            <div className="home-col">
              {attention.length > 0 && (
                <section
                  ref={attentionSectionRef}
                  className={`home-section home-section--attention ${flash === 'attention' ? 'home-section--flash' : ''}`}
                  aria-label="Needs you"
                >
                  <h2 className="home-section-title">Needs you</h2>
                  <div className="home-attention-block">
                    {attention.map((a) => (
                      <div key={a.id} className="home-attention-row">
                        <span className="home-attention-icon" aria-hidden="true">
                          <AttentionIcon kind={a.kind} mono={a.mono} />
                        </span>
                        <div className="home-row-main">
                          <span className="home-row-name">{a.title}</span>
                          <span className={`home-attention-detail ${a.mono ? 'mono' : ''}`}>{a.detail}</span>
                          {(a.context || a.since) && (
                            <span className="home-attention-meta">
                              {a.context}
                              {a.context && a.since ? ' · ' : ''}
                              {waitingFor(a.since)}
                            </span>
                          )}
                        </div>
                        <button className="btn-ghost small home-attention-btn" onClick={() => onAct(a.id)}>
                          {a.actionLabel}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {running.length > 0 && (
                <section
                  ref={runningSectionRef}
                  className={`home-section ${flash === 'running' ? 'home-section--flash' : ''}`}
                  aria-label="Running"
                >
                  <h2 className="home-section-title">Running</h2>
                  <div className="home-list">
                    {running.map((r) => {
                      const clickable = r.kind === 'chat'
                      const dur = r.startedAt ? duration(r.startedAt) : ''
                      return (
                        <div
                          key={r.id}
                          className={`home-row home-running-row ${r.attention ? 'attention' : ''} ${clickable ? 'clickable' : ''}`}
                          onClick={clickable ? () => onOpenSession(r.id) : undefined}
                          role={clickable ? 'button' : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') onOpenSession(r.id)
                                }
                              : undefined
                          }
                        >
                          <span className={`home-dot ${r.attention ? 'attention' : 'running'}`} aria-hidden="true" />
                          <span className="home-row-name">{r.name}</span>
                          <span className="home-running-kind">{r.kind === 'chat' ? 'Chat' : 'CLI'}</span>
                          <span className="home-running-spacer" />
                          {r.detail && <span className="home-running-detail">{r.detail}</span>}
                          {dur && <span className="home-running-duration">{dur}</span>}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              {recent.length > 0 && (
                <section className="home-section" aria-label="Pick up where you left off">
                  <h2 className="home-section-title">Pick up where you left off</h2>
                  <div className="home-list">
                    {recent.map((r) => (
                      <div
                        key={r.id}
                        className="home-row home-recent-row clickable"
                        onClick={() => onOpenSession(r.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') onOpenSession(r.id)
                        }}
                      >
                        <div className="home-row-main">
                          <div className="home-row-top">
                            <span className="home-row-name">{r.name}</span>
                            {r.projectName && <span className="home-row-project">{r.projectName}</span>}
                            <span className="home-recent-time">{timeAgo(r.updatedAt)}</span>
                          </div>
                          <div className="home-recent-preview">{r.preview}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <div className="home-col">
              {(plans.length > 0 || spend !== null) && (
                <section className="home-section" aria-label="Plan and spend">
                  <h2 className="home-section-title">Plan &amp; spend</h2>
                  <button className="home-plan-card" onClick={onOpenUsage}>
                    {plans.map((p) => (
                      <div key={p.accountKey} className="home-plan-row">
                        <div className="home-plan-top">
                          <span className="home-plan-name">{p.accountName}</span>
                          {p.percent === null ? (
                            <span className="home-plan-nodata">no data</span>
                          ) : (
                            <span className="home-plan-percent">{Math.round(p.percent)}%</span>
                          )}
                        </div>
                        {p.percent !== null && (
                          <div className="home-plan-bar-track">
                            <div
                              className="home-plan-bar-fill"
                              style={{ width: `${Math.min(100, Math.max(0, p.percent))}%` }}
                            />
                          </div>
                        )}
                        {(fmtReset(p.resetsAt) || p.stale) && (
                          <span className="home-plan-sub">
                            {fmtReset(p.resetsAt)}
                            {p.stale ? ' · stale' : ''}
                          </span>
                        )}
                      </div>
                    ))}

                    {spend !== null && (
                      <>
                        {plans.length > 0 && <div className="home-plan-sep" />}
                        <div className="home-spend-top">
                          <span className="home-plan-name">Today</span>
                          <span className="home-plan-percent">{formatDollars(spend.today)}</span>
                        </div>
                        <SpendChart days={spend.days} />
                      </>
                    )}
                  </button>
                </section>
              )}

              {routines.length > 0 && (
                <section className="home-section" aria-label="Next up">
                  <div className="home-section-title-row">
                    <h2 className="home-section-title">Next up</h2>
                    <button className="home-section-action" onClick={onOpenScheduled}>
                      <ScheduleIcon />
                      Scheduled
                    </button>
                  </div>
                  <div className="home-list">
                    {routines.map((r) => (
                      <div key={r.id} className="home-row home-routine-row">
                        <div className="home-row-main">
                          <span className="home-row-name">{r.name}</span>
                          <span className="home-routine-sub">
                            {nextRun(r.nextRunAt)}
                            {nextRun(r.nextRunAt) ? ' · ' : ''}
                            {r.cadence}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {repos.length > 0 && (
                <section
                  ref={reposSectionRef}
                  className={`home-section ${flash === 'dirty' ? 'home-section--flash' : ''}`}
                  aria-label="Uncommitted work"
                >
                  <h2 className="home-section-title">Uncommitted work</h2>
                  <div className="home-list">
                    {repos.map((r) => (
                      <div key={r.key} className="home-row home-repo-row">
                        <div className="home-row-main">
                          <div className="home-row-top">
                            <span className="home-row-name">{r.name}</span>
                            {r.branch && <span className="home-row-project">{r.branch}</span>}
                          </div>
                          {r.error && (
                            <div className="home-repo-error" role="alert">
                              {r.error}
                            </div>
                          )}
                        </div>
                        {r.loading ? (
                          <span className="home-repo-loading">
                            <span className="view-spinner small" />
                          </span>
                        ) : r.error ? null : r.fileCount === 0 ? (
                          <span className="home-repo-clean">clean</span>
                        ) : (
                          <button className="btn-ghost small" onClick={() => onOpenRepo(r.key)}>
                            <FolderIcon />
                            {r.fileCount === 1 ? '1 file' : `${r.fileCount} files`}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
          )}
        </div>
    </div>
  )
}
