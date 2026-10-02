import { useEffect, useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import Markdown from './Markdown'
import './OpsReportModal.css'

interface Props {
  runId: string
  /** The runbook folder; without it the client report shows hosts as [servidor] and
   *  "Save beside runbook" is unavailable. */
  runbookPath?: string
  onClose: () => void
}

type Kind = 'internal' | 'client'

/**
 * The run report (docs/OPS_AGENT_PLAN.md §5, §5.1, §8): Internal / Client toggle over the
 * ledger's rendering, a copy button, and a save that writes a new file beside the runbook.
 * Nothing here is sent anywhere.
 */
export default function OpsReportModal({ runId, runbookPath, onClose }: Props) {
  const [kind, setKind] = useState<Kind>('internal')
  const [loading, setLoading] = useState(true)
  const [markdown, setMarkdown] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ ok: true; path: string } | { ok: false; error: string } | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setSaved(null)
    window.electronAPI
      .opsReport(runId, kind, runbookPath)
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setMarkdown(r.markdown)
          setWarnings(r.warnings)
        } else {
          setMarkdown('')
          setWarnings([])
          setError(r.error)
        }
      })
      .catch((e) => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [runId, kind, runbookPath])

  const copy = () => {
    if (!markdown) return
    navigator.clipboard.writeText(markdown).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch((e) => setError(String(e)))
  }

  const save = async () => {
    if (!runbookPath) return
    setSaving(true)
    try {
      setSaved(await window.electronAPI.opsSaveReport(runId, kind, runbookPath))
    } catch (e) {
      setSaved({ ok: false, error: String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal ops-rp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-rp-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="ops-rp-title">Run report</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="ops-rp-bar">
          <div className="ops-rp-toggle" role="group" aria-label="Report kind">
            <button className={kind === 'internal' ? 'active' : ''} aria-pressed={kind === 'internal'} onClick={() => setKind('internal')}>
              Internal
            </button>
            <button className={kind === 'client' ? 'active' : ''} aria-pressed={kind === 'client'} onClick={() => setKind('client')}>
              Client
            </button>
          </div>
          <div className="ops-rp-actions">
            <button className="btn-ghost small" onClick={copy} disabled={loading || !markdown}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button
              className="btn-primary small"
              onClick={save}
              disabled={!runbookPath || loading || !markdown || saving}
              title={runbookPath ? `Writes a new file under ${runbookPath}/reports` : 'This chat has no runbook folder'}
            >
              {saving ? 'Saving…' : 'Save beside runbook'}
            </button>
          </div>
        </div>

        {saved && (
          <p className={`ops-rp-saved${saved.ok ? '' : ' error'}`} role="status">
            {saved.ok ? `Saved to ${saved.path}` : saved.error}
          </p>
        )}
        {warnings.length > 0 && (
          <ul className="ops-rp-warnings" aria-label="Warnings">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        <div className="ops-rp-body">
          {loading ? (
            <p className="ops-rp-note">Loading report…</p>
          ) : error ? (
            <p className="ops-rp-error" role="alert">{error}</p>
          ) : (
            <Markdown content={markdown} />
          )}
        </div>
      </div>
    </div>
  )
}
