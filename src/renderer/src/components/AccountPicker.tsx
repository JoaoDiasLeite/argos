import { useState, useRef, useEffect } from 'react'
import { ProviderId } from '../types'
import './AccountPicker.css'

export interface AccountPickerItem {
  provider: ProviderId
  id: string
  name: string
  loggedIn: boolean
  email?: string
  plan?: string
  usagePct?: number // Claude-only; omitted for codex/gemini
}

interface Props {
  items: AccountPickerItem[] // pre-ordered claude → codex → gemini
  selectedProvider: ProviderId
  selectedId?: string
  onPick: (provider: ProviderId, id: string) => void
  onManage: () => void
  compact?: boolean
  disabled?: boolean
}

const PROVIDER_GROUPS: { label: string; provider: ProviderId }[] = [
  { label: 'Claude', provider: 'claude' },
  { label: 'Codex', provider: 'codex' },
  { label: 'Gemini', provider: 'gemini' }
]

export default function AccountPicker({
  items,
  selectedProvider,
  selectedId,
  onPick,
  onManage,
  compact,
  disabled
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const current =
    items.find((i) => i.provider === selectedProvider && i.id === selectedId) ?? items[0]

  let seenGroup = false

  return (
    <div className={`account-picker ${compact ? 'compact' : ''}`} ref={ref}>
      <button
        className="account-picker-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Account for this chat"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`account-dot ${current?.loggedIn ? 'ok' : 'warn'}`} />
        <span className="account-picker-label">{current?.name ?? 'Account'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="account-picker-menu">
          {PROVIDER_GROUPS.map(({ label, provider }) => {
            const list = items.filter((i) => i.provider === provider)
            if (list.length === 0) return null
            const isFirstGroup = !seenGroup
            seenGroup = true
            return (
              <div key={provider}>
                <div className={`eyebrow account-picker-group-label ${isFirstGroup ? '' : 'not-first'}`}>{label}</div>
                {list.map((a) => {
                  const selected = a.provider === selectedProvider && a.id === selectedId
                  return (
                    <button
                      key={a.id}
                      className={`account-picker-item ${selected ? 'selected' : ''}`}
                      onClick={() => {
                        onPick(a.provider, a.id)
                        setOpen(false)
                      }}
                    >
                      <div className="account-picker-item-main">
                        <span className={`account-dot ${a.loggedIn ? 'ok' : 'warn'}`} />
                        <span className="account-picker-item-name">{a.name}</span>
                        {a.usagePct != null && (
                          <span
                            className={`chip ${a.usagePct >= 90 ? 'err' : a.usagePct >= 70 ? 'warn' : ''}`}
                          >
                            {a.usagePct.toFixed(0)}%
                          </span>
                        )}
                        {selected && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                      <div className="account-picker-item-meta">
                        {a.loggedIn
                          ? [a.email, a.plan].filter(Boolean).join(' · ') || 'Logged in'
                          : 'Not logged in'}
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })}
          <button
            className="account-picker-manage"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            Manage accounts
          </button>
        </div>
      )}
    </div>
  )
}
