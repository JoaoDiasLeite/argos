import { useEffect, useState } from 'react'
import type { RemoteContainerTarget, SshHostPublic } from '../types'
import RemoteTerminal from '../components/RemoteTerminal'
import { useT } from '../i18n'
import type { MessageKey } from '../../../shared/i18n'
import './views.css'
import './RemoteSessionView.css'

interface Props {
  host: SshHostPublic
  container: RemoteContainerTarget
  /** The container's name, as the listing showed it. Display only. */
  name: string
  /** This tab's number within its group, so two tabs on one container get their own channel. */
  seq: number
  active?: boolean
  onBack: () => void
  onStatusChange?: (status: 'connecting' | 'connected' | 'error') => void
}

const STATUS_LABEL: Record<'connecting' | 'connected' | 'error', MessageKey> = {
  connecting: 'remote.session.status.connecting',
  connected: 'remote.session.status.connected',
  error: 'remote.session.status.error'
}

/**
 * A container's own tab, opened from a Remote Session's Containers pane: the same header
 * as a session, then one full-width terminal whose channel runs the container's shell
 * (`exec -it`, see main/remote-shell.ts) on the host's shared SSH connection. `exit`
 * ends the channel; Reconnect enters again.
 */
export default function ContainerSessionView({ host, container, name, seq, active, onBack, onStatusChange }: Props) {
  const t = useT()
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [statusError, setStatusError] = useState<string | null>(null)

  // Only for the dot: the terminal connects on its own, over the same cached client.
  useEffect(() => {
    let cancelled = false
    setStatus('connecting')
    window.electronAPI.sftpConnect(host.id).then((res) => {
      if (cancelled) return
      setStatus(res.ok ? 'connected' : 'error')
      setStatusError(res.ok ? null : res.error || t('remote.session.couldNotConnect'))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id])

  useEffect(() => {
    onStatusChange?.(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  return (
    <div className="view remote-session-view">
      <div className="remote-session-header">
        <button type="button" className="remote-session-back" onClick={onBack} title={t('remote.session.back')} aria-label={t('remote.session.back')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div className="remote-session-title">
          <span className={`remote-session-dot ${status}`} title={status === 'error' ? statusError || t('remote.session.couldNotConnect') : t(STATUS_LABEL[status])} />
          <span className="remote-session-name">{name}</span>
          <span className="remote-session-target">
            {t('remote.containers.tabTarget', { runtime: `${container.sudo ? 'sudo ' : ''}${container.runtime}`, host: host.name })}
          </span>
        </div>
        <span className="remote-session-spacer" />
      </div>
      <div className="remote-session-body">
        <div className="remote-session-right">
          <RemoteTerminal
            terminalId={`ctrterm_${host.id}_${container.id}_${seq}`}
            hostId={host.id}
            container={container}
            active={active}
            closable={false}
          />
        </div>
      </div>
    </div>
  )
}
