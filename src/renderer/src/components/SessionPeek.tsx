import { useEffect, useRef, useState } from 'react'
import { CCProject, CCSessionMeta, LifecycleResult, SessionPeek as Peek } from '../types'
import { TagChips, TagEditor } from './SessionTags'
import { shortModel } from '../lib/model-id'
import type { TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import './SessionPeek.css'
import Select from './Select'

interface Props {
  session: CCSessionMeta
  colorFor: (tag: string) => string
  vocabulary: string[]
  projects: CCProject[]
  onResume: () => void
  /**
   * False when this transcript was not written by Claude Code — `claude --resume` does
   * not know a Codex session id, so resuming would start a chat the CLI then rejects.
   * Reading it still works, which is what this column is for.
   */
  resumable?: boolean
  /** The column goes: a click outside it (not on a session row), Esc, or a lifecycle verb. */
  onClose: () => void
  onTagsSaved: (tags: string[]) => void
  /** Something on disk changed — the list has to be read again. */
  onChanged: () => void
}

function fmtCost(usd: number): string {
  if (!usd) return ''
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/** "today 18:02", "yesterday 09:15", or the date and time. */
function fmtWhen(ts: number, t: TFunction, locale: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000)
  if (days === 0) return t('sessions.peek.today', { time })
  if (days === 1) return t('sessions.peek.yesterday', { time })
  return t('sessions.peek.dateTime', { date: d.toLocaleDateString(locale), time })
}

/** Enter on a destructive confirmation is ignored this long after it appears (§6). */
const ENTER_GRACE_MS = 400

/** A press on an element's own scrollbar lands past its client box. */
function onScrollbar(el: HTMLElement, e: MouseEvent): boolean {
  const scrolls = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth
  return scrolls && el.clientWidth > 0 && (e.offsetX > el.clientWidth || e.offsetY > el.clientHeight)
}

type Prompt = 'rename' | 'delete' | 'move' | null

/**
 * The detail column for the selected session (wireframe 3A): enough of a conversation to
 * decide whether to reopen it, without opening it, and its lifecycle verbs in one footer
 * row. Mounted only while a session is selected, and it gets out of the way by itself: a
 * mousedown anywhere outside it that is not a session row closes it, so the list beside
 * it stays interactive and takes the full width back. No scrim.
 */
export default function SessionPeek({
  session,
  colorFor,
  vocabulary,
  projects,
  onResume,
  resumable = true,
  onClose,
  onTagsSaved,
  onChanged
}: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTags, setEditingTags] = useState(false)
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const colRef = useRef<HTMLElement>(null)
  const deleteRef = useRef<HTMLDivElement>(null)
  const promptAt = useRef(0)
  // Listeners below are bound once per mount or per prompt; they read the latest
  // callbacks and actions through these.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const confirmRef = useRef<() => void>(() => {})

  const { sourceId, encodedDir, sessionId, archived } = session
  // Codex records the same four operations in its own terms, so what the notes below
  // promise has to say which CLI will see it.
  const codex = session.provider === 'codex'

  // Clicking outside the column closes it. A session row is not "outside": clicking one
  // swaps the content instead. Neither is a click on a scrollbar, which reaches its
  // element with an offset past the content box: dragging the list's scrollbar must not
  // dismiss what is being read beside it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target
      if (!(target instanceof Element)) return
      if (colRef.current?.contains(target) || target.closest('[data-session-row]')) return
      if (target instanceof HTMLElement && onScrollbar(target, e)) return
      closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // While an inline form is open, Esc cancels the form (not the column) and Enter
  // confirms it. Both are kept from the view's own keys, which would otherwise close the
  // column or resume the session. A focused button keeps its native Enter.
  useEffect(() => {
    if (!prompt) return
    promptAt.current = Date.now()
    if (prompt === 'delete') deleteRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setPrompt(null)
        return
      }
      if (e.key !== 'Enter') return
      e.stopPropagation()
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT')) return
      if (prompt === 'delete' && Date.now() - promptAt.current < ENTER_GRACE_MS) return
      confirmRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt])

  /** Every lifecycle call answers the same three ways, so they are handled once. */
  const run = async (fn: () => Promise<LifecycleResult>, after: 'close' | 'stay') => {
    setBusy(true)
    setError('')
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      setError(
        res.error === 'not-found'
          ? t('sessions.peek.notFound')
          : res.error === 'exists'
            ? t('sessions.peek.exists')
            : res.message
      )
      return
    }
    setPrompt(null)
    onChanged()
    if (after === 'close') onClose()
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPeek(null)
    window.electronAPI
      // The archived flag decides which directory to look in, so leaving it off made
      // every archived conversation read as empty.
      .ccSessionPeek(session.sourceId, session.encodedDir, session.sessionId, session.archived)
      .then((p) => {
        // Arrowing down the list fires one of these per row; without the guard a slow
        // read for a row you have already left would overwrite the one you are on.
        if (cancelled) return
        setPeek(p)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    // Everything transient follows the conversation: moving to another one must not
    // leave a half-typed rename, or a delete confirmation, pointing at a session it no
    // longer belongs to.
    setEditingTags(false)
    setPrompt(null)
    setError('')
    return () => {
      cancelled = true
    }
  }, [session.sourceId, session.encodedDir, session.sessionId, session.archived])

  const doRename = () => {
    if (busy || !draft.trim()) return
    return run(
      () => window.electronAPI.ccSessionRename(sourceId, encodedDir, sessionId, draft.trim(), archived),
      'stay'
    )
  }

  const doMove = () => {
    if (busy || !draft) return
    // The picker's value is `<sourceId>:<encodedDir>`, and a sourceId can itself
    // contain a colon (`wsl:Ubuntu`), so only the FIRST one separates them.
    const at = draft.indexOf(':')
    const toSource = draft.slice(0, at)
    const toDir = draft.slice(at + 1)
    return run(
      () => window.electronAPI.ccSessionMove(sourceId, encodedDir, sessionId, toSource, toDir, archived),
      'close'
    )
  }

  const doArchiveToggle = () =>
    run(
      () =>
        archived
          ? window.electronAPI.ccSessionUnarchive(sourceId, encodedDir, sessionId)
          : window.electronAPI.ccSessionArchive(sourceId, encodedDir, sessionId),
      'close'
    )

  const doDelete = () => {
    if (busy) return
    return run(() => window.electronAPI.ccSessionDelete(sourceId, encodedDir, sessionId, archived), 'close')
  }

  confirmRef.current = prompt === 'rename' ? doRename : prompt === 'move' ? doMove : prompt === 'delete' ? doDelete : () => {}

  const meta = [
    shortModel(session.model),
    t('sessions.peek.msgs', { n: session.messageCount }),
    peek ? fmtCost(peek.costUsd) : '',
    fmtWhen(session.updatedAt, t, locale)
  ].filter(Boolean)

  const moveTargets = projects
    .filter((p) => !(p.sourceId === sourceId && p.encodedDir === encodedDir))
    // A Codex "project" is a folder derived from transcripts, not a directory anything
    // can be filed into, so it is a destination only for conversations filed that way.
    .filter((p) => codex || p.provider !== 'codex')

  return (
    <aside className="sp" ref={colRef} aria-label={t('sessions.peek.label')}>
      <section className="sp-sec">
        <h2 className="sp-title" title={session.title}>
          {session.title}
        </h2>
        <div className="sp-meta">
          {meta.join(' · ')}
          {session.realPath && (
            <>
              {' · '}
              <span className="sp-path">{session.realPath}</span>
            </>
          )}
        </div>
        <div className="sp-tags">
          {/* Edited here, in the column that is already about this conversation. */}
          {editingTags ? (
            <TagEditor
              session={session}
              vocabulary={vocabulary}
              colorFor={colorFor}
              onSaved={onTagsSaved}
              onClose={() => setEditingTags(false)}
            />
          ) : (
            <>
              <TagChips tags={session.tags} colorFor={colorFor} />
              <button type="button" className="btn-ghost small sp-tag-add" onClick={() => setEditingTags(true)}>
                {t('sessions.peek.addTag')}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="sp-sec sp-body">
        {loading ? (
          <p className="help">{t('sessions.peek.reading')}</p>
        ) : !peek || (!peek.first && !peek.last) ? (
          <p className="help">{t('sessions.peek.nothing')}</p>
        ) : (
          <>
            {peek.first && (
              <div className="sp-part">
                <div className="eyebrow">{t('sessions.peek.startedWith')}</div>
                <p className="sp-quote">{peek.first}</p>
              </div>
            )}
            {peek.last && peek.last !== peek.first && (
              <div className="sp-part">
                <div className="eyebrow">{t('sessions.peek.leftOffAt')}</div>
                <p className="sp-quote">{peek.last}</p>
              </div>
            )}
          </>
        )}
      </section>

      {error && <div className="sp-error">{error}</div>}

      {prompt === 'rename' ? (
        <div className="sp-foot sp-form">
          <input
            className="text-input"
            aria-label={t('sessions.peek.newName')}
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                doRename()
              }
            }}
          />
          <p className="help">
            {codex
              ? t('sessions.peek.renameNoteCodex')
              : t('sessions.peek.renameNote')}
          </p>
          <div className="sp-form-actions">
            <span className="help">{t('sessions.peek.renameHint')}</span>
            <button type="button" className="btn-ghost small" onClick={() => setPrompt(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn-primary small" disabled={busy || !draft.trim()} onClick={doRename}>
              {t('common.rename')}
            </button>
          </div>
        </div>
      ) : prompt === 'move' ? (
        <div className="sp-foot sp-form">
          <Select
            aria-label={t('sessions.peek.moveTo')}
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                doMove()
              }
            }}
          >
            <option value="">{t('sessions.peek.pickProject')}</option>
            {moveTargets.map((p) => (
              <option key={`${p.sourceId}:${p.encodedDir}`} value={`${p.sourceId}:${p.encodedDir}`}>
                {p.name}
                {p.kind === 'wsl' ? ` (${p.distro})` : ''}
              </option>
            ))}
          </Select>
          <p className="help">
            {codex
              ? t('sessions.peek.moveNoteCodex')
              : t('sessions.peek.moveNote')}
          </p>
          <div className="sp-form-actions">
            <span className="help">{t('sessions.peek.moveHint')}</span>
            <button type="button" className="btn-ghost small" onClick={() => setPrompt(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn-primary small" disabled={busy || !draft} onClick={doMove}>
              {t('sessions.peek.move')}
            </button>
          </div>
        </div>
      ) : prompt === 'delete' ? (
        <div className="sp-foot sp-form" ref={deleteRef} tabIndex={-1}>
          <p className="sp-confirm">
            {t('sessions.peek.deleteConfirm', { n: session.messageCount })}
          </p>
          <p className="help">{t('sessions.peek.deleteUndone')}</p>
          <div className="sp-form-actions">
            <span className="help">{t('sessions.peek.deleteHint')}</span>
            <button type="button" className="btn-ghost small" onClick={() => setPrompt(null)}>
              {t('sessions.peek.keep')}
            </button>
            <button type="button" className="btn-primary small danger" disabled={busy} onClick={doDelete}>
              {t('common.delete')}
            </button>
          </div>
        </div>
      ) : (
        <div className="sp-foot">
          <button
            type="button"
            className="btn-primary sp-resume"
            onClick={onResume}
            disabled={!resumable}
            title={resumable ? undefined : t('sessions.peek.notResumable')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 4l14 8-14 8Z" />
            </svg>
            {t('sessions.peek.resume')}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setDraft(session.title)
              setError('')
              setPrompt('rename')
            }}
          >
            {t('common.rename')}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setDraft('')
              setError('')
              setPrompt('move')
            }}
          >
            {t('sessions.peek.move')}
          </button>
          {/* Archiving is the reversible one, so it acts on a single press; delete asks first. */}
          <button type="button" className="btn-ghost" disabled={busy} onClick={doArchiveToggle}>
            {archived ? t('sessions.peek.unarchive') : t('sessions.peek.archive')}
          </button>
          <button
            type="button"
            className="btn-text danger sp-delete"
            onClick={() => {
              setError('')
              setPrompt('delete')
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </aside>
  )
}
