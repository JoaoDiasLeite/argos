import { useEffect, useMemo, useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { useT } from '../i18n'
import type { TFunction } from '../../../shared/i18n'
import { OVERLAY_CHORD, SHORTCUT_GROUPS, Shortcut } from '../lib/shortcuts'
import './ShortcutsModal.css'

interface Props {
  onClose: () => void
}

/** A chord as keys, with the quick launcher's placeholder resolved to what the OS gave us. */
function resolveKeys(item: Shortcut, overlay: string, t: TFunction): string[] {
  if (!item.keys.includes(OVERLAY_CHORD)) return item.keys.map((k) => (k === 'right-click' ? t('shortcuts.key.rightClick') : k))
  // No accelerator could be registered — say so rather than printing an empty key.
  if (!overlay) return [t('shortcuts.key.unavailable')]
  return overlay.split('+')
}

export default function ShortcutsModal({ onClose }: Props) {
  const t = useT()
  const [q, setQ] = useState('')
  // Blank until main answers, and possibly blank for good: the chord is whatever could be
  // registered at startup, and on a machine where another launcher already owns every
  // candidate that is nothing.
  const [overlay, setOverlay] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  useEffect(() => {
    window.electronAPI.overlayShortcut().then(setOverlay).catch(() => {})
  }, [])

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase()
    return SHORTCUT_GROUPS.map((g) => {
      if (!query) return g
      // A group whose own title matches keeps all of its rows — searching "terminal"
      // should show the terminal's keys, not just the rows with "terminal" in them.
      if (t(g.title).toLowerCase().includes(query)) return g
      const items = g.items.filter((it) =>
        `${t(it.action)} ${it.note ? t(it.note) : ''} ${resolveKeys(it, overlay, t).join(' ')}`.toLowerCase().includes(query)
      )
      return { ...g, items }
    }).filter((g) => g.items.length > 0)
  }, [q, overlay, t])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.modal.title')}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{t('shortcuts.modal.title')}</h3>
          <input
            className="shortcuts-filter"
            placeholder={t('shortcuts.modal.filterPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Esc clears a filter first and closes on the second press — losing the
              // whole sheet because you wanted the search box empty reads as a misfire.
              if (e.key === 'Escape' && q) {
                e.preventDefault()
                e.stopPropagation()
                setQ('')
              }
            }}
            aria-label={t('shortcuts.modal.filterLabel')}
            autoFocus
          />
          <button className="icon-btn" onClick={onClose} aria-label={t('shortcuts.modal.closeLabel')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body shortcuts-body">
          {groups.length === 0 && <div className="shortcuts-empty">{t('shortcuts.modal.noMatch', { q })}</div>}
          {groups.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h4 className="shortcuts-group-title">{t(g.title)}</h4>
              <dl className="shortcuts-list">
                {g.items.map((it) => (
                  <div key={it.action + it.keys.join()} className="shortcuts-row">
                    <dt className="shortcuts-keys">
                      {resolveKeys(it, overlay, t).map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </dt>
                    <dd className="shortcuts-action">
                      {t(it.action)}
                      {it.note && <span className="shortcuts-note">{t(it.note)}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
