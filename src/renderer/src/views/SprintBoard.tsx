import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Sprint,
  SprintItem,
  SprintBackfillCache,
  DailyStandup,
  ItemStatus,
  SprintStatus,
  CCAccountStatus,
  ModelInfo,
  ProviderAccountStatus,
  ProviderId
} from '../types'
import Menu, { MoreIcon, CaretDownIcon } from '../components/Menu'
import ModelPicker from '../components/ModelPicker'
import AccountPicker, { AccountPickerItem } from '../components/AccountPicker'
import './views.css'
import './PlannerView.css'
import './SprintBoard.css'

export type PlannerMode = 'week' | 'sprint' | 'backlog'
type SprintSection = 'board' | 'standup' | 'burndown'

interface SprintBoardProps {
  mode: PlannerMode
  onMode: (m: PlannerMode) => void
  accounts: CCAccountStatus[]
  models: ModelInfo[]
  defaultModel: string
  defaultAccountId: string
  /** Codex/Gemini accounts + their defaults — combined with `accounts`/`models` into a
   *  cross-provider "Run with" selector for the standup Generate + backlog backfill. */
  codexAccounts: ProviderAccountStatus[]
  geminiAccounts: ProviderAccountStatus[]
  codexDefaultAccountId: string
  geminiDefaultAccountId: string
  /** Open a light chat seeded with the standup context (talk through the day). */
  onStandupChat?: (context: string, opener: string, name: string) => void
  /** Create a daily standup routine and jump to Routines. */
  onScheduleStandup?: (name: string, prompt: string, projectPath?: string) => void
}

// Which provider a model id belongs to, given the app's model catalog — used to seed the
// "Run with" selector from the app-wide default model.
function providerOf(models: ModelInfo[], modelId: string): ProviderId {
  return models.find((m) => modelId.startsWith(m.id))?.provider ?? 'claude'
}

// The first catalog model for a given provider — used when switching providers in the
// "Run with" selector (the previous model won't exist under the new provider).
function firstModelForProvider(models: ModelInfo[], provider: ProviderId): string | undefined {
  return models.find((m) => m.provider === provider)?.id
}

// ─── Date helpers (local time, never round-trip through UTC) ────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function addDays(dateStr: string, n: number): string {
  const d = parseYmd(dateStr)
  d.setDate(d.getDate() + n)
  return ymd(d)
}
const uid = () =>
  crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e6)}`

const COLUMNS: { status: ItemStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'done', label: 'Done' }
]
const STATUS_LABELS: Record<SprintStatus, string> = {
  planning: 'Planning',
  active: 'Active',
  completed: 'Completed'
}

function pointsOf(i: SprintItem): number {
  return typeof i.points === 'number' && i.points > 0 ? i.points : 0
}

// Shared Week|Sprint segmented toggle — rendered by both PlannerView and SprintBoard so
// the control sits in the same header slot regardless of the active mode.
export function PlannerModeToggle({ mode, onMode }: { mode: PlannerMode; onMode: (m: PlannerMode) => void }) {
  return (
    <div
      className="seg-control planner-mode"
      title="Switch between the weekly planner, the sprint board and the repo's own backlog"
    >
      {(['week', 'sprint', 'backlog'] as const).map((m) => (
        <button key={m} className={mode === m ? 'on' : ''} onClick={() => onMode(m)}>
          {m === 'week' ? 'Week' : m === 'sprint' ? 'Sprint' : 'Backlog'}
        </button>
      ))}
    </div>
  )
}

export default function SprintBoard({
  mode,
  onMode,
  accounts,
  models,
  defaultModel,
  defaultAccountId,
  codexAccounts,
  geminiAccounts,
  codexDefaultAccountId,
  geminiDefaultAccountId,
  onStandupChat,
  onScheduleStandup
}: SprintBoardProps) {
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [drag, setDrag] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ItemStatus | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [sprintModal, setSprintModal] = useState<'new' | 'edit' | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [standupDate, setStandupDate] = useState(() => ymd(new Date()))
  // Which section of the sprint is shown — persisted like the Week/Sprint mode.
  const [section, setSection] = useState<SprintSection>(
    () => (['board', 'standup', 'burndown'].includes(localStorage.getItem('sprint.section') || '')
      ? (localStorage.getItem('sprint.section') as SprintSection)
      : 'board')
  )
  const changeSection = (s: SprintSection) => {
    setSection(s)
    localStorage.setItem('sprint.section', s)
  }
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─── Cross-provider "Run with" selector (standup Generate + backlog backfill) ─────────
  // Seeded from the app-wide default model/account, but switchable to any logged-in
  // Claude/Codex/Gemini account+model right from the sprint board — these two AI actions
  // don't otherwise have anywhere to pick a provider.
  const [runProvider, setRunProvider] = useState<ProviderId>(() => providerOf(models, defaultModel))
  const [runAccountId, setRunAccountId] = useState<string>(() => {
    const p = providerOf(models, defaultModel)
    return p === 'codex' ? codexDefaultAccountId : p === 'gemini' ? geminiDefaultAccountId : defaultAccountId
  })
  const [runModel, setRunModel] = useState<string>(defaultModel)

  // Accounts across all providers, pre-ordered claude → codex → gemini, for the picker.
  const runAccountItems: AccountPickerItem[] = useMemo(
    () => [
      ...accounts.map((a) => ({ provider: 'claude' as const, id: a.id, name: a.name, loggedIn: a.loggedIn, email: a.email, plan: a.plan })),
      ...codexAccounts.map((a) => ({ provider: 'codex' as const, id: a.id, name: a.name, loggedIn: a.loggedIn, email: a.email, plan: a.plan })),
      ...geminiAccounts.map((a) => ({ provider: 'gemini' as const, id: a.id, name: a.name, loggedIn: a.loggedIn, email: a.email, plan: a.plan }))
    ],
    [accounts, codexAccounts, geminiAccounts]
  )
  const runModels = useMemo(() => models.filter((m) => m.provider === runProvider), [models, runProvider])

  const pickRunAccount = (provider: ProviderId, id: string) => {
    setRunProvider(provider)
    setRunAccountId(id)
    // Switching provider invalidates the current model selection — jump to that
    // provider's first catalog model (falling back to whatever was selected before).
    setRunModel((prev) => (provider === runProvider ? prev : firstModelForProvider(models, provider) ?? prev))
  }

  const active = sprints.find((s) => s.id === activeId) ?? null

  // Load all sprints on mount; select the most-recently-updated one.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.sprintList().then((list) => {
      if (cancelled) return
      setSprints(list)
      setActiveId((prev) => prev || list[0]?.id || '')
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  // Persist one sprint (debounced) and keep it in the in-memory list.
  const persist = (next: Sprint) => {
    setSprints((prev) => {
      const has = prev.some((s) => s.id === next.id)
      return has ? prev.map((s) => (s.id === next.id ? next : s)) : [next, ...prev]
    })
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => window.electronAPI.sprintSave(next), 350)
  }

  // Mutate the active sprint immutably, then persist.
  const mutate = (fn: (s: Sprint) => Sprint) => {
    if (!active) return
    persist(fn(active))
  }

  // ─── Sprint CRUD ──────────────────────────────────────────────────────────
  const createSprint = (draft: {
    name: string
    goal: string
    startDate: string
    endDate: string
    status: SprintStatus
    projectPath?: string
  }) => {
    const now = Date.now()
    const s: Sprint = {
      id: uid(),
      name: draft.name.trim() || `Sprint ${sprints.length + 1}`,
      goal: draft.goal.trim(),
      startDate: draft.startDate,
      endDate: draft.endDate,
      status: draft.status,
      projectPath: draft.projectPath,
      items: [],
      standups: [],
      createdAt: now,
      updatedAt: now
    }
    persist(s)
    setActiveId(s.id)
    setSprintModal(null)
  }
  const patchSprint = (patch: Partial<Sprint>) => mutate((s) => ({ ...s, ...patch }))
  const deleteSprint = async () => {
    if (!active) return
    const list = await window.electronAPI.sprintDelete(active.id)
    setSprints(list)
    setActiveId(list[0]?.id ?? '')
    setSprintModal(null)
  }

  // ─── Item CRUD ────────────────────────────────────────────────────────────
  const addItem = (status: ItemStatus, title: string) => {
    const t = title.trim()
    if (!t) return
    mutate((s) => ({
      ...s,
      items: [
        ...s.items,
        { id: uid(), title: t, status, points: null, createdAt: Date.now(), completedAt: status === 'done' ? Date.now() : null }
      ]
    }))
  }
  const updateItem = (id: string, patch: Partial<SprintItem>) =>
    mutate((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === id ? applyItemPatch(i, patch) : i))
    }))
  const deleteItem = (id: string) => mutate((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }))
  const moveItem = (id: string, status: ItemStatus) => updateItem(id, { status })

  // The card checkbox steps an item forward through the workflow (todo → in-progress →
  // done); checking a done item steps it back to whatever it was before (not straight
  // to the backlog).
  const advanceItem = (item: SprintItem) => {
    if (item.status === 'done') {
      const back = item.prevStatus && item.prevStatus !== 'done' ? item.prevStatus : 'in-progress'
      moveItem(item.id, back)
    } else {
      moveItem(item.id, NEXT_STATUS[item.status])
    }
  }

  // Column header "check all" advances every item in that column one step forward.
  const advanceAll = (status: ItemStatus) => {
    const next = NEXT_STATUS[status]
    if (next === status) return
    mutate((s) => ({
      ...s,
      items: s.items.map((i) => (i.status === status ? applyItemPatch(i, { status: next }) : i))
    }))
  }

  // Persist the last GitLab backfill so re-opening the importer is instant.
  const cacheBackfill = (cache: SprintBackfillCache) => mutate((s) => ({ ...s, backfillCache: cache }))

  // Append imported issues (from the GitLab backfill) as fresh To-do items.
  const addBacklogItems = (rows: { title: string; points?: number | null; notes?: string }[]) =>
    mutate((s) => ({
      ...s,
      items: [
        ...s.items,
        ...rows.map((r) => ({
          id: uid(),
          title: r.title.trim(),
          notes: r.notes?.trim() || null,
          status: 'todo' as ItemStatus,
          points: typeof r.points === 'number' && r.points > 0 ? r.points : null,
          createdAt: Date.now(),
          completedAt: null
        }))
      ]
    }))

  // ─── Standups (one per date, upserted in place) ─────────────────────────────
  const standupFor = (date: string): DailyStandup =>
    active?.standups.find((s) => s.date === date) ?? {
      date,
      yesterday: '',
      today: '',
      blockers: '',
      updatedAt: 0
    }
  const patchStandup = (date: string, patch: Partial<Omit<DailyStandup, 'date'>>) =>
    mutate((s) => {
      const existing = s.standups.find((st) => st.date === date)
      const merged: DailyStandup = {
        ...(existing ?? { date, yesterday: '', today: '', blockers: '', updatedAt: 0 }),
        ...patch,
        date,
        updatedAt: Date.now()
      }
      const standups = existing
        ? s.standups.map((st) => (st.date === date ? merged : st))
        : [...s.standups, merged]
      return { ...s, standups }
    })
  const deleteStandup = (date: string) =>
    mutate((s) => ({ ...s, standups: s.standups.filter((st) => st.date !== date) }))

  // Draft a standup from git commits + the current board, then fill the day's fields.
  const generateStandup = async () => {
    if (!active || genBusy) return
    setGenBusy(true)
    setGenError(null)
    const summarize = (st: ItemStatus, label: string) => {
      const rows = active.items.filter((i) => i.status === st)
      return rows.length ? `${label}:\n${rows.map((i) => `  - ${i.title}`).join('\n')}` : ''
    }
    const boardSummary = [
      summarize('in-progress', 'In progress'),
      summarize('done', 'Done'),
      summarize('todo', 'To do')
    ]
      .filter(Boolean)
      .join('\n')
    const res = await window.electronAPI.standupGenerate({
      projectPath: active.projectPath,
      date: standupDate,
      boardSummary,
      model: runModel,
      accountId: runAccountId
    })
    setGenBusy(false)
    if (!res.ok || !res.data) {
      setGenError(res.error || 'Could not generate a standup.')
      return
    }
    patchStandup(standupDate, {
      yesterday: res.data.yesterday ?? '',
      today: res.data.today ?? '',
      blockers: res.data.blockers ?? ''
    })
  }

  // Open a light chat to talk through the day, seeded with the standup + board context.
  const discussStandup = () => {
    if (!active) return
    const context = buildStandupContext(active, standupFor(standupDate), standupDate)
    onStandupChat?.(
      context,
      "Let's talk through my day. Help me prioritise what to focus on today and think through how to clear any blockers.",
      `Standup chat · ${fmtDate(standupDate)}`
    )
  }

  // One-click create a daily standup routine for this sprint, then jump to Routines.
  const scheduleStandup = () => {
    if (!active) return
    const prompt =
      'Write my daily standup for today. Review my git commits from the last day in this project and summarise them, then produce three short sections — Yesterday (what got done), Today (what I plan to work on, inferred from recent/in-progress work), and Blockers (anything evident, otherwise say none). Be concise and concrete.'
    onScheduleStandup?.(`Daily standup — ${active.name}`, prompt, active.projectPath)
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const items = active?.items ?? []
    const total = items.reduce((n, i) => n + pointsOf(i), 0)
    const done = items.filter((i) => i.status === 'done').reduce((n, i) => n + pointsOf(i), 0)
    const byCol = (st: ItemStatus) => items.filter((i) => i.status === st)
    const pct = total ? Math.round((done / total) * 100) : 0
    return { total, done, remaining: total - done, count: items.length, byCol, pct }
  }, [active])

  // Whole days from today (inclusive) to the sprint's end; 0 once the end has passed.
  const daysLeft = useMemo(() => {
    if (!active) return 0
    const today = parseYmd(ymd(new Date()))
    const end = parseYmd(active.endDate)
    const diff = Math.round((end.getTime() - today.getTime()) / 86400000)
    return Math.max(0, diff + 1)
  }, [active])

  const editingItem = active?.items.find((i) => i.id === editingItemId) ?? null

  return (
    <div className="view">
      <div className="view-header planner-header">
        <div className="sprint-head-left">
          <PlannerModeToggle mode={mode} onMode={onMode} />
          {active && (
            <div>
              <h1 className="sprint-title">{active.name}</h1>
              <p className="view-sub">
                {parseYmd(active.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                {' – '}
                {parseYmd(active.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                {' · '}
                {stats.done}/{stats.total} pts · {stats.count} items
                {' · '}
                {daysLeft === 0 ? 'sprint ended' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
              </p>
            </div>
          )}
        </div>
        <div className="planner-header-actions">
          {sprints.length > 0 && (
            <SprintSwitcher
              sprints={sprints}
              activeId={activeId}
              onSelect={setActiveId}
            />
          )}
          {active && (
            <Menu
              triggerClass="assist-btn sb-icon-btn"
              triggerTitle="More sprint actions"
              triggerContent={<MoreIcon />}
              align="right"
              items={[
                { label: 'Backfill from GitLab', icon: <ImportIcon />, onClick: () => setBackfillOpen(true) },
                { label: 'Sprint settings', icon: <GearIcon />, onClick: () => setSprintModal('edit') }
              ]}
            />
          )}
          <button className="assist-btn primary" onClick={() => setSprintModal('new')}>
            + New sprint
          </button>
        </div>
      </div>

      {loading ? (
        <div className="view-loading">
          <div className="view-spinner" />
          <span className="view-loading-text">Loading sprints…</span>
        </div>
      ) : !active ? (
        <div className="sprint-empty">
          <div className="sprint-empty-card">
            <h2>No sprints yet</h2>
            <p>Create your first sprint to plan work on a Scrum board, log daily standups, and track a burndown.</p>
            <button className="assist-btn primary wide" onClick={() => setSprintModal('new')}>
              + New sprint
            </button>
          </div>
        </div>
      ) : (
        <div className="view-scroll sprint-scroll">
          <div className="planner-stats sprint-stats">
            <div className="stat-card">
              <div className="stat-ico sched"><Spark /></div>
              <div className="stat-body">
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">Total points</div>
              </div>
            </div>
            <div className="stat-card">
              <MiniRing pct={stats.pct} />
              <div className="stat-body">
                <div className="stat-value">
                  {stats.done}
                  <span className="stat-sub">/{stats.total || 0}</span>
                </div>
                <div className="stat-label">Points done</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-ico deep">↓</div>
              <div className="stat-body">
                <div className="stat-value">{stats.remaining}</div>
                <div className="stat-label">Remaining</div>
              </div>
            </div>
          </div>

          {active.goal?.trim() && (
            <div className="sprint-goal">
              <span className="planner-label">Sprint goal</span>
              <p>{active.goal}</p>
            </div>
          )}

          {/* Section tabs — keep the scroll focused on one thing at a time. */}
          <div className="seg-control sprint-tabs">
            {(['board', 'standup', 'burndown'] as SprintSection[]).map((s) => (
              <button key={s} className={section === s ? 'on' : ''} onClick={() => changeSection(s)}>
                {s === 'board' ? 'Board' : s === 'standup' ? 'Standup' : 'Burndown'}
              </button>
            ))}
          </div>

          {/* Kanban board */}
          {section === 'board' && (
          <div className="sprint-board">
            {COLUMNS.map((col) => {
              const colItems = stats.byCol(col.status)
              const pts = colItems.reduce((n, i) => n + pointsOf(i), 0)
              return (
                <div
                  key={col.status}
                  className={`sprint-col ${overCol === col.status ? 'over' : ''} ${col.status}`}
                  onDragOver={(e) => {
                    if (drag) {
                      e.preventDefault()
                      setOverCol(col.status)
                    }
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget === e.target) setOverCol(null)
                  }}
                  onDrop={() => {
                    if (drag) moveItem(drag, col.status)
                    setDrag(null)
                    setOverCol(null)
                  }}
                >
                  <div className="sprint-col-head">
                    <label className="sprint-col-check-wrap">
                      {col.status !== 'done' && (
                        <input
                          type="checkbox"
                          className="sprint-col-check"
                          checked={false}
                          disabled={colItems.length === 0}
                          onChange={() => advanceAll(col.status)}
                          title={`Move all to ${col.status === 'todo' ? 'In progress' : 'Done'}`}
                        />
                      )}
                      <span className="sprint-col-name">{col.label}</span>
                    </label>
                    <span className="sprint-col-count">
                      {colItems.length}
                      {pts > 0 && <em> · {pts}p</em>}
                    </span>
                  </div>
                  <div className="sprint-col-items">
                    {colItems.map((i) => (
                      <ItemCard
                        key={i.id}
                        item={i}
                        onDragStart={() => setDrag(i.id)}
                        onDragEnd={() => {
                          setDrag(null)
                          setOverCol(null)
                        }}
                        onOpen={() => setEditingItemId(i.id)}
                        onAdvance={() => advanceItem(i)}
                        onDelete={() => deleteItem(i.id)}
                      />
                    ))}
                    <AddItemInline onAdd={(t) => addItem(col.status, t)} />
                  </div>
                </div>
              )
            })}
          </div>
          )}

          {section === 'burndown' && <BurndownChart sprint={active} total={stats.total} />}

          {section === 'standup' && (
          <StandupSection
            date={standupDate}
            onDate={setStandupDate}
            standup={standupFor(standupDate)}
            history={[...active.standups].sort((a, b) => b.date.localeCompare(a.date))}
            onPatch={(patch) => patchStandup(standupDate, patch)}
            onEditHistory={setStandupDate}
            onDeleteHistory={deleteStandup}
            onGenerate={generateStandup}
            genBusy={genBusy}
            genError={genError}
            hasProject={!!active.projectPath}
            onDiscuss={onStandupChat ? discussStandup : undefined}
            onSchedule={onScheduleStandup ? scheduleStandup : undefined}
            runAccountItems={runAccountItems}
            runProvider={runProvider}
            runAccountId={runAccountId}
            onPickRunAccount={pickRunAccount}
            runModels={runModels}
            runModel={runModel}
            onPickRunModel={setRunModel}
          />
          )}
        </div>
      )}

      {sprintModal && (
        <SprintModal
          mode={sprintModal}
          sprint={sprintModal === 'edit' ? active : null}
          onCreate={createSprint}
          onPatch={patchSprint}
          onDelete={deleteSprint}
          onClose={() => setSprintModal(null)}
        />
      )}

      {editingItem && (
        <ItemModal
          item={editingItem}
          onPatch={(patch) => updateItem(editingItem.id, patch)}
          onDelete={() => {
            deleteItem(editingItem.id)
            setEditingItemId(null)
          }}
          onClose={() => setEditingItemId(null)}
        />
      )}

      {backfillOpen && active && (
        <BacklogBackfillModal
          sprint={active}
          model={runModel}
          accountId={runAccountId}
          onAdd={addBacklogItems}
          onCache={cacheBackfill}
          onClose={() => setBackfillOpen(false)}
        />
      )}
    </div>
  )
}

// Any status change records where the item came from (prevStatus) so un-checking 'done'
// can restore the previous column; entering 'done' stamps completedAt (burndown anchor).
function applyItemPatch(item: SprintItem, patch: Partial<SprintItem>): SprintItem {
  const next = { ...item, ...patch }
  if (patch.status !== undefined && patch.status !== item.status) {
    next.prevStatus = item.status
    if (patch.status === 'done') next.completedAt = item.completedAt ?? Date.now()
    else next.completedAt = null
  }
  return next
}

const NEXT_STATUS: Record<ItemStatus, ItemStatus> = {
  todo: 'in-progress',
  'in-progress': 'done',
  done: 'done'
}

// ─── Sprint switcher (built on the shared Menu) ─────────────────────────────────
function SprintSwitcher({
  sprints,
  activeId,
  onSelect
}: {
  sprints: Sprint[]
  activeId: string
  onSelect: (id: string) => void
}) {
  const active = sprints.find((s) => s.id === activeId)
  return (
    <Menu
      triggerClass="assist-btn sprint-switcher-trigger"
      triggerTitle="Switch sprint"
      triggerContent={
        <>
          <span className="sprint-switcher-current">{active?.name ?? 'Select sprint'}</span>
          <CaretDownIcon />
        </>
      }
      align="right"
      items={sprints.map((s) => ({
        label: s.name,
        icon: <span className={`sprint-status-dot ${s.status}`} title={STATUS_LABELS[s.status]} />,
        active: s.id === activeId,
        onClick: () => onSelect(s.id)
      }))}
    />
  )
}

// ─── Item card ──────────────────────────────────────────────────────────────
function ItemCard(props: {
  item: SprintItem
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
  onAdvance: () => void
  onDelete: () => void
}) {
  const i = props.item
  const advanceTitle =
    i.status === 'done'
      ? 'Move back a step'
      : i.status === 'todo'
        ? 'Move to In progress'
        : 'Mark done'
  return (
    <div
      className={`sprint-item ${i.status === 'done' ? 'done' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        props.onDragStart()
      }}
      onDragEnd={props.onDragEnd}
      onClick={props.onOpen}
      title="Click to edit · drag to move"
    >
      <div className="sprint-item-main">
        <button
          className={`task-check ${i.status === 'done' ? 'on' : ''} ${i.status === 'in-progress' ? 'partial' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onAdvance()
          }}
          title={advanceTitle}
        >
          {i.status === 'done' ? '✓' : ''}
        </button>
        <span className="sprint-item-title">{i.title}</span>
        <button
          className="task-del"
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete()
          }}
          title="Delete"
        >
          ×
        </button>
      </div>
      {pointsOf(i) > 0 && (
        <div className="sprint-item-meta">
          <span className="sprint-points">{pointsOf(i)} pts</span>
        </div>
      )}
    </div>
  )
}

function AddItemInline({ onAdd }: { onAdd: (t: string) => void }) {
  const [val, setVal] = useState('')
  return (
    <input
      className="add-task-inline"
      placeholder="+ add item"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && val.trim()) {
          onAdd(val)
          setVal('')
        }
      }}
      onBlur={() => {
        if (val.trim()) {
          onAdd(val)
          setVal('')
        }
      }}
    />
  )
}

// ─── Item editor modal ────────────────────────────────────────────────────────
const POINT_CHOICES = [1, 2, 3, 5, 8, 13]
function ItemModal(props: {
  item: SprintItem
  onPatch: (patch: Partial<SprintItem>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const i = props.item
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return createPortal(
    <div className="task-modal-overlay" onClick={props.onClose}>
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-modal-heading">Edit item</span>
          <button className="chip-x lg" onClick={props.onClose}>×</button>
        </div>
        <div className="task-modal-body">
          <textarea
            className="text-input task-modal-title"
            rows={2}
            value={i.title}
            placeholder="Item title"
            autoFocus
            onChange={(e) => props.onPatch({ title: e.target.value })}
          />

          <div className="task-modal-field">
            <span className="task-modal-label">Status</span>
            <div className="pill-row">
              {COLUMNS.map((c) => (
                <button
                  key={c.status}
                  className={`pill ${i.status === c.status ? 'on' : ''}`}
                  onClick={() => props.onPatch({ status: c.status })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="task-modal-field">
            <span className="task-modal-label">Story points</span>
            <div className="pill-row">
              <button className={`pill ${!i.points ? 'on' : ''}`} onClick={() => props.onPatch({ points: null })}>
                —
              </button>
              {POINT_CHOICES.map((p) => (
                <button
                  key={p}
                  className={`pill ${i.points === p ? 'on' : ''}`}
                  onClick={() => props.onPatch({ points: p })}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="task-modal-field">
            <span className="task-modal-label">Notes</span>
            <textarea
              className="text-input"
              rows={3}
              value={i.notes ?? ''}
              placeholder="Optional detail, acceptance criteria…"
              onChange={(e) => props.onPatch({ notes: e.target.value || null })}
            />
          </div>
        </div>
        <div className="task-modal-foot">
          <button className="btn-text danger" onClick={props.onDelete}>Delete item</button>
          <button className="assist-btn primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Sprint create/settings modal ──────────────────────────────────────────────
function SprintModal(props: {
  mode: 'new' | 'edit'
  sprint: Sprint | null
  onCreate: (draft: {
    name: string
    goal: string
    startDate: string
    endDate: string
    status: SprintStatus
    projectPath?: string
  }) => void
  onPatch: (patch: Partial<Sprint>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const isEdit = props.mode === 'edit' && props.sprint
  const today = ymd(new Date())
  const [name, setName] = useState(props.sprint?.name ?? '')
  const [goal, setGoal] = useState(props.sprint?.goal ?? '')
  const [startDate, setStartDate] = useState(props.sprint?.startDate ?? today)
  const [endDate, setEndDate] = useState(props.sprint?.endDate ?? addDays(today, 13))
  const [status, setStatus] = useState<SprintStatus>(props.sprint?.status ?? 'active')
  const [projectPath, setProjectPath] = useState<string | undefined>(props.sprint?.projectPath)

  const pickFolder = async () => {
    const folder = await window.electronAPI.openFolder()
    if (folder) {
      setProjectPath(folder)
      commitEdit({ projectPath: folder })
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // In edit mode, changes patch the live sprint immediately (consistent with the debounced save).
  const commitEdit = (patch: Partial<Sprint>) => isEdit && props.onPatch(patch)

  const statuses: SprintStatus[] = ['planning', 'active', 'completed']
  return createPortal(
    <div className="task-modal-overlay" onClick={props.onClose}>
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-modal-heading">{isEdit ? 'Sprint settings' : 'New sprint'}</span>
          <button className="chip-x lg" onClick={props.onClose}>×</button>
        </div>
        <div className="task-modal-body">
          <div className="task-modal-field">
            <span className="task-modal-label">Name</span>
            <input
              className="text-input"
              value={name}
              autoFocus
              placeholder="e.g. Sprint 14 — Checkout revamp"
              onChange={(e) => {
                setName(e.target.value)
                commitEdit({ name: e.target.value })
              }}
            />
          </div>
          <div className="task-modal-field">
            <span className="task-modal-label">Goal</span>
            <textarea
              className="text-input"
              rows={2}
              value={goal}
              placeholder="The one outcome this sprint is about"
              onChange={(e) => {
                setGoal(e.target.value)
                commitEdit({ goal: e.target.value })
              }}
            />
          </div>
          <div className="task-modal-times">
            <label>
              <span className="task-modal-label">Start</span>
              <input
                type="date"
                className="text-input"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  commitEdit({ startDate: e.target.value })
                }}
              />
            </label>
            <label>
              <span className="task-modal-label">End</span>
              <input
                type="date"
                className="text-input"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value)
                  commitEdit({ endDate: e.target.value })
                }}
              />
            </label>
          </div>
          <div className="task-modal-field">
            <span className="task-modal-label">Status</span>
            <div className="pill-row">
              {statuses.map((st) => (
                <button
                  key={st}
                  className={`pill ${status === st ? 'on' : ''}`}
                  onClick={() => {
                    setStatus(st)
                    commitEdit({ status: st })
                  }}
                >
                  {STATUS_LABELS[st]}
                </button>
              ))}
            </div>
          </div>
          <div className="task-modal-field">
            <span className="task-modal-label">Project folder</span>
            <div className="sprint-project-row">
              <span className="sprint-project-path" title={projectPath}>
                {projectPath || 'None — standups use the board only'}
              </span>
              <button className="assist-btn" onClick={pickFolder}>
                {projectPath ? 'Change' : 'Choose'}
              </button>
              {projectPath && (
                <button
                  className="btn-text danger"
                  onClick={() => {
                    setProjectPath(undefined)
                    commitEdit({ projectPath: undefined })
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <span className="sprint-project-hint">
              A git repo lets “Generate” read your recent commits for the standup.
            </span>
          </div>
        </div>
        <div className="task-modal-foot">
          {isEdit ? (
            <button className="btn-text danger" onClick={props.onDelete}>Delete sprint</button>
          ) : (
            <span />
          )}
          {isEdit ? (
            <button className="assist-btn primary" onClick={props.onClose}>Done</button>
          ) : (
            <button
              className="assist-btn primary"
              onClick={() => props.onCreate({ name, goal, startDate, endDate, status, projectPath })}
            >
              Create sprint
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Standup section (editor + saved history) ──────────────────────────────────
function fmtDate(dateStr: string): string {
  return parseYmd(dateStr).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

function StandupSection(props: {
  date: string
  onDate: (d: string) => void
  standup: DailyStandup
  history: DailyStandup[]
  onPatch: (patch: Partial<Omit<DailyStandup, 'date'>>) => void
  onEditHistory: (date: string) => void
  onDeleteHistory: (date: string) => void
  onGenerate: () => void
  genBusy: boolean
  genError: string | null
  hasProject: boolean
  onDiscuss?: () => void
  onSchedule?: () => void
  // Cross-provider "Run with" selector governing Generate (and the backfill modal).
  runAccountItems: AccountPickerItem[]
  runProvider: ProviderId
  runAccountId: string
  onPickRunAccount: (provider: ProviderId, id: string) => void
  runModels: ModelInfo[]
  runModel: string
  onPickRunModel: (modelId: string) => void
}) {
  const today = ymd(new Date())
  const s = props.standup
  const isToday = props.date === today
  return (
    <div className="standup">
      <div className="standup-head">
        <span className="planner-label">Daily standup</span>
        <div className="standup-head-right">
          <div className="assist-runwith standup-runwith">
            <div className="assist-runwith-field">
              <span className="assist-runwith-label">Account</span>
              <AccountPicker
                items={props.runAccountItems}
                selectedProvider={props.runProvider}
                selectedId={props.runAccountId}
                onPick={props.onPickRunAccount}
                onManage={() => {}}
                disabled={props.genBusy}
              />
            </div>
            <div className="assist-runwith-field">
              <span className="assist-runwith-label">Model</span>
              <ModelPicker models={props.runModels} value={props.runModel} onChange={props.onPickRunModel} disabled={props.genBusy} />
            </div>
          </div>
          <div className="sb-split">
            <button
              className="assist-btn primary sb-split-main"
              onClick={props.onGenerate}
              disabled={props.genBusy}
              title={
                props.hasProject
                  ? 'Draft this standup from your git commits and board'
                  : 'Draft from your board (set a project folder in Sprint settings to include git commits)'
              }
            >
              <Spark /> {props.genBusy ? 'Generating…' : 'Generate'}
            </button>
            {(props.onDiscuss || props.onSchedule) && (
              <Menu
                triggerClass="assist-btn primary sb-split-caret"
                triggerTitle="More standup actions"
                triggerContent={<CaretDownIcon />}
                align="right"
                items={[
                  ...(props.onDiscuss
                    ? [{ label: 'Discuss in chat', icon: <ChatIcon />, onClick: props.onDiscuss }]
                    : []),
                  ...(props.onSchedule
                    ? [{ label: 'Schedule daily routine', icon: <ClockIcon />, onClick: props.onSchedule }]
                    : [])
                ]}
              />
            )}
          </div>
          <div className="standup-datenav">
            {!isToday && (
              <button className="btn-ghost small" onClick={() => props.onDate(today)}>
                Today
              </button>
            )}
            <button className="standup-nav-btn" title="Previous day" onClick={() => props.onDate(addDays(props.date, -1))}>
              <ChevronIcon dir="left" />
            </button>
            <input
              type="date"
              className="text-input standup-date-input"
              value={props.date}
              onChange={(e) => e.target.value && props.onDate(e.target.value)}
            />
            <button className="standup-nav-btn" title="Next day" onClick={() => props.onDate(addDays(props.date, 1))}>
              <ChevronIcon dir="right" />
            </button>
          </div>
        </div>
      </div>

      {props.genError && <div className="assist-error standup-error">{props.genError}</div>}

      <div className="standup-grid">
        <StandupField
          label="Yesterday"
          hint="What did you get done?"
          value={s.yesterday}
          onChange={(v) => props.onPatch({ yesterday: v })}
        />
        <StandupField
          label="Today"
          hint="What are you working on?"
          value={s.today}
          onChange={(v) => props.onPatch({ today: v })}
        />
        <StandupField
          label="Blockers"
          hint="Anything in the way?"
          value={s.blockers}
          onChange={(v) => props.onPatch({ blockers: v })}
          tone="warn"
        />
      </div>

      {props.history.length > 0 && (
        <div className="standup-history">
          <span className="planner-label">Standup history</span>
          <div className="standup-history-list">
            {props.history.map((h) => (
              <StandupHistoryCard
                key={h.date}
                standup={h}
                active={h.date === props.date}
                onEdit={() => props.onEditHistory(h.date)}
                onDelete={() => props.onDeleteHistory(h.date)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StandupField(props: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  tone?: 'warn'
}) {
  return (
    <div className={`standup-field ${props.tone ?? ''}`}>
      <span className="standup-field-label">{props.label}</span>
      <textarea
        className="text-input standup-textarea"
        rows={4}
        placeholder={props.hint}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}

function StandupHistoryCard(props: {
  standup: DailyStandup
  active: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const h = props.standup
  const preview = (h.today || h.yesterday || h.blockers || '').replace(/\s+/g, ' ').slice(0, 90)
  return (
    <div className={`standup-hcard ${props.active ? 'active' : ''}`}>
      <div className="standup-hcard-head" onClick={() => setOpen((v) => !v)}>
        <span className="standup-hcard-date">{fmtDate(h.date)}</span>
        {!open && preview && <span className="standup-hcard-preview">{preview}</span>}
        {h.blockers.trim() && <span className="standup-blocked-dot" title="Had blockers" />}
        <button
          className="btn-ghost small"
          onClick={(e) => {
            e.stopPropagation()
            props.onEdit()
          }}
          title="Load into the editor"
        >
          Edit
        </button>
        <button
          className="task-del"
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete()
          }}
          title="Delete standup"
        >
          ×
        </button>
      </div>
      {open && (
        <div className="standup-hcard-body">
          {h.yesterday.trim() && <StandupReadRow label="Yesterday" text={h.yesterday} />}
          {h.today.trim() && <StandupReadRow label="Today" text={h.today} />}
          {h.blockers.trim() && <StandupReadRow label="Blockers" text={h.blockers} tone="warn" />}
        </div>
      )}
    </div>
  )
}

function StandupReadRow({ label, text, tone }: { label: string; text: string; tone?: 'warn' }) {
  return (
    <div className={`standup-read ${tone ?? ''}`}>
      <span className="standup-read-label">{label}</span>
      <p>{text}</p>
    </div>
  )
}

// ─── Burndown chart (hand-rolled SVG, no chart deps) ────────────────────────────
function BurndownChart({ sprint, total }: { sprint: Sprint; total: number }) {
  const data = useMemo(() => {
    const start = parseYmd(sprint.startDate)
    const end = parseYmd(sprint.endDate)
    const rawDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
    const n = Math.max(2, Math.min(rawDays, 60)) // guard: at least 2 points, cap runaway ranges
    const todayStr = ymd(new Date())

    // Points completed on or before each day, using completedAt (or the sprint start for
    // legacy done items that predate completedAt tracking).
    const doneOnOrBefore = (dayStr: string): number =>
      sprint.items
        .filter((i) => i.status === 'done')
        .filter((i) => {
          const when = i.completedAt ? ymd(new Date(i.completedAt)) : sprint.startDate
          return when <= dayStr
        })
        .reduce((sum, i) => sum + pointsOf(i), 0)

    const days: string[] = []
    const ideal: number[] = []
    const actual: (number | null)[] = []
    for (let i = 0; i < n; i++) {
      const dayStr = addDays(sprint.startDate, i)
      days.push(dayStr)
      ideal.push(total - (total * i) / (n - 1))
      // Only draw the actual line through today — the future is unknown.
      actual.push(dayStr <= todayStr ? total - doneOnOrBefore(dayStr) : null)
    }
    return { n, days, ideal, actual }
  }, [sprint, total])

  if (total === 0) {
    return (
      <div className="burndown">
        <span className="planner-label">Burndown</span>
        <p className="burndown-empty">Add story points to items to see the sprint burndown.</p>
      </div>
    )
  }

  const W = 640
  const H = 240
  const padL = 34
  const padR = 12
  const padT = 14
  const padB = 26
  const maxY = total
  const x = (i: number) => padL + (i / (data.n - 1)) * (W - padL - padR)
  const y = (v: number) => padT + (1 - v / maxY) * (H - padT - padB)

  const idealPts = data.ideal.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const actualPairs = data.actual
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null)
  const actualPts = actualPairs.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')

  // A couple of y gridlines (0, half, full) and sparse x labels (start / mid / end).
  const yTicks = [0, Math.round(total / 2), total]
  const xLabelIdx = [0, Math.floor((data.n - 1) / 2), data.n - 1]

  return (
    <div className="burndown">
      <div className="burndown-head">
        <span className="planner-label">Burndown</span>
        <div className="burndown-legend">
          <span className="bd-key ideal">Ideal</span>
          <span className="bd-key actual">Actual</span>
        </div>
      </div>
      <svg className="burndown-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Sprint burndown chart">
        {yTicks.map((t) => (
          <g key={t}>
            <line className="bd-grid" x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} />
            <text className="bd-axis" x={padL - 6} y={y(t) + 3} textAnchor="end">{t}</text>
          </g>
        ))}
        {xLabelIdx.map((i) => (
          <text key={i} className="bd-axis" x={x(i)} y={H - 8} textAnchor="middle">
            {parseYmd(data.days[i]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </text>
        ))}
        <polyline className="bd-line ideal" points={idealPts} />
        {actualPts && <polyline className="bd-line actual" points={actualPts} />}
        {actualPairs.map((p) => (
          <circle key={p.i} className="bd-dot" cx={x(p.i)} cy={y(p.v)} r={2.6} />
        ))}
      </svg>
    </div>
  )
}

function MiniRing({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className="mini-ring">
      <svg viewBox="0 0 36 36" width="40" height="40">
        <circle className="ring-bg" cx="18" cy="18" r="15.9" />
        <circle className="ring-fg good" cx="18" cy="18" r="15.9" strokeDasharray={`${p}, 100`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="mini-ring-num">{p}%</span>
    </div>
  )
}

// ─── Backlog backfill from GitLab MCP ──────────────────────────────────────────
function relBackfillTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

const SOURCE_LABELS: Record<string, string> = {
  'git-remote': 'from git remote',
  'mcp-default': 'MCP default project',
  instructions: 'from your input',
  guess: 'best guess'
}

function BacklogBackfillModal(props: {
  sprint: Sprint
  /** The "Run with" selection from the standup header — the same account+model runs both. */
  model: string
  accountId: string
  onAdd: (rows: { title: string; points?: number | null; notes?: string }[]) => void
  onCache: (cache: SprintBackfillCache) => void
  onClose: () => void
}) {
  const cache = props.sprint.backfillCache
  // Phase 1 — load the MCP and resolve which GitLab project it's attributed to.
  const [resolving, setResolving] = useState(!cache)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [project, setProject] = useState(cache?.project ?? '')
  const [info, setInfo] = useState<{ source?: string; url?: string; note?: string; openIssueCount?: number | null } | null>(
    cache ? { source: cache.source, url: cache.projectUrl, note: cache.note, openIssueCount: cache.openIssueCount ?? null } : null
  )

  // Phase 2 — fetch that project's open issues.
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [items, setItems] = useState<{ title: string; points?: number | null; notes?: string }[]>(cache?.items ?? [])
  const [hasFetched, setHasFetched] = useState(!!cache)
  const [cachedAt, setCachedAt] = useState<number | null>(cache?.fetchedAt ?? null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const existing = useMemo(
    () => new Set(props.sprint.items.map((i) => i.title.trim().toLowerCase())),
    [props.sprint]
  )
  const isDup = (title: string) => existing.has(title.trim().toLowerCase())
  const busy = resolving || fetching

  // Pre-select fetched issues that aren't already on the board (skip duplicates).
  const preselect = (rows: { title: string }[]) =>
    setSelected(new Set(rows.map((f, i) => (isDup(f.title) ? -1 : i)).filter((i) => i >= 0)))

  const resolveProject = async () => {
    setResolving(true)
    setResolveError(null)
    const res = await window.electronAPI.sprintBackfill({
      projectPath: props.sprint.projectPath,
      probe: true,
      model: props.model,
      accountId: props.accountId
    })
    setResolving(false)
    if (!res.ok || !res.data) {
      setResolveError(res.error || 'Could not load the GitLab MCP.')
      return
    }
    setProject(res.data.project || '')
    setInfo({
      source: res.data.source,
      url: res.data.url,
      note: res.data.note,
      openIssueCount: res.data.openIssueCount ?? null
    })
  }

  useEffect(() => {
    // Cached results hydrate the initial state above — only probe when there's no cache.
    if (cache) preselect(cache.items ?? [])
    else resolveProject()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchIssues = async () => {
    setFetching(true)
    setFetchError(null)
    setHasFetched(false)
    const res = await window.electronAPI.sprintBackfill({
      projectPath: props.sprint.projectPath,
      instructions: project.trim() || undefined,
      model: props.model,
      accountId: props.accountId
    })
    setFetching(false)
    setHasFetched(true)
    if (!res.ok || !res.data) {
      setFetchError(res.error || 'Could not fetch issues.')
      return
    }
    const fetched = (res.data.items ?? []).filter((i) => i && i.title && i.title.trim())
    setItems(fetched)
    preselect(fetched)
    // Cache the fresh result so re-opening is instant (persisted on the sprint).
    const now = Date.now()
    setCachedAt(now)
    props.onCache({
      fetchedAt: now,
      project: project.trim() || undefined,
      projectUrl: info?.url,
      source: info?.source,
      note: info?.note,
      openIssueCount: info?.openIssueCount ?? null,
      items: fetched
    })
  }

  const toggle = (i: number) =>
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })

  const addSelected = () => {
    const chosen = items.filter((_, i) => selected.has(i))
    if (chosen.length) props.onAdd(chosen)
    props.onClose()
  }

  return createPortal(
    <div className="task-modal-overlay" onClick={props.onClose}>
      <div className="task-modal backfill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-modal-heading">
            <ImportIcon /> Backfill backlog from GitLab
          </span>
          <button className="chip-x lg" onClick={props.onClose}>×</button>
        </div>
        <div className="task-modal-body">
          {/* Phase 1 — which project the MCP is attributed to */}
          {resolving ? (
            <div className="assist-loading">
              <div className="view-spinner" />
              <span>Loading the GitLab MCP and finding the attributed project…</span>
            </div>
          ) : (
            <div className="backfill-attribution">
              <span className="planner-label">Attributed project</span>
              {info?.note && <p className="backfill-attr-note">{info.note}</p>}
              <div className="backfill-project-row">
                <input
                  className="text-input"
                  placeholder="group/subgroup/project — or a filter"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && fetchIssues()}
                />
                <button className="assist-btn primary" onClick={fetchIssues} disabled={busy}>
                  {fetching ? 'Fetching…' : hasFetched && items.length > 0 ? 'Refresh' : 'Fetch issues'}
                </button>
              </div>
              <div className="backfill-attr-meta">
                {info?.source && <span className="backfill-source">{SOURCE_LABELS[info.source] ?? info.source}</span>}
                {typeof info?.openIssueCount === 'number' && (
                  <span className="backfill-attr-count">{info.openIssueCount} open</span>
                )}
                {info?.url && <span className="backfill-attr-url" title={info.url}>{info.url}</span>}
                {cachedAt && <span className="backfill-cached">cached {relBackfillTime(cachedAt)}</span>}
              </div>
              {resolveError && (
                <div className="assist-error">{resolveError} — you can still type a project above and fetch.</div>
              )}
            </div>
          )}

          {/* Phase 2 — the project's open issues */}
          {fetching && (
            <div className="assist-loading">
              <div className="view-spinner" />
              <span>Reading open issues from GitLab…</span>
            </div>
          )}
          {fetchError && !fetching && <div className="assist-error">{fetchError}</div>}
          {hasFetched && !fetching && !fetchError && items.length === 0 && (
            <p className="burndown-empty">No open issues came back. Try a different project or filter above.</p>
          )}
          {!fetching && items.length > 0 && (
            <>
              <div className="backfill-actions-row">
                <span className="backfill-count">
                  {items.filter((it) => !isDup(it.title)).length} new
                  {items.some((it) => isDup(it.title)) &&
                    ` · ${items.filter((it) => isDup(it.title)).length} already added`}
                  {' · '}
                  {selected.size} selected
                </span>
                <div className="backfill-selbtns">
                  <button className="btn-ghost small" onClick={() => setSelected(new Set(items.map((_, i) => i)))}>All</button>
                  <button className="btn-ghost small" onClick={() => setSelected(new Set())}>None</button>
                </div>
              </div>
              <div className="backfill-list">
                {items.map((it, i) => {
                  const dup = isDup(it.title)
                  return (
                    <label key={i} className={`backfill-row ${dup ? 'dup' : ''}`}>
                      <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                      <span className="backfill-row-body">
                        <span className="backfill-row-title">{it.title}</span>
                        {it.notes?.trim() && <span className="backfill-row-notes">{it.notes}</span>}
                      </span>
                      {typeof it.points === 'number' && it.points > 0 && (
                        <span className="sprint-points">{it.points} pts</span>
                      )}
                      {dup && <span className="backfill-dup-tag">already added</span>}
                    </label>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <div className="task-modal-foot">
          <button className="btn-text" onClick={props.onClose}>Cancel</button>
          <button className="assist-btn primary" onClick={addSelected} disabled={busy || selected.size === 0}>
            Add {selected.size || ''} to backlog
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ImportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function Spark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  )
}

// Serialize the current standup + board into a compact context block for the discuss chat.
function buildStandupContext(sprint: Sprint, standup: DailyStandup, date: string): string {
  const lines: string[] = [
    `You are helping me (a developer) talk through my day. Here is my current sprint and standup — keep answers concise and practical.`,
    '',
    `Sprint: ${sprint.name}`
  ]
  if (sprint.goal?.trim()) lines.push(`Goal: ${sprint.goal.trim()}`)
  lines.push('', `Standup for ${date}:`)
  lines.push(`  Yesterday: ${standup.yesterday.trim() || '(empty)'}`)
  lines.push(`  Today: ${standup.today.trim() || '(empty)'}`)
  lines.push(`  Blockers: ${standup.blockers.trim() || '(none)'}`)
  lines.push('', 'Sprint board:')
  const section = (st: ItemStatus, label: string) => {
    const rows = sprint.items.filter((i) => i.status === st)
    if (!rows.length) return
    lines.push(`  ${label}:`)
    for (const i of rows) lines.push(`    - ${i.title}${pointsOf(i) ? ` (${pointsOf(i)}p)` : ''}`)
  }
  section('in-progress', 'In progress')
  section('todo', 'To do')
  section('done', 'Done')
  return lines.join('\n')
}
