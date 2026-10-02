import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Sprint,
  SprintItem,
  SprintBackfillCache,
  BackfillKind,
  BackfillRow,
  Forge,
  DailyStandup,
  ItemStatus,
  SprintStatus,
  CCAccountStatus,
  ModelInfo,
  ProviderAccountStatus,
  ProviderId
} from '../types'
import Menu, { MoreIcon } from '../components/Menu'
import Sheet from '../components/Sheet'
import { originOf, kindLabel, FORGE_NAMES } from '../lib/sprint-origin'
import ModelPicker from '../components/ModelPicker'
import AccountPicker, { AccountPickerItem } from '../components/AccountPicker'
import './views.css'
import './SprintBoard.css'

export type PlannerMode = 'week' | 'sprint'

interface SprintBoardProps {
  mode: PlannerMode
  /** Absent when the weekly planner is off: there is nothing to switch to, so no toggle. */
  onMode?: (m: PlannerMode) => void
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
const dayMs = 86_400_000
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
// Fixed English names, as the rest of the UI: a locale would turn "Sep" into "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "29 Sep" */
function fmtShort(dateStr: string): string {
  const d = parseYmd(dateStr)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
/** "Thu 2 Oct" */
function fmtDay(dateStr: string): string {
  return `${WEEKDAYS[parseYmd(dateStr).getDay()]} ${fmtShort(dateStr)}`
}
/** "Tue" within the last week, "29 Sep" before that. */
function fmtSince(dateStr: string): string {
  const days = Math.round((parseYmd(ymd(new Date())).getTime() - parseYmd(dateStr).getTime()) / dayMs)
  return days >= 0 && days < 7 ? WEEKDAYS[parseYmd(dateStr).getDay()] : fmtShort(dateStr)
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

/** Enter on a sheet is ignored this long after it opens (§6). */
const ENTER_GRACE_MS = 400

/**
 * The forge a sprint talks to: whatever its last import used, else GitLab. The probe
 * corrects it from the project's git remote as soon as the importer opens.
 */
function forgeOf(sprint: Sprint | null): Forge {
  return sprint?.backfillCache?.forge ?? 'gitlab'
}

function pointsOf(i: SprintItem): number {
  return typeof i.points === 'number' && i.points > 0 ? i.points : 0
}

/** The last segment of the sprint's project folder: "Portal municipal". */
function projectNameOf(s: Sprint): string | undefined {
  return s.projectPath?.split(/[\\/]/).filter(Boolean).pop()
}

/** How many blockers a standup lists: one per non-empty line, bullets stripped. */
function blockerCount(text: string): number {
  return text
    .split('\n')
    .map((l) => l.replace(/^[\s\-*•]+/, '').trim())
    .filter(Boolean).length
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does a standup's Blockers text name this item, by its title or its forge reference? */
function mentions(text: string, item: SprintItem): boolean {
  if (!text.trim()) return false
  const title = item.title.trim().toLowerCase()
  if (title.length >= 4 && text.toLowerCase().includes(title)) return true
  const ref = originOf(item)?.ref
  return !!ref && new RegExp(`(^|[^\\w])${escapeRe(ref)}(?!\\d)`).test(text)
}

/** "Waiting on the client's IdP team." when the blockers text says who it waits on. */
function waitingOn(text: string): string | undefined {
  const m = text.match(/waiting on ([^.\n]+)/i)
  return m ? `Waiting on ${m[1].trim()}.` : undefined
}

interface BlockInfo {
  item: SprintItem
  /** The first standup of the unbroken run that names it. */
  since: string
  waiting?: string
}

/**
 * Items have no blocked flag, so "blocked" is read from the standups: an open item that
 * the latest standup (today or before) names in its Blockers is blocked, since the
 * earliest standup of the unbroken run that names it. A standup whose Blockers no longer
 * name it clears it.
 */
// TODO(port): SprintItem has no blocked flag, so there is nothing for "Unblock" to clear.
function blockedItems(sprint: Sprint): BlockInfo[] {
  const today = ymd(new Date())
  const past = sprint.standups
    .filter((s) => s.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
  const latest = past[0]
  if (!latest || !latest.blockers.trim()) return []
  const out: BlockInfo[] = []
  for (const item of sprint.items) {
    if (item.status === 'done' || !mentions(latest.blockers, item)) continue
    let since = latest.date
    for (const s of past.slice(1)) {
      if (!mentions(s.blockers, item)) break
      since = s.date
    }
    out.push({ item, since, waiting: waitingOn(latest.blockers) })
  }
  return out
}

// What happens to the unfinished items when a sprint is completed.
type CarryChoice =
  | { kind: 'keep' }
  | { kind: 'existing'; sprintId: string }
  | { kind: 'new'; name: string }

/** Inclusive length of a sprint in days — reused for the sprint that follows it. */
function sprintLengthDays(s: Sprint): number {
  const n = Math.round((parseYmd(s.endDate).getTime() - parseYmd(s.startDate).getTime()) / dayMs) + 1
  return n > 0 ? n : 14
}

/** "Sprint 3 — Checkout" -> "Sprint 4 — Checkout"; falls back to a plain count. */
function nextSprintName(prev: string, count: number): string {
  const m = prev.match(/(\d+)/)
  return m ? prev.replace(/\d+/, String(Number(m[1]) + 1)) : `Sprint ${count + 1}`
}

/** Enter submits a sheet's form, except on a control with its own Enter, and never in the
 *  first moments after the sheet opened, so the keystroke that opened it cannot submit it. */
function enterSubmits(e: ReactKeyboardEvent, openedAt: number, submit: () => void) {
  if (e.key !== 'Enter') return
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') return
  if (Date.now() - openedAt < ENTER_GRACE_MS) return
  e.preventDefault()
  submit()
}

// Shared Week|Sprint segmented toggle — rendered by both PlannerView and SprintBoard so
// the control sits in the same header slot regardless of the active mode.
export function PlannerModeToggle({ mode, onMode }: { mode: PlannerMode; onMode: (m: PlannerMode) => void }) {
  return (
    <div className="seg-control planner-mode" title="Switch between the weekly planner and the sprint board">
      {(['week', 'sprint'] as const).map((m) => (
        <button key={m} className={mode === m ? 'on' : ''} onClick={() => onMode(m)}>
          {m === 'week' ? 'Week' : 'Sprint'}
        </button>
      ))}
    </div>
  )
}

type SprintDraft = {
  name: string
  goal: string
  startDate: string
  endDate: string
  status: SprintStatus
  projectPath?: string
}

type ItemDraft = { title: string; status: ItemStatus; points: number | null; notes: string | null }

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
  onStandupChat
}: SprintBoardProps) {
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [drag, setDrag] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<ItemStatus | null>(null)
  // The item sheet: an existing item's id, or 'new' for one being added to To do.
  const [itemSheet, setItemSheet] = useState<string | null>(null)
  const [sprintSheet, setSprintSheet] = useState<'new' | 'edit' | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [standupDate, setStandupDate] = useState(() => ymd(new Date()))
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

  // Accounts across all providers, pre-ordered claude -> codex -> gemini, for the picker.
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

  // Write several sprints at once (sprint completion moves items between two of them).
  // The debounced `persist` keeps a single timer, so a second call would swallow the
  // first — these go straight to disk instead.
  const persistAll = (next: Sprint[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSprints((prev) => {
      const byId = new Map(next.map((s) => [s.id, s]))
      const merged = prev.map((s) => byId.get(s.id) ?? s)
      const added = next.filter((s) => !prev.some((p) => p.id === s.id))
      return [...added, ...merged]
    })
    next.forEach((s) => window.electronAPI.sprintSave(s))
  }

  // Mutate the active sprint immutably, then persist. A completed sprint is a closed
  // record — every board edit routes through here, so locking it here locks all of them.
  const mutate = (fn: (s: Sprint) => Sprint) => {
    if (!active || active.status === 'completed') return
    persist(fn(active))
  }

  // ─── Sprint CRUD ──────────────────────────────────────────────────────────
  const createSprint = (draft: SprintDraft) => {
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
    setSprintSheet(null)
  }
  // Sprint-level fields (name, dates, status…) stay editable even once completed —
  // that's how a sprint gets reopened.
  const patchSprint = (patch: Partial<Sprint>) => {
    if (!active) return
    persist({ ...active, ...patch })
  }
  const deleteSprint = async () => {
    if (!active) return
    const list = await window.electronAPI.sprintDelete(active.id)
    setSprints(list)
    setActiveId(list[0]?.id ?? '')
    setSprintSheet(null)
  }

  // ─── Closing a sprint ─────────────────────────────────────────────────────
  // Completing marks the sprint done and decides what happens to the items that
  // didn't make it: leave them on the record, hand them to an existing sprint, or
  // roll them into a fresh one that starts the day after this one ended.
  const completeSprint = (carry: CarryChoice) => {
    if (!active) return
    const unfinished = active.items.filter((i) => i.status !== 'done')
    const closed: Sprint = { ...active, status: 'completed' as SprintStatus, updatedAt: Date.now() }

    if (carry.kind === 'keep' || unfinished.length === 0) {
      persistAll([closed])
      setCompleteOpen(false)
      return
    }

    // Carried items start over in the receiving sprint: no completion stamp, and no
    // "previous status" pointing back at a column in the sprint they just left.
    const carried = unfinished.map((i) => ({ ...i, completedAt: null, prevStatus: null }))
    closed.items = active.items.filter((i) => i.status === 'done')

    if (carry.kind === 'existing') {
      const target = sprints.find((s) => s.id === carry.sprintId)
      if (!target) return
      const next: Sprint = { ...target, items: [...target.items, ...carried], updatedAt: Date.now() }
      persistAll([closed, next])
      setCompleteOpen(false)
      setActiveId(next.id)
      return
    }

    const now = Date.now()
    const start = addDays(active.endDate, 1)
    const created: Sprint = {
      id: uid(),
      name: carry.name.trim() || nextSprintName(active.name, sprints.length),
      goal: '',
      startDate: start,
      endDate: addDays(start, sprintLengthDays(active) - 1),
      status: 'active',
      projectPath: active.projectPath,
      items: carried,
      standups: [],
      createdAt: now,
      updatedAt: now
    }
    persistAll([closed, created])
    setCompleteOpen(false)
    setActiveId(created.id)
  }

  const reopenSprint = () => patchSprint({ status: 'active' })

  // The open sprint that follows this one, if any: where a blocked item can go.
  const nextSprint = useMemo(() => {
    if (!active) return null
    return (
      sprints
        .filter((s) => s.id !== active.id && s.status !== 'completed' && s.startDate > active.startDate)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
    )
  }, [sprints, active])

  // Hand one item to another sprint; it starts over there like a carried item.
  // TODO(port): there is no backlog model, so a blocked item offers no "Move to backlog".
  const moveToSprint = (item: SprintItem, target: Sprint) => {
    if (!active || active.status === 'completed') return
    persistAll([
      { ...active, items: active.items.filter((i) => i.id !== item.id), updatedAt: Date.now() },
      { ...target, items: [...target.items, { ...item, completedAt: null, prevStatus: null }], updatedAt: Date.now() }
    ])
  }

  // ─── Item CRUD ────────────────────────────────────────────────────────────
  const addItem = (draft: ItemDraft) => {
    const t = draft.title.trim()
    if (!t) return
    mutate((s) => ({
      ...s,
      items: [
        ...s.items,
        {
          id: uid(),
          title: t,
          notes: draft.notes?.trim() || null,
          status: draft.status,
          points: draft.points,
          createdAt: Date.now(),
          completedAt: draft.status === 'done' ? Date.now() : null
        }
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

  // The item's hover control steps it forward through the workflow (todo -> in-progress ->
  // done); on a done item it steps back to whatever it was before (not straight to To do).
  const advanceItem = (item: SprintItem) => {
    if (item.status === 'done') {
      const back = item.prevStatus && item.prevStatus !== 'done' ? item.prevStatus : 'in-progress'
      moveItem(item.id, back)
    } else {
      moveItem(item.id, NEXT_STATUS[item.status])
    }
  }

  // The column head's control advances every item in that column one step forward.
  const advanceAll = (status: ItemStatus) => {
    const next = NEXT_STATUS[status]
    if (next === status) return
    mutate((s) => ({
      ...s,
      items: s.items.map((i) => (i.status === status ? applyItemPatch(i, { status: next }) : i))
    }))
  }

  // Persist the last forge backfill so re-opening the importer is instant.
  const cacheBackfill = (cache: SprintBackfillCache) => mutate((s) => ({ ...s, backfillCache: cache }))

  // Append imported issues / change requests (from the forge backfill) as fresh To-do items.
  const addBacklogItems = (rows: BackfillRow[], forge: Forge) =>
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
          ref: r.ref?.trim() || null,
          kind: r.kind ?? null,
          forge,
          url: r.url?.trim() || null,
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
      `Standup chat · ${fmtDay(standupDate)}`
    )
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const items = active?.items ?? []
    const total = items.reduce((n, i) => n + pointsOf(i), 0)
    const done = items.filter((i) => i.status === 'done').reduce((n, i) => n + pointsOf(i), 0)
    const byCol = (st: ItemStatus) => items.filter((i) => i.status === st)
    return { total, done, count: items.length, byCol }
  }, [active])

  // Whole days from today (inclusive) to the sprint's end; 0 once the end has passed.
  const daysLeft = useMemo(() => {
    if (!active) return 0
    const today = parseYmd(ymd(new Date()))
    const end = parseYmd(active.endDate)
    const diff = Math.round((end.getTime() - today.getTime()) / dayMs)
    return Math.max(0, diff + 1)
  }, [active])
  const daysLeftLabel = daysLeft === 0 ? 'sprint ended' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`

  const blocked = useMemo(() => (active ? blockedItems(active) : []), [active])
  const blockedById = useMemo(() => new Map(blocked.map((b) => [b.item.id, b])), [blocked])

  const editingItem = itemSheet && itemSheet !== 'new' ? active?.items.find((i) => i.id === itemSheet) ?? null : null
  // A completed sprint is a closed record — the board stops taking edits until reopened.
  const locked = active?.status === 'completed'

  const projectName = active ? projectNameOf(active) : undefined
  const title = !active
    ? 'Sprints'
    : projectName && !active.name.toLowerCase().includes(projectName.toLowerCase())
      ? `${active.name} · ${projectName}`
      : active.name

  const todayYmd = ymd(new Date())
  const earlier = (active?.standups ?? [])
    .filter((s) => s.date < todayYmd && (s.yesterday.trim() || s.today.trim() || s.blockers.trim()))
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="view">
      <div className="sb-head">
        <div className="sb-head-text">
          <div className="sb-title-row">
            <h1>{title}</h1>
            {locked && <span className="chip ok">Completed</span>}
            {sprints.length > 0 && <SprintSwitcher sprints={sprints} activeId={activeId} onSelect={setActiveId} />}
          </div>
          <p className="sb-sub">
            {active ? (
              <>
                {fmtShort(active.startDate)} – {fmtShort(active.endDate)} · {stats.done} / {stats.total} pts ·{' '}
                {stats.count} item{stats.count === 1 ? '' : 's'} · {daysLeftLabel}
              </>
            ) : (
              'Plan work on a board, log daily standups, and track a burndown.'
            )}
          </p>
        </div>
        {onMode && <PlannerModeToggle mode={mode} onMode={onMode} />}
        {active && (
          <Menu
            triggerClass="btn-ghost sb-icon-btn"
            ariaLabel="More"
            triggerTitle="More"
            triggerContent={<MoreIcon />}
            align="right"
            items={[
              ...(locked
                ? [{ label: 'Reopen sprint', icon: <ReopenIcon />, onClick: reopenSprint }]
                : [
                    {
                      label: `Import from ${FORGE_NAMES[forgeOf(active)]}`,
                      icon: <ImportIcon />,
                      onClick: () => setBackfillOpen(true)
                    },
                    { label: 'Complete sprint', icon: <FlagIcon />, onClick: () => setCompleteOpen(true) }
                  ]),
              { label: 'Sprint settings', icon: <GearIcon />, onClick: () => setSprintSheet('edit') },
              { label: 'New sprint', icon: <PlusIcon />, onClick: () => setSprintSheet('new') }
            ]}
          />
        )}
        {active &&
          (locked ? (
            <button type="button" className="btn-primary" onClick={reopenSprint}>
              Reopen sprint
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => setItemSheet('new')}>
              <PlusIcon />
              Add item
            </button>
          ))}
      </div>

      {loading ? (
        <div className="view-loading">
          <div className="view-spinner" />
          <span className="view-loading-text">Loading sprints…</span>
        </div>
      ) : !active ? (
        <div className="sb-empty">
          <h2>No sprints yet</h2>
          <p className="help">Create a sprint to plan work on a board, log daily standups, and track a burndown.</p>
          <button type="button" className="btn-primary" onClick={() => setSprintSheet('new')}>
            <PlusIcon />
            New sprint
          </button>
        </div>
      ) : (
        <div className="sb-page">
          <div className={`sb-board ${locked ? 'locked' : ''}`}>
            {COLUMNS.map((col) => {
              const colItems = stats.byCol(col.status)
              const pts = colItems.reduce((n, i) => n + pointsOf(i), 0)
              return (
                <div
                  key={col.status}
                  className={`sb-lane ${overCol === col.status ? 'over' : ''}`}
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
                  <div className="sb-lane-head">
                    <span className="sb-lane-name">{col.label}</span>
                    <span className="sb-muted">
                      {colItems.length} · {pts} p
                    </span>
                    {col.status !== 'done' && !locked && (
                      <button
                        type="button"
                        className="sb-ic sb-lane-advance"
                        disabled={colItems.length === 0}
                        onClick={() => advanceAll(col.status)}
                        aria-label={col.status === 'todo' ? 'Move all to In progress' : 'Mark all done'}
                        title={col.status === 'todo' ? 'Move all to In progress' : 'Mark all done'}
                      >
                        {col.status === 'todo' ? <ArrowRightIcon /> : <CheckIcon />}
                      </button>
                    )}
                  </div>
                  <div className="sb-lane-items">
                    {colItems.map((i) => (
                      <ItemCard
                        key={i.id}
                        item={i}
                        locked={locked}
                        blockedSince={blockedById.get(i.id)?.since}
                        onDragStart={() => setDrag(i.id)}
                        onDragEnd={() => {
                          setDrag(null)
                          setOverCol(null)
                        }}
                        onOpen={() => setItemSheet(i.id)}
                        onAdvance={() => advanceItem(i)}
                        onDelete={() => deleteItem(i.id)}
                      />
                    ))}
                    {!locked && (
                      <AddItemRow onAdd={(t) => addItem({ title: t, status: col.status, points: null, notes: null })} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <aside className="sb-side" aria-label="Sprint progress and standup">
            <section className="sb-sec">
              {active.goal?.trim() && <p className="sb-goal">{active.goal}</p>}
              <div className="sb-progress-head">
                <span className="sb-t3">
                  {stats.done} of {stats.total} points
                </span>
                <span className="sb-muted">{daysLeftLabel}</span>
              </div>
              <div className="sb-bar">
                <span style={{ width: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%` }} />
              </div>
              <Burndown sprint={active} total={stats.total} />
            </section>

            {blocked.length > 0 && (
              <BlockedBlock
                info={blocked[0]}
                more={blocked.length - 1}
                locked={locked}
                nextSprint={nextSprint}
                onMove={(target) => moveToSprint(blocked[0].item, target)}
              />
            )}

            <StandupPanel
              key={standupDate}
              locked={locked}
              date={standupDate}
              onDate={setStandupDate}
              standup={standupFor(standupDate)}
              earlier={earlier}
              onSave={(patch) => patchStandup(standupDate, patch)}
              onDelete={() => deleteStandup(standupDate)}
              onGenerate={generateStandup}
              genBusy={genBusy}
              genError={genError}
              hasProject={!!active.projectPath}
              onDiscuss={onStandupChat ? discussStandup : undefined}
              runAccountItems={runAccountItems}
              runProvider={runProvider}
              runAccountId={runAccountId}
              onPickRunAccount={pickRunAccount}
              runModels={runModels}
              runModel={runModel}
              onPickRunModel={setRunModel}
            />
          </aside>
        </div>
      )}

      {sprintSheet && (
        <SprintSheet
          mode={sprintSheet}
          sprint={sprintSheet === 'edit' ? active : null}
          onCreate={createSprint}
          onSave={(patch) => {
            patchSprint(patch)
            setSprintSheet(null)
          }}
          onDelete={deleteSprint}
          onClose={() => setSprintSheet(null)}
        />
      )}

      {itemSheet && (itemSheet === 'new' || editingItem) && (
        <ItemSheet
          item={editingItem}
          locked={locked}
          onSave={(draft) => {
            if (editingItem) updateItem(editingItem.id, draft)
            else addItem(draft)
            setItemSheet(null)
          }}
          onDelete={() => {
            if (editingItem) deleteItem(editingItem.id)
            setItemSheet(null)
          }}
          onClose={() => setItemSheet(null)}
        />
      )}

      {completeOpen && active && (
        <CompleteSprintSheet
          sprint={active}
          targets={sprints.filter((s) => s.id !== active.id && s.status !== 'completed')}
          suggestedName={nextSprintName(active.name, sprints.length)}
          onComplete={completeSprint}
          onClose={() => setCompleteOpen(false)}
        />
      )}

      {backfillOpen && active && (
        <BacklogBackfillSheet
          sprint={active}
          model={runModel}
          accountId={runAccountId}
          onAdd={(rows) => addBacklogItems(rows, forgeOf(active))}
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
      triggerClass="sb-switch"
      triggerTitle="Switch sprint"
      ariaLabel="Switch sprint"
      triggerContent={
        <>
          <span className={`sb-status-dot ${active?.status ?? 'planning'}`} />
          <span className="sb-switch-name">{active?.name ?? 'Select sprint'}</span>
          <ChevronDownIcon />
        </>
      }
      align="left"
      items={[...sprints]
        // Open sprints first, completed ones parked underneath — a closed sprint is
        // history, not something you want at the top of the list every day.
        .sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed'))
        .map((s) => ({
          label: s.name,
          group: s.status === 'completed' ? 'Completed' : 'Open',
          icon: <span className={`sb-status-dot ${s.status}`} title={STATUS_LABELS[s.status]} />,
          active: s.id === activeId,
          onClick: () => onSelect(s.id)
        }))}
    />
  )
}

// ─── Item on the board ──────────────────────────────────────────────────────────
// Open items are flat blocks; done items are rows. Neither carries a coloured edge: the
// one tinted block on the board is the blocked item.
function ItemCard(props: {
  item: SprintItem
  /** The sprint is completed: show the item, take no edits. */
  locked?: boolean
  /** Set when the standups name this item as blocked. */
  blockedSince?: string
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
  onAdvance: () => void
  onDelete: () => void
}) {
  const i = props.item
  const origin = originOf(i)
  const pts = pointsOf(i)
  const advanceLabel =
    i.status === 'done' ? 'Move back to In progress' : i.status === 'todo' ? 'Move to In progress' : 'Mark done'
  const shared = {
    draggable: !props.locked,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      props.onDragStart()
    },
    onDragEnd: props.onDragEnd,
    onClick: props.onOpen,
    role: 'button',
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && e.target === e.currentTarget) props.onOpen()
    },
    title: props.locked ? 'Sprint completed: click to view' : 'Click to edit · drag to move'
  }
  const actions = !props.locked && (
    <span className="sb-item-actions">
      <button
        type="button"
        className="sb-ic"
        aria-label={advanceLabel}
        title={advanceLabel}
        onClick={(e) => {
          e.stopPropagation()
          props.onAdvance()
        }}
      >
        {i.status === 'done' ? <UndoIcon /> : i.status === 'todo' ? <CircleIcon /> : <HalfCircleIcon />}
      </button>
      <button
        type="button"
        className="sb-ic danger"
        aria-label="Delete item"
        title="Delete item"
        onClick={(e) => {
          e.stopPropagation()
          props.onDelete()
        }}
      >
        <XIcon />
      </button>
    </span>
  )

  if (i.status === 'done') {
    return (
      <div className="sb-done-row" {...shared}>
        <span className="sb-done-check">
          <CheckIcon />
        </span>
        <span className="sb-done-title">{i.title}</span>
        {actions}
        {pts > 0 && <span className="sb-pts">{pts} p</span>}
      </div>
    )
  }

  return (
    <div className={`block sb-item ${props.blockedSince ? 'warn' : ''}`} {...shared}>
      <div className="sb-item-row">
        <span className="sb-item-title">{i.title}</span>
        {actions}
        {pts > 0 && <span className="sb-pts">{pts} p</span>}
      </div>
      {(origin || props.blockedSince) && (
        <div className="sb-item-meta">
          {origin && (
            <span className="chip sb-ref" title={`${kindLabel(origin.forge, origin.kind)} on ${FORGE_NAMES[origin.forge]}`}>
              {origin.ref}
            </span>
          )}
          {props.blockedSince && <span className="sb-blocked-since">blocked since {fmtSince(props.blockedSince)}</span>}
        </div>
      )}
    </div>
  )
}

/** "Add item" at the foot of a column; opens into a title input in place. */
function AddItemRow({ onAdd }: { onAdd: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')
  // Esc closes without adding; the blur that follows must not add what it just discarded.
  const discard = useRef(false)
  if (!open) {
    return (
      <button type="button" className="sb-add" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add item
      </button>
    )
  }
  return (
    <div className="sb-add-form">
      <input
        className="text-input"
        autoFocus
        placeholder="Item title"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && val.trim()) {
            onAdd(val)
            setVal('')
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            discard.current = true
            setVal('')
            setOpen(false)
          }
        }}
        onBlur={() => {
          if (!discard.current && val.trim()) onAdd(val)
          discard.current = false
          setVal('')
          setOpen(false)
        }}
      />
      <span className="help">Enter adds · Esc cancels</span>
    </div>
  )
}

// ─── Burndown (hand-rolled SVG, no chart deps) ──────────────────────────────────
function Burndown({ sprint, total }: { sprint: Sprint; total: number }) {
  const data = useMemo(() => {
    const start = parseYmd(sprint.startDate)
    const end = parseYmd(sprint.endDate)
    const rawDays = Math.round((end.getTime() - start.getTime()) / dayMs) + 1
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

    const ideal: number[] = []
    const actual: (number | null)[] = []
    for (let i = 0; i < n; i++) {
      const dayStr = addDays(sprint.startDate, i)
      ideal.push(total - (total * i) / (n - 1))
      // Only draw the actual line through today — the future is unknown.
      actual.push(dayStr <= todayStr ? total - doneOnOrBefore(dayStr) : null)
    }
    return { n, ideal, actual }
  }, [sprint, total])

  if (total === 0) return <p className="help">Add story points to items to see the burndown.</p>

  const W = 420
  const H = 90
  const top = 6
  const base = 76
  const padX = 4
  const x = (i: number) => padX + (i / (data.n - 1)) * (W - 2 * padX)
  const y = (v: number) => top + (1 - v / total) * (base - top)

  const idealPts = data.ideal.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const actualPairs = data.actual
    .map((v, i) => (v === null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null)
  const actualPts = actualPairs.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')
  const last = actualPairs[actualPairs.length - 1]
  const diff = last ? Math.round(last.v - data.ideal[last.i]) : null
  const abs = Math.abs(diff ?? 0)
  const where =
    diff === null
      ? ''
      : diff === 0
        ? ' · on the line'
        : ` · ${abs} point${abs === 1 ? '' : 's'} ${diff > 0 ? 'above' : 'below'} the line`

  return (
    <>
      <svg className="sb-burndown" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Burndown">
        <line className="sb-bd-base" x1={0} y1={base} x2={W} y2={base} />
        <polyline className="sb-bd-ideal" points={idealPts} />
        {actualPts && <polyline className="sb-bd-actual" points={actualPts} />}
        {last && <circle className="sb-bd-dot" cx={x(last.i)} cy={y(last.v)} r={3} />}
        <text className="sb-bd-label" x={0} y={H - 1}>
          {fmtShort(sprint.startDate)}
        </text>
        <text className="sb-bd-label" x={W} y={H - 1} textAnchor="end">
          {fmtShort(sprint.endDate)}
        </text>
      </svg>
      <p className="sb-cap">Ideal dashed · actual in accent{where}</p>
    </>
  )
}

// ─── The blocked item: the one tinted block in the column ───────────────────────
function BlockedBlock(props: {
  info: BlockInfo
  /** Other blocked items not shown in their own block. */
  more: number
  locked?: boolean
  nextSprint: Sprint | null
  onMove: (target: Sprint) => void
}) {
  const { info } = props
  return (
    <div className="block warn sb-blocked">
      <div className="sb-blocked-head">
        <span className="sb-blocked-title">Blocked</span>
        <span className="sb-muted">since {fmtSince(info.since)}</span>
      </div>
      <div className="sb-blocked-item">{info.item.title}</div>
      <p className="help">
        {info.waiting ? `${info.waiting} ` : ''}Mention it in today's standup or move it out of the sprint.
        {props.more > 0 && ` ${props.more} more item${props.more === 1 ? ' is' : 's are'} blocked.`}
      </p>
      {!props.locked && props.nextSprint && (
        <div className="sb-blocked-actions">
          <button type="button" className="btn-ghost small" onClick={() => props.onMove(props.nextSprint!)}>
            Move to next sprint
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Standup: the chosen day, then earlier days folded to one line each ─────────
type StandupFields = Pick<DailyStandup, 'yesterday' | 'today' | 'blockers'>
const STANDUP_FIELDS: { key: keyof StandupFields; label: string; hint: string }[] = [
  { key: 'yesterday', label: 'Yesterday', hint: 'What did you get done?' },
  { key: 'today', label: 'Today', hint: 'What are you working on?' },
  { key: 'blockers', label: 'Blockers', hint: 'Anything in the way?' }
]

function StandupPanel(props: {
  /** The sprint is completed: the standups are history, not a form. */
  locked?: boolean
  date: string
  onDate: (d: string) => void
  standup: DailyStandup
  earlier: DailyStandup[]
  onSave: (patch: StandupFields) => void
  onDelete: () => void
  onGenerate: () => void
  genBusy: boolean
  genError: string | null
  hasProject: boolean
  onDiscuss?: () => void
  // Cross-provider "Run with" selector governing Generate (and the backfill sheet).
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
  const hasContent = !!(s.yesterday.trim() || s.today.trim() || s.blockers.trim())
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState<StandupFields>({ yesterday: s.yesterday, today: s.today, blockers: s.blockers })

  // A save or a Generate lands as a new standup version: show it as read.
  useEffect(() => {
    setDraft({ yesterday: s.yesterday, today: s.today, blockers: s.blockers })
    setEditing(false)
    setConfirmDelete(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.updatedAt])

  const form = !props.locked && (editing || !hasContent)
  const dirty = draft.yesterday !== s.yesterday || draft.today !== s.today || draft.blockers !== s.blockers
  const save = () => {
    props.onSave(draft)
    setEditing(false)
  }
  const discuss = props.onDiscuss && (
    <button type="button" className="btn-text" onClick={props.onDiscuss}>
      Discuss in chat
    </button>
  )

  return (
    <section className="sb-sec sb-standup">
      <div className="sb-standup-head">
        <span className="sb-t3">Standup · {fmtDay(props.date)}</span>
        <span className="sb-grow" />
        <button type="button" className="sb-ic" aria-label="Previous day" title="Previous day" onClick={() => props.onDate(addDays(props.date, -1))}>
          <ChevronIcon dir="left" />
        </button>
        <button type="button" className="sb-ic" aria-label="Next day" title="Next day" onClick={() => props.onDate(addDays(props.date, 1))}>
          <ChevronIcon dir="right" />
        </button>
        {!isToday && (
          <button type="button" className="btn-text" onClick={() => props.onDate(today)}>
            Today
          </button>
        )}
        {!props.locked && (
          <button
            type="button"
            className="btn-ghost small"
            onClick={props.onGenerate}
            disabled={props.genBusy}
            title={
              props.hasProject
                ? 'Draft this standup from your git commits and board'
                : 'Draft from your board (set a project folder in Sprint settings to include git commits)'
            }
          >
            {props.genBusy ? 'Generating…' : 'Generate'}
          </button>
        )}
      </div>

      {!props.locked && (
        <div className="sb-runwith">
          <span className="sb-muted">Run with</span>
          <AccountPicker
            compact
            items={props.runAccountItems}
            selectedProvider={props.runProvider}
            selectedId={props.runAccountId}
            onPick={props.onPickRunAccount}
            onManage={() => {}}
            disabled={props.genBusy}
          />
          <ModelPicker
            variant="select"
            models={props.runModels}
            value={props.runModel}
            onChange={props.onPickRunModel}
            disabled={props.genBusy}
          />
        </div>
      )}

      {props.genError && <p className="sb-error">{props.genError}</p>}

      {form ? (
        <>
          <dl className="sb-dl">
            {STANDUP_FIELDS.map((f) => (
              <div key={f.key} className="sb-dl-row">
                <dt>{f.label}</dt>
                <dd>
                  <textarea
                    className="text-input textarea"
                    rows={2}
                    aria-label={f.label}
                    placeholder={f.hint}
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                </dd>
              </div>
            ))}
          </dl>
          <div className="sb-standup-actions">
            <button type="button" className="btn-ghost small" onClick={save} disabled={!dirty}>
              Save
            </button>
            {editing && (
              <button
                type="button"
                className="btn-text"
                onClick={() => {
                  setDraft({ yesterday: s.yesterday, today: s.today, blockers: s.blockers })
                  setEditing(false)
                }}
              >
                Cancel
              </button>
            )}
            {discuss}
          </div>
        </>
      ) : hasContent ? (
        <>
          <dl className="sb-dl">
            {STANDUP_FIELDS.map((f) => (
              <div key={f.key} className="sb-dl-row">
                <dt>{f.label}</dt>
                <dd className={s[f.key].trim() ? '' : 'empty'}>{s[f.key].trim() || 'Nothing noted'}</dd>
              </div>
            ))}
          </dl>
          <div className="sb-standup-actions">
            {!props.locked && (
              <button type="button" className="btn-text" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {discuss}
            <span className="sb-grow" />
            {!props.locked &&
              (confirmDelete ? (
                <>
                  <span className="help">Delete this standup?</span>
                  <button type="button" className="btn-text" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                  <button type="button" className="btn-text danger" onClick={props.onDelete}>
                    Delete
                  </button>
                </>
              ) : (
                <button type="button" className="btn-text danger" onClick={() => setConfirmDelete(true)}>
                  Delete standup
                </button>
              ))}
          </div>
        </>
      ) : (
        <p className="help">No standup for this day.</p>
      )}

      {props.earlier.length > 0 && (
        <>
          <div className="divider-caption sb-divcap">
            Earlier · {props.earlier.length} standup{props.earlier.length === 1 ? '' : 's'}
          </div>
          <div className="sb-earlier">
            {props.earlier.map((h) => {
              const n = blockerCount(h.blockers)
              return (
                <button
                  type="button"
                  key={h.date}
                  className={`sb-earlier-row ${h.date === props.date ? 'on' : ''}`}
                  onClick={() => props.onDate(h.date)}
                >
                  <span className={`sb-dot ${n ? 'warn' : ''}`} />
                  <span>{fmtDay(h.date)}</span>
                  <span className="sb-earlier-right">{n === 0 ? 'no blockers' : `${n} blocker${n === 1 ? '' : 's'}`}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

// ─── Sheet footer: buttons on one row, the keyboard line under them ─────────────
function SheetFoot({ children, help }: { children: React.ReactNode; help?: string }) {
  return (
    <div className="sb-foot">
      <div className="sb-foot-row">{children}</div>
      {help && <span className="help sb-foot-help">{help}</span>}
    </div>
  )
}

// ─── Sprint settings / new sprint ───────────────────────────────────────────────
function SprintSheet(props: {
  mode: 'new' | 'edit'
  sprint: Sprint | null
  onCreate: (draft: SprintDraft) => void
  onSave: (patch: Partial<Sprint>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const sprint = props.mode === 'edit' ? props.sprint : null
  const today = ymd(new Date())
  const [d, setD] = useState<SprintDraft>(() => ({
    name: sprint?.name ?? '',
    goal: sprint?.goal ?? '',
    startDate: sprint?.startDate ?? today,
    endDate: sprint?.endDate ?? addDays(today, 13),
    status: sprint?.status ?? 'active',
    projectPath: sprint?.projectPath
  }))
  const set = (patch: Partial<SprintDraft>) => setD((p) => ({ ...p, ...patch }))
  const [confirming, setConfirming] = useState(false)
  const openedAt = useRef(Date.now())
  const valid = !!d.startDate && !!d.endDate && d.endDate >= d.startDate

  const submit = () => {
    if (!valid) return
    if (sprint) props.onSave({ ...d, name: d.name.trim() || sprint.name, goal: d.goal.trim() })
    else props.onCreate(d)
  }
  const pickFolder = async () => {
    const folder = await window.electronAPI.openFolder()
    if (folder) set({ projectPath: folder })
  }
  // A sprint still in planning keeps that choice on offer; new ones start active.
  const statuses: SprintStatus[] = sprint?.status === 'planning' ? ['planning', 'active', 'completed'] : ['active', 'completed']

  return (
    <Sheet
      title={sprint ? 'Sprint settings' : 'New sprint'}
      width={520}
      onClose={props.onClose}
      footer={
        confirming && sprint ? (
          <SheetFoot help="Its items and standups go with it. This cannot be undone.">
            <span className="sb-confirm">Delete {sprint.name}?</span>
            <span className="sb-grow" />
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button type="button" className="btn-primary danger" onClick={props.onDelete}>
              Delete
            </button>
          </SheetFoot>
        ) : (
          <SheetFoot help="Enter saves · Esc cancels">
            {sprint && (
              <button type="button" className="btn-text danger" onClick={() => setConfirming(true)}>
                Delete sprint
              </button>
            )}
            <span className="sb-grow" />
            <button type="button" className="btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={!valid}>
              {sprint ? 'Save' : 'Create sprint'}
            </button>
          </SheetFoot>
        )
      }
    >
      <div className="sb-form" onKeyDown={(e) => enterSubmits(e, openedAt.current, submit)}>
        <div className="form-group">
          <label htmlFor="sb-sprint-name">Name</label>
          <input
            id="sb-sprint-name"
            className="text-input"
            value={d.name}
            autoFocus
            placeholder="Sprint 14"
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label htmlFor="sb-sprint-goal">
            Goal<span className="optional">optional</span>
          </label>
          <textarea
            id="sb-sprint-goal"
            className="text-input textarea"
            rows={2}
            value={d.goal}
            placeholder="The one outcome this sprint is about"
            onChange={(e) => set({ goal: e.target.value })}
          />
        </div>
        <div className="sb-form-row">
          <div className="form-group grow">
            <label htmlFor="sb-sprint-start">Start</label>
            <input
              id="sb-sprint-start"
              type="date"
              className="text-input sb-date"
              value={d.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
          </div>
          <div className="form-group grow">
            <label htmlFor="sb-sprint-end">End</label>
            <input
              id="sb-sprint-end"
              type="date"
              className="text-input sb-date"
              value={d.endDate}
              onChange={(e) => set({ endDate: e.target.value })}
            />
          </div>
        </div>
        {!valid && <p className="help">The end date comes on or after the start date.</p>}
        <div className="form-group">
          <label>Status</label>
          <div className="seg-control" role="radiogroup" aria-label="Status">
            {statuses.map((st) => (
              <button
                type="button"
                key={st}
                role="radio"
                aria-checked={d.status === st}
                className={d.status === st ? 'on' : ''}
                onClick={() => set({ status: st })}
              >
                {STATUS_LABELS[st]}
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="sb-sprint-folder">
            Project folder<span className="optional">optional</span>
          </label>
          <div className="sb-folder-row">
            <input
              id="sb-sprint-folder"
              className="text-input mono"
              readOnly
              value={d.projectPath ?? ''}
              placeholder="None, standups use the board only"
              title={d.projectPath}
            />
            <button type="button" className="btn-ghost small" onClick={pickFolder}>
              Browse
            </button>
            {d.projectPath && (
              <button type="button" className="btn-text" onClick={() => set({ projectPath: undefined })}>
                Clear
              </button>
            )}
          </div>
          <span className="help">A git repository lets Generate read your recent commits for the standup.</span>
        </div>
      </div>
    </Sheet>
  )
}

// ─── Item editor ────────────────────────────────────────────────────────────────
function ItemSheet(props: {
  /** Null for a new item, which goes to To do unless another status is picked. */
  item: SprintItem | null
  /** The sprint is completed: the item opens for reading only. */
  locked?: boolean
  onSave: (draft: ItemDraft) => void
  onDelete: () => void
  onClose: () => void
}) {
  const i = props.item
  const locked = !!props.locked
  const origin = i ? originOf(i) : null
  const [d, setD] = useState<ItemDraft>(() => ({
    title: i?.title ?? '',
    status: i?.status ?? 'todo',
    points: i?.points ?? null,
    notes: i?.notes ?? null
  }))
  const set = (patch: Partial<ItemDraft>) => setD((p) => ({ ...p, ...patch }))
  const [confirming, setConfirming] = useState(false)
  const openedAt = useRef(Date.now())
  const valid = !!d.title.trim()
  const submit = () => {
    if (!valid || locked) return
    props.onSave({ ...d, title: d.title.trim(), notes: d.notes?.trim() || null })
  }

  const footer = locked ? (
    <SheetFoot>
      <span className="help">Sprint completed, read only.</span>
      <span className="sb-grow" />
      <button type="button" className="btn-ghost" onClick={props.onClose}>
        Close
      </button>
    </SheetFoot>
  ) : confirming ? (
    <SheetFoot help="This cannot be undone.">
      <span className="sb-confirm">Delete this item?</span>
      <span className="sb-grow" />
      <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
        Keep
      </button>
      <button type="button" className="btn-primary danger" onClick={props.onDelete}>
        Delete
      </button>
    </SheetFoot>
  ) : (
    <SheetFoot help="Enter saves · Esc cancels">
      {i && (
        <button type="button" className="btn-text danger" onClick={() => setConfirming(true)}>
          Delete item
        </button>
      )}
      <span className="sb-grow" />
      <button type="button" className="btn-ghost" onClick={props.onClose}>
        Cancel
      </button>
      <button type="button" className="btn-primary" onClick={submit} disabled={!valid}>
        {i ? 'Save' : 'Add item'}
      </button>
    </SheetFoot>
  )

  return (
    <Sheet title={i ? 'Item' : 'New item'} width={480} onClose={props.onClose} footer={footer}>
      <div className="sb-form" onKeyDown={(e) => enterSubmits(e, openedAt.current, submit)}>
        <div className="form-group">
          <label htmlFor="sb-item-title">Title</label>
          <input
            id="sb-item-title"
            className="text-input"
            value={d.title}
            placeholder="What needs doing"
            autoFocus={!locked}
            readOnly={locked}
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>
        {origin && (
          <div className="sb-origin">
            <span className="chip sb-ref">{origin.ref}</span>
            <span className="sb-muted">{kindLabel(origin.forge, origin.kind)}</span>
            {i?.url ? (
              <a className="btn-text" href={i.url} target="_blank" rel="noreferrer">
                Open in {FORGE_NAMES[origin.forge]}
              </a>
            ) : (
              <span className="help">No link; import it again to pick one up.</span>
            )}
          </div>
        )}
        <div className="form-group">
          <label>Status</label>
          <div className="seg-control" role="radiogroup" aria-label="Status">
            {COLUMNS.map((c) => (
              <button
                type="button"
                key={c.status}
                role="radio"
                aria-checked={d.status === c.status}
                className={d.status === c.status ? 'on' : ''}
                disabled={locked}
                onClick={() => set({ status: c.status })}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="sb-item-points">
            Story points<span className="optional">optional</span>
          </label>
          <input
            id="sb-item-points"
            type="number"
            min={0}
            className="text-input sb-points-input"
            value={d.points ?? ''}
            readOnly={locked}
            onChange={(e) => {
              const n = Number(e.target.value)
              set({ points: e.target.value === '' || !(n > 0) ? null : Math.round(n) })
            }}
          />
        </div>
        <div className="form-group">
          <label htmlFor="sb-item-notes">
            Notes<span className="optional">optional</span>
          </label>
          <textarea
            id="sb-item-notes"
            className="text-input textarea"
            rows={4}
            value={d.notes ?? ''}
            placeholder="Detail, acceptance criteria"
            readOnly={locked}
            onChange={(e) => set({ notes: e.target.value || null })}
          />
        </div>
      </div>
    </Sheet>
  )
}

// ─── Complete sprint ────────────────────────────────────────────────────────────
// Closing a sprint is the moment you decide what happens to the work that did not
// land, so the sheet leads with the numbers and then asks exactly that.
function CompleteSprintSheet(props: {
  sprint: Sprint
  /** Sprints the leftovers can be handed to (everything open but this one). */
  targets: Sprint[]
  suggestedName: string
  onComplete: (carry: CarryChoice) => void
  onClose: () => void
}) {
  const s = props.sprint
  const unfinished = s.items.filter((i) => i.status !== 'done')
  const total = s.items.reduce((n, i) => n + pointsOf(i), 0)
  const donePts = s.items.filter((i) => i.status === 'done').reduce((n, i) => n + pointsOf(i), 0)
  const leftPts = unfinished.reduce((n, i) => n + pointsOf(i), 0)

  type Kind = 'keep' | 'existing' | 'new'
  const [kind, setKind] = useState<Kind>(props.targets.length > 0 ? 'existing' : 'new')
  const [targetId, setTargetId] = useState(props.targets[0]?.id ?? '')
  const [newName, setNewName] = useState(props.suggestedName)

  const confirm = () => {
    if (unfinished.length === 0 || kind === 'keep') return props.onComplete({ kind: 'keep' })
    if (kind === 'existing') {
      if (!targetId) return
      return props.onComplete({ kind: 'existing', sprintId: targetId })
    }
    props.onComplete({ kind: 'new', name: newName })
  }

  const choices: { kind: Kind; label: string; hint: string; hidden?: boolean }[] = [
    {
      kind: 'existing',
      label: 'Move to an existing sprint',
      hint: props.targets.length === 1 ? `Hand them to ${props.targets[0].name}.` : 'Hand them to a sprint already on the board.',
      hidden: props.targets.length === 0
    },
    {
      kind: 'new',
      label: 'Move to a new sprint',
      hint: `Starts ${fmtShort(addDays(s.endDate, 1))}, the same length as this one.`
    },
    { kind: 'keep', label: 'Leave them here', hint: 'They stay on the closed sprint as a record.' }
  ]

  return (
    <Sheet
      title="Complete sprint"
      width={520}
      onClose={props.onClose}
      footer={
        <SheetFoot>
          <span className="sb-grow" />
          <button type="button" className="btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={confirm}>
            Complete sprint
          </button>
        </SheetFoot>
      }
    >
      <div className="sb-form">
        <p className="sb-summary">
          {donePts} of {total} points done · {s.items.length - unfinished.length} of {s.items.length} items
          {leftPts > 0 && ` · ${leftPts} points left`}
        </p>

        {unfinished.length === 0 ? (
          <p className="help">Everything landed, nothing to carry over.</p>
        ) : (
          <>
            <div className="eyebrow">Unfinished items · {unfinished.length}</div>
            <div className="sb-choices" role="radiogroup" aria-label="Unfinished items">
              {choices
                .filter((c) => !c.hidden)
                .map((c) => (
                  <div key={c.kind}>
                    <RadioRow on={kind === c.kind} label={c.label} hint={c.hint} onPick={() => setKind(c.kind)} />
                    {c.kind === 'existing' && kind === 'existing' && props.targets.length > 1 && (
                      <div className="sb-choice-sub" role="radiogroup" aria-label="Sprint">
                        {props.targets.map((t) => (
                          <RadioRow key={t.id} on={targetId === t.id} label={t.name} onPick={() => setTargetId(t.id)} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
            {kind === 'new' && (
              <div className="form-group">
                <label htmlFor="sb-next-name">Next sprint name</label>
                <input
                  id="sb-next-name"
                  className="text-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

/** A flat choice row with the shared radio mark (`.auth-option-radio`), not a card. */
function RadioRow({ on, label, hint, onPick }: { on: boolean; label: string; hint?: string; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`sb-choice ${on ? 'on' : ''}`} onClick={onPick}>
      <span className="auth-option-radio">
        <span className={on ? 'on' : ''} />
      </span>
      <span className="sb-choice-body">
        <span className="sb-choice-label">{label}</span>
        {hint && <span className="help">{hint}</span>}
      </span>
    </button>
  )
}

// ─── Import from the forge (backfill through its MCP) ───────────────────────────
function relBackfillTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

/** The picker's labels, in the forge's own vocabulary. */
function kindLabels(forge: Forge): Record<BackfillKind, string> {
  return {
    issues: 'Issues',
    'merge-requests': forge === 'github' ? 'Pull requests' : 'Merge requests',
    both: 'Both'
  }
}
/** Used mid-sentence ("No open issues came back"). */
function kindNoun(forge: Forge, kind: BackfillKind): string {
  const changes = forge === 'github' ? 'pull requests' : 'merge requests'
  return kind === 'issues' ? 'issues' : kind === 'merge-requests' ? changes : `issues and ${changes}`
}

const SOURCE_LABELS: Record<string, string> = {
  'git-remote': 'from the git remote',
  'mcp-default': 'the MCP default project',
  instructions: 'from your input',
  guess: 'a best guess'
}

function BacklogBackfillSheet(props: {
  sprint: Sprint
  /** The "Run with" selection from the standup — the same account+model runs both. */
  model: string
  accountId: string
  onAdd: (rows: BackfillRow[]) => void
  onCache: (cache: SprintBackfillCache) => void
  onClose: () => void
}) {
  const cache = props.sprint.backfillCache
  // Phase 1 — load the MCP and resolve which project it's attributed to.
  const [resolving, setResolving] = useState(!cache)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [project, setProject] = useState(cache?.project ?? '')
  const [info, setInfo] = useState<{
    source?: string
    url?: string
    note?: string
    openIssueCount?: number | null
    openMrCount?: number | null
  } | null>(
    cache
      ? {
          source: cache.source,
          url: cache.projectUrl,
          note: cache.note,
          openIssueCount: cache.openIssueCount ?? null,
          openMrCount: cache.openMrCount ?? null
        }
      : null
  )

  // Phase 2 — fetch that project's open issues and/or pending change requests.
  // The cache belongs to one kind of fetch, so switching kind empties the list
  // rather than showing issues under a "Merge requests" heading.
  const [kind, setKind] = useState<BackfillKind>(cache?.kind ?? 'issues')
  // Which forge this sprint talks to. The probe confirms it from the git remote; until
  // then the last cached answer stands, and GitLab is the fallback.
  const [forge, setForge] = useState<Forge>(cache?.forge ?? 'gitlab')
  const forgeName = FORGE_NAMES[forge]
  const KIND_LABELS = kindLabels(forge)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // A run that succeeded but returned something other than what was asked for.
  const [fetchWarning, setFetchWarning] = useState<string | null>(null)
  const [items, setItems] = useState<BackfillRow[]>(cache?.items ?? [])
  const [hasFetched, setHasFetched] = useState(!!cache)
  const [cachedAt, setCachedAt] = useState<number | null>(cache?.fetchedAt ?? null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const existing = useMemo(
    () => new Set(props.sprint.items.map((i) => i.title.trim().toLowerCase())),
    [props.sprint]
  )
  const isDup = (title: string) => existing.has(title.trim().toLowerCase())
  const busy = resolving || fetching

  // Pre-select fetched rows that aren't already on the board (skip duplicates).
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
      setResolveError(res.error || 'Could not load the forge MCP.')
      return
    }
    if (res.data.forge) setForge(res.data.forge)
    setProject(res.data.project || '')
    setInfo({
      source: res.data.source,
      url: res.data.url,
      note: res.data.note,
      openIssueCount: res.data.openIssueCount ?? null,
      openMrCount: res.data.openMrCount ?? null
    })
  }

  useEffect(() => {
    // Cached results hydrate the initial state above — only probe when there's no cache.
    if (cache) preselect(cache.items ?? [])
    else resolveProject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchIssues = async (which: BackfillKind = kind) => {
    setFetching(true)
    setFetchError(null)
    setFetchWarning(null)
    setHasFetched(false)
    const res = await window.electronAPI.sprintBackfill({
      projectPath: props.sprint.projectPath,
      instructions: project.trim() || undefined,
      model: props.model,
      accountId: props.accountId,
      kind: which,
      forge
    })
    setFetching(false)
    setHasFetched(true)
    if (!res.ok || !res.data) {
      setFetchError(res.error || `Could not fetch ${kindNoun(forge, which)}.`)
      return
    }
    if (res.data.forge) setForge(res.data.forge)
    setFetchWarning(res.warning ?? null)
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
      openMrCount: info?.openMrCount ?? null,
      kind: which,
      forge,
      items: fetched
    })
  }

  const changeKind = (next: BackfillKind) => {
    if (next === kind) return
    setKind(next)
    setItems([])
    setSelected(new Set())
    setHasFetched(false)
    setFetchError(null)
    setFetchWarning(null)
    setCachedAt(null)
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

  const meta = [
    info?.source ? SOURCE_LABELS[info.source] ?? info.source : null,
    typeof info?.openIssueCount === 'number' ? `${info.openIssueCount} open issues` : null,
    typeof info?.openMrCount === 'number' ? `${info.openMrCount} open ${forge === 'github' ? 'PRs' : 'MRs'}` : null,
    cachedAt ? `cached ${relBackfillTime(cachedAt)}` : null
  ].filter(Boolean)
  const newCount = items.filter((it) => !isDup(it.title)).length
  const dupCount = items.length - newCount
  const n = selected.size

  return (
    <Sheet
      title={`Import from ${forgeName}`}
      width={560}
      onClose={props.onClose}
      footer={
        <SheetFoot>
          <span className="sb-grow" />
          <button type="button" className="btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={addSelected} disabled={busy || n === 0}>
            {n === 0 ? 'Add items' : `Add ${n} item${n === 1 ? '' : 's'}`}
          </button>
        </SheetFoot>
      }
    >
      <div className="sb-form">
        {resolving ? (
          <div className="sb-loading">
            <div className="view-spinner" />
            <span>Loading the forge MCP and finding the attributed repository…</span>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label htmlFor="sb-bf-project">Attributed project</label>
              <input
                id="sb-bf-project"
                className="text-input mono"
                placeholder="group/subgroup/project, or a filter"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && fetchIssues()}
              />
              {info?.note && <span className="help">{info.note}</span>}
              {meta.length > 0 && <span className="help">{meta.join(' · ')}</span>}
              {info?.url && (
                <span className="help sb-bf-url" title={info.url}>
                  {info.url}
                </span>
              )}
            </div>
            <div className="sb-bf-kind">
              <div className="seg-control" role="radiogroup" aria-label="What to import">
                {(['issues', 'merge-requests', 'both'] as BackfillKind[]).map((k) => (
                  <button
                    type="button"
                    key={k}
                    role="radio"
                    aria-checked={kind === k}
                    className={kind === k ? 'on' : ''}
                    disabled={busy}
                    onClick={() => changeKind(k)}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
              <button type="button" className="btn-ghost" onClick={() => fetchIssues()} disabled={busy}>
                {fetching ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
            {resolveError && (
              <div className="block err sb-msg">{resolveError} You can still type a project above and fetch.</div>
            )}
          </>
        )}

        {fetching && (
          <div className="sb-loading">
            <div className="view-spinner" />
            <span>
              Reading open {kindNoun(forge, kind)} from {forgeName}…
            </span>
          </div>
        )}
        {fetchError && !fetching && <div className="block err sb-msg">{fetchError}</div>}
        {fetchWarning && !fetching && !fetchError && <div className="block warn sb-msg">{fetchWarning}</div>}
        {hasFetched && !fetching && !fetchError && items.length === 0 && (
          <p className="help">No open {kindNoun(forge, kind)} came back. Try a different repository or filter above.</p>
        )}
        {!fetching && items.length > 0 && (
          <div className="sb-bf">
            <div className="sb-bf-bar">
              <span className="sb-muted">
                {newCount} new{dupCount > 0 && ` · ${dupCount} already in sprint`} · {n} selected
              </span>
              <span className="sb-grow" />
              <button type="button" className="btn-text" onClick={() => setSelected(new Set(items.map((_, i) => i)))}>
                All
              </button>
              <button type="button" className="btn-text" onClick={() => setSelected(new Set())}>
                None
              </button>
            </div>
            <div className="sb-bf-list">
              {items.map((it, i) => {
                const dup = isDup(it.title)
                const rowKind = it.kind ?? (kind === 'merge-requests' ? 'merge-request' : 'issue')
                return (
                  <label key={i} className={`sb-bf-row ${dup ? 'dup' : ''}`}>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                    <span className="sb-bf-body">
                      <span className="sb-bf-title">{it.title}</span>
                      {it.notes?.trim() && <span className="help sb-bf-notes">{it.notes}</span>}
                    </span>
                    {it.ref && <span className="chip sb-ref">{it.ref}</span>}
                    <span className="chip">{rowKind === 'merge-request' ? (forge === 'github' ? 'PR' : 'MR') : 'Issue'}</span>
                    {typeof it.points === 'number' && it.points > 0 && <span className="sb-pts">{it.points} p</span>}
                    {dup && <span className="sb-muted">already in sprint</span>}
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}

// ─── Icons (24-unit viewBox, 2 px stroke, round caps) ───────────────────────────
function Svg({ children, size = 14 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
function PlusIcon() {
  return <Svg><path d="M12 5v14M5 12h14" /></Svg>
}
function CheckIcon() {
  return <Svg><path d="M20 6L9 17l-5-5" /></Svg>
}
function XIcon() {
  return <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>
}
function CircleIcon() {
  return <Svg><circle cx="12" cy="12" r="8" /></Svg>
}
function HalfCircleIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </Svg>
  )
}
function UndoIcon() {
  return <Svg><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>
}
function ArrowRightIcon() {
  return <Svg><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
}
function ChevronDownIcon() {
  return <Svg size={13}><path d="M6 9l6 6 6-6" /></Svg>
}
function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return <Svg><path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} /></Svg>
}
function ImportIcon() {
  return <Svg><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></Svg>
}
function GearIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  )
}
function FlagIcon() {
  return <Svg><path d="M4 22V4a6 6 0 0 1 8 0 6 6 0 0 0 8 0v10a6 6 0 0 1-8 0 6 6 0 0 0-8 0" /></Svg>
}
function ReopenIcon() {
  return <Svg><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></Svg>
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
