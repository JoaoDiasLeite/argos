import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApprovalRequest } from '../types'
import { planChangesLine, planStepLabel, planTarget, planTotals, planTotalsGroups } from '../lib/ops-approval'
import { useModalA11y } from '../hooks/useModalA11y'
import './PlanReviewSheet.css'

interface Props {
  request: ApprovalRequest
  onDecide: (allow: boolean) => void
  /** "Deny and stop the run": offered only when the caller wires it. */
  onStop?: () => void
  /** A plain column that fills its container (the Ops workspace's side column) instead of
   *  a right-side drawer over the app. */
  embedded?: boolean
}

// A plan can arrive while the operator is mid-keystroke in the terminal or composer; an
// Enter typed a moment before the sheet appeared must not approve what they never saw.
const ARM_DELAY_MS = 400

/** Keys the sheet's own buttons already act on natively, so the sheet-level handler
 *  must not answer twice. */
const isControl = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('button, a[href], input, textarea, select')

/**
 * The review sheet for an ops plan (`mcp__ops__propose_plan`): every step the model
 * proposes, each already classified by the gate, with the totals first. A plan is answered,
 * never dismissed, so the scrim does not close it.
 */
export default function PlanReviewSheet({ request, onDecide, onStop, embedded = false }: Props) {
  const ops = request.ops
  const steps = ops?.planSteps ?? []
  const totals = ops ? planTotals(ops) : null
  const sheetRef = useRef<HTMLDivElement>(null)
  const approveRef = useRef<HTMLButtonElement>(null)
  const decidedRef = useRef(false)
  const armedAtRef = useRef(Date.now() + ARM_DELAY_MS)

  const decide = useCallback(
    (allow: boolean) => {
      if (decidedRef.current) return
      decidedRef.current = true
      onDecide(allow)
    },
    [onDecide]
  )
  const stop = useCallback(() => {
    if (decidedRef.current || !onStop) return
    decidedRef.current = true
    onStop()
  }, [onStop])

  // Focus trap + restore for the drawer; Esc is ours (below), so the hook leaves it alone.
  useModalA11y(sheetRef, () => decide(false), { escapeToClose: false, enabled: !embedded })

  // Land on Approve (after the hook has focused the first control), so Enter means what
  // the hint says and Tab reaches Reject next to it.
  useEffect(() => {
    approveRef.current?.focus()
  }, [request.approvalId])

  const onKey = useCallback(
    (e: KeyboardEvent | ReactKeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return
      if (e.key === 'Escape') {
        e.preventDefault()
        decide(false)
      } else if (e.key === 'Enter') {
        // Too early: swallow it, including a focused button's native activation.
        if (Date.now() < armedAtRef.current) {
          e.preventDefault()
          return
        }
        if (e.shiftKey || e.altKey || isControl(e.target)) return
        e.preventDefault()
        decide(true)
      }
    },
    [decide]
  )

  // The drawer answers keys window-wide, like the approval modal. Embedded, the sheet
  // shares the screen with a live terminal, so it answers only keys aimed at itself.
  useEffect(() => {
    if (embedded) return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [embedded, onKey])

  const n = steps.length
  const pct = (k: number) => (totals && totals.total > 0 ? `${(k / totals.total) * 100}%` : '0%')
  const titleId = `plan-sheet-${request.approvalId}`

  const sheet = (
    <div
      ref={sheetRef}
      className={`plan-sheet${embedded ? ' embedded' : ''}`}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={embedded ? onKey : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="plan-sheet-head">
        <div className="plan-sheet-eyebrow-row">
          <span className="plan-sheet-eyebrow">Plan for approval</span>
          <span className="plan-sheet-run" title={request.appSessionId}>
            run {request.appSessionId.slice(-4)}
          </span>
        </div>
        <div className="plan-sheet-title-row">
          <h3 id={titleId} className="plan-sheet-count">
            {n} step{n === 1 ? '' : 's'}
          </h3>
          {ops && <span className="plan-sheet-target">{planTarget(ops)}</span>}
        </div>
        {totals && totals.total > 0 && (
          <div className="plan-sheet-bar" aria-hidden="true">
            <span className="runs" style={{ width: pct(totals.runs) }} />
            <span className="asks" style={{ width: pct(totals.asks) }} />
            <span className="denied" style={{ width: pct(totals.denied) }} />
          </div>
        )}
        {totals && (
          <div className="plan-sheet-totals">
            {planTotalsGroups(totals).map((g) => (
              <span key={g.kind}>
                <span className={`plan-sheet-n ${g.kind}`}>{g.n}</span> {g.text}
              </span>
            ))}
            <span className={`plan-sheet-changes${totals.mutates > 0 ? ' mutates' : ''}`}>
              {planChangesLine(totals)}
            </span>
          </div>
        )}
      </div>

      <ol className="plan-sheet-steps">
        {steps.length === 0 && <li className="plan-sheet-empty">The plan names no steps.</li>}
        {steps.map((s, i) => {
          const flagged = s.verdict === 'asks' || s.verdict === 'denied'
          return (
            <li key={i} className={`plan-sheet-step ${s.verdict}${flagged ? ' flagged' : ''}`}>
              <div className="plan-sheet-rail" aria-hidden="true">
                <span className="plan-sheet-dot" />
                {i < steps.length - 1 && <span className="plan-sheet-line" />}
              </div>
              <div className="plan-sheet-step-body">
                <div className="plan-sheet-step-head">
                  <span className="plan-sheet-step-title">{s.title}</span>
                  <span className="plan-sheet-label">{planStepLabel(s)}</span>
                </div>
                {s.commands.length > 0 && (
                  <div className="plan-sheet-cmd" title={s.commands.join('\n')}>
                    {s.commands.join(' · ')}
                  </div>
                )}
                {flagged && s.reason && (
                  <div className="plan-sheet-reason" title={s.reason}>
                    {s.reason}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="plan-sheet-foot">
        <div className="plan-sheet-actions">
          <button type="button" className="plan-sheet-reject" onClick={() => decide(false)}>
            Reject plan
          </button>
          <button type="button" className="plan-sheet-approve" ref={approveRef} onClick={() => decide(true)}>
            Approve {n} step{n === 1 ? '' : 's'}
          </button>
        </div>
        <div className="plan-sheet-hints">
          <span>Enter approves · Esc rejects</span>
          {onStop && (
            <button type="button" className="plan-sheet-stop" onClick={stop}>
              Deny and stop the run
            </button>
          )}
        </div>
      </div>
    </div>
  )

  if (embedded) return sheet
  return <div className="plan-sheet-scrim">{sheet}</div>
}
