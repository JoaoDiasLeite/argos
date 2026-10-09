import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { CCProject, ProjectMoveRefusal, ProjectOpResult } from '../types'
import { plural, type TFunction } from '../../../shared/i18n'
import { useT } from '../i18n'
import './ProjectActions.css'

interface Props {
  project: CCProject
  /**
   * Every transcript directory that resolves to this same project — one folder can be
   * addressed under more than one of them (a Windows path and its Git Bash spelling, a
   * WSL directory reached three ways), and the list shows them as one row.
   *
   * Archiving is a preference and applies to all of them, or unarchiving one member of
   * a group that has another still archived looks like the click did nothing. Move and
   * delete are filesystem operations on one directory and stay that way — they just say
   * so when there is more than one.
   */
  siblings?: { sourceId: string; encodedDir: string }[]
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
const MENU_WIDTH = 300

/** One sentence per refusal — a generic failure is exactly what the discriminated
 * union in ProjectMoveResult exists to prevent. */
function moveRefusalMessage(t: TFunction, error: ProjectMoveRefusal, detail?: string): string {
  switch (error) {
    case 'not-found':
      return t('projects.actions.move.notFound')
    case 'invalid-target':
      return t('projects.actions.move.invalidTarget')
    case 'same-path':
      return t('projects.actions.move.samePath')
    case 'target-inside-source':
      return t('projects.actions.move.insideSource')
    case 'target-exists':
      return t('projects.actions.move.targetExists')
    case 'no-parent':
      return t('projects.actions.move.noParent')
    case 'cross-volume':
      return t('projects.actions.move.crossVolume')
    case 'encoded-collision':
      return t('projects.actions.move.encodedCollision')
    case 'busy':
      return t('projects.actions.move.busy')
    case 'failed':
    default:
      return detail || t('projects.actions.move.failed')
  }
}

/** A translated sentence with markup inside it: the `{name}` placeholders the template
 *  still holds (it was fetched without those params) are swapped for the given nodes. */
function withNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part))
}

/** The folder's own name, from the last segment of a path — split on both separators
 * because a WSL project's `realPath` is POSIX even though this process is Windows. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** One sentence per delete refusal, worded for the one directory it happened to
 * rather than the whole project once there is more than one member — a `not-empty`
 * on the second spelling of a folder does not mean the project itself gained a
 * session, just that this particular transcript directory did. */
function deleteFailureMessage(t: TFunction, res: Extract<ProjectOpResult, { ok: false }>, multiple: boolean): string {
  switch (res.error) {
    case 'not-found':
      return multiple
        ? t('projects.actions.delete.notFoundMultiple')
        : t('projects.actions.delete.notFound')
    case 'not-empty': {
      const subject = multiple ? t('projects.actions.delete.subjectMultiple') : t('projects.actions.delete.subjectSingle')
      const sessions = plural(t, 'projects.actions.sessions', res.sessions)
      const count = res.archived
        ? t('projects.actions.delete.countWithArchived', { sessions, archived: res.archived })
        : sessions
      return t('projects.actions.delete.notEmpty', { subject, count })
    }
    case 'failed':
    default:
      return res.message
  }
}

/**
 * A project's own actions: archive (a preference, reversible, no confirmation),
 * change folder (a real filesystem move, guarded by nine refusals) and delete
 * (destructive, but only ever of an empty directory — see the guard below).
 *
 * Shape and tone follow the session column's footer: a plain row for the reversible
 * archive, an inline confirmation that names exactly what goes for the ones that aren't.
 * Only one of the move and delete prompts is ever open — opening either closes the
 * other, the same "one open thing at a time" rule the tag popover follows.
 */
export default function ProjectActions({ project, siblings, anchor, onChanged, onMoved, onClose }: Props) {
  const t = useT()
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

  const members = siblings?.length ? siblings : [{ sourceId, encodedDir }]

  const doArchiveToggle = async () => {
    setBusy(true)
    // Sequentially, not Promise.all: each write reads and rewrites the same stored list,
    // and concurrent writers would race to a value that drops some of them.
    for (const m of members) {
      await window.electronAPI.ccProjectArchive(m.sourceId, m.encodedDir, !archived)
    }
    setBusy(false)
    onChanged()
    onClose()
  }

  const doDelete = async () => {
    setBusy(true)
    setError('')
    const multiple = members.length > 1
    // Sequentially, same reasoning as the archive toggle above: each delete also
    // clears this member's pin and archived flag from the same stored list.
    let deleted = 0
    const failures: string[] = []
    let stale = false
    for (const m of members) {
      const res = await window.electronAPI.ccProjectDelete(m.sourceId, m.encodedDir)
      if (res.ok) {
        deleted++
        continue
      }
      failures.push(deleteFailureMessage(t, res, multiple))
      // Stale-list message: there's no point leaving a single-directory confirm
      // panel open over data that's already known to be wrong.
      if (!multiple && res.error === 'not-empty') stale = true
    }
    setBusy(false)
    if (!failures.length) {
      onChanged()
      onClose()
      return
    }
    setError(
      multiple
        ? t('projects.actions.delete.partial', { n: deleted, total: members.length, reason: failures[0] })
        : failures[0]
    )
    if (stale) setPanel(null)
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
    const warnings: string[] = []
    // Keyed by sourceId: two members of the same source that both resolve to this
    // real folder compute the identical new encodedDir (it's `encodePath(toPath)`,
    // independent of which old spelling asked for it), so recording it once per
    // source is enough to recover the `project` prop's own new id even when ITS
    // move is the one that gets skipped below.
    const resolvedEncodedDir = new Map<string, string>()
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      const res = await window.electronAPI.ccProjectMove(m.sourceId, m.encodedDir, trimmedDraft)
      if (res.ok) {
        warnings.push(...res.warnings)
        resolvedEncodedDir.set(m.sourceId, res.encodedDir)
        continue
      }
      // Two spellings inside the same source's `projects/` can name the same real
      // folder; the first one already moved it, so the second refusing with
      // `target-exists` means the project got where it was going, not that
      // anything is wrong. Only past the first attempt does that refusal get the
      // benefit of the doubt — nothing has moved yet the first time, so a refusal
      // there is real.
      if (i > 0 && res.error === 'target-exists') {
        warnings.push(t('projects.actions.move.siblingDone'))
        continue
      }
      // A real refusal, on the first member or not: stop rather than press on with
      // the rest. A half-moved project is worse than one left where it was.
      setBusy(false)
      setError(moveRefusalMessage(t, res.error, res.detail))
      return
    }
    setBusy(false)
    // `onMoved` can only carry one {sourceId, encodedDir}, and it has to be the
    // `project` prop's own — that's the row the list's selection is pointing at,
    // not whichever sibling happened to do the actual rename.
    const newEncodedDir = resolvedEncodedDir.get(sourceId) ?? encodedDir
    if (warnings.length) {
      // Reporting the partial failure has to happen BEFORE the reload, not with it:
      // `onChanged` re-reads the list, the row this popover is anchored to vanishes
      // under its new `encodedDir`, and the popover unmounts with the warnings still
      // in it. So the reload waits for the dismissal, which is also what makes the
      // dismissal explicit rather than a timer.
      setMoveWarnings(warnings)
      setMoved({ sourceId, encodedDir: newEncodedDir })
      return
    }
    onChanged()
    onMoved({ sourceId, encodedDir: newEncodedDir })
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

  const holds = plural(t, 'projects.actions.delete.holds', totalSessions)
  const deleteDisabledReason = totalSessions
    ? archivedCount
      ? t('projects.actions.delete.holdsWithArchived', { holds, archived: archivedCount })
      : holds
    : ''

  // Kept on screen rather than trusting the anchor: a row near the right edge or the
  // bottom of a tall window would otherwise open the panel half outside it. The move
  // panel is considerably taller than the delete confirmation, so it needs more
  // headroom reserved above the bottom edge.
  const panelHeight = panel === 'move' ? 400 : panel === 'delete' ? 260 : 220
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - panelHeight))

  return (
    <div className="proj-actions-menu" ref={ref} role="menu" style={{ top, left }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="proj-actions-item" role="menuitem" disabled={busy} onClick={doArchiveToggle}>
        {archived ? t('projects.actions.unarchive') : t('projects.actions.archive')}
      </button>
      <p className="help proj-actions-note">{t('projects.actions.archiveNote')}</p>

      <div className="proj-actions-sep" />

      <button
        type="button"
        className="proj-actions-item"
        role="menuitem"
        aria-expanded={panel === 'move'}
        disabled={busy}
        onClick={openMove}
      >
        {t('projects.actions.changeFolder')}
      </button>

      {panel === 'move' &&
        (moveWarnings ? (
          <div className="block warn proj-actions-panel">
            <p className="proj-actions-text">{t('projects.actions.move.warned')}</p>
            <ul className="proj-actions-warn-list">
              {moveWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <div className="proj-actions-buttons">
              <button type="button" className="btn-text" onClick={dismissWarnings}>
                {t('projects.actions.move.dismiss')}
              </button>
            </div>
          </div>
        ) : (
          <div className="proj-actions-panel">
            <p className="help">
              {withNodes(t('projects.actions.move.currentlyAt'), {
                path: <span className="proj-actions-path">{realPath}</span>
              })}
            </p>
            <div className="proj-actions-move-row">
              <input
                className="text-input mono"
                aria-label={t('projects.actions.move.newFolder')}
                autoFocus
                value={moveDraft}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => setMoveDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canMove) doMove()
                }}
              />
              <button type="button" className="btn-ghost small" onClick={browseFolder} disabled={busy}>
                {t('projects.actions.move.browse')}
              </button>
            </div>
            {members.length > 1 && (
              <p className="help">
                {t('projects.actions.move.multiple', { n: members.length })}
              </p>
            )}
            <p className="help">
              {t('projects.actions.move.browseNote')}
            </p>
            <div className="proj-actions-buttons">
              <button type="button" className="btn-ghost small" onClick={() => setPanel(null)} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn-primary small" disabled={busy || !canMove} onClick={doMove}>
                {t('projects.actions.move.submit')}
              </button>
            </div>
          </div>
        ))}

      <div className="proj-actions-sep" />

      {totalSessions > 0 ? (
        <div className="proj-actions-delete">
          <button type="button" className="btn-text danger" role="menuitem" disabled>
            {t('projects.actions.delete.menu')}
          </button>
          {/* A disabled control that does not say why is a dead end. */}
          <p className="help">{deleteDisabledReason}</p>
        </div>
      ) : panel === 'delete' ? (
        <div className="proj-actions-panel">
          <p className="proj-actions-text">
            {members.length > 1
              ? withNodes(t('projects.actions.delete.confirmMultiple', { n: members.length }), {
                  name: <b>{name}</b>
                })
              : withNodes(t('projects.actions.delete.confirmSingle'), {
                  name: <b>{name}</b>,
                  path: <span className="proj-actions-path">{realPath}</span>
                })}
          </p>
          <p className="help">
            {withNodes(
              members.length > 1 ? t('projects.actions.delete.noteMultiple') : t('projects.actions.delete.noteSingle'),
              { folder: <code>projects/</code> }
            )}
          </p>
          <div className="proj-actions-buttons">
            <button type="button" className="btn-ghost small" onClick={() => setPanel(null)} disabled={busy}>
              {t('projects.actions.delete.keep')}
            </button>
            <button type="button" className="btn-primary small danger" onClick={doDelete} disabled={busy}>
              {t('common.delete')}
            </button>
          </div>
        </div>
      ) : (
        <div className="proj-actions-delete">
          <button type="button" className="btn-text danger" role="menuitem" onClick={openDelete}>
            {t('projects.actions.delete.menu')}
          </button>
        </div>
      )}

      {error && <div className="proj-actions-error">{error}</div>}
    </div>
  )
}
