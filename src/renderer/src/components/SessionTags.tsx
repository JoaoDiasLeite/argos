import { useEffect, useRef, useState } from 'react'
import { CCSessionMeta } from '../types'
import { useT } from '../i18n'
import './SessionTags.css'

/**
 * Session tags. The set lives in the transcript itself as an appended `custom-tags`
 * line, so it survives the app and is visible to the CLI; only the colour is a
 * local preference.
 */

const FALLBACK_COLOR = 'var(--text-2)'

export function useLabelColors(): {
  colorFor: (tag: string) => string
  vocabulary: string[]
  reload: () => Promise<void>
} {
  const [labels, setLabels] = useState<Record<string, string>>({})
  const reload = async () => {
    try {
      const reg = await window.electronAPI.ccLabels()
      setLabels(reg.labels ?? {})
    } catch {
      /* colours only — never block on this */
    }
  }
  useEffect(() => {
    reload()
  }, [])
  return {
    colorFor: (tag) => labels[tag] ?? FALLBACK_COLOR,
    vocabulary: Object.keys(labels).sort((a, b) => a.localeCompare(b)),
    reload
  }
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

interface ChipsProps {
  tags: string[]
  colorFor: (tag: string) => string
  onRemove?: (tag: string) => void
  /** Makes each chip a toggle (a filter); `active` lists the ones switched on. */
  onClick?: (tag: string) => void
  active?: string[]
  /** Extra class on the wrapper, for the caller's own layout. */
  className?: string
}

/**
 * A run of tag chips: the shared neutral `.chip`, with the label's colour only on a
 * 6 px dot before the name (the colour is data, so it stays inline).
 */
export function TagChips({ tags, colorFor, onRemove, onClick, active, className }: ChipsProps) {
  const t = useT()
  if (!tags.length) return null
  return (
    <div className={`tag-chips ${className ?? ''}`}>
      {tags.map((tag) => {
        const dot = <span className="tag-chip-dot" style={{ background: colorFor(tag) }} aria-hidden="true" />
        if (onClick) {
          const on = !!active?.includes(tag)
          return (
            <button
              key={tag}
              type="button"
              className={`chip tag-chip toggle ${on ? 'on' : ''}`}
              aria-pressed={on}
              onClick={(e) => {
                e.stopPropagation()
                onClick(tag)
              }}
            >
              {dot}
              <span className="tag-chip-name">{tag}</span>
            </button>
          )
        }
        return (
          <span key={tag} className="chip tag-chip">
            {dot}
            <span className="tag-chip-name">{tag}</span>
            {onRemove && (
              <button
                type="button"
                className="tag-chip-x"
                aria-label={t('sessions.tags.remove', { tag })}
                title={t('sessions.tags.remove', { tag })}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(tag)
                }}
              >
                <XIcon />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

interface EditorProps {
  session: CCSessionMeta
  vocabulary: string[]
  colorFor: (tag: string) => string
  onSaved: (tags: string[]) => void
  onClose: () => void
}

/**
 * Add and remove tags on one session, inline in the detail column that is already
 * about it — so it does not close when you click elsewhere in that column, only on
 * Done or Esc.
 *
 * Each change is written straight away — one appended line per change, which is
 * how the format works anyway — so there is no save button to forget and no
 * half-applied state if the editor is dismissed.
 */
export function TagEditor({ session, vocabulary, colorFor, onSaved, onClose }: EditorProps) {
  const t = useT()
  const [tags, setTags] = useState<string[]>(session.tags)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Bound once; read the latest onClose through a ref so focus is not retaken on
  // every render of the caller.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const commit = async (next: string[]) => {
    setBusy(true)
    setError('')
    const res = await window.electronAPI.ccSetSessionTags(
      session.sourceId,
      session.encodedDir,
      session.sessionId,
      next
    )
    setBusy(false)
    if (res.ok) {
      setTags(res.tags)
      onSaved(res.tags)
    } else {
      setError(res.error === 'not-found' ? t('sessions.tags.notFound') : res.message)
    }
  }

  const add = (raw: string) => {
    const tag = raw.trim()
    if (!tag || tags.includes(tag)) {
      setDraft('')
      return
    }
    setDraft('')
    commit([...tags, tag])
  }

  const suggestions = vocabulary
    .filter((v) => !tags.includes(v) && v.toLowerCase().includes(draft.trim().toLowerCase()))
    .slice(0, 6)

  return (
    <div className="tag-editor" onClick={(e) => e.stopPropagation()}>
      <div className="tag-editor-head">
        <span className="eyebrow">{t('sessions.tags.title')}</span>
        <button type="button" className="btn-text" onClick={onClose}>
          {t('sessions.tags.done')}
        </button>
      </div>
      {tags.length > 0 ? (
        <TagChips tags={tags} colorFor={colorFor} onRemove={(tag) => commit(tags.filter((x) => x !== tag))} />
      ) : (
        <p className="help">{t('sessions.tags.empty')}</p>
      )}
      <input
        ref={inputRef}
        className="text-input tag-editor-input"
        placeholder={t('sessions.tags.add')}
        aria-label={t('sessions.tags.add')}
        value={draft}
        disabled={busy}
        onChange={(e) => {
          setDraft(e.target.value)
          setError('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(draft)
          }
        }}
      />
      {suggestions.length > 0 && (
        <div className="tag-chips">
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip tag-chip toggle" onClick={() => add(s)}>
              <span className="tag-chip-dot" style={{ background: colorFor(s) }} aria-hidden="true" />
              <span className="tag-chip-name">{s}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="tag-editor-error">{error}</div>}
    </div>
  )
}
