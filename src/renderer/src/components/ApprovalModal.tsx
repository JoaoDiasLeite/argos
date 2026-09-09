import { useEffect, useRef } from 'react'
import { ApprovalRequest } from '../types'
import DiffView from './DiffView'
import { useModalA11y } from '../hooks/useModalA11y'
import './ApprovalModal.css'

interface Props {
  request: ApprovalRequest
  onDecide: (allow: boolean) => void
  // Optional session label, shown small in the header — used by the Rooms inline flow
  // where more than one session may have pending approvals.
  sessionName?: string
  inline?: boolean
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export default function ApprovalModal({ request, onDecide, sessionName, inline = false }: Props) {
  const { tool, input } = request
  const dialogRef = useRef<HTMLDivElement>(null)
  // Esc is handled by the existing keydown handler (deny), so we pass escapeToClose: false
  // to avoid a double call. Focus trap + focus-restore still apply.
  useModalA11y(dialogRef, () => onDecide(false), { escapeToClose: false, enabled: !inline })

  // Keyboard: Enter = allow, Esc = deny.
  useEffect(() => {
    if (inline) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onDecide(true)
      else if (e.key === 'Escape') onDecide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide, inline])

  const filePath = str(input.file_path || input.path)

  const renderBody = () => {
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

  const verb =
    tool === 'RemoteRun' ? 'start a remote run' : tool === 'Bash' ? 'run a command' : tool === 'Write' ? 'create / overwrite a file' : 'use a tool'

  return (
    <div className={inline ? 'approval-inline' : 'modal-backdrop'}>
      <div
        className="modal approval-modal"
        role={inline ? 'region' : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-labelledby={`approval-${request.approvalId}`}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={`approval-${request.approvalId}`}>
            <span className="approval-tool">{tool}</span> wants to {verb}
          </h3>
          {sessionName && <div className="approval-session">{sessionName}</div>}
        </div>
        {filePath && <div className="approval-path">{filePath}</div>}
        <div className="approval-body">{renderBody()}</div>
        <div className="modal-footer approval-footer">
          <button className="btn-secondary" onClick={() => onDecide(false)}>
            Deny {!inline && <span className="kbd">Esc</span>}
          </button>
          <button className="btn-primary" onClick={() => onDecide(true)}>
            Allow once {!inline && <span className="kbd">Ctrl/⌘↵</span>}
          </button>
        </div>
      </div>
    </div>
  )
}
