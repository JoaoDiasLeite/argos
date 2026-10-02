import { useEffect, useRef } from 'react'
import { ApprovalOpsContext, ApprovalRequest } from '../types'
import { describeOpsRequest } from '../lib/ops-approval'
import DiffView from './DiffView'
import { useModalA11y } from '../hooks/useModalA11y'
import './ApprovalModal.css'

interface Props {
  request: ApprovalRequest
  onDecide: (allow: boolean) => void
  // "Deny and stop the run" - only offered when the caller wires it (ops requests).
  onStop?: () => void
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function OpsBody({ ops }: { ops: ApprovalOpsContext }) {
  const { lines } = describeOpsRequest(ops)
  return (
    <div className="approval-ops">
      <div className="approval-ops-meta">
        <span>{ops.hostName} · {ops.hostAddress} · runbook {ops.runbook}</span>
        <span className={`approval-ops-class ${ops.class}`}>{ops.class}</span>
      </div>
      {ops.title && <div className="approval-ops-title">{ops.title}</div>}
      {lines.length > 0 && <pre className="approval-ops-exec">{lines.join('\n')}</pre>}
      <div className="approval-ops-rule">{ops.rule ? ops.rule : 'no rule matched'}</div>
      {ops.reason && <div className="approval-desc">{ops.reason}</div>}
      {ops.queuedBehind > 0 && (
        <div className="approval-ops-queue">
          Queued behind {ops.queuedBehind} call{ops.queuedBehind === 1 ? '' : 's'} on this host.
        </div>
      )}
    </div>
  )
}

export default function ApprovalModal({ request, onDecide, onStop }: Props) {
  const { tool, input, ops } = request
  const dialogRef = useRef<HTMLDivElement>(null)
  // Esc is handled by the existing keydown handler (deny), so we pass escapeToClose: false
  // to avoid a double call. Focus trap + focus-restore still apply.
  useModalA11y(dialogRef, () => onDecide(false), { escapeToClose: false })

  // Keyboard: Ctrl/Cmd+Enter = allow, Esc = deny. Enter is ignored for the first 400 ms
  // after the request appears, so a keystroke meant for the terminal cannot approve it.
  const shownAt = useRef(Date.now())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (Date.now() - shownAt.current >= 400) onDecide(true)
      }
      else if (e.key === 'Escape') onDecide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  const filePath = str(input.file_path || input.path)

  const renderBody = () => {
    if (ops) return <OpsBody ops={ops} />
    if (tool === 'RemoteRun') return <div className="approval-command">
      <p>{str(input.permissions)}</p>
      {/* Two separate <pre>s rather than one with an embedded "\n" — a template-literal
          "\n" inside JSX text renders as the two literal characters, not a line break,
          which used to run target and folder together on one line. Labelled because
          this is the one dialog standing between a headless remote run and the user's
          files, and a bare hostname next to a bare path invites mixing them up. */}
      <pre><strong>Target:</strong> {str(input.target)}</pre>
      <pre><strong>Folder:</strong> {str(input.folder)}</pre>
      <p>{str(input.prompt)}</p>
    </div>
    if (tool === 'Edit') {
      return <DiffView oldText={str(input.old_string)} newText={str(input.new_string)} filePath={filePath} />
    }
    if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
      return (
        <div className="approval-multi">
          {(input.edits as { old_string?: string; new_string?: string }[]).map((e, i) => (
            <div key={i} className="approval-multi-item">
              <div className="approval-multi-label">Edit {i + 1}</div>
              <DiffView oldText={str(e.old_string)} newText={str(e.new_string)} filePath={filePath} />
            </div>
          ))}
        </div>
      )
    }
    if (tool === 'Write') {
      return <DiffView oldText="" newText={str(input.content)} filePath={filePath} />
    }
    if (tool === 'Bash') {
      return (
        <div className="approval-command">
          <pre>{str(input.command)}</pre>
          {input.description ? <div className="approval-desc">{str(input.description)}</div> : null}
        </div>
      )
    }
    return <pre className="approval-json">{JSON.stringify(input, null, 2)}</pre>
  }

  const verb = ops ? describeOpsRequest(ops).verb :
    tool === 'RemoteRun' ? 'start a remote run' : tool === 'Bash' ? 'run a command' : tool === 'Write' ? 'create / overwrite a file' : 'use a tool'

  return (
    <div className="modal-backdrop">
      <div
        className="modal approval-modal"
        role="dialog"
        aria-modal
        aria-labelledby={`approval-${request.approvalId}`}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={`approval-${request.approvalId}`}>
            <span className="approval-tool">{tool}</span> wants to {verb}
          </h3>
        </div>
        {!ops && filePath && <div className="approval-path">{filePath}</div>}
        <div className="approval-body">{renderBody()}</div>
        <div className="modal-footer approval-footer">
          <span className="help approval-keys">Ctrl+Enter allows · Esc denies</span>
          {ops && onStop && (
            <button className="btn-text danger" onClick={onStop}>
              Deny and stop the run
            </button>
          )}
          <button className="btn-ghost" onClick={() => onDecide(false)}>Deny</button>
          <button className="btn-primary" onClick={() => onDecide(true)}>Allow once</button>
        </div>
      </div>
    </div>
  )
}
