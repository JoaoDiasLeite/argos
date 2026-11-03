import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type { OpsRunListItem } from '../types'
import type { OpsRun } from '../lib/ops-timeline'
import { runNotes, runStatus } from '../lib/ops-run-status'
import { plural } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'

const shortDate = (iso: string, locale: string | undefined): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
}

const clock = (iso: string, locale: string | undefined): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/**
 * "+ Refer an earlier one": opened from the Context chip row, absolute inside the side panel
 * under the Context section (styles in ActivityColumn.css). A search over the earlier runs
 * (on this server when the intervention is locked to one); picking one points the live run's
 * model at it. Arrow keys move, Enter picks, Escape or a click outside closes. An error stays
 * inside the picker.
 */
export default function OpsReferPicker({
  terminalId,
  run,
  serverLabel,
  anchorRef,
  chipRef,
  onClose
}: {
  terminalId: string
  run: OpsRun
  serverLabel?: string
  /** The Context section: the picker sits just under it. */
  anchorRef: RefObject<HTMLElement | null>
  /** The chip that opens it, so a click on it is not a click outside. */
  chipRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const t = useT()
  const { locale } = useLanguage()
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [runs, setRuns] = useState<OpsRunListItem[] | 'loading'>('loading')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [top, setTop] = useState(0)
  const hostId = run.scope?.kind === 'host' ? run.scope.hostId : undefined

  useEffect(() => {
    const anchor = anchorRef.current
    const panel = rootRef.current?.offsetParent
    if (anchor && panel) setTop(anchor.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 6)
  }, [anchorRef])

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .opsRuns({ hostId, limit: 30 })
      .then((res) => !cancelled && setRuns(res.ok ? res.runs.filter((r) => r.runId !== run.runId) : []))
      .catch(() => !cancelled && setRuns([]))
    return () => {
      cancelled = true
    }
  }, [hostId, run.runId])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = e.target as Node
      if (rootRef.current?.contains(el) || chipRef.current?.contains(el)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [chipRef, onClose])

  const shown = useMemo(() => {
    if (runs === 'loading') return []
    const q = query.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((r) => [r.headline, r.task, r.runbook].some((x) => x?.toLowerCase().includes(q)))
  }, [runs, query])
  const cur = Math.min(active, Math.max(0, shown.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cur, shown])

  const pick = async (r: OpsRunListItem): Promise<void> => {
    setError(null)
    try {
      const res = await window.electronAPI.opsReference(terminalId, r.runId)
      if (!res.ok) return setError(res.error)
      window.electronAPI.terminalWrite(terminalId, res.line + '\r')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (shown.length) setActive((cur + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[cur]) void pick(shown[cur])
    }
  }

  return (
    <div className="ac-refer" ref={rootRef} style={{ top }} onKeyDown={onKeyDown}>
      <div className="ac-refer-search">
        <input
          autoFocus
          className="ac-refer-input"
          aria-label={t('ops.activity.referTitle')}
          placeholder={t('ops.activity.referSearch')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
        />
      </div>
      <div className="ac-refer-label">{t('ops.activity.referOn', { server: serverLabel ?? '' })}</div>
      {error && (
        <div className="ac-refer-note error" role="alert">
          {t('ops.activity.referError', { error })}
        </div>
      )}
      <div className="ac-refer-list" ref={listRef} role="listbox" aria-label={t('ops.activity.referTitle')}>
        {runs === 'loading' ? (
          <div className="ac-refer-note">{t('ops.activity.referLoading')}</div>
        ) : runs.length === 0 ? (
          <div className="ac-refer-note">{t('ops.activity.referNone')}</div>
        ) : shown.length === 0 ? (
          <div className="ac-refer-note">{t('ops.activity.referNoMatch')}</div>
        ) : (
          shown.map((r, i) => {
            const status = runStatus(r, t).label
            const sub = [status.charAt(0).toUpperCase() + status.slice(1), plural(t, 'ops.start.calls', r.calls), ...runNotes(r, t)]
            return (
              <button
                key={r.runId}
                type="button"
                role="option"
                aria-selected={i === cur}
                className={`ac-refer-row${i === cur ? ' on' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => void pick(r)}
              >
                <span className="ac-refer-top">
                  <span className="ac-refer-title">{r.headline || r.task || t('ops.activity.referNoNotes', { runbook: r.runbook })}</span>
                  <span className="ac-refer-when">{[shortDate(r.startedAt, locale), clock(r.startedAt, locale)].filter(Boolean).join(' ')}</span>
                </span>
                <span className="ac-refer-sub">{sub.join(' · ')}</span>
              </button>
            )
          })
        )}
      </div>
      <div className="ac-refer-foot">{t('ops.activity.referFoot')}</div>
    </div>
  )
}
