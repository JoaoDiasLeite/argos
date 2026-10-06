import { useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import './SecretPrompt.css'

interface Props {
  request: { requestId: string; hostName: string; prompt: string }
  onSubmit: (value: string | null) => void
}

export default function SecretPrompt({ request, onSubmit }: Props) {
  const [value, setValue] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, () => onSubmit(null))
  const titleId = `secret-prompt-${request.requestId}`

  return (
    <div className="modal-backdrop" {...backdropClose(() => onSubmit(null))}>
      <div
        className="modal secret-prompt"
        role="dialog"
        aria-modal={true}
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>sudo password for {request.hostName}</h3>
        </div>
        <form
          className="secret-prompt-body"
          onSubmit={(e) => { e.preventDefault(); onSubmit(value) }}
        >
          <p className="secret-prompt-text">{request.prompt}</p>
          <input
            className="text-input mono"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`sudo password for ${request.hostName}`}
          />
          <p className="help">
            Kept in memory only for this run and never written to the audit log.
          </p>
          <div className="secret-prompt-actions">
            <button type="button" className="btn-ghost" onClick={() => onSubmit(null)}>Decline</button>
            <button type="submit" className="btn-primary">Use for this run</button>
          </div>
        </form>
      </div>
    </div>
  )
}
