import { useEffect, useRef, useState } from 'react'
import { AuthStatus, AuthMode } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import { useT } from '../i18n'
import './OnboardingModal.css'

interface Props {
  onFinish: () => void
}

export default function OnboardingModal({ onFinish }: Props) {
  const t = useT()
  const [step, setStep] = useState(0)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Onboarding must be completed (or skipped via the Skip button) — no bare Esc dismiss.
  // Focus trap and focus-restore are still applied.
  useModalA11y(dialogRef, null, { escapeToClose: false })

  const refresh = async () => setAuth(await window.electronAPI.authStatus())
  useEffect(() => {
    refresh()
  }, [])

  const choose = async (mode: AuthMode) => {
    setBusy(true)
    await window.electronAPI.setAuthMode(mode)
    await refresh()
    setBusy(false)
  }

  const saveKey = async () => {
    if (!key.trim()) return
    setBusy(true)
    await window.electronAPI.setApiKey(key.trim())
    await window.electronAPI.setAuthMode('api-key')
    await refresh()
    setBusy(false)
    setKey('')
  }

  const detected = auth?.claudeCodeDetected
  const ready = auth ? (auth.mode === 'api-key' ? auth.hasApiKey : detected || auth.hasApiKey) : false

  return (
    <div className="modal-backdrop">
      <div
        className="modal onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-modal-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        {step === 0 && (
          <div className="ob-step ob-welcome">
            <div className="ob-logo">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.4" />
                <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </div>
            <h2 id="onboarding-modal-title">{t('onboarding.welcome.title')}</h2>
            <p>{t('onboarding.welcome.body')}</p>
            <button className="btn-primary" onClick={() => setStep(1)}>{t('onboarding.welcome.getStarted')}</button>
          </div>
        )}

        {step === 1 && (
          <div className="ob-step">
            <h3 id="onboarding-modal-title">{t('onboarding.connect.title')}</h3>
            <div className={`ob-detect ${detected ? 'ok' : 'warn'}`}>
              <span className={`auth-dot ${detected ? 'ok' : 'warn'}`} />
              {detected
                ? t('onboarding.connect.detected')
                : t('onboarding.connect.notDetected')}
            </div>

            <button
              className={`auth-option ${auth?.mode === 'claude-code' ? 'selected' : ''}`}
              onClick={() => choose('claude-code')}
              disabled={busy}
            >
              <div className="auth-option-radio"><span className={auth?.mode === 'claude-code' ? 'on' : ''} /></div>
              <div className="auth-option-body">
                <div className="auth-option-title">{t('onboarding.connect.useClaudeCode')} {detected && <span className="chip ok">{t('onboarding.connect.detectedChip')}</span>}</div>
                <div className="auth-option-desc">
                  {t('onboarding.connect.claudeCodeDesc')}{' '}
                  {!detected && t('onboarding.connect.claudeCodeHint')}
                </div>
              </div>
            </button>

            <button
              className={`auth-option ${auth?.mode === 'api-key' ? 'selected' : ''}`}
              onClick={() => choose('api-key')}
              disabled={busy}
            >
              <div className="auth-option-radio"><span className={auth?.mode === 'api-key' ? 'on' : ''} /></div>
              <div className="auth-option-body">
                <div className="auth-option-title">{t('onboarding.connect.useApiKey')} {auth?.hasApiKey && <span className="chip ok">{t('onboarding.connect.savedChip')}</span>}</div>
                <div className="auth-option-desc">{t('onboarding.connect.apiKeyDesc')}</div>
              </div>
            </button>

            {auth?.mode === 'api-key' && (
              <div className="ob-key">
                <input
                  className="text-input mono"
                  type="password"
                  placeholder="sk-ant-…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                />
                <button className="btn-ghost" onClick={saveKey} disabled={!key.trim() || busy}>{t('common.save')}</button>
              </div>
            )}

            <div className="ob-actions">
              <button className="btn-ghost" onClick={refresh}>{t('onboarding.connect.recheck')}</button>
              <div className="ob-spacer" />
              <button className="btn-ghost" onClick={onFinish}>{t('onboarding.connect.skip')}</button>
              <button className="btn-primary" onClick={onFinish} disabled={!ready}>
                {ready ? t('onboarding.connect.start') : t('onboarding.connect.continue')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
