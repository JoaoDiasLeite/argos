import { useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { useT } from '../i18n'
import type { HostSecretRequest, OpsSecretRequest } from '../types'
import './SecretPrompt.css'

interface Props {
  /** An ops run's sudo password, or what a connecting Remote Session asks for. */
  request: Pick<OpsSecretRequest, 'requestId' | 'hostName' | 'prompt'> | HostSecretRequest
  /** null = declined or cancelled. `save` is only ever true when the request offered it. */
  onSubmit: (value: string | null, save: boolean) => void
}

function isHostRequest(r: Props['request']): r is HostSecretRequest {
  return 'source' in r && r.source === 'host'
}

export default function SecretPrompt({ request, onSubmit }: Props) {
  const t = useT()
  const [value, setValue] = useState('')
  const [save, setSave] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancel = () => onSubmit(null, false)
  useModalA11y(dialogRef, cancel)
  const titleId = `secret-prompt-${request.requestId}`
  const host = isHostRequest(request) ? request : null
  const canSave = !!host?.canSave

  return (
    <div className="modal-backdrop" {...backdropClose(cancel)}>
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
          <h3 id={titleId}>
            {host ? t('remote.secret.title', { host: request.hostName }) : t('ops.secret.title', { host: request.hostName })}
          </h3>
        </div>
        <form
          className="secret-prompt-body"
          onSubmit={(e) => { e.preventDefault(); onSubmit(value, canSave && save) }}
        >
          {/* For a keyboard-interactive question this is the server's own text: plain text
              only, already stripped of control characters and capped in main. */}
          <p className="secret-prompt-text">{request.prompt}</p>
          <input
            className="text-input mono"
            type={host?.echo ? 'text' : 'password'}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={host ? t('remote.secret.aria', { host: request.hostName }) : t('ops.secret.aria', { host: request.hostName })}
          />
          {canSave && (
            <label className="secret-prompt-save">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              {t('remote.secret.save')}
            </label>
          )}
          <p className="help">
            {!host
              ? t('ops.secret.help')
              : host.kind === 'keyboard'
                ? t('remote.secret.helpServer')
                : canSave
                  ? t('remote.secret.help')
                  : t('remote.secret.helpMemory')}
          </p>
          <div className="secret-prompt-actions">
            <button type="button" className="btn-ghost" onClick={cancel}>
              {host ? t('remote.secret.cancel') : t('ops.secret.decline')}
            </button>
            <button type="submit" className="btn-primary">{host ? t('remote.secret.connect') : t('ops.secret.use')}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
