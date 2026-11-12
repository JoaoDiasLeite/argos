import { useEffect, useMemo, useState } from 'react'
import { useOpsEvents } from '../hooks/useOpsEvents'
import type { TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import { foldOpsEvents, touchedHosts, type OpsRun } from '../lib/ops-timeline'
import Markdown from './Markdown'
import Sheet from './Sheet'
import type { OpsReportKind } from '../types'
import './OpsReportSheet.css'

interface Props {
  runId: string
  /** The run's ops session (its terminal id). Without it the sheet shows only the
   *  rendered report, not the tiles, plan and calls read from the ledger. */
  appSessionId?: string
  /** The runbook folder, for the host roles only; without it the client report shows
   *  hosts as [servidor]. Nothing is written under it: saves go to the settings folders. */
  runbookPath?: string
  onClose: () => void
}

type Kind = OpsReportKind
/** `imported`: the run's day came from a profile archive, so its chain cannot prove its origin. */
type Verified = { ok: true; imported: boolean } | { ok: false; brokenAt?: number; reason: string } | null

const clock = (iso?: string, seconds = false, locale?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(locale ? [locale] : [], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
}

const day = (iso: string, locale?: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale ? [locale] : [], { day: 'numeric', month: 'short' })
}

/** finished / stopped / failed / running, as the context line says it. */
export function runOutcome(run: OpsRun, t: TFunction): string {
  if (!run.ended) return t('ops.report.outcome.running')
  if (run.ended.aborted) return t('ops.report.outcome.stopped')
  return run.ended.ok ? t('ops.report.outcome.finished') : t('ops.report.outcome.failed')
}

/** The host the run was about: the locked host, the hosts an open run reached, or every host. */
function hostLine(run: OpsRun, t: TFunction): string {
  if (run.scope?.kind === 'host') return run.hostNames?.[run.scope.hostId] ?? run.hosts[0] ?? ''
  if (run.scope?.kind === 'open') {
    const touched = touchedHosts(run)
    return touched.length ? touched.join(', ') : t('ops.report.anyServer')
  }
  return run.hosts.join(', ')
}

/**
 * The run report as a document (docs/INTERVENTIONS_PLAN.md §4, board E2): a sheet from the
 * right over the terminal showing the handover, Copy, and a save that writes
 * a new file in the reports folder (the handovers folder for a handover), both set in Settings. The internal view leads with what the ledger says (tiles, plan,
 * calls), the full rendered report one toggle below; the client view is that report's
 * client rendering as it would be sent. Nothing here is sent anywhere.
 */
export default function OpsReportSheet({ runId, appSessionId, runbookPath, onClose }: Props) {
  const t = useT()
  const { locale } = useLanguage()
  // Only the handover is shown: the internal and client views were dropped from the sheet
  // (2026-11-03). main still renders them, for the reports a skill reads off disk.
  const kind: Kind = 'handover'
  const [loading, setLoading] = useState(true)
  const [markdown, setMarkdown] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ ok: true; path: string } | { ok: false; error: string } | null>(null)
  const [verified, setVerified] = useState<Verified>(null)
  const [dirs, setDirs] = useState<{ reportsDir: string; handoversDir: string } | null>(null)

  const { events } = useOpsEvents(appSessionId)
  const run = useMemo(() => foldOpsEvents(events).find((r) => r.runId === runId), [events, runId])
  const ledgerDay = run?.startedAt.slice(0, 10)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .opsDirs()
      .then((d) => !cancelled && setDirs(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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
      .opsVerify(ledgerDay, runId)
      .then((v) => !cancelled && setVerified(v.ok ? { ok: true, imported: v.imported !== undefined } : v))
      .catch(() => !cancelled && setVerified(null))
    return () => {
      cancelled = true
    }
  }, [ledgerDay, runId])

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
    <p className="ops-rs-note">{t('ops.report.loading')}</p>
  ) : error ? (
    <p className="ops-rs-error" role="alert">
      {error}
    </p>
  ) : (
    <Markdown content={markdown} />
  )

  const headerExtra = (
    <>
      <button type="button" className="ops-rs-btn" onClick={copy} disabled={loading || !markdown}>
        {copied ? t('ops.report.copied') : t('common.copy')}
      </button>
      <button
        type="button"
        className="ops-rs-btn primary"
        onClick={save}
        disabled={loading || !markdown || saving}
        title={dirs ? t('ops.report.saveTitle', { path: kind === 'handover' ? dirs.handoversDir : dirs.reportsDir }) : undefined}
      >
        {saving ? t('ops.report.saving') : t('ops.report.save')}
      </button>
    </>
  )

  return (
    <Sheet title={t('ops.report.title')} width={720} onClose={onClose} headerExtra={headerExtra}>
      <div className="ops-rs-body">
        {(saved || warnings.length > 0) && (
          <div className="ops-rs-notices">
            {saved && (
              <p className={`ops-rs-saved${saved.ok ? '' : ' error'}`} role="status">
                {saved.ok ? t('ops.report.savedTo', { path: saved.path }) : saved.error}
                {saved.ok && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="ops-rs-link"
                      onClick={() => void window.electronAPI.opsOpenFolder(kind === 'handover' ? 'handovers' : 'reports')}
                    >
                      {t('ops.report.openFolder')}
                    </button>
                  </>
                )}
              </p>
            )}
            {warnings.length > 0 && (
              <ul className="ops-rs-warnings" aria-label={t('ops.report.warnings')}>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {run && (
          <div className="ops-rs-titles">
            <h2 className="ops-rs-title">{run.runbook || t('ops.report.run')}</h2>
            <div className="ops-rs-context">
              {[
                hostLine(run, t),
                run.endedAt
                  ? t('ops.report.timeRange', { day: day(run.startedAt, locale), start: clock(run.startedAt, false, locale), end: clock(run.endedAt, false, locale) })
                  : t('ops.report.timeStart', { day: day(run.startedAt, locale), start: clock(run.startedAt, false, locale) }),
                'Claude Code',
                runOutcome(run, t)
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {(run.task || run.ticket || run.client) && (
              <div className="ops-rs-task">{[run.task, run.ticket, run.client].filter(Boolean).join(' · ')}</div>
            )}
          </div>
        )}

        <div className="ops-rs-md">{rendered}</div>

        {run && (
          <div className="ops-rs-foot">
            {t('ops.report.auditLog')} <code>{ledgerDay}.jsonl</code> · {t('ops.report.runId')} <code>{run.runId.slice(0, 8)}</code>
            {run.policySha256 && (
              <>
                {' '}
                · {t('ops.report.policy')} <code>{run.policySha256.slice(0, 8)}</code>
              </>
            )}
            {verified?.ok && ` · ${t(verified.imported ? 'ops.report.chainImported' : 'ops.report.chainVerified')}`}
            {verified && !verified.ok && (
              <span className="ops-rs-broken" title={verified.reason}>
                {' '}
                · {verified.brokenAt != null ? t('ops.report.chainBrokenAt', { line: verified.brokenAt }) : t('ops.report.chainBroken')}
              </span>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}
