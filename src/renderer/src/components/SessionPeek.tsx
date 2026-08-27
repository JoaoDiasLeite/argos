import { useEffect, useState } from 'react'
import { CCProject, CCSessionMeta, LifecycleResult, SessionPeek as Peek } from '../types'
import { TagChips, TagEditor } from './SessionTags'
import './SessionPeek.css'

interface Props {
  session: CCSessionMeta
  colorFor: (tag: string) => string
  vocabulary: string[]
  projects: CCProject[]
  onResume: () => void
  onClose: () => void
  onTagsSaved: (tags: string[]) => void
  /** Something on disk changed — the list has to be read again. */
  onChanged: () => void
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
type Prompt = 'rename' | 'delete' | 'move' | null

export default function SessionPeek({
  session,
  colorFor,
  vocabulary,
  projects,
  onResume,
  onClose,
  onTagsSaved,
  onChanged
}: Props) {
  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTags, setEditingTags] = useState(false)
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const { sourceId, encodedDir, sessionId, archived } = session

  /** Every lifecycle call answers the same three ways, so they are handled once. */
  const run = async (fn: () => Promise<LifecycleResult>, after: 'close' | 'stay') => {
    setBusy(true)
    setError('')
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      setError(
        res.error === 'not-found'
          ? 'This conversation is no longer on disk.'
          : res.error === 'exists'
            ? 'A conversation with the same id is already there.'
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
    // Everything transient follows the conversation: arrowing to another one must not
    // leave a half-typed rename, or a delete confirmation, pointing at a session it no
    // longer belongs to.
    setEditingTags(false)
    setPrompt(null)
    setError('')
    return () => {
      cancelled = true
    }
  }, [session.sourceId, session.encodedDir, session.sessionId, session.archived])

  const doRename = () =>
    run(
      () =>
        window.electronAPI.ccSessionRename(sourceId, encodedDir, sessionId, draft.trim(), archived),
      'stay'
    )

  const doMove = () => {
    // The picker's value is `<sourceId>:<encodedDir>`, and a sourceId can itself
    // contain a colon (`wsl:Ubuntu`), so only the FIRST one separates them.
    const at = draft.indexOf(':')
    const toSource = draft.slice(0, at)
    const toDir = draft.slice(at + 1)
    return run(
      () =>
        window.electronAPI.ccSessionMove(sourceId, encodedDir, sessionId, toSource, toDir, archived),
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

  const doDelete = () =>
    run(() => window.electronAPI.ccSessionDelete(sourceId, encodedDir, sessionId, archived), 'close')

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

      {prompt === 'rename' && (
        <div className="peek-prompt">
          <label htmlFor="peek-rename">Rename this conversation</label>
          <input
            id="peek-rename"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) doRename()
            }}
          />
          <p className="peek-prompt-note">
            The name is stored inside the conversation, so Claude Code sees it too.
          </p>
          <div className="peek-prompt-actions">
            <button className="btn-ghost small" onClick={() => setPrompt(null)}>
              Cancel
            </button>
            <button className="btn-primary small" disabled={busy || !draft.trim()} onClick={doRename}>
              Rename
            </button>
          </div>
        </div>
      )}

      {prompt === 'move' && (
        <div className="peek-prompt">
          <label htmlFor="peek-move">Move to</label>
          <select
            id="peek-move"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          >
            <option value="">Pick a project…</option>
            {projects
              .filter((p) => !(p.sourceId === sourceId && p.encodedDir === encodedDir))
              .map((p) => (
                <option key={`${p.sourceId}:${p.encodedDir}`} value={`${p.sourceId}:${p.encodedDir}`}>
                  {p.name}
                  {p.kind === 'wsl' ? ` (${p.distro})` : ''}
                </option>
              ))}
          </select>
          <p className="peek-prompt-note">
            Filing only. Where the conversation ran is recorded inside it and is never
            rewritten, so resuming still lands in the right folder.
          </p>
          <div className="peek-prompt-actions">
            <button className="btn-ghost small" onClick={() => setPrompt(null)}>
              Cancel
            </button>
            <button className="btn-primary small" disabled={busy || !draft} onClick={doMove}>
              Move
            </button>
          </div>
        </div>
      )}

      {prompt === 'delete' && (
        <div className="peek-prompt danger">
          <p>
            Delete <b>{session.title}</b>, {session.messageCount} messages, permanently?
          </p>
          <p className="peek-prompt-note">
            The transcript is removed from disk and there is no undo. Archiving keeps it
            and takes it out of the list.
          </p>
          <div className="peek-prompt-actions">
            <button className="btn-ghost small" onClick={() => setPrompt(null)}>
              Cancel
            </button>
            <button className="btn-primary small danger" disabled={busy} onClick={doDelete}>
              Delete for good
            </button>
          </div>
        </div>
      )}

      {error && <div className="peek-error">{error}</div>}

      <div className="peek-actions">
        <button className="btn-primary" onClick={onResume}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Resume
        </button>

        <div className="peek-more">
          <button
            className="peek-more-btn"
            title="Rename"
            aria-label="Rename"
            onClick={() => {
              setDraft(session.title)
              setPrompt(prompt === 'rename' ? null : 'rename')
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            className="peek-more-btn"
            title="Move to another project"
            aria-label="Move to another project"
            onClick={() => {
              setDraft('')
              setPrompt(prompt === 'move' ? null : 'move')
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7h6l2 2h10v10H3Z" /><polyline points="13 12 16 15 13 18" />
            </svg>
          </button>
          {/* Archiving is the reversible one, so it acts on a single press; delete is
              behind a confirmation that names exactly what goes. */}
          <button
            className="peek-more-btn"
            title={archived ? 'Unarchive' : 'Archive'}
            aria-label={archived ? 'Unarchive' : 'Archive'}
            disabled={busy}
            onClick={doArchiveToggle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1" y="3" width="22" height="5" />
              <path d="M21 8v13H3V8" />
              {archived ? <polyline points="9 15 12 12 15 15" /> : <polyline points="9 12 12 15 15 12" />}
            </svg>
          </button>
          <button
            className="peek-more-btn danger"
            title="Delete permanently"
            aria-label="Delete permanently"
            onClick={() => setPrompt(prompt === 'delete' ? null : 'delete')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  )
}
