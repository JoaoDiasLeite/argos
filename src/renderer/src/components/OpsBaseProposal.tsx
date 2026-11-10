import { useEffect, useState } from 'react'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'

/**
 * "Add to Argos" (docs/BASE_INTERVENTION_PLAN.md §6), at the foot of an ended run whose
 * runbook is the operator's own: when it allows something the base intervention does not,
 * ask whether it should join the base, and open a prefilled GitHub issue if so. Main
 * decides whether there is anything to propose and builds the issue from the ledger;
 * this only names the run. "Nunca para este runbook" is remembered in localStorage.
 */

const NEVER_KEY = 'ops.baseProposal.never'

function readNever(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NEVER_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const key = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

export default function OpsBaseProposal({ runId, runbookPath }: { runId: string; runbookPath: string }) {
  const t = useT()
  const [counts, setCounts] = useState<{ rules: number; scripts: number; used: number } | null>(null)
  const [state, setState] = useState<'ask' | 'opening' | 'opened' | 'dismissed'>('ask')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCounts(null)
    setState('ask')
    setNote(null)
    if (readNever().includes(key(runbookPath))) return
    window.electronAPI
      .opsBaseProposal(runId)
      .then((r) => !cancelled && setCounts(r.ok ? r.proposal : null))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [runId, runbookPath])

  if (!counts || state === 'dismissed') return null

  const open = async () => {
    setState('opening')
    const r = await window.electronAPI.opsOpenBaseIssue(runId).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (!r.ok) {
      setNote(r.error)
      setState('ask')
      return
    }
    setNote(r.viaClipboard ? t('ops.proposal.onClipboard') : null)
    setState('opened')
  }
  const never = () => {
    try {
      localStorage.setItem(NEVER_KEY, JSON.stringify([...new Set([...readNever(), key(runbookPath)])]))
    } catch {
      /* storage unavailable: it just asks again next time */
    }
    setState('dismissed')
  }

  const what = [
    counts.rules ? plural(t, 'ops.proposal.rules', counts.rules) : '',
    counts.scripts ? plural(t, 'ops.proposal.scripts', counts.scripts) : ''
  ]
    .filter(Boolean)
    .join(t('ops.start.and'))

  return (
    <section className="ac-proposal" aria-label={t('ops.proposal.title')}>
      <p className="ac-proposal-text">
        <strong>{t('ops.proposal.title')}</strong> {t('ops.proposal.body', { what, used: counts.used })}
      </p>
      {state === 'opened' ? (
        <p className="ac-proposal-note">{note ?? t('ops.proposal.opened')}</p>
      ) : (
        <div className="ac-proposal-actions">
          <button type="button" className="ac-foot-btn" disabled={state === 'opening'} onClick={() => void open()}>
            {t('ops.proposal.create')}
          </button>
          <button type="button" className="ac-foot-btn" onClick={() => setState('dismissed')}>
            {t('ops.proposal.notNow')}
          </button>
          <button type="button" className="ac-foot-btn" onClick={never}>
            {t('ops.proposal.never')}
          </button>
        </div>
      )}
      {state !== 'opened' && note && (
        <p className="ac-proposal-note" role="alert">
          {note}
        </p>
      )}
    </section>
  )
}
