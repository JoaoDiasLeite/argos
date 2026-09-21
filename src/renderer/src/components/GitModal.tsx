import { useEffect, useRef, useState, useCallback } from 'react'
import { GitStatus, GitFile, RepoAttribution } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import './GitModal.css'

interface Props {
  cwd: string
  /**
   * The chat this panel was opened from. With it, the changes are grouped by which chat
   * wrote them; without it (opened from somewhere that has no chat) the list stays flat,
   * exactly as it always was.
   */
  sessionId?: string
  onClose: () => void
}

function UnifiedDiff({ text }: { text: string }) {
  if (!text.trim()) return <div className="git-diff-empty">No diff.</div>
  return (
    <div className="git-diff">
      {text.split('\n').map((line, i) => {
        let cls = 'ctx'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del'
        else if (line.startsWith('@@')) cls = 'hunk'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'meta'
        return (
          <div key={i} className={`git-diff-line ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function statusLabel(f: GitFile): string {
  if (f.untracked) return 'U'
  const c = f.staged ? f.index : f.worktree
  return c === ' ' ? f.index : c
}

/** Who wrote a file, as far as the ledger knows. */
type Owner = { kind: 'mine' } | { kind: 'other'; name: string } | { kind: 'unattributed' }

export default function GitModal({ cwd, sessionId, onClose }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [attr, setAttr] = useState<RepoAttribution | null>(null)
  const [selected, setSelected] = useState<GitFile | null>(null)
  const [diff, setDiff] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  const refresh = useCallback(async () => {
    const s = await window.electronAPI.gitStatus(cwd)
    setStatus(s)
    // Attribution comes from the same tree the status did, so it is asked for together
    // with it — and only when this panel belongs to a chat, since with no chat to be
    // "this chat" the three groups have nothing to say.
    if (sessionId) {
      try {
        setAttr(await window.electronAPI.authorshipForRepo(cwd, sessionId))
      } catch {
        // A ledger that cannot be read leaves the list flat rather than empty.
        setAttr(null)
      }
    }
    return s
  }, [cwd, sessionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openFile = async (f: GitFile) => {
    setSelected(f)
    setDiff(await window.electronAPI.gitDiff(cwd, f.path, f.staged))
  }

  const stage = async (f: GitFile) => {
    setBusy(true)
    await window.electronAPI.gitStage(cwd, f.path)
    await refresh()
    setBusy(false)
  }
  const unstage = async (f: GitFile) => {
    setBusy(true)
    await window.electronAPI.gitUnstage(cwd, f.path)
    await refresh()
    setBusy(false)
  }
  const stageAll = async () => {
    setBusy(true)
    await window.electronAPI.gitStageAll(cwd)
    await refresh()
    setBusy(false)
  }
  const stageGroup = async (files: GitFile[]) => {
    setBusy(true)
    for (const f of files) await window.electronAPI.gitStage(cwd, f.path)
    await refresh()
    setBusy(false)
  }
  const doCommit = async () => {
    setBusy(true)
    const res = await window.electronAPI.gitCommit(cwd, message)
    setBusy(false)
    setNotice(res.ok ? 'Committed.' : `Commit failed: ${res.message}`)
    if (res.ok) {
      setMessage('')
      setSelected(null)
      setDiff('')
      await refresh()
    }
    setTimeout(() => setNotice(''), 4000)
  }

  const staged = status?.files.filter((f) => f.staged) ?? []
  const unstaged = status?.files.filter((f) => !f.staged) ?? []

  const grouped = !!(sessionId && attr?.isRepo)
  const ownerOf = (p: string): Owner => {
    if (!grouped || !attr) return { kind: 'unattributed' }
    if (attr.mine.includes(p)) return { kind: 'mine' }
    const other = attr.others.find((o) => o.path === p)
    return other ? { kind: 'other', name: other.name } : { kind: 'unattributed' }
  }
  const byOwner = (files: GitFile[], kind: Owner['kind']) =>
    files.filter((f) => ownerOf(f.path).kind === kind)

  const fileRow = (f: GitFile, staging: boolean) => {
    const owner = ownerOf(f.path)
    return (
      <div
        key={(staging ? 's' : 'u') + f.path}
        className={`git-file ${selected?.path === f.path && selected?.staged === staging ? 'active' : ''}`}
        onClick={() => openFile({ ...f, staged: staging })}
      >
        <span className={`git-stat ${statusLabel(f)}`}>{statusLabel(f)}</span>
        <span className="git-file-name">{f.path}</span>
        {owner.kind === 'other' && (
          <span className="git-owner" title={`Written by ${owner.name}`}>
            {owner.name}
          </span>
        )}
        <button
          className="git-mini"
          onClick={(e) => {
            e.stopPropagation()
            if (staging) unstage(f)
            else stage(f)
          }}
          disabled={busy}
          title={staging ? 'Unstage' : 'Stage'}
        >
          {staging ? '−' : '+'}
        </button>
      </div>
    )
  }

  /** One of the three authorship groups, hidden entirely when it holds nothing. */
  const group = (label: string, files: GitFile[], hint?: string) => {
    if (!files.length) return null
    return (
      <div key={label}>
        <div className="git-section-head git-sub-head">
          <span title={hint}>
            {label} ({files.length})
          </span>
          <button className="btn-text" onClick={() => stageGroup(files)} disabled={busy}>
            Stage
          </button>
        </div>
        {files.map((f) => fileRow(f, false))}
      </div>
    )
  }

  const foreign = grouped ? byOwner(unstaged, 'other').length + byOwner(staged, 'other').length : 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal git-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-modal-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="git-modal-title">
            Git
            {status?.isRepo && <span className="git-branch">{status.branch}</span>}
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="git-ab">↑{status.ahead} ↓{status.behind}</span>
            )}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Said plainly, and in the header: reviewing a diff as if one chat wrote it when
            two did is the mistake this grouping exists to prevent. */}
        {foreign > 0 && (
          <div className="git-attr-note">
            {foreign} {foreign === 1 ? 'file here was' : 'files here were'} written by another
            chat.
          </div>
        )}

        {!status?.isRepo ? (
          <div className="git-empty">Not a git repository{cwd ? `: ${cwd}` : ' (open a project folder)'}.</div>
        ) : (
          <div className="git-body">
            <div className="git-files">
              <div className="git-section-head">
                <span>Staged ({staged.length})</span>
              </div>
              {staged.map((f) => fileRow(f, true))}

              <div className="git-section-head">
                <span>Changes ({unstaged.length})</span>
                {unstaged.length > 0 && <button className="btn-text" onClick={stageAll} disabled={busy}>Stage all</button>}
              </div>
              {grouped ? (
                <>
                  {group('This chat', byOwner(unstaged, 'mine'), 'Edited by the chat this panel was opened from')}
                  {group('Other chats', byOwner(unstaged, 'other'), 'Edited by another chat in Argos')}
                  {group(
                    'Unattributed',
                    byOwner(unstaged, 'unattributed'),
                    'A hand edit, another tool, a rebase, or a chat from before Argos kept this record'
                  )}
                </>
              ) : (
                unstaged.map((f) => fileRow(f, false))
              )}

              {status.files.length === 0 && <div className="git-clean">Working tree clean</div>}
            </div>

            <div className="git-detail">
              {selected ? (
                <UnifiedDiff text={diff} />
              ) : (
                <div className="git-diff-empty">Select a file to see its diff.</div>
              )}
            </div>
          </div>
        )}

        {status?.isRepo && (
          <div className="git-commit">
            {notice && <div className="git-notice">{notice}</div>}
            <textarea
              className="text-input"
              rows={2}
              placeholder="Commit message…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="btn-primary" onClick={doCommit} disabled={busy || !message.trim() || staged.length === 0}>
              Commit {staged.length > 0 ? `(${staged.length})` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
