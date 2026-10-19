import { useEffect, useMemo, useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { transferBytes } from '../lib/transfer-format'
import { useT } from '../i18n'
import { plural } from '../../../shared/i18n'
import type { ExportCandidate, ExportCandidates, ExportCounts } from '../../../shared/profile-transfer'
import './ExportProfileModal.css'

interface Props {
  onClose: () => void
}

interface Done {
  path: string
  bytes: number
  counts: ExportCounts
}

export default function ExportProfileModal({ onClose }: Props) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  busyRef.current = busy
  useModalA11y(dialogRef, () => {
    if (!busyRef.current) onClose()
  })

  const [candidates, setCandidates] = useState<ExportCandidates | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeRemote, setIncludeRemote] = useState(true)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<Done | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .profileExportCandidates()
      .then((c) => {
        if (cancelled) return
        setCandidates(c)
        setSelected(new Set(c.projects.map((p) => p.key)))
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: ExportCandidate[] }>()
    for (const p of candidates?.projects ?? []) {
      const g = map.get(p.sourceId) ?? { label: p.sourceLabel, items: [] }
      g.items.push(p)
      map.set(p.sourceId, g)
    }
    for (const g of map.values()) g.items.sort((a, b) => b.lastActive - a.lastActive)
    return [...map.entries()]
  }, [candidates])

  const projects = candidates?.projects ?? []
  const remoteCount = candidates?.remoteChatCount ?? 0
  const totalBytes = projects.reduce((sum, p) => (selected.has(p.key) ? sum + p.bytes : sum), 0)
  const chatCount =
    projects.reduce((sum, p) => (selected.has(p.key) ? sum + p.sessionCount : sum), 0) +
    (remoteCount > 0 && includeRemote ? remoteCount : 0)
  const mismatch = passphrase !== confirm
  const allSelected = projects.length > 0 && selected.size === projects.length

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const doExport = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await window.electronAPI.profileExport({
        projects: [...selected],
        includeRemoteChats: remoteCount > 0 && includeRemote,
        passphrase: passphrase || undefined
      })
      if (res.ok) setDone({ path: res.path, bytes: res.bytes, counts: res.counts })
      else if (!res.canceled) setError(t('settings.export.failed', { error: res.error }))
    } catch (e) {
      setError(t('settings.export.failed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (!busy) onClose()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('settings.export.ariaLabel')} {...backdropClose(close)}>
      <div className="modal wide export-modal" ref={dialogRef} tabIndex={-1}>
        <div className="modal-header">
          <h3>{done ? t('settings.export.done.title') : t('settings.export.title')}</h3>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label={t('settings.transfer.close')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {done ? (
          <>
            <div className="modal-body">
              <code className="export-path">{done.path}</code>
              <p className="export-text">
                {t('settings.export.done.summary', {
                  projects: plural(t, 'settings.transfer.projects', done.counts.projects),
                  chats: plural(t, 'settings.transfer.chats', done.counts.chats),
                  sprints: plural(t, 'settings.transfer.sprints', done.counts.sprints),
                  servers: plural(t, 'settings.transfer.servers', done.counts.servers),
                  size: transferBytes(t, done.bytes)
                })}
              </p>
              <p className="help">
                {done.counts.secrets ? t('settings.export.done.secrets') : t('settings.export.done.noSecrets')}
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-ghost" onClick={() => void window.electronAPI.profileShowFile(done.path)}>
                {t('settings.export.done.show')}
              </button>
              <button type="button" className="btn-primary" onClick={onClose}>{t('settings.transfer.close')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">
              <div className="block">
                <span className="help">{t('settings.export.always')}</span>
              </div>

              <section className="export-section">
                <div className="export-section-head">
                  <span className="eyebrow">{t('settings.export.chats.title')}</span>
                  {projects.length > 0 && (
                    <button
                      type="button"
                      className="btn-ghost small"
                      disabled={busy}
                      onClick={() => setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.key)))}
                    >
                      {allSelected ? t('settings.export.selectNone') : t('settings.export.selectAll')}
                    </button>
                  )}
                </div>

                {loadError ? (
                  <p className="help settings-error">{t('settings.export.loadFailed')}</p>
                ) : !candidates ? (
                  <p className="help">{t('settings.export.loading')}</p>
                ) : projects.length === 0 ? (
                  <p className="help">{t('settings.export.chats.empty')}</p>
                ) : (
                  groups.map(([sourceId, g]) => (
                    <div key={sourceId} className="export-group">
                      <div className="export-group-label">{g.label}</div>
                      {g.items.map((p) => (
                        <label key={p.key} className="export-row">
                          <input
                            type="checkbox"
                            checked={selected.has(p.key)}
                            disabled={busy}
                            onChange={() => toggle(p.key)}
                          />
                          <span className="export-row-main">
                            <span className="export-row-name">{p.name}</span>
                            <span className="export-row-path" title={p.realPath}>{p.realPath}</span>
                          </span>
                          <span className="export-row-meta">
                            {plural(t, 'settings.transfer.chats', p.sessionCount)} · {transferBytes(t, p.bytes)}
                          </span>
                        </label>
                      ))}
                    </div>
                  ))
                )}

                {remoteCount > 0 && (
                  <label className="export-row export-remote">
                    <input
                      type="checkbox"
                      checked={includeRemote}
                      disabled={busy}
                      onChange={(e) => setIncludeRemote(e.target.checked)}
                    />
                    <span className="export-row-main">
                      <span className="export-row-name">{t('settings.export.remote.label')}</span>
                      <span className="export-row-path">{t('settings.export.remote.hint')}</span>
                    </span>
                    <span className="export-row-meta">{plural(t, 'settings.transfer.chats', remoteCount)}</span>
                  </label>
                )}
              </section>

              <section className="export-section">
                <span className="eyebrow">{t('settings.export.passphrase.title')}</span>
                <p className="help">{t('settings.export.passphrase.hint')}</p>
                <div className="export-pass">
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={busy}
                    value={passphrase}
                    placeholder={t('settings.transfer.passphrase.placeholder')}
                    aria-label={t('settings.transfer.passphrase.label')}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                  <input
                    className="text-input"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={busy || !passphrase}
                    value={confirm}
                    aria-label={t('settings.export.passphrase.confirm')}
                    placeholder={t('settings.export.passphrase.confirm')}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                {mismatch && confirm !== '' && <p className="help settings-error">{t('settings.export.passphrase.mismatch')}</p>}
              </section>

              {error && <p className="help settings-error">{error}</p>}
            </div>

            <div className="modal-footer export-footer">
              <span className="help export-total">
                {t('settings.export.selected', {
                  chats: plural(t, 'settings.transfer.chats', chatCount),
                  size: transferBytes(t, totalBytes)
                })}
              </span>
              <button type="button" className="btn-ghost" onClick={close} disabled={busy}>{t('settings.transfer.cancel')}</button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !candidates || mismatch}
                onClick={doExport}
              >
                {busy ? t('settings.export.busy') : t('settings.export.button')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
