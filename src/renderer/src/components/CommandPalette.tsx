import { useEffect, useMemo, useRef, useState } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { useT } from '../i18n'
import './CommandPalette.css'

export interface CommandItem {
  id: string
  title: string
  subtitle?: string
  group: string
  run: () => void
}

interface Props {
  items: CommandItem[]
  onClose: () => void
}

export default function CommandPalette({ items, onClose }: Props) {
  const t = useT()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Esc already handled by onKey on the input; escapeToClose: false prevents double-close.
  // Focus trap + restore-focus are still applied.
  useModalA11y(dialogRef, onClose, { escapeToClose: false })

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return items.slice(0, 50)
    const scored = items
      .map((it) => {
        const hay = `${it.title} ${it.subtitle ?? ''} ${it.group}`.toLowerCase()
        const idx = hay.indexOf(query)
        return { it, score: idx < 0 ? -1 : idx }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score)
    return scored.slice(0, 50).map((s) => s.it)
  }, [q, items])

  useEffect(() => {
    setActive(0)
  }, [q])

  useEffect(() => {
    const el = listRef.current?.querySelector('.cmd-item.active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (i: number) => {
    const it = filtered[i]
    if (it) {
      it.run()
      onClose()
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Group consecutive items by group label.
  let lastGroup = ''

  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.palette.label')}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-search">
          <svg className="cmd-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="text-input"
            placeholder={t('shortcuts.palette.placeholder')}
            aria-label={t('shortcuts.palette.label')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
        </div>
        <div className="cmd-list" ref={listRef}>
          {filtered.length === 0 && <div className="help cmd-empty">{t('shortcuts.palette.noMatches')}</div>}
          {filtered.map((it, i) => {
            const showGroup = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.id}>
                {showGroup && <div className="eyebrow cmd-group">{it.group}</div>}
                <div
                  className={`cmd-item ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(i)}
                >
                  <span className="cmd-item-title">{it.title}</span>
                  {it.subtitle && <span className="help cmd-item-sub">{it.subtitle}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="cmd-foot">
          <span className="help"><kbd>↑</kbd><kbd>↓</kbd> {t('shortcuts.palette.navigate')}</span>
          <span className="help"><kbd>Enter</kbd> {t('shortcuts.palette.open')}</span>
          <span className="help"><kbd>Esc</kbd> {t('shortcuts.palette.close')}</span>
        </div>
      </div>
    </div>
  )
}
