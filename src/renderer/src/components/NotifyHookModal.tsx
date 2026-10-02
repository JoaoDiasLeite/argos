import { useEffect, useState } from 'react'
import { NotifyHookInfo } from '../types'
import Sheet from './Sheet'
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
    <Sheet
      title="Session notifications"
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <span className="help">Esc closes</span>
        </>
      }
    >
      <div className="notifyhook-body">
        <p className="help notifyhook-intro">
          Claude Code fires a <code>Notification</code> hook whenever a session needs you, waiting on a
          permission or idle after a question. Wired to Argos, every session on this machine notifies as{' '}
          <strong>[project] conversation</strong>, whether it started here, in a console or in an editor.
          Clicking the notification opens that conversation.
        </p>

        {info && (
          <>
            <div className="notifyhook-status">
              <i className={`notifyhook-dot ${info.installed ? 'ok' : ''}`} />
              <span className="notifyhook-status-text">
                {info.installed ? 'The hook is wired up in your settings.' : 'Not wired up yet.'}
              </span>
              <button type="button" className="btn-ghost small" onClick={install} disabled={installing}>
                {info.installed
                  ? installing
                    ? 'Re-wiring'
                    : 'Re-wire'
                  : installing
                    ? 'Enabling'
                    : 'Enable notifications'}
              </button>
            </div>

            {installError && (
              <div className="block err" role="alert">
                {installError}. You can still paste the block below by hand.
              </div>
            )}

            <div className="notifyhook-step">
              <div className="notifyhook-step-head">
                <span className="notifyhook-step-title">
                  Or add to <code>{info.settingsPath}</code> yourself
                </span>
                <button type="button" className="btn-ghost small" onClick={() => copy('block', info.block)}>
                  {copied === 'block' ? 'Copied' : 'Copy block'}
                </button>
              </div>
              <pre className="notifyhook-block">{info.block}</pre>
              <p className="help">
                Merge it into the <code>hooks</code> object you already have.
              </p>
            </div>

            {info.wslCommand && (
              <div className="notifyhook-step">
                <div className="notifyhook-step-head">
                  <button type="button" className="btn-text" onClick={() => setShowWsl((v) => !v)}>
                    {showWsl ? 'Hide the WSL variant' : 'Show the WSL variant'}
                  </button>
                  {showWsl && (
                    <button type="button" className="btn-ghost small" onClick={() => copy('wsl', info.wslBlock ?? '')}>
                      {copied === 'wsl' ? 'Copied' : 'Copy block'}
                    </button>
                  )}
                </div>
                {showWsl && (
                  <>
                    <pre className="notifyhook-block">{info.wslBlock}</pre>
                    <p className="help">
                      A session running inside a distro has its own <code>~/.claude/settings.json</code> and
                      reaches this executable through <code>/mnt</code>. Its transcript is not readable from
                      the Windows side, so those notifications name the project rather than the conversation.
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
