import { useEffect, useRef, useState } from 'react'
import { CCSessionMeta } from '../types'
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

interface ChipsProps {
  tags: string[]
  colorFor: (tag: string) => string
  onRemove?: (tag: string) => void
  onClick?: (tag: string) => void
  active?: string[]
}

export function TagChips({ tags, colorFor, onRemove, onClick, active }: ChipsProps) {
  if (!tags.length) return null
  return (
    <div className="tag-chips">
      {tags.map((tag) => {
        const color = colorFor(tag)
        const isActive = active?.includes(tag)
        const chip = (
          <>
            <span className="tag-chip-dot" style={{ background: color }} aria-hidden="true" />
            {tag}
            {onRemove && (
              <span
                className="tag-chip-x"
                role="button"
                tabIndex={0}
                aria-label={`Remove ${tag}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(tag)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    onRemove(tag)
                  }
                }}
              >
                ×
              </span>
            )}
          </>
        )
        return onClick ? (
          <button
            key={tag}
            type="button"
            className={`tag-chip clickable ${isActive ? 'on' : ''}`}
            style={{ borderColor: color, color }}
            onClick={(e) => {
              e.stopPropagation()
              onClick(tag)
            }}
          >
            {chip}
          </button>
        ) : (
          <span key={tag} className="tag-chip" style={{ borderColor: color, color }}>
            {chip}
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
 * Add and remove tags on one session.
 *
 * Each change is written straight away — one appended line per change, which is
 * how the format works anyway — so there is no save button to forget and no
 * half-applied state if the popover is dismissed.
 */
export function TagEditor({ session, vocabulary, colorFor, onSaved, onClose }: EditorProps) {
  const [tags, setTags] = useState<string[]>(session.tags)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

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
      setError(res.error === 'not-found' ? 'This conversation is no longer on disk.' : res.message)
    }
  }

  const add = (raw: string) => {
    const t = raw.trim()
    if (!t || tags.includes(t)) {
      setDraft('')
      return
    }
    setDraft('')
    commit([...tags, t])
  }

  const suggestions = vocabulary
    .filter((v) => !tags.includes(v) && v.toLowerCase().includes(draft.trim().toLowerCase()))
    .slice(0, 6)

  return (
    <div className="tag-editor" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="tag-editor-head">Tags</div>
      {tags.length > 0 ? (
        <TagChips tags={tags} colorFor={colorFor} onRemove={(t) => commit(tags.filter((x) => x !== t))} />
      ) : (
        <div className="tag-editor-empty">No tags yet.</div>
      )}
      <input
        ref={inputRef}
        className="tag-editor-input"
        placeholder="Add a tag…"
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
        <div className="tag-editor-suggest">
          {suggestions.map((s) => (
            <button key={s} type="button" className="tag-suggest" onClick={() => add(s)}>
              <span className="tag-chip-dot" style={{ background: colorFor(s) }} aria-hidden="true" />
              {s}
            </button>
          ))}
        </div>
      )}
      {error && <div className="tag-editor-error">{error}</div>}
    </div>
  )
}
