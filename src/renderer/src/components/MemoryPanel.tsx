import { useEffect, useState } from 'react'
import { MemoryGap, MemoryLayer, MemoryReport } from '../types'
import './MemoryPanel.css'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Score band, purely for the ring's colour — the number itself is the real report. */
function bandOf(score: number): 'good' | 'mid' | 'low' {
  if (score >= 75) return 'good'
  if (score >= 45) return 'mid'
  return 'low'
}

/** Small ring scoped to this panel — PlannerView's ScoreRing lives in a view and stays there. */
function MemScoreRing({ score }: { score: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const offset = c * (1 - score / 100)
  return (
    <div className={`mem-ring mem-ring-${bandOf(score)}`}>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} className="mem-ring-track" strokeWidth="6" fill="none" />
        <circle
          cx="32"
          cy="32"
          r={r}
          className="mem-ring-fill"
          strokeWidth="6"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span className="mem-ring-num">{score}</span>
    </div>
  )
}

function LayerRow({ layer }: { layer: MemoryLayer }) {
  return (
    // `mem-` on the state class too: a bare `.absent` is a global selector any other
    // stylesheet could define, which is the collision convention 6 exists to stop.
    <div className={`mem-layer ${layer.exists ? 'mem-present' : 'mem-absent'}`}>
      <div className="mem-layer-head">
        <span className="mem-layer-label">{layer.label}</span>
        <span className="mem-layer-state">{layer.exists ? 'present' : 'not found'}</span>
      </div>
      <div className="mem-layer-path" title={layer.path}>
        {layer.path}
      </div>
      {layer.exists && (
        <div className="mem-layer-meta">
          {formatBytes(layer.bytes)}
          {layer.files !== undefined && ` · ${layer.files} file${layer.files === 1 ? '' : 's'}`}
        </div>
      )}
    </div>
  )
}

function GapRow({ gap }: { gap: MemoryGap }) {
  return (
    <li className={`mem-gap mem-gap-${gap.severity}`}>
      <span className="mem-gap-badge">{gap.severity === 'warn' ? 'warn' : 'info'}</span>
      <span className="mem-gap-msg">{gap.message}</span>
    </li>
  )
}

/**
 * Read-only report on what Claude Code's memory holds for a project. There is no
 * write path here by design — every gap names the file to go fix, and that fix is
 * always the user's edit to make, never a button in this panel.
 */
export default function MemoryPanel({ projectPath }: { projectPath?: string }) {
  const [report, setReport] = useState<MemoryReport | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    window.electronAPI
      .memoryDiagnose(projectPath)
      .then(setReport)
      // The diagnostic is built never to throw, but it reaches here across IPC — and a
      // panel that reports on health should not be the thing that dies silently.
      .catch(() => setReport(null))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [projectPath])

  const warns = report?.gaps.filter((g) => g.severity === 'warn') ?? []
  const infos = report?.gaps.filter((g) => g.severity === 'info') ?? []

  return (
    <div className="mem-panel">
      <div className="mem-panel-head">
        <h2 className="mem-panel-title">Memory</h2>
        <button className="btn-ghost small" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && !report ? (
        <div className="mem-loading">Reading memory layers…</div>
      ) : !report ? (
        <div className="mem-loading">Could not read the memory layers.</div>
      ) : (
        <>
          <div className="mem-score-row">
            <MemScoreRing score={report.score} />
            <div className="mem-score-note">
              {/* A young project living entirely on absence still deserves to read as fine,
                  not as a project failing an inspection. */}
              {warns.length === 0
                ? 'No broken memory found.'
                : `${warns.length} thing${warns.length === 1 ? '' : 's'} to fix.`}
            </div>
          </div>

          <div className="mem-layers">
            {report.layers.map((l) => (
              <LayerRow key={l.id} layer={l} />
            ))}
          </div>

          {!projectPath && (
            <p className="mem-note">No project chosen — this covers the global layer only.</p>
          )}

          <div className="mem-gaps-section">
            {report.gaps.length === 0 ? (
              <p className="mem-empty">All clear — every layer is present and consistent.</p>
            ) : (
              <ul className="mem-gaps">
                {warns.map((g, i) => (
                  <GapRow key={`w${i}`} gap={g} />
                ))}
                {infos.map((g, i) => (
                  <GapRow key={`i${i}`} gap={g} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
