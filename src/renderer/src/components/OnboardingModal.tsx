import { useEffect, useRef, useState } from 'react'
import { AuthStatus, AuthMode } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import './OnboardingModal.css'

interface Props {
  onFinish: () => void
}

export default function OnboardingModal({ onFinish }: Props) {
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
            <h2 id="onboarding-modal-title">Welcome to Argos</h2>
            <p>A desktop control center for Claude Code — chat, projects, usage, agents, and remote/WSL backends, all in one place.</p>
            <button className="btn-primary" onClick={() => setStep(1)}>Get started</button>
          </div>
        )}

        {step === 1 && (
          <div className="ob-step">
            <h3 id="onboarding-modal-title">Connect your account</h3>
            <div className={`ob-detect ${detected ? 'ok' : 'warn'}`}>
              <span className={`auth-dot ${detected ? 'ok' : 'warn'}`} />
              {detected
                ? 'Claude Code login detected on this machine.'
                : 'No Claude Code login found yet.'}
            </div>

            <button
              className={`auth-option ${auth?.mode === 'claude-code' ? 'selected' : ''}`}
              onClick={() => choose('claude-code')}
              disabled={busy}
            >
              <div className="auth-option-radio"><span className={auth?.mode === 'claude-code' ? 'on' : ''} /></div>
              <div className="auth-option-body">
                <div className="auth-option-title">Use my Claude Code account {detected && <span className="status-pill ok">Detected</span>}</div>
                <div className="auth-option-desc">
                  Reuses the CLI login — no API key needed.{' '}
                  {!detected && 'Run `claude` once and log in, then click Re-check.'}
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
                <div className="auth-option-title">Use an API key {auth?.hasApiKey && <span className="status-pill ok">Saved</span>}</div>
                <div className="auth-option-desc">Stored encrypted in your OS keychain.</div>
              </div>
            </button>

            {auth?.mode === 'api-key' && (
              <div className="ob-key">
                <input
                  className="text-input"
                  type="password"
                  placeholder="sk-ant-…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                />
                <button className="btn-primary small" onClick={saveKey} disabled={!key.trim() || busy}>Save</button>
              </div>
            )}

            <div className="ob-actions">
              <button className="btn-text" onClick={refresh}>Re-check</button>
              <div className="ob-spacer" />
              <button className="btn-secondary" onClick={onFinish}>Skip</button>
              <button className="btn-primary" onClick={onFinish} disabled={!ready}>
                {ready ? 'Start using Argos' : 'Connect to continue'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
