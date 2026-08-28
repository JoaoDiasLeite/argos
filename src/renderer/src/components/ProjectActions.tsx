import { useEffect, useRef, useState } from 'react'
import { CCProject, ProjectMoveRefusal, ProjectOpResult } from '../types'
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
  /**
   * A move succeeded and the project now lives under a new `encodedDir` — the id the
   * whole view addresses it by. The caller re-selects the project under this key once
   * the reloaded list contains it, rather than leaving the selection pointed at an id
   * that now addresses nothing.
   */
  onMoved: (next: { sourceId: string; encodedDir: string }) => void
  onClose: () => void
}

/** Kept in sync with `.proj-actions-menu`'s width so the flip has something to measure. */
const MENU_WIDTH = 260

/** One sentence per refusal — a generic failure is exactly what the discriminated
 * union in ProjectMoveResult exists to prevent. */
function moveRefusalMessage(error: ProjectMoveRefusal, detail?: string): string {
  switch (error) {
    case 'not-found':
      return 'This project is no longer where Argos last saw it.'
    case 'invalid-target':
      return 'That is not a usable destination. Give an absolute path to a new folder, not a drive root.'
    case 'same-path':
      return 'That is where the project already is.'
    case 'target-inside-source':
      return 'A folder cannot move inside itself.'
    case 'target-exists':
      return 'Something is already at that path. Pick a name that does not exist yet — the move refuses rather than merging into it.'
    case 'no-parent':
      return 'The folder that would contain it does not exist. Create it first, or pick another destination.'
    case 'cross-volume':
      return 'That is on a different drive. Argos refuses rather than copying: a copy of a project tree is a different operation, and a half-finished one is worse than a refusal.'
    case 'encoded-collision':
      return 'Another project already owns the transcript folder that path would use.'
    case 'busy':
      return 'A chat is running in this project. Stop it first.'
    case 'failed':
    default:
      return detail || 'The move failed.'
  }
}

/** The folder's own name, from the last segment of a path — split on both separators
 * because a WSL project's `realPath` is POSIX even though this process is Windows. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * A project's own actions: archive (a preference, reversible, no confirmation),
 * change folder (a real filesystem move, guarded by nine refusals) and delete
 * (destructive, but only ever of an empty directory — see the guard below).
 *
 * Shape and tone follow SessionPeek's action row: a plain button for the reversible
 * move, a confirmation block that names exactly what goes for the ones that aren't.
 * Only one of the move and delete prompts is ever open — opening either closes the
 * other, the same "one open thing at a time" rule the tag popover follows.
 */
export default function ProjectActions({ project, anchor, onChanged, onMoved, onClose }: Props) {
  const [panel, setPanel] = useState<'delete' | 'move' | null>(null)
  const [moveDraft, setMoveDraft] = useState('')
  // Set once a move succeeds with something downstream left unfixed. Kept separate
  // from `error` because it reports a success, just not a complete one, and showing
  // it in the red error block would say the move failed when it did not.
  const [moveWarnings, setMoveWarnings] = useState<string[] | null>(null)
  /** Where the project ended up, held until the warnings above have been dismissed. */
  const [moved, setMoved] = useState<{ sourceId: string; encodedDir: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  // Read by the close handlers, which are bound once and would otherwise close over
  // the state as it was when the popover opened.
  const movedRef = useRef<{ sourceId: string; encodedDir: string } | null>(null)
  const dismissRef = useRef<() => void>(() => {})

  const { sourceId, encodedDir, name, realPath, sessionCount, archivedCount, archived } = project
  const totalSessions = sessionCount + archivedCount

  useEffect(() => {
    // Dismissing by clicking away or pressing Escape is still a dismissal: the move
    // already happened, so the list has to be told either way.
    const leave = () => (movedRef.current ? dismissRef.current() : onClose())
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) leave()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        leave()
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
      setPanel(null)
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

  const openMove = () => {
    setError('')
    setMoveWarnings(null)
    setMoveDraft(realPath)
    setPanel((p) => (p === 'move' ? null : 'move'))
  }

  const openDelete = () => {
    setError('')
    setPanel((p) => (p === 'delete' ? null : 'delete'))
  }

  // The native picker selects an EXISTING directory, but the move requires the
  // destination not to exist — it refuses rather than merging. So picking `C:\dev`
  // has to fill the field with `C:\dev\<current folder name>`, not `C:\dev` itself.
  const browseFolder = async () => {
    const parent = await window.electronAPI.openFolder(realPath)
    if (!parent) return
    const sep = parent.includes('\\') ? '\\' : '/'
    setMoveDraft(`${parent.replace(/[\\/]+$/, '')}${sep}${baseName(realPath)}`)
  }

  const trimmedDraft = moveDraft.trim()
  const canMove = trimmedDraft.length > 0 && trimmedDraft !== realPath

  const doMove = async () => {
    setBusy(true)
    setError('')
    const res = await window.electronAPI.ccProjectMove(sourceId, encodedDir, trimmedDraft)
    setBusy(false)
    if (!res.ok) {
      setError(moveRefusalMessage(res.error, res.detail))
      return
    }
    if (res.warnings.length) {
      // Reporting the partial failure has to happen BEFORE the reload, not with it:
      // `onChanged` re-reads the list, the row this popover is anchored to vanishes
      // under its new `encodedDir`, and the popover unmounts with the warnings still
      // in it. So the reload waits for the dismissal, which is also what makes the
      // dismissal explicit rather than a timer.
      setMoveWarnings(res.warnings)
      setMoved({ sourceId, encodedDir: res.encodedDir })
      return
    }
    onChanged()
    onMoved({ sourceId, encodedDir: res.encodedDir })
    onClose()
  }

  /** Let the list catch up with the move the warnings were reported for. */
  const dismissWarnings = () => {
    if (moved) onMoved(moved)
    onChanged()
    onClose()
  }

  movedRef.current = moved
  dismissRef.current = dismissWarnings

  const deleteDisabledReason = totalSessions
    ? `Holds ${totalSessions} conversation${totalSessions !== 1 ? 's' : ''}${
        archivedCount ? ` (${archivedCount} archived)` : ''
      }`
    : ''

  // Kept on screen rather than trusting the anchor: a row near the right edge or the
  // bottom of a tall window would otherwise open the panel half outside it. The move
  // panel is considerably taller than the delete confirmation, so it needs more
  // headroom reserved above the bottom edge.
  const panelHeight = panel === 'move' ? 400 : panel === 'delete' ? 260 : 220
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - panelHeight))

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

      <button className="proj-actions-item" role="menuitem" disabled={busy} onClick={openMove}>
        Change folder…
      </button>

      {panel === 'move' &&
        (moveWarnings ? (
          <div className="proj-actions-warn">
            <p>Moved, but not everything else followed.</p>
            <ul className="proj-actions-warn-list">
              {moveWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <div className="proj-actions-confirm-actions">
              <button className="btn-primary small" onClick={dismissWarnings}>
                Dismiss
              </button>
            </div>
          </div>
        ) : (
          <div className="proj-actions-move">
            <p className="proj-actions-move-current">
              Currently at <span className="proj-actions-path">{realPath}</span>
            </p>
            <label htmlFor="proj-actions-move-input">New folder</label>
            <div className="proj-actions-move-row">
              <input
                id="proj-actions-move-input"
                className="proj-actions-move-input"
                autoFocus
                value={moveDraft}
                disabled={busy}
                onChange={(e) => setMoveDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canMove) doMove()
                }}
              />
              <button className="btn-ghost small" onClick={browseFolder} disabled={busy}>
                Browse…
              </button>
            </div>
            <p className="proj-actions-note">
              Browse picks the parent folder to move into — the move requires the
              destination itself not to exist, so the current folder name is appended
              for you.
            </p>
            <div className="proj-actions-confirm-actions">
              <button className="btn-ghost small" onClick={() => setPanel(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn-primary small" disabled={busy || !canMove} onClick={doMove}>
                Move
              </button>
            </div>
          </div>
        ))}

      <div className="proj-actions-sep" />

      {totalSessions > 0 ? (
        <button className="proj-actions-item danger" role="menuitem" disabled title={deleteDisabledReason}>
          Delete project
          <span className="proj-actions-reason">{deleteDisabledReason}</span>
        </button>
      ) : panel === 'delete' ? (
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
            <button className="btn-ghost small" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary small danger" onClick={doDelete} disabled={busy}>
              Delete project
            </button>
          </div>
        </div>
      ) : (
        <button className="proj-actions-item danger" role="menuitem" onClick={openDelete}>
          Delete project
        </button>
      )}

      {error && <div className="proj-actions-error">{error}</div>}
    </div>
  )
}
