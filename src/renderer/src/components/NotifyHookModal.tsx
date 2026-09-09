import { useEffect, useRef, useState } from 'react'
import { NotifyHookInfo } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import './NotifyHookModal.css'

interface Props {
  onClose: () => void
}

/**
 * How to wire Claude Code's `Notification` hook to Argos.
 *
 * "Enable notifications" writes it: it hands `~/.claude/settings.json` to
 * `setClaudeHooks` (main/config.ts), which merges by event key — the user's own
 * hooks under other events, and any `Notification` entries that aren't ours, are
 * left exactly as found — and refuses to touch the file if it can't parse it. The
 * copy-block section stays as the manual alternative, and is the only path on WSL:
 * a distro has its own settings.json on the other side of the filesystem boundary,
 * which this writer does not reach.
 */
export default function NotifyHookModal({ onClose }: Props) {
  const [info, setInfo] = useState<NotifyHookInfo | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showWsl, setShowWsl] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  useEffect(() => {
    window.electronAPI.notifyHookInfo().then(setInfo)
  }, [])

  const install = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const result = await window.electronAPI.notifyHookInstall()
      if (!result.ok) {
        setInstallError(result.error ?? 'Could not write settings.json')
        return
      }
      setInfo(result)
    } finally {
      setInstalling(false)
    }
  }

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1400)
    } catch {
      /* clipboard denied — the block is on screen and selectable anyway */
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal notifyhook-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notifyhook-modal-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="notifyhook-modal-title">Session notifications</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body notifyhook-body">
          <p className="field-hint notifyhook-intro">
            Claude Code fires a <code>Notification</code> hook whenever a session needs you —
            waiting on a permission, or idle after a question. Wired to Argos, every session on
            this machine notifies as <strong>[project] conversation</strong>, whether it started
            here, in a console, or in an editor. Clicking the notification opens that
            conversation.
          </p>

          {info && (
            <>
              <div className={`notifyhook-status ${info.installed ? 'on' : ''}`}>
                <span>
                  {info.installed
                    ? 'The hook is wired up in your settings.'
                    : 'Not wired up yet.'}
                </span>
                {info.installed ? (
                  <button className="btn-text" onClick={install} disabled={installing}>
                    {installing ? 'Re-wiring…' : 'Re-wire'}
                  </button>
                ) : (
                  <button className="btn-primary small" onClick={install} disabled={installing}>
                    {installing ? 'Enabling…' : 'Enable notifications'}
                  </button>
                )}
              </div>

              {installError && (
                <div className="notifyhook-error" role="alert">
                  {installError} — you can still paste the block below by hand.
                </div>
              )}

              <div className="notifyhook-step">
                <div className="notifyhook-step-head">
                  <span className="notifyhook-step-title">
                    Or add to <code>{info.settingsPath}</code> yourself
                  </span>
                  <button className="btn-secondary small" onClick={() => copy('block', info.block)}>
                    {copied === 'block' ? 'Copied' : 'Copy block'}
                  </button>
                </div>
                <pre className="notifyhook-block">{info.block}</pre>
                <p className="field-hint">
                  Merge it into the <code>hooks</code> object you already have.
                </p>
              </div>

              {info.wslCommand && (
                <div className="notifyhook-step">
                  <div className="notifyhook-step-head">
                    <button className="btn-text" onClick={() => setShowWsl((v) => !v)}>
                      {showWsl ? 'Hide' : 'Show'} the WSL variant
                    </button>
                    {showWsl && (
                      <button
                        className="btn-secondary small"
                        onClick={() => copy('wsl', info.wslBlock ?? '')}
                      >
                        {copied === 'wsl' ? 'Copied' : 'Copy block'}
                      </button>
                    )}
                  </div>
                  {showWsl && (
                    <>
                      <pre className="notifyhook-block">{info.wslBlock}</pre>
                      <p className="field-hint">
                        A session running inside a distro has its own{' '}
                        <code>~/.claude/settings.json</code> and reaches this executable through{' '}
                        <code>/mnt</code>. Its transcript is not readable from the Windows side,
                        so those notifications name the project rather than the conversation.
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
