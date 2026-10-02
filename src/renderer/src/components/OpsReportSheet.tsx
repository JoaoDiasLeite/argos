import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useOpsEvents } from '../hooks/useOpsEvents'
import { displayArgv } from '../lib/ops-approval'
import { foldOpsEvents, rowLabel, rowTone, runCounts, touchedHosts, type OpsRow, type OpsRun } from '../lib/ops-timeline'
import Markdown from './Markdown'
import Sheet from './Sheet'
import './OpsReportSheet.css'

interface Props {
  runId: string
  /** The run's ops session (its terminal id). Without it the sheet shows only the
   *  rendered report, not the tiles, plan and calls read from the ledger. */
  appSessionId?: string
  /** The runbook folder; without it the client report shows hosts as [servidor] and
   *  "Save beside runbook" is unavailable. */
  runbookPath?: string
  onClose: () => void
}

type Kind = 'internal' | 'client'
type Verified = { ok: true } | { ok: false; brokenAt?: number; reason: string } | null

const clock = (iso?: string, seconds = false): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
}

const day = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** finished / stopped / failed / running, as the context line says it. */
export function runOutcome(run: OpsRun): string {
  if (!run.ended) return 'running'
  if (run.ended.aborted) return 'stopped'
  return run.ended.ok ? 'finished' : 'failed'
}

/** The host the run was about: the locked host, the hosts an open run reached, or every host. */
function hostLine(run: OpsRun): string {
  if (run.scope?.kind === 'host') return run.hostNames?.[run.scope.hostId] ?? run.hosts[0] ?? ''
  if (run.scope?.kind === 'open') {
    const touched = touchedHosts(run)
    return touched.length ? touched.join(', ') : 'any server this runbook allows'
  }
  return run.hosts.join(', ')
}

const callText = (c: OpsRow): string =>
  c.argv && c.argv.length ? displayArgv(c.argv) : c.path ? `${c.tool || 'read'} ${c.path}` : c.tool || c.callId

/** A call's result, coloured: exit 0 green, a non-zero exit amber, a refusal red. */
function resultOf(c: OpsRow): { text: string; tone: string } {
  if (c.status === 'done') return { text: 'exit 0', tone: 'ok' }
  return { text: rowLabel(c) || c.status, tone: rowTone(c) }
}

/**
 * The run report as a document (docs/INTERVENTIONS_PLAN.md §4, board E2): a sheet from the
 * right over the terminal, Internal / Client toggle, Copy, and a save that writes a new
 * file beside the runbook. The internal view leads with what the ledger says (tiles, plan,
 * calls), the full rendered report one toggle below; the client view is that report's
 * client rendering as it would be sent. Nothing here is sent anywhere.
 */
export default function OpsReportSheet({ runId, appSessionId, runbookPath, onClose }: Props) {
  const [kind, setKind] = useState<Kind>('internal')
  const [loading, setLoading] = useState(true)
  const [markdown, setMarkdown] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ ok: true; path: string } | { ok: false; error: string } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [verified, setVerified] = useState<Verified>(null)

  const { events } = useOpsEvents(appSessionId)
  const run = useMemo(() => foldOpsEvents(events).find((r) => r.runId === runId), [events, runId])
  const ledgerDay = run?.startedAt.slice(0, 10)

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
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [runId, kind, runbookPath])

  useEffect(() => {
    if (!ledgerDay) return
    let cancelled = false
    window.electronAPI
      .opsVerify(ledgerDay)
      .then((v) => !cancelled && setVerified(v.ok ? { ok: true } : v))
      .catch(() => !cancelled && setVerified(null))
    return () => {
      cancelled = true
    }
  }, [ledgerDay])

  const copy = () => {
    if (!markdown) return
    navigator.clipboard
      .writeText(markdown)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => setError(String(e)))
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

  const rendered = loading ? (
    <p className="ops-rs-note">Loading report…</p>
  ) : error ? (
    <p className="ops-rs-error" role="alert">
      {error}
    </p>
  ) : (
    <Markdown content={markdown} />
  )

  const headerExtra = (
    <>
      <div className="ops-rs-toggle" role="group" aria-label="Report kind">
        {(['internal', 'client'] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === 'internal' ? 'Internal' : 'Client'}
          </button>
        ))}
      </div>
      <button type="button" className="ops-rs-btn" onClick={copy} disabled={loading || !markdown}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        className="ops-rs-btn primary"
        onClick={save}
        disabled={!runbookPath || loading || !markdown || saving}
        title={runbookPath ? `Writes a new file under ${runbookPath}/reports` : 'The runbook folder of this run is not known'}
      >
        {saving ? 'Saving…' : 'Save beside runbook'}
      </button>
    </>
  )

  return (
    <Sheet title="Run report" width={720} onClose={onClose} headerExtra={headerExtra}>
      <div className="ops-rs-body">
        {(saved || warnings.length > 0) && (
          <div className="ops-rs-notices">
            {saved && (
              <p className={`ops-rs-saved${saved.ok ? '' : ' error'}`} role="status">
                {saved.ok ? `Saved to ${saved.path}` : saved.error}
              </p>
            )}
            {warnings.length > 0 && (
              <ul className="ops-rs-warnings" aria-label="Warnings">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {run && (
          <div className="ops-rs-titles">
            <h2 className="ops-rs-title">{run.runbook || 'Run'}</h2>
            <div className="ops-rs-context">
              {[
                hostLine(run),
                `${day(run.startedAt)}, ${clock(run.startedAt)}${run.endedAt ? ` to ${clock(run.endedAt)}` : ''}`,
                'Claude Code',
                runOutcome(run)
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {(run.task || run.ticket || run.client) && (
              <div className="ops-rs-task">{[run.task, run.ticket, run.client].filter(Boolean).join(' · ')}</div>
            )}
          </div>
        )}

        {kind === 'client' || !run ? (
          <div className="ops-rs-md">{rendered}</div>
        ) : (
          <InternalBody run={run} showAll={showAll} onToggleAll={() => setShowAll((v) => !v)} rendered={rendered} />
        )}

        {run && (
          <div className="ops-rs-foot">
            Audit log <code>{ledgerDay}.jsonl</code> · run <code>{run.runId.slice(0, 8)}</code>
            {run.policySha256 && (
              <>
                {' '}
                · policy <code>{run.policySha256.slice(0, 8)}</code>
              </>
            )}
            {verified?.ok && ' · chain verified'}
            {verified && !verified.ok && (
              <span className="ops-rs-broken" title={verified.reason}>
                {' '}
                · chain broken{verified.brokenAt != null ? ` at line ${verified.brokenAt}` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}

function InternalBody({
  run,
  showAll,
  onToggleAll,
  rendered
}: {
  run: OpsRun
  showAll: boolean
  onToggleAll: () => void
  rendered: ReactNode
}) {
  const counts = runCounts(run)
  const steps = run.planSteps ?? []
  const askedCmds = new Set(run.calls.filter((c) => c.asked).map(callText))

  return (
    <>
      <div className="ops-rs-tiles">
        <div className="ops-rs-tile">
          <span className="ops-rs-n">{counts.calls}</span>
          <span>calls</span>
        </div>
        <div className="ops-rs-tile">
          <span className="ops-rs-n ok">{counts.ran}</span>
          <span>ran</span>
        </div>
        <div className="ops-rs-tile">
          <span className="ops-rs-n warn">{counts.asked}</span>
          <span>asked you</span>
        </div>
        <div className="ops-rs-tile">
          <span className="ops-rs-n bad">{counts.notAllowed}</span>
          <span>not allowed</span>
        </div>
      </div>

      {steps.length > 0 && (
        <section className="ops-rs-section">
          <h3 className="ops-rs-eyebrow">Plan</h3>
          <ol className="ops-rs-plan">
            {steps.map((s, i) => {
              const asked = s.commands.some((c) => askedCmds.has(c))
              return (
                <li key={i} className={s.skipped ? 'skipped' : undefined}>
                  <span className="ops-rs-step">{s.title}</span>
                  {s.commands.length > 0 && <span className="ops-rs-muted ops-rs-step"> · {s.commands.join(', ')}</span>}
                  {s.skipped ? (
                    <span className="ops-rs-muted"> · skipped</span>
                  ) : asked ? (
                    <span className="ops-rs-warn"> · asked</span>
                  ) : s.verdict === 'asks' ? (
                    <span className="ops-rs-warn"> · asks</span>
                  ) : s.verdict === 'denied' ? (
                    <span className="ops-rs-bad"> · not allowed</span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <section className="ops-rs-section">
        <h3 className="ops-rs-eyebrow">Calls</h3>
        {run.calls.length === 0 ? (
          <p className="ops-rs-muted">No calls in this run.</p>
        ) : (
          <div className="ops-rs-calls">
            {run.calls.map((c) => {
              const r = resultOf(c)
              const refused = c.status === 'denied' || c.status === 'stopped'
              return (
                <div key={c.callId} className="ops-rs-call">
                  <span className="ops-rs-muted">{clock(c.at, true)}</span>
                  <span className={`ops-rs-cmd${refused ? ' refused' : ''}`}>
                    {callText(c)}
                    {c.asked && c.answer === 'allow' && <span className="ops-rs-allowed"> · you allowed</span>}
                  </span>
                  <span className={`ops-rs-result ${r.tone}`}>{r.text}</span>
                </div>
              )
            })}
          </div>
        )}
        <button type="button" className="ops-rs-link" aria-expanded={showAll} onClick={onToggleAll}>
          {showAll ? 'Hide the output of every call' : 'Show output of every call'}
        </button>
      </section>

      {showAll && <div className="ops-rs-md">{rendered}</div>}
    </>
  )
}
