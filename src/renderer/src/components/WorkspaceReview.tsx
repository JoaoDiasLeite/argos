import { useEffect, useRef, useState } from 'react'
import { CheckpointMeta, GitStatus, RestorePreview, Session } from '../types'
import './WorkspaceReview.css'

interface Props {
  session: Session
  streaming: boolean
  onGit: () => void
  onCheckpoints: () => void
}

// Small local formatter — the panel only ever needs coarse buckets, not a full i18n date lib.
function relTime(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export default function WorkspaceReview({ session, streaming, onGit, onCheckpoints }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  // The panel is reused across sessions, so an in-flight preview has to be able to ask
  // which session it was started for — by the time it resolves, `session` may be another one.
  const sessionRef = useRef(session.id)
  sessionRef.current = session.id
  const remote = !!(session.remoteHostId || session.wslDistro)
  const cwd = session.worktreePath || session.projectPath
  useEffect(() => {
    let cancelled = false
    setStatus(null); setSelected(null); setError(''); setCheckpoints([])
    setPreview(null); setPreviewError('')
    if (remote) return
    Promise.all([
      cwd ? window.electronAPI.gitStatus(cwd) : Promise.resolve(null),
      window.electronAPI.checkpointList(session.id)
    ]).then(([git, cps]) => { if (!cancelled) { setStatus(git); setCheckpoints(cps) } })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [session.id, cwd, remote, streaming, refresh])
  const previewRestore = () => {
    const latest = checkpoints[0]
    if (!latest) return
    setPreviewLoading(true); setPreviewError(''); setPreview(null)
    const startedFor = session.id
    const current = () => sessionRef.current === startedFor
    window.electronAPI.checkpointPreview(session.id, latest.id)
      .then((p) => { if (current()) setPreview(p) })
      .catch((e) => { if (current()) setPreviewError(String(e)) })
      .finally(() => { if (current()) setPreviewLoading(false) })
  }
  useEffect(() => {
    let cancelled = false
    setDiff('')
    if (!selected || !cwd || remote) { setLoading(false); return }
    setLoading(true)
    window.electronAPI.gitDiff(cwd, selected.path, selected.staged).then((text) => {
      if (!cancelled) setDiff(text)
    }).catch((e) => { if (!cancelled) setError(String(e)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selected, cwd, remote])
  const allChecks = session.messages.flatMap((m) => m.toolCalls ?? []).filter((t) => /bash|shell|command/i.test(t.tool))
  // A check only counts as "running" while the run itself is still streaming — once it stops,
  // an unresolved result means the run was interrupted, not that the command is still live.
  const runningChecks = streaming ? allChecks.filter((t) => t.result === undefined) : []
  const recentChecks = allChecks.filter((t) => t.result !== undefined || !streaming).slice(-5)
  return <section className="workspace-review" aria-label="Changes, checks and recovery">
    <div className="wr-heading"><strong>Review</strong><button className="btn-ghost small" onClick={() => setRefresh((n) => n + 1)}>Refresh</button></div>
    {error && <p role="alert" className="wr-error">{error}</p>}
    <h4>Working tree {status?.branch && <span>· {status.branch}</span>}</h4>
    {remote ? <p className="wr-note">Remote file review and checkpoints are unavailable here. Review files in the remote workspace.</p>
      : !status?.isRepo ? <p className="wr-note">Choose a local Git project to review changes.</p>
      : <><p className="wr-note">All uncommitted project changes, including existing edits.</p>
        {status.files.length === 0 && <p className="wr-note">Working tree is clean.</p>}
        {status.files.map((f) => <button className={`wr-file${selected?.path === f.path ? ' selected' : ''}`} key={f.path} onClick={() => setSelected({ path: f.path, staged: false })}>
          <span>{f.path}</span><span>{f.untracked ? 'New' : f.staged ? 'Staged' : 'Modified'}</span>
        </button>)}
        {selected && <div className="wr-diff-block"><div className="wr-heading"><span>{selected.path}</span><button className="btn-ghost small" onClick={() => setSelected({ ...selected, staged: !selected.staged })}>{selected.staged ? 'Show unstaged' : 'Show staged'}</button></div>
          <pre className="wr-diff">{loading ? 'Loading diff…' : diff || 'No changes on this side.'}</pre></div>}
        <button className="btn-secondary" onClick={onGit}>Stage & commit…</button>
      </>}
    <h4>Commands & checks</h4>
    {allChecks.length === 0 && <p className="wr-note">No command results recorded for this session.</p>}
    {runningChecks.length > 0 && <div className="wr-running">
      <div className="wr-running-title">Running now</div>
      {runningChecks.map((t) => <div className="wr-running-item" key={t.id}>
        <span className="wr-pulse" aria-hidden="true" />{String((t.input as Record<string, unknown>)?.command || t.tool)}
      </div>)}
    </div>}
    {recentChecks.length > 0 && <><div className="wr-subhead">Recent checks</div>
      {recentChecks.map((t) => <details className="wr-command" key={t.id}><summary>{String((t.input as Record<string, unknown>)?.command || t.tool)}<span>{t.isError ? 'Failed' : t.result !== undefined ? 'Completed' : 'No result'}</span></summary><pre>{t.result || 'No output recorded.'}</pre></details>)}
    </>}
    <h4>Recovery</h4>
    <p className="wr-note">{streaming ? 'Run in progress' : session.runState === 'interrupted' ? 'Previous run was interrupted' : 'Run is idle'} · partial transcripts save every 1.5 seconds.</p>
    {!remote && (checkpoints.length === 0 ? <p className="wr-note">No restore points yet.</p> : <>
      <p className="wr-note">Latest: {checkpoints[0].label} · {relTime(checkpoints[0].createdAt)} · {checkpoints[0].fileCount} file{checkpoints[0].fileCount !== 1 ? 's' : ''}</p>
      <button className="btn-ghost small" onClick={previewRestore} disabled={streaming || previewLoading}>{previewLoading ? 'Loading preview…' : 'Preview restore'}</button>
      {previewError && <p role="alert" className="wr-error">{previewError}</p>}
      {preview && (() => {
        const actionable = preview.files.filter((f) => f.action === 'write' || f.action === 'delete')
        const errored = preview.files.filter((f) => f.error)
        const counts = preview.files.reduce<Record<string, number>>((acc, f) => { acc[f.action] = (acc[f.action] || 0) + 1; return acc }, {})
        const actions = Object.entries(counts)
        return <div className="wr-restore-preview">
          <p className="wr-note">{actionable.length} file{actionable.length !== 1 ? 's' : ''} would be restored{actions.length > 1 ? ` (${actions.map(([a, n]) => `${n} ${a}`).join(', ')})` : ''}</p>
          {errored.length > 0 && <p role="alert" className="wr-error">{errored.map((f) => `${f.path}: ${f.error}`).join('; ')}</p>}
          <p className="wr-note">Check for newer edits before applying.</p>
        </div>
      })()}
      <button className="btn-secondary" onClick={onCheckpoints} disabled={streaming}>Timeline & restore…</button>
    </>)}
  </section>
}
