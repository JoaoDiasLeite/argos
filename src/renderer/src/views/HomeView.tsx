import { useState, useRef, useEffect, useMemo, ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ProviderId } from '../types'
import { CLI_PROVIDERS } from '../lib/cli-providers'
import './views.css'
import './HomeView.css'

export interface HomeAttention {
  id: string
  kind: 'approval'
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

/** A recently used project, dirty or not — the left side's "Recent projects". */
export interface HomeProject {
  key: string
  name: string
  branch?: string
  lastUsed: number
  loading?: boolean
  /** Set for a folder inside a WSL distro; shown as a neutral chip. */
  wslDistro?: string
  /** gitStatus answered and the folder is not a repository. */
  noGit?: boolean
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
  /** Which CLI the terminal starts. */
  provider?: ProviderId
  accountId?: string
  accountName?: string
}

export interface HomeStartChoice {
  projectPath?: string
  provider?: ProviderId
  accountId?: string
}

export interface HomeStartOptions {
  projects: { path: string; name: string }[]
  /** Every logged-in account, across providers. Filtered to the chosen CLI's. */
  accounts: { id: string; name: string; email?: string; provider: ProviderId }[]
}

/** The account a Start runs on and how far into its plan window it is (the header's
 *  subtitle). No usage fields when the provider reports none (Antigravity). */
export interface HomePlan {
  accountName: string
  utilization?: number
  resetsAt?: string
  windowMinutes?: number
}

interface Props {
  attention: HomeAttention[]
  running: HomeRunning[]
  repos: HomeRepo[]
  recentProjects: HomeProject[]
  recent: HomeRecent[]
  start: HomeStart
  startOptions: HomeStartOptions
  /** Null when no account is logged in for the default CLI. */
  plan: HomePlan | null
  onAct: (id: string) => void
  onStart: (prompt: string, choice: HomeStartChoice) => void
  onPickFolder: () => Promise<string | null>
  onOpenSession: (id: string) => void
  onOpenRepo: (key: string) => void
}

/** How many "Pick up where you left off" rows show before the rest fold. */
const RECENT_SHOWN = 6

/** Own copy on purpose — ProjectsView has its own, and this isn't shared across files
 *  (convention 1: no cross-file coupling to save a few lines). */
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

/** "18 min" / "2 h 5 min" for how long something has been going or waiting. */
function minutesSince(ts: number): string {
  const m = Math.floor(Math.max(0, Date.now() - ts) / 60000)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem ? `${h} h ${rem} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** "Thursday, 2 October". */
function dayTitle(d: Date): string {
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' })
  const month = d.toLocaleDateString('en-GB', { month: 'long' })
  return `${weekday}, ${d.getDate()} ${month}`
}

/** "5-hour window" / "weekly window" from the window's length in minutes. */
function windowName(minutes?: number): string {
  if (!minutes) return 'plan window'
  if (minutes === 10080) return 'weekly window'
  if (minutes < 1440) return `${Math.round(minutes / 60)}-hour window`
  return `${Math.round(minutes / 1440)}-day window`
}

/** "resets 19:40" today, "resets Fri 09:00" on another day. */
function resetLabel(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? `resets ${hm}` : `resets ${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`
}

function planLine(plan: HomePlan | null): string {
  if (!plan) return 'No account connected · Settings › Connection'
  const who = `${plan.accountName} account`
  if (plan.utilization === undefined) return who
  const pct = `${who} at ${plan.utilization.toFixed(0)} % of the ${windowName(plan.windowMinutes)}`
  const reset = resetLabel(plan.resetsAt)
  return reset ? `${pct} · ${reset}` : pct
}

function ChevronIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  )
}

interface SelectItem {
  key: string
  label: string
  /** Muted text after the label (an account's email). */
  detail?: string
}

// Where the (portaled) list should sit, in viewport coordinates. Anchored to the
// trigger's left edge, at least as wide as it, opening upward when there isn't room
// below — the list never gets clipped by the page's scroll container.
interface MenuPos {
  top?: number
  bottom?: number
  left: number
  minWidth: number
  maxHeight: number
}

/** A select-shaped trigger (§6) that portals a 4 px list of flat rows to <body>. Closes
 *  on outside click / Escape / scroll / resize and returns focus to the trigger, so
 *  keyboard use isn't stranded in a detached portal. */
function HomeSelect({
  value,
  ariaLabel,
  className,
  items,
  selectedKey,
  onSelect,
  footerLabel,
  onFooter
}: {
  value: ReactNode
  ariaLabel: string
  className: string
  items: SelectItem[]
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
      minWidth: r.width,
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
    const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.home-select-item') ?? [])
    if (focusable.length === 0) return
    const idx = focusable.indexOf(document.activeElement as HTMLButtonElement)
    const next = idx === -1 ? 0 : (idx + dir + focusable.length) % focusable.length
    focusable[next]?.focus()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`home-select ${className}`}
        onClick={toggle}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="home-select-value">{value}</span>
        <ChevronIcon />
      </button>
      {open &&
        menuPos &&
        createPortal(
          <div
            className="home-select-menu"
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            style={{
              top: menuPos.top,
              bottom: menuPos.bottom,
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              maxHeight: menuPos.maxHeight
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                moveFocus(e.key === 'ArrowDown' ? 1 : -1)
              }
            }}
          >
            {items.length === 0 && <div className="home-select-empty">Nothing yet</div>}
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                className={`home-select-item ${it.key === selectedKey ? 'selected' : ''}`}
                role="menuitemradio"
                aria-checked={it.key === selectedKey}
                onClick={() => {
                  onSelect(it.key)
                  close(true)
                }}
              >
                <span className="home-select-item-label">{it.label}</span>
                {it.detail && <span className="home-select-detail">{it.detail}</span>}
              </button>
            ))}
            {footerLabel && onFooter && (
              <button
                type="button"
                className="home-select-item home-select-footer"
                role="menuitem"
                onClick={() => {
                  onFooter()
                  close(true)
                }}
              >
                {footerLabel}
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

/** A whole row that opens something: Enter / Space act like a click. */
function rowProps(onOpen: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen()
      }
    }
  }
}

export default function HomeView({
  attention,
  running,
  repos,
  recentProjects,
  recent,
  start,
  startOptions,
  plan,
  onAct,
  onStart,
  onPickFolder,
  onOpenSession,
  onOpenRepo
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [recentOpen, setRecentOpen] = useState(false)

  // Local choice, seeded from `start`. Each field tracks whether the user has
  // touched it (`touchedRef`): an untouched field keeps following `start` as it
  // changes underneath (e.g. the active session changes, bringing new defaults),
  // but a field the user already picked must NOT be clobbered by that — the sync
  // effect below only overwrites fields still marked untouched.
  const [choice, setChoice] = useState<HomeStartChoice>({
    projectPath: start.projectPath,
    provider: start.provider,
    accountId: start.accountId
  })
  const touchedRef = useRef({ projectPath: false, provider: false, accountId: false })

  useEffect(() => {
    setChoice((prev) => ({
      projectPath: touchedRef.current.projectPath ? prev.projectPath : start.projectPath,
      provider: touchedRef.current.provider ? prev.provider : start.provider,
      accountId: touchedRef.current.accountId ? prev.accountId : start.accountId
    }))
  }, [start.projectPath, start.provider, start.accountId])

  function pick(key: keyof HomeStartChoice, value: string) {
    touchedRef.current[key] = true
    setChoice((prev) => ({ ...prev, [key]: value }))
  }

  // Folders picked via "New project" this session, so they show up in the list
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

  const projectItems = useMemo<SelectItem[]>(() => {
    const seen = new Set<string>()
    const out: SelectItem[] = []
    for (const p of [...startOptions.projects, ...extraProjects]) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      out.push({ key: p.path, label: p.name })
    }
    return out
  }, [startOptions.projects, extraProjects])

  const cliItems: SelectItem[] = CLI_PROVIDERS.map((p) => ({ key: p.id, label: p.label }))

  // An account only means anything next to its own CLI — a Codex login cannot run Claude
  // Code. The select therefore offers the chosen CLI's accounts only.
  const chosenProvider: ProviderId = choice.provider ?? 'claude'
  const accountItems = useMemo<SelectItem[]>(
    () =>
      startOptions.accounts
        .filter((a) => a.provider === chosenProvider)
        .map((a) => ({ key: a.id, label: a.name, detail: a.email })),
    [startOptions.accounts, chosenProvider]
  )

  // Switching to another CLI invalidates the selected account, so the account moves with
  // it rather than silently staying on a login that cannot run.
  const pickProvider = (provider: ProviderId) => {
    pick('provider', provider)
    if (provider === chosenProvider) return
    const first = startOptions.accounts.find((a) => a.provider === provider)
    if (first) pick('accountId', first.id)
  }

  const projectLabel =
    projectItems.find((p) => p.key === choice.projectPath)?.label ?? start.projectName ?? 'Project'
  const cliLabel = cliItems.find((p) => p.key === chosenProvider)?.label ?? 'CLI'
  const chosenAccount = accountItems.find((a) => a.key === choice.accountId)
  const accountLabel =
    chosenAccount?.label ?? start.accountName ?? choice.accountId ?? start.accountId ?? 'Account'

  function submitStart() {
    const trimmed = prompt.trim()
    if (!trimmed) return
    onStart(trimmed, choice)
    // The choice itself is kept on purpose — someone who just picked a project is
    // likely about to start something else in the same one.
    setPrompt('')
  }

  // Nothing live and nothing to resume: the page is the start box and one line.
  const nothing = attention.length === 0 && running.length === 0 && recent.length === 0

  const oldestSince = attention.reduce<number | undefined>(
    (min, a) => (a.since && (min === undefined || a.since < min) ? a.since : min),
    undefined
  )
  const shownRecent = recentOpen ? recent : recent.slice(0, RECENT_SHOWN)
  const hiddenRecent = recent.length - shownRecent.length

  return (
    <div className="view">
      <div className="home-page">
        <div className="home-main">
          <header className="home-head">
            <h1>{dayTitle(new Date())}</h1>
            <p className="home-sub">{planLine(plan)}</p>
          </header>

          <div className="home-start">
            <textarea
              aria-label="What are we doing?"
              className="text-input textarea home-start-input"
              placeholder="What are we doing?"
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
              <HomeSelect
                value={projectLabel}
                ariaLabel="Project"
                className="project"
                items={projectItems}
                selectedKey={choice.projectPath}
                onSelect={(key) => pick('projectPath', key)}
                footerLabel="New project"
                onFooter={handleNewProject}
              />
              <HomeSelect
                value={cliLabel}
                ariaLabel="CLI"
                className="cli"
                items={cliItems}
                selectedKey={chosenProvider}
                onSelect={(key) => pickProvider(key as ProviderId)}
              />
              {startOptions.accounts.length > 0 && (
                <HomeSelect
                  value={
                    <>
                      {accountLabel}
                      {chosenAccount?.detail && <span className="home-select-detail"> · {chosenAccount.detail}</span>}
                    </>
                  }
                  ariaLabel="Account"
                  className="account"
                  items={accountItems}
                  selectedKey={choice.accountId}
                  onSelect={(key) => pick('accountId', key)}
                />
              )}
              <span className="home-grow" />
              <button className="btn-primary" disabled={!prompt.trim()} onClick={submitStart}>
                <PlayIcon />
                Start
              </button>
            </div>
            <p className="help">Ctrl+Enter starts in a new terminal · the folder is the project's root</p>
          </div>

          <div className="home-body">
            {nothing ? (
              <p className="help">Nothing running, nothing waiting. Start something above.</p>
            ) : (
              <>
                {recent.length > 0 && (
                  <section aria-label="Pick up where you left off">
                    <h2 className="eyebrow home-eyebrow">Pick up where you left off</h2>
                    {shownRecent.map((r) => (
                      <div key={r.id} className="home-row home-recent" {...rowProps(() => onOpenSession(r.id))}>
                        <div className="home-recent-top">
                          <span className="home-name">{r.name}</span>
                          <span className="home-right">
                            {[r.projectName, timeAgo(r.updatedAt)].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                        {r.preview && <span className="help home-preview">{r.preview}</span>}
                      </div>
                    ))}
                    {hiddenRecent > 0 && (
                      <button type="button" className="btn-text home-more" onClick={() => setRecentOpen(true)}>
                        Show {hiddenRecent} more
                      </button>
                    )}
                  </section>
                )}

                {recentProjects.length > 0 && (
                  <section aria-label="Recent projects">
                    <h2 className="eyebrow home-eyebrow">Recent projects</h2>
                    {recentProjects.map((p) => (
                      <div key={p.key} className="home-row" {...rowProps(() => onOpenRepo(p.key))}>
                        <span className="home-name">{p.name}</span>
                        {p.wslDistro && <span className="chip">{p.wslDistro}</span>}
                        {p.loading ? (
                          <span className="view-spinner small" aria-label="Reading git status" />
                        ) : p.noGit ? (
                          <span className="home-muted">no git</span>
                        ) : (
                          p.branch && <span className="home-branch">{p.branch}</span>
                        )}
                        <span className="home-right">{timeAgo(p.lastUsed)}</span>
                      </div>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        <aside className="home-side" aria-label="What is live">
          {attention.length > 0 && (
            <div className="block warn home-needs" role="region" aria-label="Needs you">
              <div className="home-needs-head">
                <span className="home-needs-title">Needs you · {attention.length}</span>
                {oldestSince && <span className="home-right">oldest {minutesSince(oldestSince)}</span>}
              </div>
              {attention.map((a) => (
                <div key={a.id} className="home-needs-row">
                  <div className="home-needs-main">
                    <span className="home-name">{a.title}</span>
                    {a.detail &&
                      (a.mono ? (
                        <span className="home-needs-cmd">{a.detail}</span>
                      ) : (
                        <span className="help home-needs-text">{a.detail}</span>
                      ))}
                  </div>
                  <button className="btn-ghost small" onClick={() => onAct(a.id)}>
                    {a.actionLabel}
                  </button>
                </div>
              ))}
            </div>
          )}

          <section className="home-sec" aria-label="Running">
            <h2 className="eyebrow">Running · {running.length}</h2>
            {running.length === 0 && <p className="help">Nothing running.</p>}
            {/* TODO(port): an ops intervention as a running row with an --accent dot
                ("Ops · <host> · 41 min"); Home receives no ops runs today. */}
            {running.map((r) => {
              const clickable = r.kind === 'chat'
              const right = [r.detail, r.startedAt ? minutesSince(r.startedAt) : '']
                .filter(Boolean)
                .join(' · ')
              return (
                <div
                  key={r.id}
                  className={`home-row home-live ${clickable ? '' : 'static'}`}
                  {...(clickable ? rowProps(() => onOpenSession(r.id)) : {})}
                >
                  <span className="home-dot ok" aria-hidden="true" />
                  <span className="home-name">{r.name}</span>
                  <span className="home-right">{right}</span>
                </div>
              )
            })}
          </section>

          {!nothing && repos.length > 0 && (
            <section className="home-sec" aria-label="Uncommitted work">
              <h2 className="eyebrow">Uncommitted work · {repos.length}</h2>
              {repos.map((r) => (
                <div key={r.key} className="home-row home-live static">
                  <span className="home-name">{r.name}</span>
                  {r.branch && <span className="home-branch">{r.branch}</span>}
                  <span className="home-grow" />
                  {r.loading ? (
                    <span className="view-spinner small" aria-label="Counting changes" />
                  ) : r.error ? (
                    <span className="home-error" role="alert">
                      {r.error}
                    </span>
                  ) : (
                    <button className="btn-ghost small" onClick={() => onOpenRepo(r.key)}>
                      {r.fileCount === 1 ? '1 file' : `${r.fileCount} files`}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {/* TODO(port): "Earlier today · N finished" (finished chats and ops runs from
              today, with exit codes and a Report link); the renderer has no cheap source
              for it without new IPC. */}
        </aside>
      </div>
    </div>
  )
}
