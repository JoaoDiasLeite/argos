import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { WeekPlan, PlannerTask, WeeklyPriority, Effort, PlannerAssistMode, CCAccountStatus, ModelInfo, SavedReview, ProviderAccountStatus } from '../types'
import ModelPicker from '../components/ModelPicker'
import AccountPicker from '../components/AccountPicker'
import SprintBoard, { PlannerModeToggle, PlannerMode } from './SprintBoard'
import BacklogBoard from './BacklogBoard'
import './views.css'
import './PlannerView.css'

interface PlannerProps {
  accounts: CCAccountStatus[]
  models: ModelInfo[]
  defaultModel: string
  defaultAccountId: string
  /** Codex/Gemini accounts + their defaults — forwarded to the sprint board's cross-provider
   *  "Run with" selector (the Week-mode AssistDrawer stays Claude-only). */
  codexAccounts: ProviderAccountStatus[]
  geminiAccounts: ProviderAccountStatus[]
  codexDefaultAccountId: string
  geminiDefaultAccountId: string
  onRunTask?: (task: PlannerTask) => void
  /** Open a light chat seeded with the given context (used by the sprint standup). */
  onStandupChat?: (context: string, opener: string, name: string) => void
  /** Create a daily standup routine and jump to Routines. */
  onScheduleStandup?: (name: string, prompt: string, projectPath?: string) => void
  streaming?: boolean
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PRIORITY_COLORS = ['#d97757', '#5cb37e', '#8c7fd6', '#5b9bd5', '#d9a441', '#c879a8']
const EFFORTS: Effort[] = ['light', 'medium', 'deep']

// Start screen copy for the modes that run on demand (no notes/image needed first).
const START_HINTS: Record<PlannerAssistMode, string> = {
  review:
    'Claude will read your current week and critique it — flagging overload, missing priorities and gaps, with a balance score and concrete suggestions.',
  reflect:
    'Claude will look at planned vs. completed tasks and reflect on the week — wins, misses, and what to adjust next time.',
  rebalance:
    'Claude will redistribute your existing tasks across the week for a healthier load, without inventing or deleting anything.',
  draft: 'Tell Claude your goals and it will draft a balanced week.',
  import: 'Upload a calendar screenshot and Claude will turn it into a structured week.'
}
const START_LABELS: Record<PlannerAssistMode, string> = {
  review: 'Review my week',
  reflect: 'Reflect on my week',
  rebalance: 'Rebalance my week',
  draft: 'Draft my week',
  import: 'Read calendar'
}
const EFFORT_WEIGHT: Record<Effort, number> = { light: 1, medium: 2, deep: 3 }

// ─── Date helpers (all local time — never round-trip through UTC) ──────────────
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function mondayOf(d: Date): string {
  const x = new Date(d)
  const offset = (x.getDay() + 6) % 7 // Sun=0 → 6, Mon=1 → 0 …
  x.setDate(x.getDate() - offset)
  x.setHours(0, 0, 0, 0)
  return ymd(x)
}
function addDays(weekStart: string, n: number): Date {
  const d = parseYmd(weekStart)
  d.setDate(d.getDate() + n)
  return d
}
function shiftWeek(weekStart: string, weeks: number): string {
  const d = parseYmd(weekStart)
  d.setDate(d.getDate() + weeks * 7)
  return ymd(d)
}
const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e6)}`)

const emptyWeek = (weekStart: string): WeekPlan => ({
  weekStart,
  intention: '',
  priorities: [],
  tasks: [],
  reflection: '',
  createdAt: Date.now(),
  updatedAt: Date.now()
})

export default function PlannerView({
  accounts,
  models,
  defaultModel,
  defaultAccountId,
  codexAccounts,
  geminiAccounts,
  codexDefaultAccountId,
  geminiDefaultAccountId,
  onRunTask,
  onStandupChat,
  onScheduleStandup,
  streaming
}: PlannerProps) {
  // Week planner vs. sprint board vs. the repo's own backlog — persisted so the Planner
  // reopens where you left it. Every mode has to be listed here: a restore that only
  // knows two of them silently drops the user back on the week.
  const [mode, setMode] = useState<PlannerMode>(() => {
    const saved = localStorage.getItem('planner.mode')
    return saved === 'sprint' || saved === 'backlog' ? saved : 'week'
  })
  const changeMode = (m: PlannerMode) => {
    setMode(m)
    localStorage.setItem('planner.mode', m)
  }
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [week, setWeek] = useState<WeekPlan>(() => emptyWeek(mondayOf(new Date())))
  const [loading, setLoading] = useState(true)
  const [drag, setDrag] = useState<string | null>(null)
  const [newPriority, setNewPriority] = useState('')
  const [showWeekend, setShowWeekend] = useState(() => localStorage.getItem('planner.showWeekend') !== 'false')
  // Per-run account/model for Claude assist (defaults to the app defaults).
  const [runAccountId, setRunAccountId] = useState<string | undefined>(undefined)
  const [runModel, setRunModel] = useState<string | undefined>(undefined)

  // Claude assist state
  const [assistMode, setAssistMode] = useState<PlannerAssistMode | null>(null)
  const [assistBusy, setAssistBusy] = useState(false)
  const [assistResult, setAssistResult] = useState<any>(null)
  const [assistError, setAssistError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [needNotes, setNeedNotes] = useState(false)
  const [needImage, setNeedImage] = useState(false)
  const [image, setImage] = useState<{ mediaType: string; data: string; preview: string } | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const todayYmd = ymd(new Date())

  // Briefly highlight a freshly-saved review and scroll it into view.
  const [flashReviewId, setFlashReviewId] = useState<string | null>(null)
  useEffect(() => {
    if (!flashReviewId) return
    const el = document.querySelector(`[data-review-id="${flashReviewId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setFlashReviewId(null), 2600)
    return () => clearTimeout(t)
  }, [flashReviewId])

  // Load when the visible week changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.electronAPI.plannerGet(weekStart).then((w) => {
      if (cancelled) return
      setWeek(w ?? emptyWeek(weekStart))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [weekStart])

  // Debounced persistence on every mutation.
  const mutate = (fn: (w: WeekPlan) => WeekPlan) => {
    setWeek((prev) => {
      const next = fn(prev)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => window.electronAPI.plannerSave(next), 400)
      return next
    })
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  // ─── Mutations ───────────────────────────────────────────────────────────
  const addTask = (day: number | null, title: string) => {
    const t = title.trim()
    if (!t) return
    mutate((w) => ({ ...w, tasks: [...w.tasks, { id: uid(), title: t, day, done: false, effort: 'medium' }] }))
  }
  const updateTask = (id: string, patch: Partial<PlannerTask>) =>
    mutate((w) => ({ ...w, tasks: w.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  const deleteTask = (id: string) => mutate((w) => ({ ...w, tasks: w.tasks.filter((t) => t.id !== id) }))

  // Move a task to a day at a specific index (Trello-style reorder). Order within a day is
  // the global array order filtered by day, so we re-thread the array around the target.
  const moveTask = (dragId: string, targetDay: number | null, targetIndex: number) => {
    mutate((w) => {
      const dragged = w.tasks.find((t) => t.id === dragId)
      if (!dragged) return w
      const without = w.tasks.filter((t) => t.id !== dragId)
      const dayItems = without.filter((t) => t.day === targetDay)
      const idx = Math.max(0, Math.min(targetIndex, dayItems.length))
      const before = dayItems[idx] ?? null
      const moved = { ...dragged, day: targetDay }
      const result: PlannerTask[] = []
      let inserted = false
      for (const t of without) {
        if (!inserted && before && t.id === before.id) {
          result.push(moved)
          inserted = true
        }
        result.push(t)
      }
      if (!inserted) result.push(moved)
      return { ...w, tasks: result }
    })
  }

  // Check/uncheck every task in a day (header select-all).
  const toggleDay = (day: number) =>
    mutate((w) => {
      const items = w.tasks.filter((t) => t.day === day)
      if (items.length === 0) return w
      const allDone = items.every((t) => t.done)
      return { ...w, tasks: w.tasks.map((t) => (t.day === day ? { ...t, done: !allDone } : t)) }
    })

  const addPriority = (title: string) => {
    const t = title.trim()
    if (!t) return
    mutate((w) => ({
      ...w,
      priorities: [
        ...w.priorities,
        { id: uid(), title: t, color: PRIORITY_COLORS[w.priorities.length % PRIORITY_COLORS.length] }
      ]
    }))
    setNewPriority('')
  }
  const removePriority = (id: string) =>
    mutate((w) => ({
      ...w,
      priorities: w.priorities.filter((p) => p.id !== id),
      tasks: w.tasks.map((t) => (t.priorityId === id ? { ...t, priorityId: null } : t))
    }))

  // ─── Claude assist ───────────────────────────────────────────────────────
  const runAssist = async (
    mode: PlannerAssistMode,
    withNotes?: string,
    images?: { mediaType: string; data: string }[]
  ) => {
    setAssistMode(mode)
    setAssistResult(null)
    setAssistError(null)
    setNeedNotes(false)
    setNeedImage(false)
    setAssistBusy(true)
    const res = await window.electronAPI.plannerAssist({
      mode,
      week,
      notes: withNotes,
      images,
      model: runModel ?? defaultModel,
      accountId: runAccountId ?? defaultAccountId
    })
    setAssistBusy(false)
    if (!res.ok) {
      setAssistError(res.error || 'Something went wrong.')
      return
    }
    setAssistResult(res.data)
    if (mode === 'reflect' && res.data && typeof (res.data as any).summary === 'string') {
      mutate((w) => ({ ...w, reflection: (res.data as any).summary }))
    }
  }

  // Open the drawer for any mode WITHOUT running — the user picks account/model and then
  // presses Start (draft collects notes, import collects an image first).
  const startAssist = (mode: PlannerAssistMode) => {
    setNotes('')
    setImage(null)
    setAssistMode(mode)
    setAssistResult(null)
    setAssistError(null)
    setNeedNotes(mode === 'draft')
    setNeedImage(mode === 'import')
  }

  const applyDraft = (data: any) => {
    const priorities: WeeklyPriority[] = (data.priorities ?? []).map((p: any, i: number) => ({
      id: uid(),
      title: String(p.title ?? p),
      color: PRIORITY_COLORS[i % PRIORITY_COLORS.length]
    }))
    const byTitle = new Map(priorities.map((p) => [p.title.toLowerCase(), p.id]))
    const tasks: PlannerTask[] = (data.tasks ?? []).map((t: any) => ({
      id: uid(),
      title: String(t.title ?? ''),
      day: typeof t.day === 'number' && t.day >= 0 && t.day <= 6 ? t.day : null,
      done: false,
      effort: EFFORTS.includes(t.effort) ? t.effort : 'medium',
      timeOfDay: t.timeOfDay || null,
      endTime: t.endTime || null,
      durationMin: typeof t.durationMin === 'number' ? t.durationMin : null,
      priorityId: t.priorityTitle ? byTitle.get(String(t.priorityTitle).toLowerCase()) ?? null : null
    }))
    mutate((w) => ({ ...w, intention: data.intention || w.intention, priorities, tasks }))
    closeAssist()
  }

  const applyRebalance = (data: any) => {
    const moves: { id: string; day: number | null }[] = (data.moves ?? []).filter((m: any) => m && m.id)
    mutate((w) => ({
      ...w,
      tasks: w.tasks.map((t) => {
        const mv = moves.find((m) => m.id === t.id)
        if (!mv) return t
        const day = mv.day === null || (typeof mv.day === 'number' && mv.day >= 0 && mv.day <= 6) ? mv.day : t.day
        return { ...t, day }
      })
    }))
    closeAssist()
  }

  const saveReview = (mode: 'review' | 'reflect', data: any) => {
    const review: SavedReview = {
      id: uid(),
      createdAt: Date.now(),
      mode,
      model: runModel ?? defaultModel,
      score: typeof data.score === 'number' ? data.score : null,
      summary: typeof data.summary === 'string' ? data.summary : undefined,
      warnings: Array.isArray(data.warnings) ? data.warnings : undefined,
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : undefined,
      wins: Array.isArray(data.wins) ? data.wins : undefined,
      misses: Array.isArray(data.misses) ? data.misses : undefined,
      adjustments: Array.isArray(data.adjustments) ? data.adjustments : undefined
    }
    mutate((w) => ({ ...w, reviews: [review, ...(w.reviews ?? [])] }))
    // Close the drawer and draw the eye to the saved card.
    closeAssist()
    setFlashReviewId(review.id)
  }
  const deleteReview = (id: string) =>
    mutate((w) => ({ ...w, reviews: (w.reviews ?? []).filter((rv) => rv.id !== id) }))

  const closeAssist = () => {
    setAssistMode(null)
    setAssistResult(null)
    setAssistError(null)
    setNeedNotes(false)
    setNeedImage(false)
    setImage(null)
  }

  // ─── Derived ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const scheduled = week.tasks.filter((t) => t.day !== null)
    const done = scheduled.filter((t) => t.done).length
    const load = Array.from({ length: 7 }, (_, d) =>
      week.tasks.filter((t) => t.day === d).reduce((s, t) => s + (t.effort ? EFFORT_WEIGHT[t.effort] : 1), 0)
    )
    const maxLoad = Math.max(...load, 1)
    const deep = scheduled.filter((t) => t.effort === 'deep').length
    const busiest = load.reduce((best, v, i) => (v > load[best] ? i : best), 0)
    const pct = scheduled.length ? Math.round((done / scheduled.length) * 100) : 0
    return { total: scheduled.length, done, load, maxLoad, deep, busiest, pct }
  }, [week])

  const priorityById = (id?: string | null) => week.priorities.find((p) => p.id === id)
  const backlog = week.tasks.filter((t) => t.day === null)

  const rangeLabel = `${addDays(weekStart, 0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(
    weekStart,
    6
  ).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`

  // Sprint mode hands off entirely to the Scrum board (it owns its own header + toggle).
  if (mode === 'sprint') {
    return (
      <SprintBoard
        mode={mode}
        onMode={changeMode}
        accounts={accounts}
        models={models}
        defaultModel={defaultModel}
        defaultAccountId={defaultAccountId}
        codexAccounts={codexAccounts}
        geminiAccounts={geminiAccounts}
        codexDefaultAccountId={codexDefaultAccountId}
        geminiDefaultAccountId={geminiDefaultAccountId}
        onStandupChat={onStandupChat}
        onScheduleStandup={onScheduleStandup}
      />
    )
  }

  // The repo-backed backlog hands off the same way. The week stays owned here: the board
  // gets the unscheduled tasks and a way to drop one, not the week itself.
  if (mode === 'backlog') {
    return (
      <BacklogBoard mode={mode} onMode={changeMode} legacyTasks={backlog} onDropLegacyTask={deleteTask} />
    )
  }

  return (
    <div className="view">
      <div className="view-header planner-header">
        <div className="planner-title-wrap">
          <PlannerModeToggle mode={mode} onMode={changeMode} />
          <div>
            <h1>Planner</h1>
            <p className="view-sub">
              Week of {rangeLabel}
              {stats.total > 0 && (
                <>
                  {' · '}
                  {stats.done}/{stats.total} done
                </>
              )}
            </p>
          </div>
        </div>
        <div className="planner-header-actions">
          <div className="week-nav">
            <button className="btn-ghost icon" title="Previous week" onClick={() => setWeekStart((w) => shiftWeek(w, -1))}>
              ‹
            </button>
            <button className="btn-ghost" onClick={() => setWeekStart(mondayOf(new Date()))}>
              This week
            </button>
            <button className="btn-ghost icon" title="Next week" onClick={() => setWeekStart((w) => shiftWeek(w, 1))}>
              ›
            </button>
          </div>
          <div className="seg-control week-span" title="Show weekend or work week only">
            {([
              [false, '5d', 'Work week (Mon–Fri)'],
              [true, '7d', 'Full week (Mon–Sun)']
            ] as const).map(([wk, label, tip]) => (
              <button
                key={label}
                className={showWeekend === wk ? 'on' : ''}
                title={tip}
                onClick={() => {
                  setShowWeekend(wk)
                  localStorage.setItem('planner.showWeekend', String(wk))
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="assist-bar">
            <button className="assist-btn primary" onClick={() => startAssist('review')} disabled={assistBusy}>
              <Spark /> Review my week
            </button>
            <button className="assist-btn" onClick={() => startAssist('draft')} disabled={assistBusy}>
              Draft a week
            </button>
            <button className="assist-btn" onClick={() => startAssist('import')} disabled={assistBusy}>
              <ImageIcon /> Import image
            </button>
            <button className="assist-btn" onClick={() => startAssist('rebalance')} disabled={assistBusy || stats.total === 0}>
              Rebalance
            </button>
            <button className="assist-btn" onClick={() => startAssist('reflect')} disabled={assistBusy || stats.total === 0}>
              Reflect
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="view-loading">
          <div className="view-spinner" />
          <span className="view-loading-text">Loading your week…</span>
        </div>
      ) : (
        <div className="view-scroll planner-scroll">
          {/* Summary strip */}
          <div className="planner-stats">
            <div className="stat-card">
              <div className="stat-ico sched">
                <Spark />
              </div>
              <div className="stat-body">
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">Tasks scheduled</div>
              </div>
            </div>
            <div className="stat-card">
              <MiniRing pct={stats.pct} />
              <div className="stat-body">
                <div className="stat-value">
                  {stats.done}
                  <span className="stat-sub">/{stats.total || 0}</span>
                </div>
                <div className="stat-label">Completed</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-ico deep">◆</div>
              <div className="stat-body">
                <div className="stat-value">{stats.deep}</div>
                <div className="stat-label">Deep-work blocks</div>
              </div>
            </div>
            <div className="stat-card wide">
              <div className="stat-body">
                <div className="stat-label">Week load</div>
                <div className="stat-spark">
                  {stats.load.slice(0, showWeekend ? 7 : 5).map((v, i) => (
                    <div
                      key={i}
                      className={`spark-bar ${i === stats.busiest && v > 0 ? 'peak' : ''}`}
                      style={{ height: `${Math.max(8, (v / stats.maxLoad) * 100)}%` }}
                      title={`${DAY_SHORT[i]}: ${v}`}
                    >
                      <span>{DAY_SHORT[i][0]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Intention + priorities */}
          <div className="planner-top">
            <div className="planner-intention">
              <label className="planner-label">This week's intention</label>
              <input
                className="text-input"
                placeholder="What's the one thing that would make this a great week?"
                value={week.intention ?? ''}
                onChange={(e) => mutate((w) => ({ ...w, intention: e.target.value }))}
              />
            </div>
            <div className="planner-priorities">
              <label className="planner-label">Weekly priorities</label>
              <div className="priority-chips">
                {week.priorities.map((p) => (
                  <span className="priority-chip" key={p.id} style={{ ['--pc' as any]: p.color }}>
                    <span className="priority-dot" />
                    {p.title}
                    <button className="chip-x" onClick={() => removePriority(p.id)} title="Remove">
                      ×
                    </button>
                  </span>
                ))}
                {week.priorities.length < 6 && (
                  <input
                    className="priority-add"
                    placeholder="+ add priority"
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addPriority(newPriority)
                    }}
                    onBlur={() => newPriority.trim() && addPriority(newPriority)}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Week board */}
          <div className={`planner-board ${showWeekend ? '' : 'work-week'}`}>
            {DAY_NAMES.slice(0, showWeekend ? 7 : 5).map((_name, d) => {
              const dayDate = addDays(weekStart, d)
              const isToday = ymd(dayDate) === todayYmd
              const dayTasks = week.tasks.filter((t) => t.day === d)
              return (
                <DayColumn
                  key={d}
                  day={d}
                  name={DAY_SHORT[d]}
                  date={dayDate.getDate()}
                  isToday={isToday}
                  isWeekend={d >= 5}
                  load={stats.load[d]}
                  maxLoad={stats.maxLoad}
                  tasks={dayTasks}
                  allDone={dayTasks.length > 0 && dayTasks.every((t) => t.done)}
                  priorityById={priorityById}
                  dragging={drag}
                  onDragStart={setDrag}
                  onDragEnd={() => setDrag(null)}
                  onMove={(id, index) => {
                    moveTask(id, d, index)
                    setDrag(null)
                  }}
                  onAdd={(title) => addTask(d, title)}
                  onToggle={(id, done) => updateTask(id, { done })}
                  onToggleDay={() => toggleDay(d)}
                  onOpenTask={setEditingTaskId}
                  onDelete={deleteTask}
                  onRunTask={onRunTask}
                  runDisabled={!!streaming}
                />
              )
            })}
          </div>

          {/* Backlog */}
          <div
            className={`planner-backlog ${drag ? 'droppable' : ''}`}
            onDragOver={(e) => drag && e.preventDefault()}
            onDrop={() => drag && (moveTask(drag, null, Number.MAX_SAFE_INTEGER), setDrag(null))}
          >
            <div className="backlog-head">
              <span className="planner-label">Backlog / unscheduled</span>
              <span className="backlog-count">{backlog.length}</span>
            </div>
            <div className="backlog-tasks">
              {backlog.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  priority={priorityById(t.priorityId)}
                  onDragStart={() => setDrag(t.id)}
                  onDragEnd={() => setDrag(null)}
                  onToggle={(done) => updateTask(t.id, { done })}
                  onDelete={() => deleteTask(t.id)}
                  onOpen={() => setEditingTaskId(t.id)}
                  onRun={onRunTask ? () => onRunTask(t) : undefined}
                  runDisabled={!!streaming}
                />
              ))}
              <AddTaskInline onAdd={(title) => addTask(null, title)} placeholder="+ capture a task" />
            </div>
          </div>

          {/* Saved reviews / reflections */}
          {week.reviews && week.reviews.length > 0 && (
            <div className="planner-reviews">
              <div className="backlog-head">
                <span className="planner-label">Saved reviews</span>
                <span className="backlog-count">{week.reviews.length}</span>
              </div>
              <div className="reviews-list">
                {week.reviews.map((rv) => (
                  <ReviewCard
                    key={rv.id}
                    review={rv}
                    flash={flashReviewId === rv.id}
                    onDelete={() => deleteReview(rv.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {assistMode && (
        <AssistDrawer
          mode={assistMode}
          busy={assistBusy}
          result={assistResult}
          error={assistError}
          needNotes={needNotes}
          notes={notes}
          setNotes={setNotes}
          onRunWithNotes={() => runAssist('draft', notes)}
          onStart={() => runAssist(assistMode)}
          needImage={needImage}
          image={image}
          setImage={setImage}
          onRunImage={() =>
            image && runAssist('import', undefined, [{ mediaType: image.mediaType, data: image.data }])
          }
          onApplyDraft={applyDraft}
          onApplyRebalance={applyRebalance}
          onSaveReview={saveReview}
          onClose={closeAssist}
          priorityById={priorityById}
          tasksById={(id: string) => week.tasks.find((t) => t.id === id)}
          accounts={accounts}
          models={models}
          runAccountId={runAccountId ?? defaultAccountId}
          runModel={runModel ?? defaultModel}
          onPickAccount={setRunAccountId}
          onPickModel={setRunModel}
        />
      )}

      {editingTaskId &&
        (() => {
          const t = week.tasks.find((x) => x.id === editingTaskId)
          if (!t) return null
          return (
            <TaskModal
              task={t}
              priorities={week.priorities}
              onPatch={(patch) => updateTask(t.id, patch)}
              onDelete={() => {
                deleteTask(t.id)
                setEditingTaskId(null)
              }}
              onClose={() => setEditingTaskId(null)}
            />
          )
        })()}
    </div>
  )
}

// ─── Day column ────────────────────────────────────────────────────────────
function DayColumn(props: {
  day: number
  name: string
  date: number
  isToday: boolean
  isWeekend: boolean
  load: number
  maxLoad: number
  tasks: PlannerTask[]
  allDone: boolean
  priorityById: (id?: string | null) => WeeklyPriority | undefined
  dragging: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onMove: (id: string, index: number) => void
  onAdd: (title: string) => void
  onToggle: (id: string, done: boolean) => void
  onToggleDay: () => void
  onOpenTask: (id: string) => void
  onDelete: (id: string) => void
  onRunTask?: (task: PlannerTask) => void
  runDisabled?: boolean
}) {
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const loadPct = props.maxLoad ? (props.load / props.maxLoad) * 100 : 0
  const heavy = props.load >= 7
  const dragging = props.dragging
  const reset = () => setOverIndex(null)
  return (
    <div
      className={`day-col ${props.isToday ? 'today' : ''} ${props.isWeekend ? 'weekend' : ''} ${overIndex !== null ? 'over' : ''}`}
      onDragOver={(e) => dragging && e.preventDefault()}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) reset()
      }}
      onDrop={() => {
        if (dragging) props.onMove(dragging, overIndex ?? props.tasks.length)
        reset()
      }}
    >
      <div className="day-head">
        <label className="day-check-wrap" title="Mark all tasks in this day">
          <input
            type="checkbox"
            className="day-check"
            checked={props.allDone}
            onChange={props.onToggleDay}
            disabled={props.tasks.length === 0}
          />
          <span className="day-name">{props.name}</span>
        </label>
        <span className="day-date">{props.date}</span>
      </div>
      <div className="day-load" title={`Load: ${props.load}`}>
        <div className={`day-load-fill ${heavy ? 'heavy' : ''}`} style={{ width: `${loadPct}%` }} />
      </div>
      <div
        className="day-tasks"
        onDragOver={(e) => {
          if (dragging && e.target === e.currentTarget) {
            e.preventDefault()
            setOverIndex(props.tasks.length)
          }
        }}
      >
        {props.tasks.map((t, i) => (
          <div
            key={t.id}
            className="task-slot"
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              setOverIndex(e.clientY < r.top + r.height / 2 ? i : i + 1)
            }}
          >
            {dragging && overIndex === i && <div className="drop-line" />}
            <TaskCard
              task={t}
              priority={props.priorityById(t.priorityId)}
              onDragStart={() => props.onDragStart(t.id)}
              onDragEnd={() => {
                props.onDragEnd()
                reset()
              }}
              onToggle={(done) => props.onToggle(t.id, done)}
              onDelete={() => props.onDelete(t.id)}
              onOpen={() => props.onOpenTask(t.id)}
              onRun={props.onRunTask ? () => props.onRunTask!(t) : undefined}
              runDisabled={props.runDisabled}
            />
          </div>
        ))}
        {dragging && overIndex === props.tasks.length && <div className="drop-line" />}
        <AddTaskInline onAdd={props.onAdd} placeholder="+ task" />
      </div>
    </div>
  )
}

// ─── Task card (click to open the editor, drag to move/reorder) ───────────────
function TaskCard(props: {
  task: PlannerTask
  priority?: WeeklyPriority
  onDragStart: () => void
  onDragEnd: () => void
  onToggle: (done: boolean) => void
  onDelete: () => void
  onOpen: () => void
  onRun?: () => void
  runDisabled?: boolean
}) {
  const t = props.task
  return (
    <div
      className={`task-card ${t.done ? 'done' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        props.onDragStart()
      }}
      onDragEnd={props.onDragEnd}
      onClick={props.onOpen}
      title="Click to edit · drag to move"
      style={props.priority ? { ['--accent-edge' as any]: props.priority.color } : undefined}
    >
      <div className="task-main">
        <button
          className={`task-check ${t.done ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggle(!t.done)
          }}
          title={t.done ? 'Mark not done' : 'Mark done'}
        >
          {t.done ? '✓' : ''}
        </button>
        <span className="task-title">{t.title}</span>
        {props.onRun && (
          <button
            className="task-run"
            onClick={(e) => {
              e.stopPropagation()
              props.onRun!()
            }}
            title={props.runDisabled ? 'A run is already in progress' : 'Run with Claude'}
            disabled={!!props.runDisabled}
          >
            <Spark />
          </button>
        )}
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
      <div className="task-meta">
        {t.timeOfDay && (
          <span className="task-time">
            {t.timeOfDay}
            {t.endTime ? `–${t.endTime}` : ''}
          </span>
        )}
        <span className={`effort-tag ${t.effort ?? 'medium'}`}>{t.effort ?? 'medium'}</span>
        {props.priority && (
          <span className="task-prio" style={{ ['--pc' as any]: props.priority.color }}>
            {props.priority.title}
          </span>
        )}
      </div>
    </div>
  )
}

function AddTaskInline({ onAdd, placeholder }: { onAdd: (t: string) => void; placeholder: string }) {
  const [val, setVal] = useState('')
  return (
    <input
      className="add-task-inline"
      placeholder={placeholder}
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

// ─── Assist drawer ───────────────────────────────────────────────────────────
function AssistDrawer(props: {
  mode: PlannerAssistMode
  busy: boolean
  result: any
  error: string | null
  needNotes: boolean
  notes: string
  setNotes: (v: string) => void
  onRunWithNotes: () => void
  onStart: () => void
  needImage: boolean
  image: { mediaType: string; data: string; preview: string } | null
  setImage: (v: { mediaType: string; data: string; preview: string } | null) => void
  onRunImage: () => void
  onApplyDraft: (data: any) => void
  onApplyRebalance: (data: any) => void
  onSaveReview: (mode: 'review' | 'reflect', data: any) => void
  onClose: () => void
  priorityById: (id?: string | null) => WeeklyPriority | undefined
  tasksById: (id: string) => PlannerTask | undefined
  accounts: CCAccountStatus[]
  models: ModelInfo[]
  runAccountId: string
  runModel: string
  onPickAccount: (id: string) => void
  onPickModel: (id: string) => void
}) {
  const titles: Record<PlannerAssistMode, string> = {
    review: 'Claude · Week review',
    draft: 'Claude · Draft a week',
    reflect: 'Claude · Weekly reflection',
    rebalance: 'Claude · Rebalance',
    import: 'Claude · Import from image'
  }
  const fileRef = useRef<HTMLInputElement>(null)

  // While waiting for an image, accept a pasted screenshot anywhere in the window.
  useEffect(() => {
    if (!props.needImage) return
    const onPaste = async (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) {
        const img = await fileToImage(file)
        if (img) props.setImage(img)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [props.needImage])

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const img = await fileToImage(file)
      if (img) props.setImage(img)
    }
  }
  const onDropFile = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) {
      const img = await fileToImage(file)
      if (img) props.setImage(img)
    }
  }

  const r = props.result
  const isDraftLike = props.mode === 'draft' || props.mode === 'import'
  return createPortal(
    <div className="assist-overlay" onClick={props.onClose}>
      <div className="assist-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="assist-drawer-head">
          <span className="assist-title">
            <Spark /> {titles[props.mode]}
          </span>
          <button className="chip-x lg" onClick={props.onClose}>
            ×
          </button>
        </div>

        {/* Per-run account + model — custom pickers (native <select> popups don't render in
            this frameless/transparent window). Kept outside the scrollable body so the
            dropdown menus aren't clipped. */}
        <div className="assist-runwith">
          <div className="assist-runwith-field">
            <span className="assist-runwith-label">Account</span>
            <AccountPicker
              items={props.accounts.map((a) => ({
                provider: 'claude' as const,
                id: a.id,
                name: a.name,
                loggedIn: a.loggedIn,
                email: a.email,
                plan: a.plan
              }))}
              selectedProvider="claude"
              selectedId={props.runAccountId}
              onPick={(_provider, id) => props.onPickAccount(id)}
              onManage={() => {}}
              disabled={props.busy}
            />
          </div>
          <div className="assist-runwith-field">
            <span className="assist-runwith-label">Model</span>
            <ModelPicker models={props.models} value={props.runModel} onChange={props.onPickModel} disabled={props.busy} />
          </div>
        </div>

        <div className="assist-body">
          {props.needNotes && !r && (
            <div className="assist-notes">
              <p className="assist-hint">
                Tell Claude your goals and constraints for the week — it'll propose a balanced plan you can apply.
              </p>
              <textarea
                className="text-input textarea"
                rows={5}
                placeholder={
                  'e.g. Ship the v2 onboarding flow, prep the board deck, 2 gym sessions, keep Friday afternoon free for deep work…'
                }
                value={props.notes}
                onChange={(e) => props.setNotes(e.target.value)}
                autoFocus
              />
              <button className="assist-btn primary wide" onClick={props.onRunWithNotes} disabled={!props.notes.trim()}>
                <Spark /> Draft my week
              </button>
            </div>
          )}

          {props.needImage && !r && (
            <div className="assist-notes">
              <p className="assist-hint">
                Paste (Ctrl+V), drop, or upload a screenshot of your weekly calendar — Claude reads it and
                builds the week. You can review before applying.
              </p>
              <div
                className={`import-zone ${props.image ? 'has-image' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropFile}
              >
                {props.image ? (
                  <img className="import-preview" src={props.image.preview} alt="calendar to import" />
                ) : (
                  <div className="import-hint">
                    <ImageIcon />
                    <span>Paste, drop, or click to upload</span>
                  </div>
                )}
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
              </div>
              {props.image && (
                <div className="assist-apply-row">
                  <button className="assist-btn primary" onClick={props.onRunImage}>
                    <Spark /> Read calendar
                  </button>
                  <button className="assist-btn" onClick={() => props.setImage(null)}>
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Review / Reflect / Rebalance: pick account & model, then Start. */}
          {!props.needNotes && !props.needImage && !r && !props.busy && (
            <div className="assist-notes">
              <p className="assist-hint">{START_HINTS[props.mode]}</p>
              <button className="assist-btn primary wide" onClick={props.onStart}>
                <Spark /> {START_LABELS[props.mode]}
              </button>
            </div>
          )}

          {props.busy && (
            <div className="assist-loading">
              <div className="view-spinner" />
              <span>Claude is thinking through your week…</span>
            </div>
          )}

          {props.error && <div className="assist-error">{props.error}</div>}

          {r && !props.busy && (
            <>
              {/* Review */}
              {props.mode === 'review' && (
                <>
                  {typeof r.score === 'number' && <ScoreRing score={r.score} />}
                  {r.summary && <p className="assist-summary">{r.summary}</p>}
                  {Array.isArray(r.warnings) && r.warnings.length > 0 && (
                    <div className="assist-section">
                      <h4>⚠ Watch out</h4>
                      <ul className="assist-list warn">
                        {r.warnings.map((w: string, i: number) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(r.suggestions) && r.suggestions.length > 0 && (
                    <div className="assist-section">
                      <h4>Suggestions</h4>
                      <ul className="assist-list">
                        {r.suggestions.map((s: any, i: number) => (
                          <li key={i}>
                            <strong>{s.title}</strong>
                            {s.detail && <span> — {s.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="assist-apply-row">
                    <button className="assist-btn primary" onClick={() => props.onSaveReview('review', r)}>
                      Save review to week
                    </button>
                  </div>
                </>
              )}

              {/* Reflect */}
              {props.mode === 'reflect' && (
                <>
                  {r.summary && <p className="assist-summary">{r.summary}</p>}
                  {renderList('✓ Wins', r.wins, 'good')}
                  {renderList('✗ Misses', r.misses, 'warn')}
                  {renderList('→ Try next week', r.adjustments)}
                  <div className="assist-apply-row">
                    <button className="assist-btn primary" onClick={() => props.onSaveReview('reflect', r)}>
                      Save reflection to week
                    </button>
                  </div>
                </>
              )}

              {/* Draft / image-import preview */}
              {isDraftLike && (
                <>
                  {r.intention && (
                    <p className="assist-summary">
                      <strong>Intention:</strong> {r.intention}
                    </p>
                  )}
                  {Array.isArray(r.priorities) && (
                    <div className="assist-section">
                      <h4>Priorities</h4>
                      <ul className="assist-list">
                        {r.priorities.map((p: any, i: number) => (
                          <li key={i}>{p.title ?? p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(r.tasks) && (
                    <div className="assist-section">
                      <h4>{r.tasks.length} tasks across the week</h4>
                      <ul className="assist-list compact">
                        {r.tasks.map((t: any, i: number) => (
                          <li key={i}>
                            <span className="draft-day">{t.day >= 0 && t.day <= 6 ? DAY_SHORT[t.day] : '—'}</span>
                            {t.title}
                            {t.effort && <span className={`effort-tag inline ${t.effort}`}>{t.effort}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="assist-apply-row">
                    <button className="assist-btn primary" onClick={() => props.onApplyDraft(r)}>
                      Apply (replaces current week)
                    </button>
                    <button className="assist-btn" onClick={props.onClose}>
                      Discard
                    </button>
                  </div>
                </>
              )}

              {/* Rebalance preview */}
              {props.mode === 'rebalance' && (
                <>
                  {r.summary && <p className="assist-summary">{r.summary}</p>}
                  {Array.isArray(r.moves) && r.moves.length > 0 ? (
                    <>
                      <div className="assist-section">
                        <h4>Proposed moves</h4>
                        <ul className="assist-list">
                          {r.moves.map((m: any, i: number) => {
                            const task = props.tasksById(m.id)
                            return (
                              <li key={i}>
                                <span className="draft-day">
                                  {m.day === null ? 'Backlog' : DAY_SHORT[m.day] ?? '?'}
                                </span>
                                {task ? task.title : '(unknown task)'}
                                {m.reason && <span className="move-reason"> — {m.reason}</span>}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                      <div className="assist-apply-row">
                        <button className="assist-btn primary" onClick={() => props.onApplyRebalance(r)}>
                          Apply moves
                        </button>
                        <button className="assist-btn" onClick={props.onClose}>
                          Discard
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="assist-summary">Claude thinks your week is already well balanced. 👍</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Task editor modal (pill selectors — native <select> popups don't render here) ──
function TaskModal(props: {
  task: PlannerTask
  priorities: WeeklyPriority[]
  onPatch: (patch: Partial<PlannerTask>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const t = props.task
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return createPortal(
    <div className="task-modal-overlay" onClick={props.onClose}>
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-modal-heading">Edit task</span>
          <button className="chip-x lg" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="task-modal-body">
          <textarea
            className="text-input task-modal-title"
            rows={2}
            value={t.title}
            placeholder="Task title"
            autoFocus
            onChange={(e) => props.onPatch({ title: e.target.value })}
          />

          <div className="task-modal-field">
            <span className="task-modal-label">Day</span>
            <div className="pill-row">
              {DAY_SHORT.map((d, i) => (
                <button key={i} className={`pill ${t.day === i ? 'on' : ''}`} onClick={() => props.onPatch({ day: i })}>
                  {d}
                </button>
              ))}
              <button className={`pill ${t.day === null ? 'on' : ''}`} onClick={() => props.onPatch({ day: null })}>
                Backlog
              </button>
            </div>
          </div>

          <div className="task-modal-times">
            <label>
              <span className="task-modal-label">Start</span>
              <input
                type="time"
                className="text-input"
                value={t.timeOfDay ?? ''}
                onChange={(e) => props.onPatch({ timeOfDay: e.target.value || null })}
              />
            </label>
            <label>
              <span className="task-modal-label">End</span>
              <input
                type="time"
                className="text-input"
                value={t.endTime ?? ''}
                onChange={(e) => props.onPatch({ endTime: e.target.value || null })}
              />
            </label>
          </div>

          <div className="task-modal-field">
            <span className="task-modal-label">Effort</span>
            <div className="pill-row">
              {EFFORTS.map((ef) => (
                <button
                  key={ef}
                  className={`pill effort-tag ${ef} ${(t.effort ?? 'medium') === ef ? 'on' : ''}`}
                  onClick={() => props.onPatch({ effort: ef })}
                >
                  {ef}
                </button>
              ))}
            </div>
          </div>

          <div className="task-modal-field">
            <span className="task-modal-label">Priority</span>
            <div className="pill-row">
              <button className={`pill ${!t.priorityId ? 'on' : ''}`} onClick={() => props.onPatch({ priorityId: null })}>
                None
              </button>
              {props.priorities.map((p) => (
                <button
                  key={p.id}
                  className={`pill ${t.priorityId === p.id ? 'on' : ''}`}
                  style={{ ['--pc' as any]: p.color }}
                  onClick={() => props.onPatch({ priorityId: p.id })}
                >
                  <span className="pill-dot" />
                  {p.title}
                </button>
              ))}
            </div>
          </div>

          <label className="task-modal-done">
            <input type="checkbox" checked={t.done} onChange={(e) => props.onPatch({ done: e.target.checked })} />
            <span>Mark as done</span>
          </label>
        </div>
        <div className="task-modal-foot">
          <button className="btn-text danger" onClick={props.onDelete}>
            Delete task
          </button>
          <button className="assist-btn primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ReviewCard({ review, flash, onDelete }: { review: SavedReview; flash?: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const when = new Date(review.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  const title = review.mode === 'review' ? 'Week review' : 'Reflection'
  const score = review.score
  const tone = typeof score === 'number' ? (score >= 75 ? 'good' : score >= 50 ? 'mid' : 'low') : ''
  return (
    <div className={`review-card ${flash ? 'flash' : ''}`} data-review-id={review.id}>
      <div className="review-card-head" onClick={() => setOpen((v) => !v)}>
        {typeof score === 'number' && <span className={`review-score ${tone}`}>{score}</span>}
        <div className="review-card-meta">
          <span className="review-card-title">{title}</span>
          <span className="review-card-when">
            {when}
            {review.model ? ` · ${review.model}` : ''}
          </span>
        </div>
        <button
          className="task-del"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete review"
        >
          ×
        </button>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          style={{ transform: open ? 'rotate(90deg)' : '', transition: 'transform 0.15s', color: 'var(--text-2)', flexShrink: 0 }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
      {review.summary && <p className="review-card-summary">{review.summary}</p>}
      {open && (
        <div className="review-card-body">
          {renderList('⚠ Watch out', review.warnings, 'warn')}
          {review.suggestions && review.suggestions.length > 0 && (
            <div className="assist-section">
              <h4>Suggestions</h4>
              <ul className="assist-list">
                {review.suggestions.map((s, i) => (
                  <li key={i}>
                    <strong>{s.title}</strong>
                    {s.detail && <span> — {s.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {renderList('✓ Wins', review.wins, 'good')}
          {renderList('✗ Misses', review.misses, 'warn')}
          {renderList('→ Try next week', review.adjustments)}
        </div>
      )}
    </div>
  )
}

function renderList(title: string, items: unknown, tone?: string) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="assist-section">
      <h4>{title}</h4>
      <ul className={`assist-list ${tone ?? ''}`}>
        {items.map((it, i) => (
          <li key={i}>{String(it)}</li>
        ))}
      </ul>
    </div>
  )
}

function ScoreRing({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score))
  const tone = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'low'
  return (
    <div className={`score-ring ${tone}`}>
      <svg viewBox="0 0 36 36" width="64" height="64">
        <circle className="ring-bg" cx="18" cy="18" r="15.9" />
        <circle
          className="ring-fg"
          cx="18"
          cy="18"
          r="15.9"
          strokeDasharray={`${pct}, 100`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <div className="score-num">
        {pct}
        <span>/100</span>
      </div>
    </div>
  )
}

function MiniRing({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className="mini-ring">
      <svg viewBox="0 0 36 36" width="40" height="40">
        <circle className="ring-bg" cx="18" cy="18" r="15.9" />
        <circle
          className="ring-fg good"
          cx="18"
          cy="18"
          r="15.9"
          strokeDasharray={`${p}, 100`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="mini-ring-num">{p}%</span>
    </div>
  )
}

function fileToImage(
  file: File
): Promise<{ mediaType: string; data: string; preview: string } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      resolve(comma >= 0 ? { mediaType: file.type, data: url.slice(comma + 1), preview: url } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function ImageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
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
