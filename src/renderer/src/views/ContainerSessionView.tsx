import { useEffect, useMemo, useState } from 'react'
import type { ContainerLogTail, ContainerTabMode, HostSecretFlags, RemoteContainerTarget, SshHostPublic } from '../types'
import RemoteTerminal from '../components/RemoteTerminal'
import { useT } from '../i18n'
import { useLabs } from '../hooks/useLabs'
import type { MessageKey } from '../../../shared/i18n'
import './views.css'
import './RemoteSessionView.css'

interface Props {
  /** The host whose SSH connection the shell rides; null for a container on this computer. */
  host: SshHostPublic | null
  container: RemoteContainerTarget
  /** The container's name, as the listing showed it. Display only. */
  name: string
  /** A shell inside the container, or its logs (an experimental feature). */
  mode?: ContainerTabMode
  /** This tab's number within its group, so two tabs on one container get their own channel. */
  seq: number
  active?: boolean
  onBack: () => void
  onStatusChange?: (status: 'connecting' | 'connected' | 'error') => void
}

/** The logs tab's tail sizes, as main accepts them. */
const TAILS: ContainerLogTail[] = ['200', '500', '2000', 'all']

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
 *
 * In logs mode the channel runs `<runtime> logs --tail <n> [-f]` instead, and the header
 * carries its options: Follow, the tail size, Timestamps and Restart. Changing one restarts
 * the stream; with Follow off the output stops, so it can be scrolled in peace.
 */
export default function ContainerSessionView({ host, container, name, mode = 'shell', seq, active, onBack, onStatusChange }: Props) {
  const t = useT()
  const labs = useLabs()
  const hostId = host?.id ?? null
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>(hostId ? 'connecting' : 'connected')
  const [statusError, setStatusError] = useState<string | null>(null)
  // A password typed at the connect prompt is not in `host`: ask main what the terminal's
  // Send password can use once connected (flags only, see RemoteSessionView).
  const [secretFlags, setSecretFlags] = useState<HostSecretFlags | null>(null)
  const isLogs = mode === 'logs'
  const [follow, setFollow] = useState(true)
  const [tail, setTail] = useState<ContainerLogTail>('500')
  const [timestamps, setTimestamps] = useState(false)
  const [restartSignal, setRestartSignal] = useState(0)
  const logs = useMemo(() => (isLogs ? { follow, tail, timestamps } : undefined), [isLogs, follow, tail, timestamps])

  // Only for the dot: the terminal connects on its own, over the same cached client. This
  // computer has nothing to connect to.
  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    setStatus('connecting')
    window.electronAPI.sftpConnect(hostId).then((res) => {
      if (cancelled) return
      if (res.ok) {
        window.electronAPI
          .sshSecretFlags(hostId)
          .then((f) => {
            if (!cancelled) setSecretFlags(f)
          })
          .catch(() => undefined)
      }
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
          <span className="remote-session-name">{isLogs ? `${name} · ${t('remote.containers.logsSuffix')}` : name}</span>
          {labs && host?.production && <span className="prod-pill" title={t('remote.prod.title')}>{t('remote.prod.pill')}</span>}
          <span className="remote-session-target">
            {host
              ? t(isLogs ? 'remote.containers.tabTargetLogs' : 'remote.containers.tabTarget', {
                  runtime: `${container.sudo ? 'sudo ' : ''}${container.runtime}`,
                  host: host.name
                })
              : t(isLogs ? 'remote.containers.tabTargetLogsLocal' : 'remote.containers.tabTargetLocal', { runtime: container.runtime })}
          </span>
        </div>
        <span className="remote-session-spacer" />
        {isLogs && (
          <div className="ctr-logs-controls">
            <button
              type="button"
              className={`ctr-logs-toggle${follow ? ' on' : ''}`}
              aria-pressed={follow}
              title={t('remote.logs.followTitle')}
              onClick={() => setFollow((v) => !v)}
            >
              {t('remote.logs.follow')}
            </button>
            <label className="ctr-logs-tail" title={t('remote.logs.tailTitle')}>
              <span>{t('remote.logs.tail')}</span>
              <select value={tail} onChange={(e) => setTail(e.target.value as ContainerLogTail)}>
                {TAILS.map((n) => (
                  <option key={n} value={n}>
                    {n === 'all' ? t('remote.logs.tailAll') : n}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`ctr-logs-toggle${timestamps ? ' on' : ''}`}
              aria-pressed={timestamps}
              title={t('remote.logs.timestampsTitle')}
              onClick={() => setTimestamps((v) => !v)}
            >
              {t('remote.logs.timestamps')}
            </button>
            <button type="button" className="btn-ghost small" title={t('remote.logs.restartTitle')} onClick={() => setRestartSignal((n) => n + 1)}>
              {t('remote.logs.restart')}
            </button>
          </div>
        )}
      </div>
      <div className="remote-session-body">
        <div className="remote-session-right">
          <RemoteTerminal
            terminalId={`${isLogs ? 'ctrlogs' : 'ctrterm'}_${hostId ?? 'local'}_${container.id}_${seq}`}
            hostId={hostId}
            container={container}
            logs={logs}
            restartSignal={restartSignal}
            active={active}
            closable={false}
            secrets={host && secretFlags ? { ...host, ...secretFlags } : host}
          />
        </div>
      </div>
    </div>
  )
}
