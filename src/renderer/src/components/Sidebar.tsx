import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Session, AuthStatus, CCAccountStatus, ProviderAccountStatus, ProviderId, ModelInfo } from '../types'
import { idFor as idForAccount, visibleSessions as visibleSessionsFor, AccountDefaults } from '../lib/account-scope'
import FileTree from './FileTree'
import './Sidebar.css'
import './AccountPicker.css'

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-fable-5': 'Fable 5',
}

function shortModelLabel(id: string): string {
  if (MODEL_LABELS[id]) return MODEL_LABELS[id]
  // strip 'claude-' prefix, capitalize first word, keep the rest
  const stripped = id.replace(/^claude-/, '')
  return stripped
    .replace(/-(\d)/, ' $1')
    .replace(/^([a-z])/, (c) => c.toUpperCase())
}

// A small monochrome glyph shown before an account name to signal its provider —
// simplified brand marks (Claude spark / Codex hexagon / Gemini sparkle), no colors,
// inheriting currentColor so they stay subtle against the row text.
function ProviderIcon({ provider }: { provider: ProviderId }) {
  if (provider === 'codex') {
    return (
      <svg className="provider-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12 3 20 7.5 20 16.5 12 21 4 16.5 4 7.5" />
      </svg>
    )
  }
  if (provider === 'gemini') {
    return (
      <svg className="provider-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3c0 4.5-4.5 9-9 9 4.5 0 9 4.5 9 9 0-4.5 4.5-9 9-9-4.5 0-9-4.5-9-9z" />
      </svg>
    )
  }
  return (
    <svg className="provider-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 4v16M5 8l14 8M19 8l-14 8" />
    </svg>
  )
}

interface Props {
  sessions: Session[]
  activeId: string
  /** Session ids with an agent run currently in flight — pulsing accent dot. */
  runningIds: Set<string>
  /** Session ids with a pending approval waiting — amber dot. */
  attentionIds: Set<string>
  tab: 'files' | 'sessions'
  onTabChange: (tab: 'files' | 'sessions') => void
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onNewQuickChat?: () => void
  onDeleteSession: (id: string) => void
  projectPath?: string
  onSetProject: (path: string) => void
  /** Opens a file from the Files tab in the editor. */
  onOpenFile?: (path: string) => void
  /** Path currently open in the editor, so the Files tab can highlight it. */
  openFilePath?: string
  onOpenSettings: () => void
  auth: AuthStatus | null
  accounts: CCAccountStatus[]
  /** Model catalog — used to resolve a model id to its provider. */
  models: ModelInfo[]
  /** Provider currently in effect — the ACTIVE chat's provider, falling back to the
   *  app-wide default model's provider when there's no active chat. Scopes the account
   *  row, its usage badge, and the session list. */
  selectedProvider: ProviderId
  /** Account currently in effect within `selectedProvider` — the active chat's account,
   *  falling back to that provider's default. Opening a chat bound to another account
   *  (e.g. from Projects) therefore moves the row, badge and list onto that account. */
  selectedAccountId?: string
  codexAccounts: ProviderAccountStatus[]
  geminiAccounts: ProviderAccountStatus[]
  codexDefaultAccountId?: string
  geminiDefaultAccountId?: string
  /** Switch the APP-LEVEL default account (used for new chats) for the given provider. */
  onPickAccount: (provider: ProviderId, accountId: string) => void
  /** Open the accounts manager (from the picker's footer). */
  onManageAccounts: () => void
  /** Per-account 5h-window usage, keyed by managed account id — shown inside the picker dropdown. */
  accountUsage?: Record<string, { utilization: number; resetsAt?: string }>
  /** Per-account Codex usage (rateLimits.primary), keyed by Codex account id — the Codex
   *  analog of `accountUsage` above. No Gemini equivalent: Antigravity's single
   *  machine-wide login has no per-account usage to report. */
  codexAccountUsage?: Record<string, { utilization: number; resetsAt?: string; windowMinutes?: number }>
  /** Jump to the Projects view (all historical chats, across accounts). */
  onExploreProjects: () => void
  /** App-wide default model/account — session badges only render when a session diverges from these. */
  defaultModel?: string
  defaultAccountId?: string
}

// "resets in 3h 12m" for the plan badge tooltip.
function fmtReset(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
  const mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'resets soon'
  if (mins < 60) return `resets in ${mins}m`
  return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

const MIN_WIDTH = 200
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 260
const STORAGE_KEY = 'sidebar-width'

export default function Sidebar({
  sessions,
  activeId,
  runningIds,
  attentionIds,
  tab,
  onTabChange,
  onSelectSession,
  onNewSession,
  onNewQuickChat,
  onDeleteSession,
  projectPath,
  onSetProject,
  onOpenFile,
  openFilePath,
  onOpenSettings,
  auth,
  accounts,
  models,
  selectedProvider,
  selectedAccountId,
  codexAccounts,
  geminiAccounts,
  codexDefaultAccountId,
  geminiDefaultAccountId,
  onPickAccount,
  onManageAccounts,
  accountUsage,
  codexAccountUsage,
  onExploreProjects,
  defaultModel,
  defaultAccountId
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // App-level account picker (the account row). Only toggles when there's more than
  // one account and the row is in the ready state; otherwise the row opens Settings.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  // The menu renders in a portal with position: fixed so the sidebar's overflow:hidden
  // (and the nav rail's stacking context) can't clip it — the old absolutely-positioned
  // menu was cut off / hidden behind the left nav rail.
  const [accountMenuPos, setAccountMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const accountRef = useRef<HTMLDivElement>(null)
  const accountBtnRef = useRef<HTMLButtonElement>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed)) return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed))
    }
    return DEFAULT_WIDTH
  })
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current) return
    const delta = e.clientX - startXRef.current
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
    setWidth(next)
  }, [])

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setWidth((w) => {
      localStorage.setItem(STORAGE_KEY, String(w))
      return w
    })
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseMove])

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = width
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [width, handleMouseMove, handleMouseUp])

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const handleOpenFolder = async () => {
    const path = await window.electronAPI.openFolder()
    if (path) onSetProject(path)
  }

  const authReady = auth
    ? auth.mode === 'api-key'
      ? auth.hasApiKey
      : auth.claudeCodeDetected || auth.hasApiKey
    : false

  const authLabel = !auth
    ? 'Checking…'
    : auth.mode === 'claude-code'
      ? auth.claudeCodeDetected
        ? 'Claude Code account'
        : auth.hasApiKey
          ? 'API key (no Claude Code login)'
          : 'Not connected'
      : auth.hasApiKey
        ? 'API key'
        : 'No API key'

  // Surface the account currently IN EFFECT: the active chat's account, falling back to
  // the default account of whichever provider the app-wide default model belongs to. That
  // way opening a chat bound to another account (e.g. from Projects) moves the row, its
  // usage badge and the session list onto that account instead of silently disagreeing
  // with the chat on screen. The Claude default account also counts as ready when the
  // global connection is (e.g. an API key), even if its own OAuth file isn't present;
  // other accounts are ready only once logged in (or already flagged as the machine
  // default).
  const idFor = (provider: ProviderId, fallback?: string): string =>
    idForAccount(provider, selectedProvider, selectedAccountId, fallback)
  const currentClaudeId = idFor('claude', defaultAccountId)
  const currentCodexId = idFor('codex', codexDefaultAccountId)
  const currentGeminiId = idFor('gemini', geminiDefaultAccountId)
  const currentAccount =
    selectedProvider === 'codex'
      ? codexAccounts.find((a) => a.id === currentCodexId)
      : selectedProvider === 'gemini'
        ? geminiAccounts.find((a) => a.id === currentGeminiId)
        : accounts.find((a) => a.id === currentClaudeId)
  const ready = currentAccount
    ? currentAccount.isDefault
      ? currentAccount.loggedIn || (selectedProvider === 'claude' && authReady)
      : currentAccount.loggedIn
    : selectedProvider === 'claude' && authReady
  const accountDetail = currentAccount?.loggedIn
    ? [currentAccount.email, currentAccount.plan].filter(Boolean).join(' · ')
    : ''
  // The pill shows just the account name — email/plan live in the tooltip, so the
  // ~200px row never ellipsizes mid-email against the usage badge.
  const statusLabel = currentAccount
    ? currentAccount.name + (ready ? '' : ' · not logged in')
    : authLabel
  // The row doubles as a (grouped, cross-provider) account picker whenever more than one
  // account exists anywhere — Codex/Gemini always have a default, so this lets users
  // switch providers even before Claude has multiple logins. Otherwise it just opens
  // connection settings.
  const totalAccounts = accounts.length + codexAccounts.length + geminiAccounts.length
  const isAccountPicker = totalAccounts > 1
  const statusTitle =
    (accountDetail ? `${accountDetail} — ` : '') +
    (isAccountPicker ? 'Switch default account' : 'Open connection settings')

  // Toggle the (portaled) account picker, anchoring the fixed-position menu under the
  // account row. Closing just flips the flag.
  const toggleAccountMenu = () => {
    if (accountMenuOpen) {
      setAccountMenuOpen(false)
      return
    }
    const r = accountBtnRef.current?.getBoundingClientRect()
    if (!r) return
    setAccountMenuPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setAccountMenuOpen(true)
  }

  // Close the account picker on outside click / Escape (mirrors AccountPicker). The menu
  // lives outside `accountRef` (portal), so check both refs before dismissing. A fixed
  // menu doesn't follow its anchor, so also close on outside scroll / resize.
  useEffect(() => {
    if (!accountMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (accountRef.current?.contains(t) || accountMenuRef.current?.contains(t)) return
      setAccountMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountMenuOpen(false)
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && accountMenuRef.current?.contains(e.target)) return
      setAccountMenuOpen(false)
    }
    const onResize = () => setAccountMenuOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [accountMenuOpen])

  // Blank "New chat" drafts (no messages yet) stay out of the list, and chats are
  // scoped to the selected provider + account. See src/renderer/src/lib/account-scope.ts
  // for provOf/acctOf/visibleSessions — the logic (including the "fallbacks mirror how
  // an unbound chat actually RUNS" comment) lives there now, so it can be unit-tested
  // outside of React.
  const accountDefaults: AccountDefaults = { defaultAccountId, codexDefaultAccountId, geminiDefaultAccountId }
  const currentAccountId =
    selectedProvider === 'codex' ? currentCodexId : selectedProvider === 'gemini' ? currentGeminiId : currentClaudeId
  // The in-effect account's own usage, shown as a badge on the collapsed row. Claude and
  // Codex each have their own usage source; Gemini (Antigravity) has none to show.
  const currentUsage =
    selectedProvider === 'claude'
      ? accountUsage?.[currentAccountId]
      : selectedProvider === 'codex'
        ? codexAccountUsage?.[currentAccountId]
        : undefined
  const visibleSessions = visibleSessionsFor(sessions, models, selectedProvider, currentAccountId, accountDefaults)

  // ── Session search ──────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Debounce so typing doesn't re-filter (and re-scan every message) on every keystroke
  // for people with a lot of history.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 150)
    return () => clearTimeout(t)
  }, [searchInput])

  const clearSearch = () => {
    setSearchInput('')
    setSearchQuery('')
  }

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return visibleSessions
    return visibleSessions.filter((s) => {
      if (s.name?.toLowerCase().includes(q)) return true
      const base = s.projectPath?.split(/[\\/]/).filter(Boolean).pop()
      if (base?.toLowerCase().includes(q)) return true
      return s.messages.some(
        (m) => (m.role === 'user' || m.role === 'assistant') && m.content?.toLowerCase().includes(q)
      )
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSessions, searchQuery])

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div className="sidebar" style={{ width, flex: '0 0 auto' }}>
      <div className="sidebar-account" ref={accountRef}>
        <button
          ref={accountBtnRef}
          className={`auth-status ${ready ? 'ok' : 'warn'}`}
          onClick={isAccountPicker ? toggleAccountMenu : onOpenSettings}
          title={statusTitle}
          aria-haspopup={isAccountPicker ? 'listbox' : undefined}
          aria-expanded={isAccountPicker ? accountMenuOpen : undefined}
        >
          <span className={`auth-dot ${ready ? 'ok' : 'warn'}`} />
          {currentAccount && <ProviderIcon provider={selectedProvider} />}
          <span className="auth-label">{statusLabel}</span>
          {currentUsage && (
            <span
              className={`plan-badge ${currentUsage.utilization >= 90 ? 'danger' : currentUsage.utilization >= 70 ? 'warn' : 'ok'}`}
              title={`${statusLabel} — ${currentUsage.utilization.toFixed(0)}% used${currentUsage.resetsAt ? ` · ${fmtReset(currentUsage.resetsAt)}` : ''}`}
            >
              {currentUsage.utilization.toFixed(0)}%
            </span>
          )}
          {isAccountPicker && (
            <svg className="auth-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
          {!ready && <span className="auth-cta">Connect</span>}
        </button>
        {isAccountPicker && accountMenuOpen && accountMenuPos &&
          createPortal(
            <div
              className="account-picker-menu sidebar-account-menu"
              role="listbox"
              ref={accountMenuRef}
              style={{
                position: 'fixed',
                top: accountMenuPos.top,
                left: accountMenuPos.left,
                right: 'auto',
                minWidth: Math.max(accountMenuPos.width, 220),
                zIndex: 200
              }}
            >
              {(() => {
                let seenGroup = false
                return (
                  [
                    ['Claude', 'claude' as ProviderId, accounts, currentClaudeId],
                    ['Codex', 'codex' as ProviderId, codexAccounts, currentCodexId],
                    ['Gemini', 'gemini' as ProviderId, geminiAccounts, currentGeminiId]
                  ] as const
                ).map(([label, provider, list, currentId]) => {
                  if (list.length === 0) return null
                  const isFirstGroup = !seenGroup
                  seenGroup = true
                  return (
                  <div key={provider}>
                    <div className={`account-picker-group-label ${isFirstGroup ? '' : 'not-first'}`}>{label}</div>
                    {list.map((a) => {
                      const usage =
                        provider === 'claude'
                          ? accountUsage?.[a.id]
                          : provider === 'codex'
                            ? codexAccountUsage?.[a.id]
                            : undefined
                      const selected = provider === selectedProvider && a.id === currentId
                      return (
                        <button
                          key={a.id}
                          className={`account-picker-item ${selected ? 'selected' : ''}`}
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            onPickAccount(provider, a.id)
                            setAccountMenuOpen(false)
                          }}
                        >
                          <div className="account-picker-item-main">
                            <span className={`account-dot ${a.loggedIn ? 'ok' : 'warn'}`} />
                            <ProviderIcon provider={provider} />
                            <span className="account-picker-item-name">{a.name}</span>
                            {usage && (
                              <span
                                className={`plan-badge ${usage.utilization >= 90 ? 'danger' : usage.utilization >= 70 ? 'warn' : 'ok'}`}
                                title={`${usage.utilization.toFixed(0)}% used${usage.resetsAt ? ` · ${fmtReset(usage.resetsAt)}` : ''}`}
                              >
                                {usage.utilization.toFixed(0)}%
                              </span>
                            )}
                            {selected && (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                })
              })()}
              <button
                className="account-picker-manage"
                onClick={() => {
                  setAccountMenuOpen(false)
                  onManageAccounts()
                }}
              >
                Manage accounts…
              </button>
            </div>,
            document.body
          )}
      </div>

      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'sessions' ? 'active' : ''}`}
          onClick={() => onTabChange('sessions')}
        >
          Chats
        </button>
        <button
          className={`sidebar-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => onTabChange('files')}
        >
          Files
        </button>
        {tab === 'sessions' && (
          <div className="sidebar-tab-actions">
            {onNewQuickChat && (
              <button
                className="icon-btn"
                onClick={onNewQuickChat}
                title="Quick chat (cheapest model)"
                aria-label="Quick chat with the cheapest model"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </button>
            )}
            <button className="icon-btn" onClick={onNewSession} title="New chat" aria-label="New chat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-content">
        {tab === 'sessions' ? (
          <>
            {(visibleSessions.length >= 5 || searchQuery) && (
              <div className="session-search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="session-search-icon">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="session-search-input"
                  placeholder="Search chats…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      clearSearch()
                      searchInputRef.current?.blur()
                    }
                  }}
                  aria-label="Search chats"
                />
                {searchInput && (
                  <button
                    className="session-search-clear"
                    onClick={clearSearch}
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            )}
            <div className="session-list">
              {visibleSessions.length === 0 && (
                <div className="empty-state session-empty">
                  No chats yet — send your first message and it will show up here.
                </div>
              )}
              {visibleSessions.length > 0 && filteredSessions.length === 0 && (
                <div className="empty-state session-empty">No sessions match.</div>
              )}
              {filteredSessions.map((s) => {
                // Status dot: approval waiting > running > last-message error. At most one.
                const lastMsg = s.messages[s.messages.length - 1]
                const status = attentionIds.has(s.id)
                  ? 'attention'
                  : runningIds.has(s.id)
                    ? 'running'
                    : lastMsg?.error
                      ? 'error'
                      : null
                const statusTitle =
                  status === 'attention' ? 'Waiting for approval'
                    : status === 'running' ? 'Running'
                      : status === 'error' ? 'Ended with an error' : ''
                return (
                <div
                  key={s.id}
                  className={`session-item ${s.id === activeId ? 'active' : ''}`}
                  onClick={() => onSelectSession(s.id)}
                  onMouseEnter={() => setHoveredId(s.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <div className="session-name">
                    {status && <span className={`session-dot ${status}`} title={statusTitle} />}
                    {s.name || 'New chat'}
                  </div>
                  <div className="session-meta">
                    {s.projectPath && (
                      <span className="session-project" title={s.projectPath}>
                        {s.projectPath.split(/[\\/]/).pop()}
                      </span>
                    )}
                    <span className="session-date">{formatDate(s.updatedAt)}</span>
                    {hoveredId === s.id && (
                      <button
                        className="session-delete"
                        onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }}
                        title="Delete"
                        aria-label="Delete session"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {(() => {
                    const modelLabel = s.model && s.model !== defaultModel ? shortModelLabel(s.model) : null
                    const accountLabel = accounts.length > 1 && s.accountId && s.accountId !== defaultAccountId
                      ? (s.accountName || accounts.find((a) => a.id === s.accountId)?.name || null)
                      : null
                    if (!modelLabel && !accountLabel) return null
                    return (
                      <div className="session-badges">
                        {modelLabel && <span className="session-badge model">{modelLabel}</span>}
                        {accountLabel && <span className="session-badge account">{accountLabel}</span>}
                      </div>
                    )
                  })()}
                </div>
                )
              })}
            </div>
            <button className="sidebar-explore" onClick={onExploreProjects}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Explore all chats
            </button>
          </>
        ) : (
          <>
            <div className="sidebar-section-header">
              <span>{projectPath ? projectPath.split(/[\\/]/).pop() : 'No folder'}</span>
              <button className="icon-btn" onClick={handleOpenFolder} title="Open folder" aria-label="Open folder">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
            {projectPath ? (
              <FileTree rootPath={projectPath} onOpenFile={onOpenFile} selectedPath={openFilePath} />
            ) : (
              <div className="empty-state">
                <button className="open-folder-btn" onClick={handleOpenFolder}>
                  Open a folder
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="sidebar-resize-handle" onMouseDown={handleResizeMouseDown} />
    </div>
  )
}
