import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PortForward } from '../types'
import { useForwards } from '../hooks/useForwards'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'
import './PortForwards.css'

interface Props {
  hostId: string
  /** The session's connection is up: the host's autoStart tunnels start once it is. */
  connected: boolean
}

export const TunnelIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 20V11a9 9 0 0 1 18 0v9" />
    <path d="M7 20v-8a5 5 0 0 1 10 0v8" />
    <path d="M3 20h18" />
  </svg>
)

/** `127.0.0.1:<port>` to the clipboard, with a short "Copied" on the button. */
export function useCopyAddress(): [string | null, (port: number) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (port: number) => {
    const text = `127.0.0.1:${port}`
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(text)
        setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500)
      })
      .catch(() => undefined)
  }
  return [copied, copy]
}

/** Closes a popover on a click outside `ref` or on Escape. */
export function useDismiss(open: boolean, close: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return ref
}

/**
 * The Remote Session header's Tunnels button: a count of this host's open tunnels and a
 * popover to start and stop each saved one. The definitions are read fresh from the saved
 * host each time it opens, since the session's own copy of the host dates from when the tab
 * opened and the form may have changed them since.
 */
export default function PortForwardsButton({ hostId, connected }: Props) {
  const t = useT()
  const statuses = useForwards().filter((s) => s.hostId === hostId)
  const active = statuses.filter((s) => s.active).length
  const [open, setOpen] = useState(false)
  const [forwards, setForwards] = useState<PortForward[] | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [startErrors, setStartErrors] = useState<Record<string, string>>({})
  const [copied, copy] = useCopyAddress()
  const ref = useDismiss(open, () => setOpen(false))

  const loadForwards = () => {
    window.electronAPI
      .sshList()
      .then((hosts) => setForwards(hosts.find((h) => h.id === hostId)?.forwards ?? []))
      .catch(() => setForwards([]))
  }

  // The session opening is the user's gesture for the autoStart ones; once per session,
  // and main skips any already running (another session on the same host).
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!connected || autoStarted.current) return
    autoStarted.current = true
    window.electronAPI
      .forwardsAutoStart(hostId)
      .then((results) => {
        const failed: Record<string, string> = {}
        for (const r of results) if (!r.result.ok) failed[r.forwardId] = r.result.error
        if (Object.keys(failed).length) setStartErrors((prev) => ({ ...prev, ...failed }))
      })
      .catch(() => undefined)
  }, [connected, hostId])

  const toggle = () => {
    if (!open) loadForwards()
    setOpen((v) => !v)
  }

  const withBusy = async (id: string, run: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(id))
    try {
      await run()
    } finally {
      setBusy((b) => {
        const next = new Set(b)
        next.delete(id)
        return next
      })
    }
  }

  const start = (id: string) =>
    withBusy(id, async () => {
      setStartErrors((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      const res = await window.electronAPI.forwardStart(hostId, id)
      if (!res.ok) setStartErrors((prev) => ({ ...prev, [id]: res.error }))
    })

  const stop = (id: string) => withBusy(id, async () => void (await window.electronAPI.forwardStop(hostId, id)))

  const label = active > 0 ? plural(t, 'remote.forwards.buttonActive', active) : t('remote.forwards.button')

  return (
    <div className="pf-pop-wrap" ref={ref}>
      <button
        type="button"
        className={`btn-ghost small pf-trigger${active > 0 ? ' on' : ''}`}
        onClick={toggle}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <TunnelIcon />
        {t('remote.forwards.button')}
        {active > 0 && <span className="pf-badge">{active}</span>}
      </button>
      {open && (
        <div className="pf-pop" role="dialog" aria-label={t('remote.forwards.title')}>
          {forwards === null ? null : forwards.length === 0 ? (
            <p className="help pf-empty">{t('remote.forwards.none')}</p>
          ) : (
            forwards.map((f) => {
              const s = statuses.find((x) => x.forwardId === f.id)
              const running = !!s?.active
              const isBusy = busy.has(f.id)
              const error = startErrors[f.id] ?? s?.error
              const target = `${f.remoteHost || 'localhost'}:${f.remotePort}`
              return (
                <div className="pf-item" key={f.id}>
                  <div className="pf-item-head">
                    <span className={`pf-dot${running ? ' on' : s && !s.active ? ' err' : ''}`} aria-hidden="true" />
                    <span className="pf-item-name">{f.label || target}</span>
                    {f.autoStart && <span className="chip">{t('remote.forwards.autoStartChip')}</span>}
                    <span className="pf-item-actions">
                      {running ? (
                        <button type="button" className="btn-ghost small" disabled={isBusy} onClick={() => void stop(f.id)}>
                          {t('remote.forwards.stop')}
                        </button>
                      ) : (
                        <button type="button" className="btn-ghost small" disabled={isBusy} onClick={() => void start(f.id)}>
                          {isBusy ? t('remote.forwards.starting') : t('remote.forwards.start')}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="pf-item-route mono">
                    {running && s ? (
                      <>
                        <span className="pf-local">127.0.0.1:{s.localPort}</span>
                        <button
                          type="button"
                          className="btn-text pf-copy"
                          onClick={() => copy(s.localPort)}
                          title={t('remote.forwards.copy')}
                        >
                          {copied === `127.0.0.1:${s.localPort}` ? t('remote.forwards.copied') : t('remote.forwards.copy')}
                        </button>
                      </>
                    ) : (
                      <span>{f.localPort ? `127.0.0.1:${f.localPort}` : '127.0.0.1:*'}</span>
                    )}
                    <span className="pf-arrow" aria-hidden="true">→</span>
                    <span>{target}</span>
                  </div>
                  {running && s && s.connections > 0 && (
                    <span className="pf-meta">{plural(t, 'remote.forwards.connections', s.connections)}</span>
                  )}
                  {error && (
                    <span className={running ? 'pf-warn' : 'pf-error'} role="alert">
                      {error}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
