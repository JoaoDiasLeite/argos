import { useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { useLanguage, useT } from '../i18n'
import { plural } from '../../../shared/i18n'
import type { ImportPreview, ImportProjectPreview, ImportSkip } from '../../../shared/profile-transfer'
import './ImportProfileModal.css'

interface Props {
  preview: ImportPreview
  onClose: () => void
}

function statusOf(p: ImportProjectPreview): 'exists' | 'missing' | 'skipped' | 'tooLong' {
  if (p.unresolved) return 'skipped'
  if (p.tooLong) return 'tooLong'
  return p.exists ? 'exists' : 'missing'
}

export default function ImportProfileModal({ preview, onClose }: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  busyRef.current = busy
  const [passphrase, setPassphrase] = useState('')
  const [passError, setPassError] = useState(false)
  const [error, setError] = useState('')
  // Set when the import finished but left some things out: the app waits for a restart
  // until the user has read what was skipped.
  const [skipped, setSkipped] = useState<ImportSkip[] | null>(null)
  useModalA11y(dialogRef, () => {
    if (!busyRef.current) onClose()
  })

  const close = () => {
    if (!busy) onClose()
  }

  const doImport = async () => {
    setBusy(true)
    setError('')
    setPassError(false)
    try {
      const res = await window.electronAPI.profileImport({
        path: preview.path,
        passphrase: passphrase || undefined
      })
      // A clean success relaunches the app; a success with skips waits for Restart.
      if (res.ok) {
        if (res.skipped.length) setSkipped(res.skipped)
      } else {
        if (res.error === 'bad-passphrase') setPassError(true)
        else setError(t('settings.import.failed', { error: res.error }))
      }
    } catch (e) {
      setError(t('settings.import.failed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const date = new Date(preview.createdAt).toLocaleString(locale ?? undefined)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('settings.import.ariaLabel')} {...backdropClose(close)}>
      <div className="modal wide import-modal" ref={dialogRef} tabIndex={-1}>
        <div className="modal-header">
          <h3>{t('settings.import.title')}</h3>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label={t('settings.transfer.close')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {skipped ? (
          <>
            <div className="modal-body">
              <p className="help">{t('settings.import.skipped.intro')}</p>
              <ul className="import-skipped">
                {skipped.map((s, i) => (
                  <li key={i} className="import-row-main">
                    <span className="import-row-name">{s.name}</span>
                    <span className="import-row-path">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={() => void window.electronAPI.profileRelaunch()}>
                {t('settings.import.skipped.restart')}
              </button>
            </div>
          </>
        ) : (
        <>
        <div className="modal-body">
          <div className="import-meta">
            <span>{t('settings.import.meta.exported', { date })}</span>
            <span>{t('settings.import.meta.version', { version: preview.appVersion })}</span>
            <span className="import-meta-paths" title={`${preview.fromHome} → ${preview.toHome}`}>
              {t('settings.import.meta.paths', { from: preview.fromHome, to: preview.toHome })}
            </span>
            <span>
              {[
                plural(t, 'settings.transfer.chats', preview.chats),
                plural(t, 'settings.transfer.sprints', preview.sprints),
                plural(t, 'settings.transfer.servers', preview.servers)
              ].join(' · ')}
            </span>
          </div>

          {preview.crossPlatform && (
            <div className="block warn">
              <span className="help">{t('settings.import.crossPlatform', { platform: preview.platform })}</span>
            </div>
          )}

          <section className="import-section">
            <span className="eyebrow">{t('settings.import.projects.title')}</span>
            {preview.projects.length === 0 ? (
              <p className="help">{t('settings.import.projects.empty')}</p>
            ) : (
              preview.projects.map((p, i) => {
                const st = statusOf(p)
                return (
                  <div key={`${p.sourceLabel}::${p.fromPath}::${i}`} className="import-row">
                    <span className="import-row-main">
                      <span className="import-row-name">{p.name}</span>
                      <span className="import-row-path" title={p.toPath}>{p.sourceLabel} · {p.toPath}</span>
                    </span>
                    <span className="import-row-side">
                      <span className="import-row-meta">{plural(t, 'settings.transfer.chats', p.transcripts)}</span>
                      <span className={`import-status ${st}`}>{t(`settings.import.status.${st}`)}</span>
                    </span>
                  </div>
                )
              })
            )}
          </section>

          {preview.accounts.length > 0 && (
            <section className="import-section">
              <span className="eyebrow">{t('settings.import.accounts.title')}</span>
              <div className="import-accounts">
                {preview.accounts.map((a) => (
                  <span key={a} className="chip">{a}</span>
                ))}
              </div>
              <p className="help">{t('settings.import.accounts.note')}</p>
            </section>
          )}

          {preview.hasSecrets && (
            <section className="import-section">
              <span className="eyebrow">{t('settings.transfer.passphrase.label')}</span>
              <p className="help">{t('settings.import.passphrase.hint')}</p>
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={passphrase}
                placeholder={t('settings.transfer.passphrase.placeholder')}
                aria-label={t('settings.transfer.passphrase.label')}
                aria-invalid={passError}
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  setPassError(false)
                }}
              />
              {passError && <p className="help settings-error">{t('settings.import.passphrase.bad')}</p>}
            </section>
          )}

          <div className="block">
            <span className="help">{t('settings.import.info')}</span>
          </div>

          {error && <p className="help settings-error">{error}</p>}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={close} disabled={busy}>{t('settings.transfer.cancel')}</button>
          <button type="button" className="btn-primary" onClick={doImport} disabled={busy}>
            {busy ? t('settings.import.busy') : t('settings.import.button')}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  )
}
