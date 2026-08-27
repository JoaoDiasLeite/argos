import { useEffect, useState } from 'react'
import { CCSessionMeta, SessionPeek as Peek } from '../types'
import { TagChips, TagEditor } from './SessionTags'
import './SessionPeek.css'

interface Props {
  session: CCSessionMeta
  colorFor: (tag: string) => string
  vocabulary: string[]
  onResume: () => void
  onClose: () => void
  onTagsSaved: (tags: string[]) => void
}

function fmtCost(usd: number): string {
  if (!usd) return ''
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/**
 * Enough of a conversation to decide whether to reopen it, without opening it.
 *
 * Full height of the pane by design, not sized to its content: a panel that changes
 * height as you arrow through the list makes the list beside it jump, and a fixed
 * height leaves room for more of the ending — which is the part that answers the
 * question.
 */
export default function SessionPeek({
  session,
  colorFor,
  vocabulary,
  onResume,
  onClose,
  onTagsSaved
}: Props) {
  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTags, setEditingTags] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPeek(null)
    window.electronAPI
      .ccSessionPeek(session.sourceId, session.encodedDir, session.sessionId)
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
    // Editing follows the conversation: arrowing to another one closes the editor
    // rather than leaving it open over a session it no longer belongs to.
    setEditingTags(false)
    return () => {
      cancelled = true
    }
  }, [session.sourceId, session.encodedDir, session.sessionId])

  const cost = peek ? fmtCost(peek.costUsd) : ''

  return (
    <aside className="peek" aria-label="Conversation preview">
      <div className="peek-head">
        <h2 className="peek-title" title={session.title}>
          {session.title}
        </h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close preview">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="peek-meta">
        <span className="peek-model">{session.model ?? '—'}</span>
        <span>{session.messageCount} msgs</span>
        {cost && <span>{cost}</span>}
        <span>{new Date(session.updatedAt).toLocaleString()}</span>
      </div>

      <div className="peek-tags">
        {/* Edited here, in the panel that is already about this conversation — the
            first version reached back into the list and opened the row's popover,
            which put the editor at the other end of the window from the button. */}
        {editingTags ? (
          <TagEditor
            variant="inline"
            session={session}
            vocabulary={vocabulary}
            colorFor={colorFor}
            onSaved={onTagsSaved}
            onClose={() => setEditingTags(false)}
          />
        ) : (
          <>
            <TagChips tags={session.tags} colorFor={colorFor} />
            <button className="peek-tag-add" onClick={() => setEditingTags(true)}>
              {session.tags.length ? 'Edit tags' : '+ tag'}
            </button>
          </>
        )}
      </div>

      <div className="peek-body">
        {loading ? (
          <div className="peek-loading">Reading…</div>
        ) : !peek || (!peek.first && !peek.last) ? (
          <div className="peek-loading">Nothing to show — this transcript has no messages.</div>
        ) : (
          <>
            {peek.first && (
              <section className="peek-section">
                <h3>Started with</h3>
                <p className="peek-quote">{peek.first}</p>
              </section>
            )}
            {peek.last && peek.last !== peek.first && (
              <section className="peek-section">
                <h3>Left off at</h3>
                {/* The accent rule marks this one: of the two, it is what decides
                    whether the conversation still needs you. */}
                <p className={`peek-quote last ${peek.lastRole}`}>{peek.last}</p>
              </section>
            )}
          </>
        )}
      </div>

      <div className="peek-actions">
        <button className="btn-primary" onClick={onResume}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Resume
        </button>
        {/* Said, not implied. Bare keycaps in a corner read as buttons — they were
            asked what they did, which is the answer. */}
        <span className="peek-keys">
          <kbd>↑↓</kbd> browse <span className="peek-keys-sep">·</span> <kbd>⏎</kbd> resume
        </span>
      </div>
    </aside>
  )
}
