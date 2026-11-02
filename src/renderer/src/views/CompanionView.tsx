// The companion's list in the main window (docs/COMPANION_PLAN.md §12 item 7): tasks in
// Hoje / Amanhã / Mais tarde / Sem data, notes newest first, and the selected task's
// detail in a column that slides open on the right (SYSTEM-DESIGN.md §7, §9).
//
// Everything goes through the same IPC as the pet's bubble: `capture` for the quick-add
// line (one parser for both), `update` / `done` / `delete` for edits, and `onChanged`
// keeps the list live when the pet or the scheduler changes something.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  CompanionActiveSprint,
  CompanionCaptureResult,
  CompanionList,
  CompanionNote,
  CompanionPrefs,
  CompanionSprintLink,
  CompanionTodo
} from '../types'
import { useLanguage, useT } from '../i18n'
import { useLingering } from '../hooks/useLingering'
import { chipLabel, rowWhen, toLocalInputValue, whenPhrase } from '../companion/format'
import {
  GROUP_ORDER,
  defaultNewReminder,
  dueFromInputs,
  groupTodos,
  isOverdue,
  reminderLabel,
  rowTimeLabel,
  sprintRange,
  toDateInput,
  toTimeInput,
  withDue,
  type CompanionGroupKey
} from './companion-groups'
import './CompanionView.css'

const api = window.electronAPI.companion

const DEFAULT_PREFS: CompanionPrefs = {
  stayOnScreen: false,
  shortcut: '',
  leadMinutes: 10,
  morningHour: 9,
  hideFromCapture: true,
  voice: false,
  voiceShortcut: '',
  walk: true,
  askModel: true
}

/** Text-field saves wait this long after the last keystroke. */
const SAVE_DEBOUNCE_MS = 500

type Tab = 'todos' | 'notes'

const isField = (el: EventTarget | null): boolean => {
  const tag = (el as HTMLElement | null)?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** The Sprint view's column names, reused for a promoted todo's read-only status. */
const SPRINT_STATUS_KEY = {
  todo: 'sprints.column.todo',
  'in-progress': 'sprints.column.inProgress',
  done: 'sprints.column.done'
} as const

/** A promoted todo whose sprint item is still there: the sprint owns its `done`. */
const isOwned = (link: CompanionSprintLink | undefined): link is CompanionSprintLink & { status: 'todo' | 'in-progress' | 'done' } =>
  !!link && link.status !== 'missing'

export default function CompanionView({ onOpenSprint }: { onOpenSprint?: () => void } = {}) {
  const t = useT()
  const { locale } = useLanguage()
  const [list, setList] = useState<CompanionList | null>(null)
  const [prefs, setPrefs] = useState<CompanionPrefs>(DEFAULT_PREFS)
  const [shortcut, setShortcut] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('todos')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const colRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let cancelled = false
    api
      .list()
      .then((l) => !cancelled && setList(l))
      .catch(() => {})
    api
      .state()
      .then((s) => {
        if (cancelled) return
        setPrefs(s.prefs)
        setShortcut(s.shortcut)
      })
      .catch(() => {})
    const off = api.onChanged((l) => setList(l))
    // Sections are computed from the clock: past midnight, tomorrow's items become today's.
    const tick = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      cancelled = true
      off()
      window.clearInterval(tick)
    }
  }, [])

  const todos = useMemo(() => list?.todos ?? [], [list])
  const notes = list?.notes ?? []
  const links = useMemo(() => list?.sprintLinks ?? {}, [list])
  const activeSprint = list?.activeSprint ?? null
  const groups = useMemo(() => groupTodos(todos, now), [todos, now])
  const openCount = todos.length - groups.done.length

  // The keyboard's order: the sections top to bottom, then the done ones if unfolded.
  const order = useMemo(
    () => [...GROUP_ORDER.flatMap((k) => groups[k]), ...(showDone ? groups.done : [])].map((x) => x.id),
    [groups, showDone]
  )

  const selected = tab === 'todos' ? (todos.find((x) => x.id === selectedId) ?? null) : null
  const { shown, open } = useLingering(selected)

  // A selection that vanished (deleted from the pet, or aged out of the done list).
  useEffect(() => {
    if (selectedId && list && !list.todos.some((x) => x.id === selectedId)) setSelectedId(null)
  }, [list, selectedId])

  const select = useCallback((id: string | null) => {
    setSelectedId(id)
    setConfirmId(null)
  }, [])

  // The column closes on a click outside it that is not a row, and on Esc (§9).
  useEffect(() => {
    if (!selectedId) return
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target || colRef.current?.contains(target) || target.closest('[data-cmp-row]')) return
      select(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const inCol = colRef.current?.contains(e.target as Node)
      if (isField(e.target) && !inCol) return
      ;(document.activeElement as HTMLElement | null)?.blur()
      select(null)
      listRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [selectedId, select])

  useEffect(() => {
    if (selectedId) rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const toggleDone = (todo: CompanionTodo): void => {
    // A promoted todo is ticked in the Sprint view, not here (plan §6.1).
    if (isOwned(links[todo.id])) return
    void api.done(todo.id, !todo.done)
  }

  const remove = (id: string): void => {
    setConfirmId(null)
    if (selectedId === id) {
      // Keep the keyboard somewhere sensible: the next row, else the previous one.
      const i = order.indexOf(id)
      setSelectedId(order[i + 1] ?? order[i - 1] ?? null)
    }
    void api.delete(id)
  }

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isField(e.target) || tab !== 'todos') return
    if (confirmId) {
      if (e.key === 'Enter') {
        e.preventDefault()
        remove(confirmId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setConfirmId(null)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (order.length === 0) return
      const i = selectedId ? order.indexOf(selectedId) : -1
      const next = e.key === 'ArrowDown' ? Math.min(order.length - 1, i + 1) : i <= 0 ? 0 : i - 1
      select(order[next])
      return
    }
    const sel = selectedId ? todos.find((x) => x.id === selectedId) : undefined
    if (!sel) return
    if (e.key === ' ') {
      e.preventDefault()
      toggleDone(sel)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      setConfirmId(sel.id)
    }
  }

  const row = (todo: CompanionTodo) => {
    const late = isOverdue(todo, now)
    const confirming = confirmId === todo.id
    return (
      <div
        key={todo.id}
        ref={(el) => {
          if (el) rowRefs.current.set(todo.id, el)
          else rowRefs.current.delete(todo.id)
        }}
        data-cmp-row
        role="option"
        aria-selected={selectedId === todo.id}
        className={`cmp-row${selectedId === todo.id ? ' sel' : ''}${todo.done ? ' done' : ''}`}
        onMouseDown={() => {
          // Keep the list focused so the arrow keys keep working after a click.
          window.setTimeout(() => listRef.current?.focus({ preventScroll: true }), 0)
        }}
        onClick={() => select(selectedId === todo.id ? null : todo.id)}
      >
        {isOwned(links[todo.id]) ? (
          <SprintGlyph link={links[todo.id]} />
        ) : (
          <CheckBox todo={todo} onToggle={() => toggleDone(todo)} />
        )}
        <span className="cmp-row-title">{todo.title}</span>
        {confirming ? (
          <span className="cmp-confirm" onClick={(e) => e.stopPropagation()}>
            <span>{t('companion.panel.confirm.delete')}</span>
            <button type="button" className="btn-text danger" onClick={() => remove(todo.id)}>
              {t('companion.panel.confirm.yes')}
            </button>
            <button type="button" className="btn-text" onClick={() => setConfirmId(null)}>
              {t('companion.panel.confirm.no')}
            </button>
          </span>
        ) : (
          <span className={`cmp-row-when${late ? ' late' : ''}`}>{rowTimeLabel(todo, now, locale, t)}</span>
        )}
      </div>
    )
  }

  const groupLabel: Record<CompanionGroupKey, string> = {
    today: t('companion.panel.group.today'),
    tomorrow: t('companion.panel.group.tomorrow'),
    later: t('companion.panel.group.later'),
    someday: t('companion.panel.group.someday')
  }

  return (
    <div className="view cmp">
      <div className="cmp-head">
        <h1>{t('companion.panel.title')}</h1>
        {shortcut !== null && (
          <p className="cmp-sub">
            {shortcut ? t('companion.panel.sub', { shortcut }) : t('companion.panel.subNoShortcut')}
          </p>
        )}
      </div>

      <div className="cmp-page">
        <div className="cmp-list">
          <div className="seg-control" role="tablist" aria-label={t('companion.panel.tabs.aria')}>
            {(['todos', 'notes'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={tab === k ? 'on' : ''}
                onClick={() => {
                  setTab(k)
                  select(null)
                }}
              >
                {t(k === 'todos' ? 'companion.panel.tab.todos' : 'companion.panel.tab.notes')}
                <em>{k === 'todos' ? openCount : notes.length}</em>
              </button>
            ))}
          </div>

          {tab === 'todos' ? (
            <>
              <QuickAdd key="todos" mode="todos" onTodo={(id) => select(id)} />
              <div
                className="cmp-sections"
                ref={listRef}
                role="listbox"
                tabIndex={0}
                aria-label={t('companion.panel.list.aria')}
                onKeyDown={onListKey}
              >
                {list &&
                  GROUP_ORDER.map((k) => (
                    <section key={k} className="cmp-sect">
                      <span className="eyebrow">
                        {groupLabel[k]} · <span className="cmp-num">{groups[k].length}</span>
                      </span>
                      {groups[k].length === 0 ? (
                        <p className="help cmp-empty">{t(`companion.panel.empty.${k}`)}</p>
                      ) : (
                        groups[k].map(row)
                      )}
                    </section>
                  ))}
                {list && groups.done.length > 0 && (
                  <section className="cmp-sect">
                    <button
                      type="button"
                      className="cmp-done-toggle eyebrow"
                      aria-expanded={showDone}
                      onClick={() => setShowDone((v) => !v)}
                    >
                      <svg className={showDone ? 'open' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                      {t('companion.panel.done', { n: groups.done.length })}
                    </button>
                    {showDone && groups.done.map(row)}
                  </section>
                )}
              </div>
              {list && openCount > 0 && <p className="help cmp-keys">{t('companion.panel.list.help')}</p>}
            </>
          ) : (
            <>
              <QuickAdd key="notes" mode="notes" />
              <div className="cmp-notes">
                {list && notes.length === 0 && <p className="help cmp-empty">{t('companion.panel.notes.empty')}</p>}
                {notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    when={rowWhen(note.createdAt, now, locale, t)}
                    confirming={confirmId === note.id}
                    onAsk={() => setConfirmId(note.id)}
                    onCancel={() => setConfirmId(null)}
                    onDelete={() => remove(note.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className={`slide-col ${open ? 'open' : ''}`}>
          {shown && (
            <aside className="cmp-col" aria-label={t('companion.panel.detail.aria')} ref={colRef}>
              <TodoDetail
                key={shown.id}
                todo={todos.find((x) => x.id === shown.id) ?? shown}
                prefs={prefs}
                now={now}
                link={links[shown.id]}
                activeSprint={activeSprint}
                onOpenSprint={onOpenSprint}
                onToggle={toggleDone}
                onDelete={() => remove(shown.id)}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Pieces ────────────────────────────────────────────────────────────────────

function CheckBox({ todo, onToggle }: { todo: CompanionTodo; onToggle: () => void }) {
  const t = useT()
  return (
    <button
      type="button"
      className={`cmp-check${todo.done ? ' on' : ''}`}
      role="checkbox"
      aria-checked={todo.done}
      aria-label={t(todo.done ? 'companion.panel.row.uncheck' : 'companion.panel.row.check', { title: todo.title })}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      {todo.done && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
    </button>
  )
}

/** In the checkbox's place on a promoted todo: a small board, the sprint's sign. */
function SprintGlyph({ link }: { link: CompanionSprintLink }) {
  const t = useT()
  const label = t('companion.panel.promote.badge', {
    sprint: link.sprintName,
    status: link.status === 'missing' ? '' : t(SPRINT_STATUS_KEY[link.status])
  })
  return (
    <span className={`cmp-sprint-glyph${link.status === 'done' ? ' on' : ''}`} role="img" aria-label={label} title={label}>
      <SprintIcon />
    </span>
  )
}

function SprintIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  )
}

/**
 * The detail column's sprint section (plan §6.1, §12 item 7): the promote button with the
 * active sprint as muted detail; once promoted, a badge with the item's status, read-only,
 * and a way to the Sprint view; once the item is gone, a way back to a plain todo.
 */
function SprintSection({
  todo,
  link,
  activeSprint,
  onOpenSprint
}: {
  todo: CompanionTodo
  link: CompanionSprintLink | undefined
  activeSprint: CompanionActiveSprint | null
  onOpenSprint?: () => void
}) {
  const t = useT()
  const { locale } = useLanguage()
  const [busy, setBusy] = useState(false)

  if (link?.status === 'missing') {
    return (
      <div className="cmp-sec cmp-sprint">
        <p className="cmp-sprint-missing">{t('companion.panel.promote.missing')}</p>
        <div>
          <button type="button" className="btn-ghost small" onClick={() => void api.unlink(todo.id)}>
            {t('companion.panel.promote.unlink')}
          </button>
        </div>
        <p className="help">{t('companion.panel.promote.unlinkHelp')}</p>
      </div>
    )
  }

  if (link) {
    return (
      <div className="cmp-sec cmp-sprint">
        <div className="cmp-sprint-row">
          <span className="cmp-sprint-badge">
            <SprintIcon />
            <span className="cmp-sprint-name">{link.sprintName}</span>
          </span>
          <span className={`cmp-sprint-status s-${link.status}`}>{t(SPRINT_STATUS_KEY[link.status])}</span>
        </div>
        {onOpenSprint && (
          <div>
            <button type="button" className="btn-ghost small" onClick={onOpenSprint}>
              {t('companion.panel.promote.open')}
            </button>
          </div>
        )}
      </div>
    )
  }

  // A ticked todo is finished business: nothing to hand to the sprint.
  if (todo.done) return null

  return (
    <div className="cmp-sec cmp-sprint">
      <div>
        <button
          type="button"
          className="btn-ghost small cmp-promote"
          disabled={!activeSprint || busy}
          onClick={() => {
            setBusy(true)
            void api.promote(todo.id).finally(() => setBusy(false))
          }}
        >
          <SprintIcon />
          {t('companion.panel.promote.button')}
        </button>
      </div>
      {activeSprint ? (
        <p className="help cmp-sprint-detail">
          {activeSprint.name} · {sprintRange(activeSprint.startDate, activeSprint.endDate, locale)}
        </p>
      ) : (
        <p className="help">{t('companion.panel.promote.noSprint')}</p>
      )}
    </div>
  )
}

function NoteRow({
  note,
  when,
  confirming,
  onAsk,
  onCancel,
  onDelete
}: {
  note: CompanionNote
  when: string
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const t = useT()
  return (
    <div className="cmp-note">
      <p className="cmp-note-text">{note.text}</p>
      <div className="cmp-note-side">
        {confirming ? (
          <span className="cmp-confirm">
            <span>{t('companion.panel.confirm.delete')}</span>
            <button type="button" className="btn-text danger" onClick={onDelete}>
              {t('companion.panel.confirm.yes')}
            </button>
            <button type="button" className="btn-text" onClick={onCancel}>
              {t('companion.panel.confirm.no')}
            </button>
          </span>
        ) : (
          <>
            <span className="cmp-row-when">{when}</span>
            <button type="button" className="cmp-icon-btn" aria-label={t('companion.panel.note.delete')} title={t('companion.panel.note.delete')} onClick={onAsk}>
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  )
}

interface Pending {
  text: string
  at: number
  precision: 'day' | 'minute'
}

/**
 * The quick-add line. The same `companion:capture` the bubble uses, so "ligar ao Rui
 * amanhã às 14h" means the same thing in both; a bare date keeps its chip and asks what
 * it is for, as the bubble does (plan §5.4).
 */
function QuickAdd({ mode, onTodo }: { mode: Tab; onTodo?: (id: string) => void }) {
  const t = useT()
  const { locale } = useLanguage()
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [isQuery, setIsQuery] = useState(false)
  const busy = useRef(false)
  const now = Date.now()

  const submit = async (): Promise<void> => {
    const typed = text.trim()
    if (!typed || busy.current) return
    busy.current = true
    try {
      let line = pending ? `${typed} ${pending.text}` : typed
      if (mode === 'notes' && !/^\s*(nota|note|anota|anotar)\s*:/iu.test(line)) line = `nota: ${line}`
      const r: CompanionCaptureResult | null = await api.capture(line, 'text')
      if (!r) return
      setText('')
      setIsQuery(r.kind === 'query')
      if (r.kind === 'todo' || r.kind === 'note' || r.kind === 'query') {
        setPending(null)
        if (r.kind === 'todo' && r.todo) onTodo?.(r.todo.id)
        return
      }
      if (!pending && r.parsed.when) setPending({ text: typed, at: r.parsed.when.at, precision: r.parsed.when.precision })
    } finally {
      busy.current = false
    }
  }

  const label = mode === 'todos' ? t('companion.panel.add.label') : t('companion.panel.addNote.label')
  const placeholder = pending
    ? t('companion.needsTitle.question', { when: whenPhrase(pending.at, pending.precision, now, locale, t) })
    : mode === 'todos'
      ? t('companion.panel.add.placeholder')
      : t('companion.panel.addNote.placeholder')

  return (
    <div className="cmp-add">
      <div className="cmp-add-row">
        {pending && <span className="cmp-add-chip">{chipLabel(pending.at, pending.precision, now, locale, t)}</span>}
        <input
          className="cmp-add-input"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          maxLength={2000}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            if (isQuery) setIsQuery(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape' && (pending || text)) {
              e.preventDefault()
              setPending(null)
              setText('')
            }
          }}
        />
      </div>
      {isQuery ? (
        <p className="help">{t('companion.panel.add.query')}</p>
      ) : (
        mode === 'todos' && <p className="help">{t('companion.panel.add.help')}</p>
      )}
    </div>
  )
}

// ─── Detail column ─────────────────────────────────────────────────────────────

function TodoDetail({
  todo,
  prefs,
  now,
  link,
  activeSprint,
  onOpenSprint,
  onToggle,
  onDelete
}: {
  todo: CompanionTodo
  prefs: CompanionPrefs
  now: number
  link: CompanionSprintLink | undefined
  activeSprint: CompanionActiveSprint | null
  onOpenSprint?: () => void
  onToggle: (todo: CompanionTodo) => void
  onDelete: () => void
}) {
  const t = useT()
  const { locale } = useLanguage()
  const latest = useRef(todo)
  latest.current = todo
  const rules = { leadMinutes: prefs.leadMinutes, morningHour: prefs.morningHour, now: Date.now() }

  // ── Title and notes: local drafts, saved after a pause and when the column goes ──
  const [title, setTitle] = useState(todo.title)
  const [notes, setNotes] = useState(todo.notes ?? '')
  const draft = useRef({ title: todo.title, notes: todo.notes ?? '' })
  const timer = useRef<number | undefined>(undefined)
  // Once deleted, a pending save must not write the todo back.
  const deleted = useRef(false)

  const flush = useCallback((): void => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (deleted.current) return
    const cur = latest.current
    const nextTitle = draft.current.title.trim()
    const nextNotes = draft.current.notes
    const titleChanged = nextTitle !== '' && nextTitle !== cur.title
    const notesChanged = nextNotes !== (cur.notes ?? '')
    if (!titleChanged && !notesChanged) return
    void api.update({ ...cur, title: titleChanged ? nextTitle : cur.title, notes: nextNotes || null })
  }, [])

  const schedule = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  useEffect(() => flush, [flush])

  // ── Due date and time: local strings, committed once they read as a date ──
  const [date, setDate] = useState(todo.dueAt != null ? toDateInput(todo.dueAt) : '')
  const [time, setTime] = useState(todo.dueAt != null && todo.duePrecision !== 'day' ? toTimeInput(todo.dueAt) : '')
  useEffect(() => {
    setDate(todo.dueAt != null ? toDateInput(todo.dueAt) : '')
    setTime(todo.dueAt != null && todo.duePrecision !== 'day' ? toTimeInput(todo.dueAt) : '')
  }, [todo.dueAt, todo.duePrecision])

  const commitDue = (d: string, tm: string): void => {
    const next = dueFromInputs(d, tm, Date.now())
    if (!next) return
    const cur = latest.current
    const curPrecision = cur.dueAt != null ? (cur.duePrecision ?? 'minute') : undefined
    if (next.dueAt === (cur.dueAt ?? null) && next.duePrecision === curPrecision) return
    void api.update(withDue(cur, next, { ...rules, now: Date.now() }))
  }

  // ── Reminders ──
  const [adding, setAdding] = useState<string | null>(null)
  const fired = new Set(todo.firedAt ?? [])
  const reminders = [...todo.remindAt].sort((a, b) => a - b)

  const removeReminder = (at: number): void => {
    const cur = latest.current
    void api.update({
      ...cur,
      remindAt: cur.remindAt.filter((x) => x !== at),
      ...(cur.firedAt ? { firedAt: cur.firedAt.filter((x) => x !== at) } : {})
    })
  }
  const addAt = adding ? new Date(adding).getTime() : NaN
  const canAdd = Number.isFinite(addAt) && addAt > now
  const addReminder = (): void => {
    if (!canAdd) return
    const cur = latest.current
    if (!cur.remindAt.includes(addAt)) {
      void api.update({ ...cur, remindAt: [...cur.remindAt, addAt].sort((a, b) => a - b) })
    }
    setAdding(null)
  }

  const [confirmDelete, setConfirmDelete] = useState(false)
  const owned = isOwned(link)
  const pad = (n: number): string => String(n).padStart(2, '0')

  return (
    <div className="cmp-detail">
      <div className="cmp-sec">
        <div className="cmp-title-row">
          {owned && link ? <SprintGlyph link={link} /> : <CheckBox todo={todo} onToggle={() => onToggle(latest.current)} />}
          <input
            className="cmp-title-input"
            aria-label={t('companion.panel.detail.title')}
            value={title}
            maxLength={500}
            onChange={(e) => {
              setTitle(e.target.value)
              draft.current.title = e.target.value
              schedule()
            }}
            onBlur={flush}
          />
        </div>
        <p className="help">
          {t('companion.panel.detail.created', { when: whenPhrase(todo.createdAt, 'minute', now, locale, t) })}
        </p>
      </div>

      <div className="cmp-sec">
        <label className="cmp-field">
          <span className="cmp-label">{t('companion.panel.detail.notes')}</span>
          <textarea
            className="text-input cmp-notes-area"
            value={notes}
            rows={4}
            placeholder={t('companion.panel.detail.notesPlaceholder')}
            onChange={(e) => {
              setNotes(e.target.value)
              draft.current.notes = e.target.value
              schedule()
            }}
            onBlur={flush}
          />
        </label>

        <div className="cmp-pair">
          <label className="cmp-field">
            <span className="cmp-label">{t('companion.panel.detail.date')}</span>
            <input
              type="date"
              className="text-input"
              value={date}
              onChange={(e) => {
                setDate(e.target.value)
                if (e.target.value) commitDue(e.target.value, time)
              }}
              onBlur={() => commitDue(date, time)}
            />
          </label>
          <label className="cmp-field">
            <span className="cmp-label">
              {t('companion.panel.detail.time')} <span className="cmp-optional">{t('companion.panel.detail.optional')}</span>
            </span>
            <input
              type="time"
              className="text-input"
              value={time}
              onChange={(e) => {
                setTime(e.target.value)
                if (e.target.value) commitDue(date, e.target.value)
              }}
              onBlur={() => commitDue(date, time)}
            />
          </label>
        </div>
        {todo.dueAt != null && (
          <div className="cmp-due-foot">
            {todo.duePrecision === 'day' ? (
              <span className="help">{t('companion.panel.detail.dayHelp', { time: `${pad(prefs.morningHour)}:00` })}</span>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                setDate('')
                setTime('')
                commitDue('', '')
              }}
            >
              {t('companion.panel.detail.clearDate')}
            </button>
          </div>
        )}
      </div>

      {owned ? (
        <div className="cmp-sec">
          <span className="cmp-label">{t('companion.panel.detail.reminders')}</span>
          <p className="help">{t('companion.panel.promote.owned')}</p>
        </div>
      ) : (
        <div className="cmp-sec">
          <span className="cmp-label">{t('companion.panel.detail.reminders')}</span>
          {reminders.length === 0 && adding === null && <p className="help">{t('companion.panel.detail.noReminders')}</p>}
          {reminders.length > 0 && (
            <div className="cmp-chips">
              {reminders.map((at) => {
                const label = reminderLabel(at, todo, now, locale, t)
                const wasFired = fired.has(at)
                return (
                  <span
                    key={at}
                    className={`cmp-chip${wasFired ? ' fired' : ''}`}
                    title={wasFired ? t('companion.panel.detail.fired') : undefined}
                  >
                    <span className="cmp-num">{label}</span>
                    <button
                      type="button"
                      className="cmp-chip-x"
                      aria-label={t('companion.panel.detail.removeReminder', { when: label })}
                      onClick={() => removeReminder(at)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                )
              })}
            </div>
          )}
          {adding === null ? (
            <div>
              <button
                type="button"
                className="btn-ghost small"
                onClick={() => setAdding(toLocalInputValue(defaultNewReminder(latest.current, { ...rules, now: Date.now() })))}
              >
                {t('companion.panel.detail.addReminder')}
              </button>
            </div>
          ) : (
            <div className="cmp-add-reminder">
              <input
                type="datetime-local"
                className="text-input"
                aria-label={t('companion.panel.detail.reminderAt')}
                value={adding}
                min={toLocalInputValue(now)}
                autoFocus
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addReminder()
                  }
                }}
              />
              <button type="button" className="btn-ghost small" disabled={!canAdd} onClick={addReminder}>
                {t('companion.panel.detail.add')}
              </button>
              <button type="button" className="btn-text" onClick={() => setAdding(null)}>
                {t('companion.panel.detail.cancel')}
              </button>
            </div>
          )}
        </div>
      )}

      <SprintSection todo={todo} link={link} activeSprint={activeSprint} onOpenSprint={onOpenSprint} />

      <div className="cmp-sec cmp-foot">
        {confirmDelete ? (
          <span className="cmp-confirm">
            <span>{t('companion.panel.detail.deleteConfirm')}</span>
            <button
              type="button"
              className="btn-text danger"
              onClick={() => {
                deleted.current = true
                onDelete()
              }}
            >
              {t('companion.panel.confirm.yes')}
            </button>
            <button type="button" className="btn-text" onClick={() => setConfirmDelete(false)}>
              {t('companion.panel.confirm.no')}
            </button>
          </span>
        ) : (
          <button type="button" className="btn-ghost small cmp-delete" onClick={() => setConfirmDelete(true)}>
            <TrashIcon />
            {t('companion.panel.detail.delete')}
          </button>
        )}
        <p className="help">{t('companion.panel.detail.help')}</p>
      </div>
    </div>
  )
}
