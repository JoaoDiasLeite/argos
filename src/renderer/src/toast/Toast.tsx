import { useState, useEffect } from 'react'
import { ApprovalRequest } from '../types'
import { applyPalette } from '../lib/palettes'

// Approval toast window. Shown bottom-right, always on top, whenever an agent run
// needs tool approval while the main window is hidden/unfocused, so the run never
// stalls invisibly. Every decision routes through the same respondApproval bridge
// the main-window modal uses; the main process broadcasts approval:resolved to
// keep both UIs in sync (whichever one didn't answer clears that entry).

/** One-line human summary of the tool's most salient argument. */
function summarize(req: ApprovalRequest): string {
  const input = req.input || {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (req.tool) {
    case 'Bash':
      return str(input.command) || 'Run a command'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path) || 'Modify a file'
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
  const [queue, setQueue] = useState<ApprovalRequest[]>([])

  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config) => applyPalette(document.documentElement, config.ui.theme, config.ui.palette))

    const offApproval = window.electronAPI.onToastApproval((data: ApprovalRequest) => {
      // Ignore duplicates (the same id could arrive twice on rapid re-shows).
      setQueue((prev) => (prev.some((r) => r.approvalId === data.approvalId) ? prev : [...prev, data]))
    })
    const offResolved = window.electronAPI.onApprovalResolved((approvalId: string) => {
      setQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
    })
    return () => {
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

  return (
    <div className="toast-shell">
      <div className="toast-head">
        <span className="toast-title">Approve tool use</span>
        {queue.length > 1 && <span className="toast-more">+{queue.length - 1} more</span>}
      </div>
      <div className="toast-body">
        <span className="toast-tool">{head.tool}</span>
        <span className="toast-summary" title={summarize(head)}>
          {summarize(head)}
        </span>
      </div>
      <div className="toast-actions">
        <button className="toast-btn allow" onClick={() => decide(true)}>
          Allow
        </button>
        <button className="toast-btn deny" onClick={() => decide(false)}>
          Deny
        </button>
        <button className="toast-btn open" onClick={() => window.electronAPI.toastOpenMain()}>
          Open app
        </button>
      </div>
    </div>
  )
}
