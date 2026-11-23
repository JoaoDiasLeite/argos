import { useEffect, useState } from 'react'
import type { RemoteContainerTarget, SshHostPublic } from '../types'
import RemoteTerminal from '../components/RemoteTerminal'
import { useT } from '../i18n'
import type { MessageKey } from '../../../shared/i18n'
import './views.css'
import './RemoteSessionView.css'

interface Props {
  /** The host whose SSH connection the shell rides; null for a container on this computer. */
  host: SshHostPublic | null
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
 * ends the channel; Reconnect enters again. A container on this computer (host null) runs
 * the same command on a local pty instead (main/remote-shell.ts localContainerShellCreate).
 */
export default function ContainerSessionView({ host, container, name, seq, active, onBack, onStatusChange }: Props) {
  const t = useT()
  const hostId = host?.id ?? null
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>(hostId ? 'connecting' : 'connected')
  const [statusError, setStatusError] = useState<string | null>(null)

  // Only for the dot: the terminal connects on its own, over the same cached client. This
  // computer has nothing to connect to.
  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    setStatus('connecting')
    window.electronAPI.sftpConnect(hostId).then((res) => {
      if (cancelled) return
      setStatus(res.ok ? 'connected' : 'error')
      setStatusError(res.ok ? null : res.error || t('remote.session.couldNotConnect'))
    })
    return () => {
      cancelled = true
    }
  }, [hostId])

  useEffect(() => {
    onStatusChange?.(status)
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
          {host?.production && <span className="prod-pill" title={t('remote.prod.title')}>{t('remote.prod.pill')}</span>}
          <span className="remote-session-target">
            {host
              ? t('remote.containers.tabTarget', { runtime: `${container.sudo ? 'sudo ' : ''}${container.runtime}`, host: host.name })
              : t('remote.containers.tabTargetLocal', { runtime: container.runtime })}
          </span>
        </div>
        <span className="remote-session-spacer" />
      </div>
      <div className="remote-session-body">
        <div className="remote-session-right">
          <RemoteTerminal
            terminalId={`ctrterm_${hostId ?? 'local'}_${container.id}_${seq}`}
            hostId={hostId}
            container={container}
            active={active}
            closable={false}
            secrets={host}
          />
        </div>
      </div>
    </div>
  )
}
