import { useId, useRef, useState } from 'react'
import type { OpsIntervention } from '../types'
import type { OpsRun } from '../lib/ops-timeline'
import { handoverTask } from '../lib/ops-timeline'
import { samePath, useBaseRunbook, useBuiltinRunbook } from '../lib/builtin-runbook'
import { writeLastRunbook } from '../lib/runbook-library'
import { readOnBase, writeOnBase } from '../lib/runbook-on-base'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { RunbookField, runbookHostProblem, useRunbookPicker } from './RunbookPicker'
import { useT } from '../i18n'
import './OpsHandoverDialog.css'

/**
 * "Hand over to a runbook" (board C of the despiste plan, phase 4): a diagnosis that
 * reached a fix carries on as an intervention on the same server, for the same client and
 * ticket. The base intervention comes first (docs/BASE_INTERVENTION_PLAN.md §4): most fixes
 * are a Jarvis command it already allows. A runbook is picked as on the start screen, added
 * to the base or alone. The task comes filled from the diagnosis's notes and can be edited.
 * `onConfirm` opens the new run and resolves with an error to show, or null once it is open.
 */

interface Props {
  /** The diagnosis being handed over. */
  intervention: OpsIntervention
  /** Its run, for the notes the task is filled from. */
  run: OpsRun
  /** The locked host's name, for the host check's message. */
  hostName?: string
  onCancel: () => void
  onConfirm: (next: OpsIntervention) => Promise<string | null>
}

export default function OpsHandoverDialog({ intervention, run, hostName, onCancel, onConfirm }: Props) {
  const t = useT()
  const builtin = useBuiltinRunbook()
  const baseDir = useBaseRunbook()
  const { scope } = intervention
  /** The base intervention, or a runbook of the operator's. */
  const [withRunbook, setWithRunbook] = useState(false)
  const picker = useRunbookPicker({ active: withRunbook, hostId: scope.kind === 'host' ? scope.hostId : undefined, builtin })
  const { runbookPath: pickedPath, infos } = picker
  const [, setOnBaseFlips] = useState(0)
  const onBase = withRunbook && !!pickedPath && readOnBase(pickedPath)
  const setOnBase = (on: boolean) => {
    if (!pickedPath) return
    writeOnBase(pickedPath, on)
    setOnBaseFlips((n) => n + 1)
  }
  const runbookPath = withRunbook ? pickedPath : baseDir
  const [task, setTask] = useState(() => handoverTask(run, t))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const runbookLabelId = useId()
  const taskId = useId()
  const close = () => {
    if (!busy) onCancel()
  }
  // useModalA11y binds its handler once; read the latest close through a ref.
  const closeRef = useRef(close)
  closeRef.current = close
  useModalA11y(dialogRef, () => closeRef.current())

  // The base reaches every server; a runbook (alone or added to the base, whose hosts are
  // the runbook's) is checked against the locked server.
  const info = withRunbook && pickedPath ? infos[pickedPath] : undefined
  const okInfo = info && info !== 'loading' && info.ok ? info : undefined
  const isBuiltin = withRunbook && samePath(pickedPath, builtin)
  const hostProblem = !withRunbook || isBuiltin ? null : runbookHostProblem(okInfo, scope, hostName, t)
  const canStart = (withRunbook ? !!okInfo && !isBuiltin && !hostProblem : !!baseDir) && !busy

  const start = async () => {
    if (!canStart || !runbookPath) return
    setBusy(true)
    setError(null)
    const { ticket, client } = intervention
    const err = await onConfirm({
      runbookPath,
      scope,
      task: task.trim(),
      ...(ticket ? { ticket } : {}),
      ...(client ? { client } : {}),
      parentRunId: run.runId,
      ...(onBase ? { onBase: true } : {})
    }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    if (err) {
      setError(err)
      setBusy(false)
      return
    }
    if (withRunbook) writeLastRunbook(runbookPath)
  }

  return (
    <div className="modal-backdrop" {...backdropClose(close)}>
      <div className="modal wide ohd" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <div className="modal-header">
          <h3 id={titleId}>{t('ops.handover.title')}</h3>
        </div>
        <div className="modal-body">
          <p className="ohd-sub">{t('ops.handover.sub')}</p>
          <div className="ivs-field">
            <span className="ivs-label" id={runbookLabelId}>
              {t('ops.handover.with')}
            </span>
            <div className="ohd-choice" role="radiogroup" aria-labelledby={runbookLabelId}>
              <label className="ohd-option">
                <input type="radio" name={runbookLabelId} checked={!withRunbook} onChange={() => setWithRunbook(false)} />
                <span>
                  <span className="ivs-onbase-title">{t('ops.handover.base')}</span>
                  <span className="ivs-help">{t('ops.handover.baseHelp')}</span>
                </span>
              </label>
              <label className="ohd-option">
                <input type="radio" name={runbookLabelId} checked={withRunbook} onChange={() => setWithRunbook(true)} />
                <span className="ivs-onbase-title">{t('ops.handover.runbook')}</span>
              </label>
            </div>
            {withRunbook && <RunbookField picker={picker} labelledBy={runbookLabelId} />}
            {withRunbook && pickedPath && !isBuiltin && (
              <label className="ivs-onbase">
                <input type="checkbox" checked={onBase} onChange={(e) => setOnBase(e.target.checked)} />
                <span>
                  <span className="ivs-onbase-title">{t('ops.start.onBase')}</span>
                  <span className="ivs-help">{t('ops.start.onBaseHelp')}</span>
                </span>
              </label>
            )}
            {isBuiltin && (
              <span className="ivs-error" role="alert">
                {t('ops.handover.builtin')}
              </span>
            )}
            {hostProblem && (
              <span className="ivs-error" role="alert">
                {hostProblem}
              </span>
            )}
          </div>
          <div className="ivs-field">
            <label className="ivs-label" htmlFor={taskId}>
              {t('ops.start.task')}
            </label>
            <textarea
              id={taskId}
              className="ivs-control ivs-textarea"
              value={task}
              placeholder={t('ops.start.taskPlaceholder')}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void start()
                }
              }}
            />
          </div>
          {error && (
            <span className="ivs-error" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={() => void start()} disabled={!canStart}>
            {busy ? t('ops.handover.starting') : t('ops.start.startButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
