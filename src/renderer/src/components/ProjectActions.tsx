import { useEffect, useRef, useState } from 'react'
import { CCProject, ProjectOpResult } from '../types'
import './ProjectActions.css'

interface Props {
  project: CCProject
  /**
   * Where the trigger button is on screen, in viewport coordinates.
   *
   * The popover is positioned `fixed` from this rather than absolutely inside the
   * row, because the project column is 210px wide and scrolls — an absolutely
   * positioned panel is clipped by it on both axes, and the confirmation this one
   * shows has a full folder path in it.
   */
  anchor: { top: number; left: number }
  /** Something changed on disk — the caller re-reads the project list. */
  onChanged: () => void
  onClose: () => void
}

/** Kept in sync with `.proj-actions-menu`'s width so the flip has something to measure. */
const MENU_WIDTH = 260

/**
 * A project's own actions: archive (a preference, reversible, no confirmation) and
 * delete (destructive, but only ever of an empty directory — see the guard below).
 *
 * Shape and tone follow SessionPeek's action row: a plain button for the reversible
 * move, a confirmation block that names exactly what goes for the one that isn't.
 */
export default function ProjectActions({ project, anchor, onChanged, onClose }: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const { sourceId, encodedDir, name, realPath, sessionCount, archivedCount, archived } = project
  const totalSessions = sessionCount + archivedCount

  useEffect(() => {
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

  const doArchiveToggle = async () => {
    setBusy(true)
    await window.electronAPI.ccProjectArchive(sourceId, encodedDir, !archived)
    setBusy(false)
    onChanged()
    onClose()
  }

  const handleResult = (res: ProjectOpResult) => {
    setBusy(false)
    if (res.ok) {
      onChanged()
      onClose()
      return
    }
    if (res.error === 'not-found') {
      setError('This project is no longer on disk.')
    } else if (res.error === 'not-empty') {
      // The list this popover was opened from is stale: a transcript landed here
      // after the read that produced these counts. Say so, and offer the fix.
      setError(
        `A conversation appeared in this project since the list was read (now ${res.sessions} session${
          res.sessions !== 1 ? 's' : ''
        }${res.archived ? `, ${res.archived} archived` : ''}). Refresh and try again.`
      )
      setConfirmingDelete(false)
    } else {
      setError(res.message)
    }
  }

  const doDelete = async () => {
    setBusy(true)
    setError('')
    const res = await window.electronAPI.ccProjectDelete(sourceId, encodedDir)
    handleResult(res)
  }

  const deleteDisabledReason = totalSessions
    ? `Holds ${totalSessions} conversation${totalSessions !== 1 ? 's' : ''}${
        archivedCount ? ` (${archivedCount} archived)` : ''
      }`
    : ''

  // Kept on screen rather than trusting the anchor: a row near the right edge or the
  // bottom of a tall window would otherwise open the panel half outside it.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - 220))

  return (
    <div
      className="proj-actions-menu"
      ref={ref}
      role="menu"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="proj-actions-item"
        role="menuitem"
        disabled={busy}
        onClick={doArchiveToggle}
      >
        {archived ? 'Unarchive project' : 'Archive project'}
      </button>
      <p className="proj-actions-note">
        Filing only — archiving a project is a preference and does not touch any
        conversation.
      </p>

      <div className="proj-actions-sep" />

      {totalSessions > 0 ? (
        <button className="proj-actions-item danger" role="menuitem" disabled title={deleteDisabledReason}>
          Delete project
          <span className="proj-actions-reason">{deleteDisabledReason}</span>
        </button>
      ) : confirmingDelete ? (
        <div className="proj-actions-confirm">
          <p>
            Delete the empty project <b>{name}</b> — <span className="proj-actions-path">{realPath}</span>?
          </p>
          <p className="proj-actions-note">
            Removes the empty project directory under the source's <code>projects/</code>
            folder, plus this project's pin and archived flag. Nothing inside the real
            project folder on disk is touched.
          </p>
          <div className="proj-actions-confirm-actions">
            <button className="btn-ghost small" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary small danger" onClick={doDelete} disabled={busy}>
              Delete project
            </button>
          </div>
        </div>
      ) : (
        <button
          className="proj-actions-item danger"
          role="menuitem"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete project
        </button>
      )}

      {error && <div className="proj-actions-error">{error}</div>}
    </div>
  )
}
