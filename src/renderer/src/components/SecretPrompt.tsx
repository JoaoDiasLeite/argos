import { useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { useT } from '../i18n'
import './SecretPrompt.css'

interface Props {
  request: { requestId: string; hostName: string; prompt: string }
  onSubmit: (value: string | null) => void
}

export default function SecretPrompt({ request, onSubmit }: Props) {
  const t = useT()
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
          <h3 id={titleId}>{t('ops.secret.title', { host: request.hostName })}</h3>
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
            aria-label={t('ops.secret.aria', { host: request.hostName })}
          />
          <p className="help">
            {t('ops.secret.help')}
          </p>
          <div className="secret-prompt-actions">
            <button type="button" className="btn-ghost" onClick={() => onSubmit(null)}>{t('ops.secret.decline')}</button>
            <button type="submit" className="btn-primary">{t('ops.secret.use')}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
