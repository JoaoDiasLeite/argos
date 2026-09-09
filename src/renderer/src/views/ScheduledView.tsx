import { useEffect, useRef, useState } from 'react'
import { CCAccountStatus, ModelInfo, ScheduledCadence, ScheduledRun } from '../types'
import ModelPicker from '../components/ModelPicker'
import { useModalA11y } from '../hooks/useModalA11y'
import './views.css'
import './ScheduledView.css'

interface Props {
  models: ModelInfo[]
  defaultModel: string
  accounts: CCAccountStatus[]
  defaultAccountId: string
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "read-only" — mutating tools blocked via disallowedTools at execution time. "full" — no restriction. */
type ToolPreset = 'read-only' | 'full'

function presetFromRun(run: ScheduledRun): ToolPreset {
  // Honour explicit toolAccess first; fall back to legacy allowedTools presence for old saved data.
  if (run.toolAccess === 'read-only') return 'read-only'
  if (run.toolAccess === 'full') return 'full'
  // Legacy: any allowedTools list was the old read-only preset
  if (Array.isArray(run.allowedTools)) return 'read-only'
  return 'full'
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function emptyRun(defaultModel: string, defaultAccountId: string): ScheduledRun {
  return {
    id: genId(),
    name: '',
    prompt: '',
    model: defaultModel,
    projectPath: undefined,
    accountId: defaultAccountId,
    cadence: { kind: 'interval', everyMinutes: 60 },
    enabled: false,
    createdAt: Date.now(),
    // Default new routines to read-only for safety
    toolAccess: 'read-only'
  }
}

function cadenceSummary(cadence: ScheduledCadence): string {
  if (cadence.kind === 'interval') {
    const mins = cadence.everyMinutes
    if (mins < 60) return `Every ${mins} min`
    const h = mins / 60
    return `Every ${h % 1 === 0 ? h : h.toFixed(1)} hour${h !== 1 ? 's' : ''}`
  }
  if (cadence.kind === 'daily') return `Daily at ${cadence.time}`
  if (cadence.kind === 'weekly') return `Weekly · ${DAY_NAMES[cadence.day]} at ${cadence.time}`
  return 'Unknown cadence'
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) {
    const future = -diff
    if (future < 60_000) return 'in a moment'
    if (future < 3_600_000) return `in ${Math.round(future / 60_000)} min`
    if (future < 86_400_000) return `in ${Math.round(future / 3_600_000)} h`
    return `in ${Math.round(future / 86_400_000)} d`
  }
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} d ago`
}

export default function ScheduledView({ models, defaultModel, accounts, defaultAccountId }: Props) {
  const [runs, setRuns] = useState<ScheduledRun[]>([])
  const [editing, setEditing] = useState<ScheduledRun | null>(null)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [runResult, setRunResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null)

  const load = async () => setRuns(await window.electronAPI.schedulerList())

  useEffect(() => {
    load()
    // Refresh every 30s to pick up nextRunAt / lastResult changes from the scheduler
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const toggleEnabled = async (run: ScheduledRun) => {
    const updated = await window.electronAPI.schedulerSetEnabled(run.id, !run.enabled)
    setRuns(updated)
  }

  const remove = async (id: string) => {
    setRuns(await window.electronAPI.schedulerDelete(id))
  }

  const runNow = async (run: ScheduledRun) => {
    setRunning((prev) => new Set(prev).add(run.id))
    setRunResult(null)
    try {
      const result = await window.electronAPI.schedulerRunNow(run.id)
      if (result) {
        setRunResult({
          id: run.id,
          ok: result.ok,
          msg: result.ok
            ? `Done · $${result.costUsd.toFixed(4)}`
            : `Failed: ${result.summary.slice(0, 120)}`
        })
      }
    } finally {
      setRunning((prev) => {
        const next = new Set(prev)
        next.delete(run.id)
        return next
      })
      load()
    }
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Routines</h1>
          <p className="view-sub">Scheduled prompts that run automatically on a cadence.</p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setEditing(emptyRun(defaultModel, defaultAccountId))}
        >
          + New routine
        </button>
      </div>

      <div className="view-scroll">
        {runs.length === 0 ? (
          <div className="view-empty">
            <div className="view-empty-icon">⏰</div>
            <div className="view-empty-msg">
              No routines yet. Create one to run a prompt automatically on a schedule.
            </div>
          </div>
        ) : (
          <div className="scheduled-list">
            {runs.map((run) => (
              <div key={run.id} className={`scheduled-card ${run.enabled ? 'enabled' : 'disabled'}`}>
                <div className="scheduled-card-main">
                  <div className="scheduled-card-top">
                    <span className="scheduled-card-name">{run.name}</span>
                    <span className="scheduled-cadence-badge">{cadenceSummary(run.cadence)}</span>
                    <span
                      className={`scheduled-access-badge ${presetFromRun(run) === 'full' ? 'full' : 'readonly'}`}
                      title={presetFromRun(run) === 'full'
                        ? 'Full access — can read, write, and run commands'
                        : 'Read-only — Bash, Write, Edit, and other mutating tools are blocked'}
                    >
                      {presetFromRun(run) === 'full' ? 'Full access' : 'Read-only'}
                    </span>
                    {run.lastResult && (
                      <span
                        className={`scheduled-status-dot ${run.lastResult.ok ? 'ok' : 'err'}`}
                        title={run.lastResult.ok ? 'Last run succeeded' : 'Last run failed'}
                      />
                    )}
                  </div>
                  <div className="scheduled-card-prompt">{run.prompt}</div>
                  <div className="scheduled-card-meta">
                    {run.lastResult && (
                      <span className={`scheduled-last-result ${run.lastResult.ok ? 'ok' : 'err'}`}>
                        {run.lastResult.ok ? 'OK' : 'ERR'} · ${run.lastResult.costUsd.toFixed(4)} ·{' '}
                        {relativeTime(run.lastResult.at)}
                      </span>
                    )}
                    {run.nextRunAt && run.enabled && (
                      <span className="scheduled-next-run">
                        Next: {relativeTime(run.nextRunAt)}
                      </span>
                    )}
                    {run.projectPath && (
                      <span className="scheduled-path" title={run.projectPath}>
                        {run.projectPath.split(/[\\/]/).filter(Boolean).pop()}
                      </span>
                    )}
                    {runResult?.id === run.id && (
                      <span className={`scheduled-run-result ${runResult.ok ? 'ok' : 'err'}`}>
                        {runResult.msg}
                      </span>
                    )}
                  </div>
                </div>
                <div className="scheduled-card-actions">
                  <button
                    className={`toggle-btn ${run.enabled ? 'on' : ''}`}
                    onClick={() => toggleEnabled(run)}
                    title={run.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                    <span className="toggle-label">{run.enabled ? 'On' : 'Off'}</span>
                  </button>
                  <button
                    className="btn-ghost small"
                    onClick={() => runNow(run)}
                    disabled={running.has(run.id)}
                    title="Run now"
                  >
                    {running.has(run.id) ? 'Running…' : 'Run now'}
                  </button>
                  <button className="btn-ghost small" onClick={() => setEditing(run)}>
                    Edit
                  </button>
                  <button className="btn-text danger" onClick={() => remove(run.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <RoutineEditor
          run={editing}
          setRun={setEditing}
          isExisting={!!runs.find((r) => r.id === editing.id)}
          models={models}
          accounts={accounts}
          onSave={async () => {
            await window.electronAPI.schedulerUpsert(editing)
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

interface EditorProps {
  run: ScheduledRun
  setRun: (run: ScheduledRun | null) => void
  isExisting: boolean
  models: ModelInfo[]
  accounts: CCAccountStatus[]
  onSave: () => void
}

function RoutineEditor({ run, setRun, isExisting, models, accounts, onSave }: EditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, () => setRun(null))

  const cadence = run.cadence
  const preset = presetFromRun(run)

  const setCadence = (c: ScheduledCadence) => setRun({ ...run, cadence: c })

  const setPreset = (p: ToolPreset) => {
    setRun({ ...run, toolAccess: p })
  }

  const pickFolder = async () => {
    const p = await window.electronAPI.openFolder()
    if (p) setRun({ ...run, projectPath: p })
  }

  const valid = run.name.trim().length > 0 && run.prompt.trim().length > 0

  return (
    <div className="modal-backdrop" onClick={() => setRun(null)}>
      <div
        className="modal wide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="routine-editor-title">{isExisting ? 'Edit routine' : 'New routine'}</h3>
          <button
            className="icon-btn"
            onClick={() => setRun(null)}
            aria-label="Close"
            title="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">

          {/* ── Autonomous execution warning ── */}
          <div className="routine-warning" role="note">
            <span className="routine-warning-icon" aria-hidden="true">⚠</span>
            <div className="routine-warning-text">
              <strong>Routines run autonomously with no approval prompts.</strong>{' '}
              Each run executes the prompt in the background, on a timer, without asking for
              confirmation. Use the access level below to limit what Claude can do.
            </div>
          </div>

          <div className="form-group">
            <label>Name</label>
            <input
              className="text-input"
              value={run.name}
              placeholder="e.g. Daily standup summary"
              onChange={(e) => setRun({ ...run, name: e.target.value })}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>Prompt</label>
            <textarea
              className="text-input textarea"
              rows={4}
              value={run.prompt}
              placeholder="What should Claude do each time this runs?"
              onChange={(e) => setRun({ ...run, prompt: e.target.value })}
            />
          </div>

          {/* ── Tool access level ── */}
          <div className="form-group">
            <label>Access level</label>
            <div className="preset-row">
              <button
                className={`preset-btn ${preset === 'read-only' ? 'active' : ''}`}
                onClick={() => setPreset('read-only')}
                type="button"
              >
                <span className="preset-btn-icon">🔍</span>
                <span className="preset-btn-body">
                  <span className="preset-btn-title">Read-only</span>
                  <span className="preset-btn-desc">Read, search, and web-fetch only. Cannot write files or run shell commands.</span>
                </span>
              </button>
              <button
                className={`preset-btn ${preset === 'full' ? 'active' : ''}`}
                onClick={() => setPreset('full')}
                type="button"
              >
                <span className="preset-btn-icon">⚡</span>
                <span className="preset-btn-body">
                  <span className="preset-btn-title">Full access</span>
                  <span className="preset-btn-desc">All tools including Bash, Write, and Edit. Use only when necessary.</span>
                </span>
              </button>
            </div>
          </div>

          <div className="agent-edit-row">
            <div className="form-group">
              <label>Model</label>
              <ModelPicker
                models={models}
                value={run.model ?? models[0]?.id ?? ''}
                onChange={(m) => setRun({ ...run, model: m })}
              />
            </div>
            <div className="form-group grow">
              <label>Account</label>
              <select
                className="text-input"
                value={run.accountId ?? ''}
                onChange={(e) => setRun({ ...run, accountId: e.target.value || undefined })}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.email ? ` (${a.email})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Project folder (optional)</label>
            <div className="folder-row">
              <span className="folder-path text-input mono" title={run.projectPath}>
                {run.projectPath ?? 'None (uses home dir)'}
              </span>
              <button className="btn-ghost small" onClick={pickFolder}>
                Browse…
              </button>
              {run.projectPath && (
                <button
                  className="btn-text"
                  onClick={() => setRun({ ...run, projectPath: undefined })}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="form-group">
            <label>Cadence</label>
            <label htmlFor="missed-run-policy">When the app was closed at the scheduled time</label>
            <select id="missed-run-policy" className="text-input" value={run.missedRunPolicy ?? 'skip'} onChange={(e) => setRun({ ...run, missedRunPolicy: e.target.value as 'skip' | 'run-once' })}>
              <option value="skip">Skip missed runs and wait for the next scheduled time</option>
              <option value="run-once">Run once when the app reopens</option>
            </select>
            <div className="cadence-row">
              <select
                className="text-input cadence-kind"
                value={cadence.kind}
                onChange={(e) => {
                  const kind = e.target.value as ScheduledCadence['kind']
                  if (kind === 'interval') setCadence({ kind: 'interval', everyMinutes: 60 })
                  else if (kind === 'daily') setCadence({ kind: 'daily', time: '09:00' })
                  else setCadence({ kind: 'weekly', day: 1, time: '09:00' })
                }}
              >
                <option value="interval">Interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>

              {cadence.kind === 'interval' && (
                <div className="cadence-field-row">
                  <input
                    type="number"
                    className="text-input cadence-num"
                    min={1}
                    max={10080}
                    value={cadence.everyMinutes}
                    onChange={(e) =>
                      setCadence({ kind: 'interval', everyMinutes: Math.max(1, parseInt(e.target.value, 10) || 60) })
                    }
                  />
                  <span className="cadence-unit">minutes</span>
                </div>
              )}

              {cadence.kind === 'daily' && (
                <div className="cadence-field-row">
                  <input
                    type="time"
                    className="text-input cadence-time"
                    value={cadence.time}
                    onChange={(e) => setCadence({ kind: 'daily', time: e.target.value })}
                  />
                </div>
              )}

              {cadence.kind === 'weekly' && (
                <div className="cadence-field-row">
                  <select
                    className="text-input cadence-day"
                    value={cadence.day}
                    onChange={(e) =>
                      setCadence({ ...cadence, kind: 'weekly', day: parseInt(e.target.value, 10) })
                    }
                  >
                    {DAY_NAMES.map((d, i) => (
                      <option key={i} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    className="text-input cadence-time"
                    value={cadence.time}
                    onChange={(e) =>
                      setCadence({ ...cadence, kind: 'weekly', time: e.target.value })
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={() => setRun(null)}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSave} disabled={!valid}>
            Save routine
          </button>
        </div>
      </div>
    </div>
  )
}
