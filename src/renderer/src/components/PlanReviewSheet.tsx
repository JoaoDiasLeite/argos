import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'
import type { ApprovalRequest } from '../types'
import { planChangesLine, planStepLabel, planTarget, planTotalsGroups, planTotalsWithout } from '../lib/ops-approval'
import './PlanReviewSheet.css'

interface Props {
  request: ApprovalRequest
  /** `skipSteps`: 0-based indices into `ops.planSteps` the operator approved the plan
   *  without; only with `allow`, and only when any were skipped. */
  onDecide: (allow: boolean, skipSteps?: number[]) => void
}

// A plan can arrive while the operator is mid-keystroke in the terminal; an Enter typed a
// moment before the plan appeared must not approve what they never saw.
const ARM_DELAY_MS = 400

/** Keys the plan's own buttons already act on natively, so the region's handler must not
 *  answer twice. */
const isControl = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest('button, a[href], input, textarea, select')

/**
 * An ops plan (`mcp__ops__propose_plan`) waiting for the operator, as the plan variant of
 * the activity column's waiting block: every step the model proposes, each already
 * classified by the gate, with the totals first. A step can be skipped, so the plan is
 * approved without it; a step the gate refuses will not run anyway and is not offered. It shares the screen with a live terminal,
 * so it answers only keys aimed at itself. "Deny and stop" lives under the block, with the
 * column.
 */
export default function PlanReviewSheet({ request, onDecide }: Props) {
  const t = useT()
  const ops = request.ops
  const steps = ops?.planSteps ?? []
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(() => new Set())
  const totals = ops ? planTotalsWithout(ops, skipped) : null
  // Read by `decide`, so Enter approves with the skips on screen.
  const skippedRef = useRef(skipped)
  skippedRef.current = skipped
  const approveRef = useRef<HTMLButtonElement>(null)
  const decidedRef = useRef(false)
  const armedAtRef = useRef(Date.now() + ARM_DELAY_MS)

  const decide = useCallback(
    (allow: boolean) => {
      if (decidedRef.current) return
      const skip = [...skippedRef.current].sort((a, b) => a - b)
      if (allow && skip.length >= steps.length && steps.length > 0) return
      decidedRef.current = true
      if (allow && skip.length > 0) onDecide(true, skip)
      else onDecide(allow)
    },
    [onDecide, steps.length]
  )

  const toggleSkip = (i: number) =>
    setSkipped((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // Land on Approve, so Enter means what the hint says and Tab reaches Reject next to it.
  useEffect(() => {
    approveRef.current?.focus()
  }, [request.approvalId])

  const onKey = useCallback(
    (e: ReactKeyboardEvent) => {
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

  const n = steps.length
  const left = n - skipped.size
  const pct = (k: number) => (totals && totals.total > 0 ? `${(k / totals.total) * 100}%` : '0%')
  const titleId = `plan-sheet-${request.approvalId}`

  return (
    <div className="plan-sheet" role="region" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKey}>
      <div className="plan-sheet-head">
        <div className="plan-sheet-eyebrow-row">
          <span className="plan-sheet-eyebrow">{t('planner.review.waiting')}</span>
          <span className="plan-sheet-kind">{t('planner.review.kind')}</span>
        </div>
        <div className="plan-sheet-title-row">
          <h3 id={titleId} className="plan-sheet-count">
            {plural(t, 'planner.review.steps', n)}
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
            <span className={`plan-sheet-changes${totals.mutates > 0 ? ' mutates' : ''}`}>{planChangesLine(totals)}</span>
          </div>
        )}
      </div>

      <ol className="plan-sheet-steps">
        {steps.length === 0 && <li className="plan-sheet-empty">{t('planner.review.noSteps')}</li>}
        {steps.map((s, i) => {
          const isSkipped = skipped.has(i)
          const flagged = !isSkipped && (s.verdict === 'asks' || s.verdict === 'denied')
          return (
            <li key={i} className={`plan-sheet-step ${isSkipped ? 'skipped' : s.verdict}${flagged ? ' flagged' : ''}`}>
              <div className="plan-sheet-rail" aria-hidden="true">
                <span className="plan-sheet-dot" />
                {i < steps.length - 1 && <span className="plan-sheet-line" />}
              </div>
              <div className="plan-sheet-step-body">
                <div className="plan-sheet-step-head">
                  <span className="plan-sheet-step-title">{s.title}</span>
                  <span className="plan-sheet-label">{isSkipped ? t('planner.review.skipped') : planStepLabel(s)}</span>
                  {s.verdict !== 'denied' && (
                    <button
                      type="button"
                      className={`plan-sheet-skip${isSkipped ? ' on' : ''}`}
                      aria-pressed={isSkipped}
                      title={isSkipped ? t('planner.review.unskipTitle') : t('planner.review.skipTitle')}
                      onClick={() => toggleSkip(i)}
                    >
                      {isSkipped ? t('planner.review.skippedButton') : t('planner.review.skip')}
                    </button>
                  )}
                </div>
                {/* Shown in full, one command per line: this is what gets approved. */}
                {s.commands.map((cmd, j) => (
                  <div key={j} className="plan-sheet-cmd">
                    {cmd}
                  </div>
                ))}
                {flagged && s.reason && <div className="plan-sheet-reason">{s.reason}</div>}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="plan-sheet-foot">
        <div className="plan-sheet-actions">
          <button
            type="button"
            className="plan-sheet-approve"
            ref={approveRef}
            disabled={n > 0 && left === 0}
            onClick={() => decide(true)}
          >
            {skipped.size > 0 ? t('planner.review.approvePartial', { left, n }) : plural(t, 'planner.review.approve', n)}
          </button>
          <button type="button" className="plan-sheet-reject" onClick={() => decide(false)}>
            {t('planner.review.reject')}
          </button>
        </div>
        <div className="plan-sheet-hints">{t('planner.review.hints')}</div>
      </div>
    </div>
  )
}
