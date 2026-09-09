import { useEffect, useState } from 'react'
import { CheckpointMeta, GitStatus, Session } from '../types'
import './WorkspaceReview.css'

interface Props {
  session: Session
  streaming: boolean
  onGit: () => void
  onCheckpoints: () => void
}

export default function WorkspaceReview({ session, streaming, onGit, onCheckpoints }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const remote = !!(session.remoteHostId || session.wslDistro)
  const cwd = session.worktreePath || session.projectPath
  useEffect(() => {
    let cancelled = false
    setStatus(null); setSelected(null); setError(''); setCheckpoints([])
    if (remote) return
    Promise.all([
      cwd ? window.electronAPI.gitStatus(cwd) : Promise.resolve(null),
      window.electronAPI.checkpointList(session.id)
    ]).then(([git, cps]) => { if (!cancelled) { setStatus(git); setCheckpoints(cps) } })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [session.id, cwd, remote, streaming, refresh])
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
  const commands = session.messages.flatMap((m) => m.toolCalls ?? []).filter((t) => /bash|shell|command/i.test(t.tool)).slice(-5)
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
    <h4>Recent commands & checks</h4>
    {commands.length === 0 && <p className="wr-note">No command results recorded for this session.</p>}
    {commands.map((t) => <details className="wr-command" key={t.id}><summary>{String((t.input as Record<string, unknown>)?.command || t.tool)}<span>{t.isError ? 'Failed' : t.result !== undefined ? 'Completed' : streaming ? 'In progress' : 'No result'}</span></summary><pre>{t.result || 'No output recorded.'}</pre></details>)}
    <h4>Recovery</h4>
    <p className="wr-note">{streaming ? 'Run in progress' : session.runState === 'interrupted' ? 'Previous run was interrupted' : 'Run is idle'} · partial transcripts save every 1.5 seconds.</p>
    {!remote && <><p className="wr-note">{checkpoints.length ? `Latest: ${checkpoints[0].label}` : 'No restore points yet.'}</p><button className="btn-secondary" onClick={onCheckpoints} disabled={streaming}>Timeline & restore preview…</button></>}
  </section>
}
