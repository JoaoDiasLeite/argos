import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteContainerList, RemoteContainerRow, RemoteContainerTarget } from '../types'
import { useT } from '../i18n'
import './ContainersPanel.css'

interface Props {
  hostId: string
  /** The session's SSH connection is up; the listing rides it, so it waits for it. */
  connected: boolean
  /** The pane's Files / History / Containers switch, drawn at the start of the bar. */
  barSlot: ReactNode
  /** Opens a tab with a shell inside that container. */
  onOpen: (container: RemoteContainerTarget, name: string) => void
}

/**
 * The Remote Session's Containers pane: the host's docker (or podman) containers, listed
 * when the pane opens and on Refresh (no polling). A running one has a Shell button that
 * opens it in a tab of its own (its channel runs `exec -it`, built in main from the
 * validated id only), so the session's own terminal stays on the host.
 */
export default function ContainersPanel({ hostId, connected, barSlot, onOpen }: Props) {
  const t = useT()
  const [result, setResult] = useState<RemoteContainerList | null>(null)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  const load = useCallback(() => {
    const req = ++reqRef.current
    setLoading(true)
    window.electronAPI.remoteContainers(hostId).then(
      (res) => {
        if (req !== reqRef.current) return
        setResult(res)
        setLoading(false)
      },
      (e: unknown) => {
        if (req !== reqRef.current) return
        setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
        setLoading(false)
      }
    )
  }, [hostId])

  useEffect(() => {
    if (connected) load()
    return () => {
      // A reply for a host or mount we left behind is dropped.
      reqRef.current++
    }
  }, [connected, load])

  const containers = result?.ok ? (result.containers ?? []) : []
  const running = containers.filter((c) => c.running)
  const stopped = containers.filter((c) => !c.running)

  const row = (c: RemoteContainerRow) => (
    <div key={c.id} className={`containers-row${c.running ? '' : ' stopped'}`}>
      <span className={`containers-dot${c.running ? ' up' : ''}`} aria-hidden="true" />
      <div className="containers-main">
        <div className="containers-name" title={c.name}>{c.name || c.id}</div>
        <div className="containers-meta mono" title={`${c.image} · ${c.id}`}>{c.image}</div>
        <div className="containers-status">{c.status}</div>
      </div>
      {c.running && result?.runtime ? (
        <button
          type="button"
          className="btn-ghost small containers-shell"
          disabled={!connected}
          title={connected ? t('remote.containers.shellTitle', { name: c.name || c.id }) : t('remote.containers.notConnected')}
          onClick={() =>
            result.runtime && onOpen({ runtime: result.runtime, sudo: result.sudo === true, id: c.id }, c.name || c.id)
          }
        >
          {t('remote.containers.shell')}
        </button>
      ) : null}
    </div>
  )

  return (
    <>
      <div className="remote-session-pane-bar">
        {barSlot}
        <span className="containers-bar-spacer" />
        <button
          type="button"
          className="btn-ghost small"
          onClick={load}
          disabled={!connected || loading}
          title={t('remote.containers.refresh')}
        >
          {t('remote.containers.refresh')}
        </button>
      </div>
      <div className="containers-panel">
        {!connected && <p className="containers-note">{t('remote.containers.notConnected')}</p>}
        {connected && loading && !result && <p className="containers-note">{t('remote.containers.loading')}</p>}
        {result && !result.ok && (
          <div className="block err containers-error" role="alert">
            {result.error}
          </div>
        )}
        {result?.ok && result.runtime === null && <p className="containers-note">{t('remote.containers.noRuntime')}</p>}
        {result?.ok && result.runtime && containers.length === 0 && (
          <p className="containers-note">{t('remote.containers.none')}</p>
        )}
        {result?.ok && result.sudo && containers.length > 0 && (
          <p className="containers-note">{t('remote.containers.viaSudo')}</p>
        )}
        {running.length > 0 && (
          <>
            <div className="eyebrow containers-eyebrow">
              {result?.runtime} · {t('remote.containers.running', { n: running.length })}
            </div>
            <div className="containers-list">{running.map(row)}</div>
          </>
        )}
        {stopped.length > 0 && (
          <>
            <div className="eyebrow containers-eyebrow">{t('remote.containers.stopped')}</div>
            <div className="containers-list">{stopped.map(row)}</div>
          </>
        )}
      </div>
    </>
  )
}
