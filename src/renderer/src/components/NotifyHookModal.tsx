import { useEffect, useState } from 'react'
import { NotifyHookInfo } from '../types'
import Sheet from './Sheet'
import './NotifyHookModal.css'
import { useT } from '../i18n'
import { rich } from '../lib/t-rich'

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
  const t = useT()
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
        setInstallError(result.error ?? t('settings.notifyHook.writeFailed'))
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
      title={t('settings.general.notifications.label')}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('settings.sheet.done')}
          </button>
          <span className="help">{t('settings.sheet.escCloses')}</span>
        </>
      }
    >
      <div className="notifyhook-body">
        <p className="help notifyhook-intro">
          {rich(t('settings.notifyHook.intro'), {
            hook: <code>Notification</code>,
            title: <strong>[project] conversation</strong>
          })}
        </p>

        {info && (
          <>
            <div className="notifyhook-status">
              <i className={`notifyhook-dot ${info.installed ? 'ok' : ''}`} />
              <span className="notifyhook-status-text">
                {info.installed ? t('settings.notifyHook.status.on') : t('settings.notifyHook.status.off')}
              </span>
              <button type="button" className="btn-ghost small" onClick={install} disabled={installing}>
                {info.installed
                  ? installing
                    ? t('settings.notifyHook.rewiring')
                    : t('settings.notifyHook.rewire')
                  : installing
                    ? t('settings.notifyHook.enabling')
                    : t('settings.notifyHook.enable')}
              </button>
            </div>

            {installError && (
              <div className="block err" role="alert">
                {t('settings.notifyHook.installError', { error: installError })}
              </div>
            )}

            <div className="notifyhook-step">
              <div className="notifyhook-step-head">
                <span className="notifyhook-step-title">
                  {rich(t('settings.notifyHook.manual'), { path: <code>{info.settingsPath}</code> })}
                </span>
                <button type="button" className="btn-ghost small" onClick={() => copy('block', info.block)}>
                  {copied === 'block' ? t('settings.notifyHook.copied') : t('settings.notifyHook.copyBlock')}
                </button>
              </div>
              <pre className="notifyhook-block">{info.block}</pre>
              <p className="help">
                {rich(t('settings.notifyHook.merge'), { hooks: <code>hooks</code> })}
              </p>
            </div>

            {info.wslCommand && (
              <div className="notifyhook-step">
                <div className="notifyhook-step-head">
                  <button type="button" className="btn-text" onClick={() => setShowWsl((v) => !v)}>
                    {showWsl ? t('settings.notifyHook.wsl.hide') : t('settings.notifyHook.wsl.show')}
                  </button>
                  {showWsl && (
                    <button type="button" className="btn-ghost small" onClick={() => copy('wsl', info.wslBlock ?? '')}>
                      {copied === 'wsl' ? t('settings.notifyHook.copied') : t('settings.notifyHook.copyBlock')}
                    </button>
                  )}
                </div>
                {showWsl && (
                  <>
                    <pre className="notifyhook-block">{info.wslBlock}</pre>
                    <p className="help">
                      {rich(t('settings.notifyHook.wsl.note'), {
                        path: <code>~/.claude/settings.json</code>,
                        mnt: <code>/mnt</code>
                      })}
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
