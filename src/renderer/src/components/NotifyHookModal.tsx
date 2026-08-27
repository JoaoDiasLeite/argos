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
 * This panel shows and never writes. `~/.claude/settings.json` holds the user's
 * permissions, their own hooks and their environment; a block merged into it by us
 * is a merge we would have to get right every time, against a schema that is not
 * ours. So the block goes on the clipboard and the edit stays theirs.
 */
export default function NotifyHookModal({ onClose }: Props) {
  const [info, setInfo] = useState<NotifyHookInfo | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showWsl, setShowWsl] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  useEffect(() => {
    window.electronAPI.notifyHookInfo().then(setInfo)
  }, [])

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
                {info.installed
                  ? 'The hook is wired up in your settings.'
                  : 'Not wired up yet — paste the block below.'}
              </div>

              <div className="notifyhook-step">
                <div className="notifyhook-step-head">
                  <span className="notifyhook-step-title">
                    Add to <code>{info.settingsPath}</code>
                  </span>
                  <button className="btn-secondary small" onClick={() => copy('block', info.block)}>
                    {copied === 'block' ? 'Copied' : 'Copy block'}
                  </button>
                </div>
                <pre className="notifyhook-block">{info.block}</pre>
                <p className="field-hint">
                  Merge it into the <code>hooks</code> object you already have — Argos does not
                  edit this file.
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
