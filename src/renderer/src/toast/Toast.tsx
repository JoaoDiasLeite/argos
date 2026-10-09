import { useState, useEffect } from 'react'
import { ApprovalRequest } from '../types'
import { applyTheme } from '../lib/theme'
import { opsToastEyebrow, opsToastQuestion } from '../lib/ops-approval'
import { rich } from '../lib/t-rich'
import { useT } from '../i18n'
import type { TFunction } from '../../../shared/i18n'

// Approval toast window. Shown bottom-right, always on top, whenever an agent run
// needs tool approval while the main window is hidden/unfocused, so the run never
// stalls invisibly. Every decision routes through the same respondApproval bridge
// the main-window modal uses; the main process broadcasts approval:resolved to
// keep both UIs in sync (whichever one didn't answer clears that entry).

/** One-line human summary of the tool's most salient argument. */
function summarize(req: ApprovalRequest, t: TFunction): string {
  const input = req.input || {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (req.tool) {
    case 'Bash':
      return str(input.command) || t('app.toast.runCommand')
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path) || t('app.toast.modifyFile')
    default: {
      // Fall back to the first string-valued argument, else a compact JSON blob.
      const first = Object.values(input).find((v) => typeof v === 'string')
      if (typeof first === 'string' && first) return first
      try {
        return JSON.stringify(input)
      } catch {
        return ''
      }
    }
  }
}

export default function Toast() {
  const t = useT()
  const [queue, setQueue] = useState<ApprovalRequest[]>([])

  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config) => applyTheme(document.documentElement, config.ui))

    // Long-lived window, one mount-time palette read: follow the push instead.
    const offUi = window.electronAPI.onUiPrefs((ui) => applyTheme(document.documentElement, ui))

    const offApproval = window.electronAPI.onToastApproval((data: ApprovalRequest) => {
      // Ignore duplicates (the same id could arrive twice on rapid re-shows).
      setQueue((prev) => (prev.some((r) => r.approvalId === data.approvalId) ? prev : [...prev, data]))
    })
    const offResolved = window.electronAPI.onApprovalResolved((approvalId: string) => {
      setQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
    })
    return () => {
      offUi()
      offApproval()
      offResolved()
    }
  }, [])

  const head = queue[0]
  if (!head) return <div className="toast-shell toast-empty" />

  const decide = (allow: boolean) => {
    // The main process broadcasts approval:resolved which prunes the queue here,
    // so we don't need to optimistically remove — but doing so keeps the UI snappy.
    window.electronAPI.respondApproval({ approvalId: head.approvalId, allow })
    setQueue((prev) => prev.filter((r) => r.approvalId !== head.approvalId))
  }

  if (head.ops) {
    // An ops request says what it asks in words (board F2): the MCP tool name means nothing
    // to the person deciding, and a plan is approved, not "allowed".
    const q = opsToastQuestion(head.ops, t)
    const plan = head.ops.tool === 'plan'
    return (
      <div className="toast-shell">
        <div className="toast-head">
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-eyebrow" title={opsToastEyebrow(head.ops, t)}>
            {opsToastEyebrow(head.ops, t)}
          </span>
          {queue.length > 1 && <span className="toast-more">{t('app.toast.more', { n: queue.length - 1 })}</span>}
        </div>
        <div className="toast-question">
          {rich(q.text, { code: q.code ? <code className="toast-chip">{q.code}</code> : '' })}
        </div>
        <div className="toast-actions">
          <button className="toast-btn allow" onClick={() => decide(true)}>
            {plan ? t('app.toast.approve') : t('app.toast.allow')}
          </button>
          <button className="toast-btn deny" onClick={() => decide(false)}>
            {t('app.toast.deny')}
          </button>
          <span className="toast-spacer" />
          <button className="toast-link" onClick={() => window.electronAPI.toastOpenMain()}>
            {t('app.toast.openArgos')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="toast-shell">
      <div className="toast-head">
        <span className="toast-title">{t('app.toast.approveToolUse')}</span>
        {queue.length > 1 && <span className="toast-more">{t('app.toast.more', { n: queue.length - 1 })}</span>}
      </div>
      <div className="toast-body">
        <span className="toast-tool">{head.tool}</span>
        <span className="toast-summary" title={summarize(head, t)}>
          {summarize(head, t)}
        </span>
      </div>
      <div className="toast-actions">
        <button className="toast-btn allow" onClick={() => decide(true)}>
          {t('app.toast.allow')}
        </button>
        <button className="toast-btn deny" onClick={() => decide(false)}>
          {t('app.toast.deny')}
        </button>
        <span className="toast-spacer" />
        <button className="toast-link" onClick={() => window.electronAPI.toastOpenMain()}>
          {t('app.toast.openArgos')}
        </button>
      </div>
    </div>
  )
}
