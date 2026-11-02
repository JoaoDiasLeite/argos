import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type {
  CompanionBubbleAnchor,
  CompanionBubblePayload,
  CompanionCaptureResult,
  CompanionReminder,
  CompanionSnoozeRequest,
  CompanionTodo
} from '../types'
import { plural } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import {
  chipLabel,
  dayLine,
  dayOffset,
  dayWord,
  defaultPickTime,
  formatTime,
  lateSpan,
  rowWhen,
  toLocalInputValue,
  whenPhrase
} from './format'
import { DictationPanel, MicButton, useDictation, type Dictation } from './dictation'
import './bubble.css'

// The bubble beside Argos's head (docs/COMPANION_PLAN.md §5.4, §3.2, wireframes 2, 4–6).
// A separate focusable window that main sizes to whatever this measures and places by
// the dog; `anchor` says which side of the head that is, so the tail can point at it.
// One component per mode; the receipt also follows a capture made in 'input', and query
// results show under the input.

const api = window.electronAPI.companion

/** The receipt stays this long, then the bubble closes on its own (plan §5.4). */
const RECEIPT_MS = 2500
/** "Desfeito" stays this long before the bubble closes. */
const UNDONE_MS = 900
/** Enter is ignored this long after a reminder appears (SYSTEM-DESIGN §6). */
const ENTER_GUARD_MS = 400

const ANCHORS: readonly CompanionBubbleAnchor[] = ['above-left', 'above-right', 'below-left', 'below-right']

/** A keydown listener on the window for as long as the view is up. */
function useWindowKey(handler: (e: KeyboardEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const fn = (e: KeyboardEvent): void => ref.current(e)
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])
}

export default function Bubble() {
  const [view, setView] = useState<CompanionBubblePayload>({ mode: 'input', payload: null })
  const [anchor, setAnchor] = useState<CompanionBubbleAnchor>('above-left')
  // Bumped on every summon, so the input view remounts empty.
  const [session, setSession] = useState(0)
  const frame = useRef<HTMLDivElement>(null)
  // Dictation lives here, not in InputView: a summon remounts the input, and the shortcut's
  // "start recording" arrives right behind that summon. The input registers where text goes.
  const [voiceOn, setVoiceOn] = useState(false)
  const textSink = useRef<((text: string) => void) | null>(null)
  const dictation = useDictation(voiceOn, (text) => textSink.current?.(text))
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation

  useEffect(() => {
    const readPrefs = (): void => {
      api
        .state()
        .then((s) => setVoiceOn(!!s.prefs.voice))
        .catch(() => {})
    }
    const offToggle = api.onVoiceToggle(() => {
      // The shortcut is only registered with dictation on; the prefs may not have arrived yet.
      setVoiceOn(true)
      dictationRef.current.toggle()
    })
    const offShownPrefs = api.onShown(() => {
      dictationRef.current.reset()
      readPrefs()
    })
    readPrefs()
    return () => {
      offToggle()
      offShownPrefs()
    }
  }, [])

  useEffect(() => {
    const acceptAnchor = (a: unknown): void => {
      if (ANCHORS.includes(a as CompanionBubbleAnchor)) setAnchor(a as CompanionBubbleAnchor)
    }
    api
      .state()
      .then((s) => {
        if (!s.bubble) return
        const { anchor: a, ...b } = s.bubble
        acceptAnchor(a)
        setView(b as CompanionBubblePayload)
      })
      .catch(() => {})
    const offMode = api.onBubbleMode((b) => {
      setView(b)
      setSession((n) => n + 1)
    })
    const offAnchor = api.onBubbleAnchor(acceptAnchor)
    const offShown = api.onShown(() => {
      setView({ mode: 'input', payload: null })
      setSession((n) => n + 1)
    })
    return () => {
      offMode()
      offAnchor()
      offShown()
    }
  }, [])

  // Main sizes the window to the frame, shadow and tail included.
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const report = (): void => api.bubbleSize(Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight))
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const content = ((): ReactNode => {
    switch (view.mode) {
      case 'input':
        return (
          <InputView
            key={session}
            dictation={voiceOn ? dictation : null}
            textSink={textSink}
            onReceipt={(r) => setView({ mode: 'confirm', payload: r })}
          />
        )
      case 'confirm':
        return <Receipt key={session} result={view.payload} />
      case 'reminder':
        return <ReminderView key={view.payload.reminder.todoId + session} reminder={view.payload.reminder} queued={view.payload.queued} />
      case 'catchup':
        return <CatchUp key={session} reminders={view.payload.reminders} reason={view.payload.reason} />
    }
  })()

  return (
    <div ref={frame} className={`bq-frame bq-${anchor}`}>
      <div className={`bq bq-mode-${view.mode}`}>{content}</div>
    </div>
  )
}

// ─── Input ─────────────────────────────────────────────────────────────────────

interface Pending {
  /** What was typed first ("amanhã às 14h"), sent again with the title. */
  text: string
  at: number
  precision: 'day' | 'minute'
}

function InputView({
  onReceipt,
  dictation,
  textSink
}: {
  onReceipt: (r: CompanionCaptureResult) => void
  /** null with dictation off: no mic button, no voice keys. */
  dictation: Dictation | null
  textSink: { current: ((text: string) => void) | null }
}) {
  const t = useT()
  const { locale } = useLanguage()
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [query, setQuery] = useState<CompanionCaptureResult | null>(null)
  /** Main is asking the model for this capture's date (plan §5.1, layer 2). */
  const [thinking, setThinking] = useState(false)
  /** The capture in flight, so main's "thinking" and Esc's cancel name the right one. */
  const captureId = useRef<string | null>(null)
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  /** Some of the text came from dictation: the capture is marked 'voice'. */
  const spoken = useRef(false)
  const now = Date.now()

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(
    () =>
      api.onCaptureThinking((id) => {
        if (id === captureId.current) setThinking(true)
      }),
    []
  )

  // Dictated text lands in the input, never submitted: João reads it and presses Enter.
  useEffect(() => {
    textSink.current = (said) => {
      spoken.current = true
      setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${said}` : said))
      requestAnimationFrame(() => {
        const el = input.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    }
    return () => {
      textSink.current = null
    }
  }, [textSink])

  useWindowKey((e) => {
    const kind = dictation?.state.kind
    // Esc while the model reads the date: nothing is saved, and the capture answers
    // 'cancelled', which closes the bubble.
    if (e.key === 'Escape' && thinking && captureId.current) {
      e.preventDefault()
      void api.captureCancel(captureId.current)
      return
    }
    if (e.key === 'Escape') {
      // Esc throws a recording away; the bubble stays for typing.
      if (kind === 'recording' || kind === 'starting') {
        e.preventDefault()
        dictation!.cancel()
        return
      }
      api.bubbleClose()
    } else if (e.key === 'Enter' && kind === 'recording') {
      e.preventDefault()
      dictation!.stop()
    }
  })

  const submit = async (): Promise<void> => {
    const typed = text.trim()
    if (!typed || busy.current) return
    busy.current = true
    const id = crypto.randomUUID()
    captureId.current = id
    try {
      // The parser gets the title and the date together: "ligar à Câmara amanhã às 14h".
      const r = await api.capture(pending ? `${typed} ${pending.text}` : typed, spoken.current ? 'voice' : 'text', id)
      if (!r) return
      if (r.kind === 'cancelled') {
        api.bubbleClose()
        return
      }
      if (r.kind === 'todo' || r.kind === 'note') {
        onReceipt(r)
        return
      }
      setText('')
      spoken.current = false
      if (r.kind === 'query') {
        setPending(null)
        setQuery(r)
        return
      }
      // needs-title: keep the date (the first one typed, if this was a second bare date).
      setQuery(null)
      if (!pending && r.parsed.when) setPending({ text: typed, at: r.parsed.when.at, precision: r.parsed.when.precision })
    } finally {
      busy.current = false
      captureId.current = null
      setThinking(false)
    }
  }

  const placeholder = pending
    ? t('companion.needsTitle.question', { when: whenPhrase(pending.at, pending.precision, now, locale, t) })
    : t('companion.input.placeholder')

  return (
    <>
      <div className="bq-input-row">
        {pending && <span className="bq-chip bq-mono">{chipLabel(pending.at, pending.precision, now, locale, t)}</span>}
        <input
          ref={input}
          className="bq-input"
          aria-label={t('companion.input.label')}
          placeholder={placeholder}
          value={text}
          maxLength={2000}
          spellCheck={false}
          readOnly={thinking}
          onChange={(e) => {
            setText(e.target.value)
            if (!e.target.value.trim()) spoken.current = false
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              // While dictating, Enter stops the recording (the window handler), never submits.
              if (dictation?.busy) return
              void submit()
            }
          }}
        />
        {dictation && !thinking && <MicButton dictation={dictation} />}
      </div>
      {dictation && <DictationPanel dictation={dictation} />}
      {thinking ? (
        <div className="bq-thinking" role="status">
          <span className="bq-thinking-label">
            {t('companion.thinking.label')}
            <span className="bq-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </span>
          <span className="help">{t('companion.thinking.help')}</span>
        </div>
      ) : (
        !dictation?.busy && <div className="help">{t('companion.input.help')}</div>
      )}
      {query && <QueryResults result={query} now={now} />}
    </>
  )
}

function QueryResults({ result, now }: { result: CompanionCaptureResult; now: number }) {
  const t = useT()
  const { locale } = useLanguage()
  const results = result.results ?? []
  const range = result.parsed.queryRange
  let label = t('companion.query.title')
  if (range) {
    // A single day reads as that day; a week as "seg 2 nov a dom 8 nov".
    const last = range.to - 1
    label =
      dayOffset(last, range.from) === 0
        ? dayWord(range.from, now, locale, t)
        : t('companion.query.range', { from: dayWord(range.from, now, locale, t), to: dayWord(last, now, locale, t) })
  }
  return (
    <div className="bq-results">
      <span className="eyebrow">
        {label} · <span className="num">{results.length}</span>
      </span>
      {results.length === 0 ? (
        <p className="help">{t('companion.query.empty')}</p>
      ) : (
        <ul className="bq-rows">
          {results.map((todo) => (
            <li key={todo.id} className="bq-row">
              <span className="bq-when num">{todoWhen(todo, now, locale, t)}</span>
              <span className="bq-row-title">{todo.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function todoWhen(todo: CompanionTodo, now: number, locale: string | undefined, t: ReturnType<typeof useT>): string {
  const at = todo.dueAt ?? todo.remindAt[0]
  if (at == null) return ''
  if (todo.duePrecision === 'day' && todo.dueAt != null) return dayWord(at, now, locale, t)
  return rowWhen(at, now, locale, t)
}

// ─── Receipt (plan §5.4) ───────────────────────────────────────────────────────

function Receipt({ result }: { result: CompanionCaptureResult }) {
  const t = useT()
  const { locale } = useLanguage()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const [undone, setUndone] = useState(false)
  const remaining = useRef(RECEIPT_MS)
  const now = Date.now()

  // The countdown, paused while the pointer or keyboard focus is on the card.
  useEffect(() => {
    if (paused || undone) return
    const started = Date.now()
    const timer = setTimeout(() => api.bubbleClose(), Math.max(0, remaining.current))
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - started
    }
  }, [paused, undone])

  useEffect(() => {
    if (!undone) return
    const timer = setTimeout(() => api.bubbleClose(), UNDONE_MS)
    return () => clearTimeout(timer)
  }, [undone])

  const target = result.todo ? { id: result.todo.id, kind: 'todo' as const } : result.note ? { id: result.note.id, kind: 'note' as const } : null

  const undo = async (): Promise<void> => {
    if (!target || undone) return
    if (await api.undo(target.id, target.kind)) setUndone(true)
  }

  useWindowKey((e) => {
    if (e.key === 'Escape') api.bubbleClose()
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      void undo()
    }
  })

  if (undone) return <div className="bq-undone">{t('companion.receipt.undone')}</div>

  const todo = result.todo
  const note = result.note
  const dated = todo?.dueAt != null
  const dayPrecision = todo?.duePrecision === 'day'
  const remind = todo?.remindAt[0]

  let eyebrow = t('companion.receipt.saved')
  if (note) eyebrow = t('companion.receipt.noteSaved')
  else if (!dated) eyebrow = t('companion.receipt.savedNoDate')

  return (
    <div
      className="bq-receipt"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <span className="eyebrow">{eyebrow}</span>
      {note && <div className="bq-title bq-clamp">{note.text}</div>}
      {todo && dated && (
        <>
          <div className="bq-day">{dayLine(todo.dueAt!, now, locale, t)}</div>
          {dayPrecision ? (
            // A date with no time: no time column, the title takes the line.
            <div className="bq-title">{todo.title}</div>
          ) : (
            <div className="bq-grid">
              <span className="num bq-grid-time">{formatTime(todo.dueAt!, locale)}</span>
              <span className="bq-title">{todo.title}</span>
              {remind != null && remind !== todo.dueAt && (
                <>
                  <span className="num bq-grid-time muted">{formatTime(remind, locale)}</span>
                  <span className="muted bq-small">{t('companion.receipt.reminder')}</span>
                </>
              )}
            </div>
          )}
          {remind != null && dayPrecision && (
            <div className="help">
              {dayOffset(remind, todo.dueAt!) === 0
                ? t('companion.receipt.reminderAt', { time: formatTime(remind, locale) })
                : `${t('companion.receipt.reminder')} ${whenPhrase(remind, 'minute', now, locale, t)}`}
            </div>
          )}
        </>
      )}
      {todo && !dated && (
        <>
          <div className="bq-title">{todo.title}</div>
          {remind != null && (
            <div className="help">{`${t('companion.receipt.reminder')} ${whenPhrase(remind, 'minute', now, locale, t)}`}</div>
          )}
        </>
      )}
      {todo && dated && result.parsed.fromModel && <div className="bq-model-mark">{t('companion.receipt.byModel')}</div>}
      <div className="bq-actions bq-end">
        <button type="button" className="btn-secondary small" onClick={() => api.openMain()}>
          <PencilIcon />
          {todo && !dated ? t('companion.receipt.setDate') : t('companion.receipt.edit')}
        </button>
        <button type="button" className="btn-secondary small" onClick={() => void undo()}>
          {t('companion.receipt.undo')}
        </button>
      </div>
      <div className="bq-drain" aria-hidden="true">
        <i className={paused ? 'paused' : ''} style={{ animationDuration: `${RECEIPT_MS}ms` }} />
      </div>
    </div>
  )
}

// ─── Reminder (plan §3.2) ──────────────────────────────────────────────────────

function ReminderView({ reminder, queued }: { reminder: CompanionReminder; queued: number }) {
  const t = useT()
  const { locale } = useLanguage()
  const [menu, setMenu] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickValue, setPickValue] = useState(() => toLocalInputValue(defaultPickTime(Date.now())))
  const shownAt = useRef(Date.now())
  const firstItem = useRef<HTMLButtonElement>(null)
  const pickInput = useRef<HTMLInputElement>(null)
  const now = Date.now()
  const id = reminder.todoId

  useEffect(() => {
    if (menu) firstItem.current?.focus()
  }, [menu])
  useEffect(() => {
    if (picking) pickInput.current?.focus()
  }, [picking])

  const done = (): void => void api.done(id, true)
  const snooze = (option: CompanionSnoozeRequest): void => {
    setMenu(false)
    void api.snooze(id, option)
  }
  const pickOk = (): void => {
    const at = new Date(pickValue).getTime()
    if (Number.isFinite(at) && at > Date.now()) snooze({ at })
  }

  useWindowKey((e) => {
    if (e.key === 'Escape') {
      if (picking) setPicking(false)
      else if (menu) setMenu(false)
      else void api.dismiss(id)
      return
    }
    // Enter is Feito, unless it is pressing some other control or typing the date.
    if (e.key === 'Enter' && (e.target === document.body || e.target === null)) {
      if (Date.now() - shownAt.current < ENTER_GUARD_MS) return
      e.preventDefault()
      done()
    }
  })

  return (
    <>
      <div className="bq-meta">
        {reminder.late && (
          <span className="bq-chip bq-warn">{t('companion.reminder.late', { span: lateSpan(reminder.lateMinutes, t) })}</span>
        )}
        <span className="help">
          {dayWord(reminder.at, now, locale, t)} · <span className="num">{formatTime(reminder.at, locale)}</span>
        </span>
      </div>
      <div className="bq-title">{reminder.title}</div>
      <div className="bq-actions">
        <button type="button" className="btn-primary" onClick={done}>
          {t('companion.reminder.done')}
        </button>
        <div className="bq-split">
          <button type="button" className="btn-secondary" onClick={() => snooze({ minutes: 10 })}>
            {t('companion.reminder.snooze10')}
          </button>
          <button
            type="button"
            className="btn-secondary bq-split-more"
            aria-label={t('companion.reminder.snoozeMore')}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => {
              setPicking(false)
              setMenu((m) => !m)
            }}
          >
            <Chevron up={menu} />
          </button>
        </div>
        <button type="button" className="btn-secondary" onClick={() => api.openMain()}>
          {t('companion.reminder.open')}
        </button>
      </div>
      {menu && (
        <div className="bq-menu" role="menu">
          <button ref={firstItem} type="button" role="menuitem" onClick={() => snooze({ minutes: 10 })}>
            {t('companion.snooze.10m')}
          </button>
          <button type="button" role="menuitem" onClick={() => snooze({ minutes: 60 })}>
            {t('companion.snooze.1h')}
          </button>
          <button type="button" role="menuitem" onClick={() => snooze({ tomorrowMorning: true })}>
            {t('companion.snooze.tomorrow')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false)
              setPicking(true)
            }}
          >
            {t('companion.snooze.pick')}
          </button>
        </div>
      )}
      {picking && (
        <div className="bq-pick">
          <input
            ref={pickInput}
            type="datetime-local"
            className="text-input"
            aria-label={t('companion.snooze.pickLabel')}
            value={pickValue}
            min={toLocalInputValue(Date.now())}
            onChange={(e) => setPickValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                pickOk()
              }
            }}
          />
          <button type="button" className="btn-secondary" onClick={pickOk}>
            {t('companion.snooze.ok')}
          </button>
        </div>
      )}
      <div className="help">
        {t('companion.reminder.help')}
        {queued > 0 && ` · ${plural(t, 'companion.reminder.queued', queued)}`}
      </div>
    </>
  )
}

// ─── Catch-up ──────────────────────────────────────────────────────────────────

function CatchUp({ reminders, reason }: { reminders: CompanionReminder[]; reason: 'launch' | 'dnd' }) {
  const t = useT()
  const { locale } = useLanguage()
  const [open, setOpen] = useState(true)
  const [done, setDone] = useState<Set<string>>(() => new Set())
  const now = Date.now()

  useWindowKey((e) => {
    if (e.key === 'Escape') api.bubbleClose()
  })

  const tick = (id: string): void => {
    if (done.has(id)) return
    setDone((d) => new Set(d).add(id))
    void api.done(id, true)
  }

  return (
    <>
      <button type="button" className="bq-catch-head" aria-expanded={open} title={t('companion.catchup.toggle')} onClick={() => setOpen((o) => !o)}>
        <span>
          <span className="bq-catch-title">{plural(t, 'companion.catchup.title', reminders.length)}</span>
          <span className="help">{t(reason === 'dnd' ? 'companion.catchup.dnd' : 'companion.catchup.launch')}</span>
        </span>
        <Chevron up={open} />
      </button>
      {open && (
        <ul className="bq-rows bq-scroll">
          {reminders.map((r) => {
            const ticked = done.has(r.todoId)
            return (
              <li key={r.todoId} className={`bq-row${ticked ? ' done' : ''}`}>
                <span className="bq-when num">{rowWhen(r.at, now, locale, t)}</span>
                <span className="bq-row-title">{r.title}</span>
                <button
                  type="button"
                  className="bq-check"
                  aria-label={t('companion.catchup.markDone', { title: r.title })}
                  aria-pressed={ticked}
                  onClick={() => tick(r.todoId)}
                >
                  {ticked && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12l5 5 9-10" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="bq-actions bq-end">
        <button type="button" className="btn-secondary small" onClick={() => api.openMain()}>
          {t('companion.catchup.seeAll')}
        </button>
      </div>
    </>
  )
}

// ─── Icons ─────────────────────────────────────────────────────────────────────

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}
