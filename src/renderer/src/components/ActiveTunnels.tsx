import { useState } from 'react'
import type { SshHostPublic } from '../types'
import { useForwards } from '../hooks/useForwards'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'
import { TunnelIcon, useCopyAddress, useDismiss } from './PortForwardsButton'
import './PortForwards.css'

interface Props {
  hosts: SshHostPublic[]
}

/**
 * The Servers screen's view of every tunnel, whichever session opened it: shown only while
 * there is one, with Stop for a running tunnel and Dismiss for one that stopped on its own.
 */
export default function ActiveTunnels({ hosts }: Props) {
  const t = useT()
  const list = useForwards()
  const [open, setOpen] = useState(false)
  const [copied, copy] = useCopyAddress()
  const ref = useDismiss(open, () => setOpen(false))
  if (list.length === 0) return null

  const active = list.filter((s) => s.active).length
  const label = plural(t, 'remote.forwards.buttonActive', active)

  return (
    <div className="pf-pop-wrap" ref={ref}>
      <button
        type="button"
        className={`btn-ghost pf-trigger${active > 0 ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <TunnelIcon />
        {t('remote.forwards.button')}
        <span className="pf-badge">{active}</span>
      </button>
      {open && (
        <div className="pf-pop" role="dialog" aria-label={t('remote.forwards.openTitle')}>
          <div className="eyebrow pf-pop-title">{t('remote.forwards.openTitle')}</div>
          {list.map((s) => {
            const host = hosts.find((h) => h.id === s.hostId)
            const f = host?.forwards?.find((x) => x.id === s.forwardId)
            const target = f ? `${f.remoteHost || 'localhost'}:${f.remotePort}` : ''
            return (
              <div className="pf-item" key={`${s.hostId}:${s.forwardId}`}>
                <div className="pf-item-head">
                  <span className={`pf-dot${s.active ? ' on' : ' err'}`} aria-hidden="true" />
                  <span className="pf-item-name">
                    {host?.name ?? t('remote.forwards.unknownHost')}
                    {f && <span className="pf-item-sub"> · {f.label || target}</span>}
                  </span>
                  <span className="pf-item-actions">
                    <button type="button" className="btn-ghost small" onClick={() => void window.electronAPI.forwardStop(s.hostId, s.forwardId)}>
                      {s.active ? t('remote.forwards.stop') : t('remote.forwards.dismiss')}
                    </button>
                  </span>
                </div>
                {s.active ? (
                  <div className="pf-item-route mono">
                    <span className="pf-local">127.0.0.1:{s.localPort}</span>
                    <button type="button" className="btn-text pf-copy" onClick={() => copy(s.localPort)} title={t('remote.forwards.copy')}>
                      {copied === `127.0.0.1:${s.localPort}` ? t('remote.forwards.copied') : t('remote.forwards.copy')}
                    </button>
                    {target && (
                      <>
                        <span className="pf-arrow" aria-hidden="true">→</span>
                        <span>{target}</span>
                      </>
                    )}
                  </div>
                ) : (
                  <span className="pf-meta">{t('remote.forwards.stopped')}</span>
                )}
                {s.active && s.connections > 0 && <span className="pf-meta">{plural(t, 'remote.forwards.connections', s.connections)}</span>}
                {s.error && <span className={s.active ? 'pf-warn' : 'pf-error'}>{s.error}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
