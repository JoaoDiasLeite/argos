// Settings, as a screen.
//
// It was a single scrolling modal, and the appearance model outgrew it: thirty presets,
// two independently themed sides, three fonts and two sizes do not fit in a 420px dialog
// that also has to hold auth, system integration and the updater. So it owns the content
// area now — its own nav column where the chat Sidebar would be, with the icon rail left
// where it is. Permissions / Hooks / Session notifications open as sheets from within it.
//
// Everything here reads a prop and writes through a callback, with two deliberate
// exceptions kept from the modal: `system` and `updater` are fetched here rather than
// threaded through App.tsx, because App has never held them and nothing else needs them.

import { useEffect, useRef, useState } from 'react'
import {
  CCAccountStatus,
  ClaudeHooks,
  ClaudePermissions,
  ModelInfo,
  ProviderAccountStatus,
  SystemPrefs,
  UiPrefs,
  UiPrefsPatch,
  UpdaterState
} from '../types'
import ModelPicker from '../components/ModelPicker'
import PermissionsModal from '../components/PermissionsModal'
import HooksModal from '../components/HooksModal'
import NotifyHookModal from '../components/NotifyHookModal'
import ChangelogModal from '../components/ChangelogModal'
import AppearanceSettings from '../components/AppearanceSettings'
import './views.css'
import './SettingsView.css'
import Select from '../components/Select'

type SectionId = 'appearance' | 'general' | 'connection' | 'system' | 'ops' | 'about'

interface Props {
  models: ModelInfo[]
  defaultModel: string
  onSetDefaultModel: (modelId: string) => void
  ui: UiPrefs | null
  onSetUi: (patch: UiPrefsPatch) => void
  onManageAccounts: () => void
  /** For the Accounts row's current value; App.tsx already holds them. */
  accounts?: CCAccountStatus[]
  defaultAccountId?: string
  codexAccounts?: ProviderAccountStatus[]
  /** Back to whatever view this screen displaced — App.tsx remembers which. */
  onBack: () => void
}

const SECTIONS: { id: SectionId; label: string; icon: JSX.Element }[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
      </>
    )
  },
  {
    id: 'general',
    label: 'General',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
      </>
    )
  },
  {
    id: 'connection',
    label: 'Connection',
    icon: (
      <>
        <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </>
    )
  },
  {
    id: 'system',
    label: 'System',
    icon: (
      <>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    )
  },
  {
    id: 'ops',
    label: 'Ops audit',
    icon: (
      <>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
        <polyline points="9 12 11 14 15 10" />
      </>
    )
  },
  {
    id: 'about',
    label: 'About',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </>
    )
  }
]

const isWindows = window.electronAPI.platform === 'win32'

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Ledger files are named by UTC day, so "today" must be the UTC date, not the local one.
const utcToday = () => new Date().toISOString().slice(0, 10)

export default function SettingsView({
  models,
  defaultModel,
  onSetDefaultModel,
  ui,
  onSetUi,
  onManageAccounts,
  accounts,
  defaultAccountId,
  codexAccounts,
  onBack
}: Props) {
  const [section, setSection] = useState<SectionId>('appearance')
  const pane = useRef<HTMLDivElement>(null)

  // Switching section is a page change, not a scroll — landing halfway down System
  // because Appearance was scrolled is the one thing a nav like this gets wrong.
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 })
  }, [section])

  // ── Ops audit ──
  const [ledger, setLedger] = useState<{ dir: string; files: number; bytes: number } | null>(null)
  const [verifyDate, setVerifyDate] = useState(utcToday)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; lines: number } | { ok: false; brokenAt?: number; reason: string } | null
  >(null)
  const [dirCopied, setDirCopied] = useState(false)

  useEffect(() => {
    if (section !== 'ops') return
    let cancelled = false
    window.electronAPI
      .opsLedgerInfo()
      .then((info) => !cancelled && setLedger(info))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [section])

  const verifyLedger = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      setVerifyResult(await window.electronAPI.opsVerify(verifyDate))
    } catch (e) {
      setVerifyResult({ ok: false, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setVerifying(false)
    }
  }

  const copyLedgerDir = async () => {
    if (!ledger) return
    try {
      await navigator.clipboard.writeText(ledger.dir)
      setDirCopied(true)
      setTimeout(() => setDirCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const [showPerms, setShowPerms] = useState(false)
  const [showHooks, setShowHooks] = useState(false)
  const [showNotifyHook, setShowNotifyHook] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)

  // ── Chats from before 2.0 ──
  // How many SDK chats the startup migration exported as Markdown. Fetched here, like
  // `system` below: nothing else in the app needs it.
  const [archivedChats, setArchivedChats] = useState(0)
  useEffect(() => {
    window.electronAPI
      .sessionMigrationInfo()
      .then((info) => setArchivedChats(info.state?.exported ?? 0))
      .catch(() => {})
  }, [])

  // ── System integration ──
  // These prefs live in config.ts alongside `ui`, but App.tsx has never fetched them;
  // they are read here so App's props stay untouched. `registeredShortcut` reflects what
  // the OS actually granted, which can differ from the requested accelerator.
  const [system, setSystem] = useState<SystemPrefs | null>(null)
  const [registeredShortcut, setRegisteredShortcut] = useState('')
  const [systemBusy, setSystemBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getConfig().then((cfg) => {
      if (!cancelled) setSystem(cfg.system)
    })
    window.electronAPI.overlayShortcut().then((s) => {
      if (!cancelled) setRegisteredShortcut(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const updateSystem = async (patch: Partial<SystemPrefs>) => {
    setSystemBusy(true)
    try {
      const res = await window.electronAPI.setSystemPrefs(patch)
      setSystem(res.system)
      setRegisteredShortcut(res.registeredShortcut)
    } finally {
      setSystemBusy(false)
    }
  }

  // ── About / auto-update ──
  // Subscribed for as long as the screen is open, because a check can complete long
  // after it was started — the 4-hourly background one, for instance.
  const [updater, setUpdater] = useState<UpdaterState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.updaterState().then((s) => {
      if (!cancelled) setUpdater(s)
    })
    const off = window.electronAPI.onUpdaterEvent((s) => {
      if (!cancelled) setUpdater((prev) => ({ ...(prev ?? s), ...s }))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const checkForUpdates = async () => {
    setChecking(true)
    try {
      const s = await window.electronAPI.updaterCheck()
      setUpdater(s)
    } finally {
      setChecking(false)
    }
  }

  const updaterStatusText = (): string => {
    if (!updater) return ''
    switch (updater.state) {
      case 'disabled':
        return 'Updates are managed manually in dev builds.'
      case 'checking':
        return 'Checking for updates.'
      case 'available':
        return `Downloading v${updater.version ?? ''}.`
      case 'not-available':
        return 'Up to date.'
      case 'downloaded':
        return `Update v${updater.version ?? ''} downloaded. Restart to apply.`
      case 'error':
        return updater.error || 'Update check failed.'
      default:
        return ''
    }
  }

  // ── Claude Code rows: the current value, read from the same files the sheets edit ──
  const [permCounts, setPermCounts] = useState<ClaudePermissions | null>(null)
  const [hooks, setHooks] = useState<ClaudeHooks | null>(null)
  const [notifyInstalled, setNotifyInstalled] = useState<boolean | null>(null)

  const loadClaudeCode = () => {
    window.electronAPI.getClaudePermissions().then(setPermCounts).catch(() => {})
    window.electronAPI.getClaudeHooks().then(setHooks).catch(() => {})
    window.electronAPI
      .notifyHookInfo()
      .then((i) => setNotifyInstalled(i.installed))
      .catch(() => {})
  }
  useEffect(loadClaudeCode, [])

  // The sheets write as you edit, so the rows are re-read when one closes.
  const closeSheet = (close: () => void) => () => {
    close()
    loadClaudeCode()
  }

  const permissionsValue = permCounts
    ? `${permCounts.allow.length} allow · ${permCounts.deny.length} deny · ${permCounts.ask.length} ask`
    : undefined
  const hooksValue = (() => {
    if (!hooks) return undefined
    const events = Object.keys(hooks).filter((k) => hooks[k]?.length > 0)
    if (events.length === 0) return 'No hooks'
    const n = events.reduce((sum, k) => sum + hooks[k].reduce((s, e) => s + (e.hooks?.length ?? 0), 0), 0)
    return `${n} ${n === 1 ? 'hook' : 'hooks'} on ${events.length} ${events.length === 1 ? 'event' : 'events'}`
  })()
  const notifyValue =
    notifyInstalled === null
      ? undefined
      : notifyInstalled
        ? 'Wired up · toast when a chat needs you'
        : 'Not wired up'

  // ── Accounts row ──
  const accountsValue = (() => {
    if (!accounts) return undefined
    const n = accounts.length + (codexAccounts?.length ?? 0)
    const def = accounts.find((a) => a.id === defaultAccountId)?.name
    return `${n} ${n === 1 ? 'account' : 'accounts'}${def ? ` · default: ${def}` : ''}`
  })()

  // ── Row builders ──
  const toggleRow = (label: string, hint: string, checked: boolean, onChange: (next: boolean) => void) => (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">{label}</span>
        <span className="help">{hint}</span>
      </div>
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={systemBusy}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={label}
        />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      </label>
    </div>
  )

  const editRow = (label: string, value: string | undefined, onClick: () => void, action = 'Edit') => (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">{label}</span>
        {value && <span className="help">{value}</span>}
      </div>
      <button type="button" className="btn-ghost" onClick={onClick} aria-label={`${action} ${label.toLowerCase()}`}>
        {action}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  )

  return (
    <div className="settings-screen">
      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" className="settings-back" onClick={onBack}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back to app
        </button>

        <h2 className="settings-nav-title">Settings</h2>

        <div className="settings-nav-items">
          {SECTIONS.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`settings-nav-item ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {s.icon}
              </svg>
              {s.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="settings-pane" ref={pane}>
        <div className="settings-column">
          {section === 'appearance' && (
            <>
              <h1 className="settings-title">Appearance</h1>
              {ui ? <AppearanceSettings ui={ui} onSetUi={onSetUi} /> : <p className="help">Loading preferences</p>}
            </>
          )}

          {section === 'general' && (
            <>
              <h1 className="settings-title">General</h1>

              <div className="srow">
                <div className="srow-text">
                  <span className="srow-label">Model for background tasks</span>
                  <span className="help">Runs headless work: standup, sprint backfill and planner assist.</span>
                </div>
                <ModelPicker models={models} value={defaultModel} onChange={onSetDefaultModel} variant="select" />
              </div>

              {ui && (
                <>
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">Density</span>
                      <span className="help">How much breathing room lists and rows get.</span>
                    </div>
                    <div className="seg-control" role="group" aria-label="Density">
                      <button type="button" className={ui.density === 'comfortable' ? 'on' : ''} onClick={() => onSetUi({ density: 'comfortable' })}>
                        Comfortable
                      </button>
                      <button type="button" className={ui.density === 'compact' ? 'on' : ''} onClick={() => onSetUi({ density: 'compact' })}>
                        Compact
                      </button>
                    </div>
                  </div>

                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">Weekly planner</span>
                      <span className="help">Shows the Week mode next to Sprint.</span>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={ui.showWeekPlanner}
                        onChange={(e) => onSetUi({ showWeekPlanner: e.target.checked })}
                        aria-label="Weekly planner"
                      />
                      <span className="toggle-track">
                        <span className="toggle-thumb" />
                      </span>
                    </label>
                  </div>
                </>
              )}

              {archivedChats > 0 && (
                <div className="srow">
                  <div className="srow-text">
                    <span className="srow-label">Chats from before 2.0</span>
                    <span className="help">
                      {archivedChats === 1 ? '1 chat' : `${archivedChats} chats`} saved as Markdown when Argos became
                      terminal-only.
                    </span>
                  </div>
                  <button type="button" className="btn-ghost" onClick={() => void window.electronAPI.openChatExport()}>
                    Open folder
                  </button>
                </div>
              )}

              <div className="eyebrow settings-eyebrow">Claude Code</div>
              {editRow('Permissions', permissionsValue, () => setShowPerms(true))}
              {editRow('Hooks', hooksValue, () => setShowHooks(true))}
              {editRow('Session notifications', notifyValue, () => setShowNotifyHook(true))}
            </>
          )}

          {section === 'connection' && (
            <>
              <h1 className="settings-title">Connection</h1>
              <p className="help settings-lead">
                Which logins this app runs chats under. Claude and Codex each sign in through their own CLI;
                add them under Accounts.
              </p>
              {editRow('Accounts', accountsValue, onManageAccounts, 'Manage')}
            </>
          )}

          {section === 'system' && (
            <>
              <h1 className="settings-title">System</h1>
              {system ? (
                <>
                  {toggleRow(
                    isWindows ? 'Start with Windows' : 'Start at login',
                    'Launch Argos when you sign in.',
                    system.openAtLogin,
                    (openAtLogin) => updateSystem({ openAtLogin })
                  )}
                  {toggleRow(
                    'Start minimized to tray',
                    'Come up in the notification area instead of a window.',
                    system.startMinimized,
                    (startMinimized) => updateSystem({ startMinimized })
                  )}
                  {toggleRow(
                    'Close button hides to tray',
                    'Keeps running chats alive instead of quitting.',
                    system.closeToTray,
                    (closeToTray) => updateSystem({ closeToTray })
                  )}
                  {isWindows &&
                    toggleRow(
                      'Show ‘Open with Argos’ in the Explorer folder menu',
                      'Adds an entry to the right-click menu for folders.',
                      system.explorerContextMenu,
                      (explorerContextMenu) => updateSystem({ explorerContextMenu })
                    )}

                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">Quick launcher shortcut</span>
                      <span className="help">Opens the launcher from anywhere, even when Argos is hidden.</span>
                      {registeredShortcut ? (
                        <span className="help">Registered: {registeredShortcut}</span>
                      ) : (
                        <span className="help settings-error">
                          Could not register a quick-launcher shortcut. It may be in use by another app.
                        </span>
                      )}
                    </div>
                    <Select
                      className="settings-select"
                      value={system.overlayShortcut}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ overlayShortcut: e.target.value })}
                      aria-label="Quick launcher shortcut"
                    >
                      <option value="">Auto (Alt+Space)</option>
                      <option value="Alt+Space">Alt+Space</option>
                      <option value="Ctrl+Shift+Space">Ctrl+Shift+Space</option>
                      <option value="Ctrl+Alt+Space">Ctrl+Alt+Space</option>
                      <option value="Ctrl+Alt+K">Ctrl+Alt+K</option>
                    </Select>
                  </div>
                </>
              ) : (
                <p className="help">Loading system preferences</p>
              )}
            </>
          )}

          {section === 'ops' && (
            <>
              <h1 className="settings-title">Ops audit</h1>
              <p className="help settings-lead">
                The audit log is append-only, written by Argos only, and never deleted by it.
              </p>

              {ledger ? (
                <div className="srow">
                  <div className="srow-text">
                    <span className="srow-label">Audit log folder</span>
                    <code className="settings-path">{ledger.dir}</code>
                    <span className="help">
                      {ledger.files} day {ledger.files === 1 ? 'file' : 'files'} · {humanBytes(ledger.bytes)}
                    </span>
                  </div>
                  <button type="button" className="btn-ghost small" onClick={copyLedgerDir}>
                    {dirCopied ? 'Copied' : 'Copy path'}
                  </button>
                </div>
              ) : (
                <p className="help">Loading</p>
              )}

              <div className="srow settings-verify">
                <div className="srow-text">
                  <span className="srow-label">Verify a day</span>
                  <span className="help">Checks that the day&rsquo;s hash chain is unbroken (UTC).</span>
                  {verifyResult && (
                    <span
                      className={`help settings-result ${verifyResult.ok ? (verifyResult.lines === 0 ? '' : 'ok') : 'err'}`}
                      role="status"
                    >
                      {verifyResult.ok
                        ? verifyResult.lines === 0
                          ? 'No entries'
                          : `Chain intact · ${verifyResult.lines} lines`
                        : verifyResult.brokenAt !== undefined
                          ? `Chain broken at line ${verifyResult.brokenAt}: ${verifyResult.reason}`
                          : `Chain broken: ${verifyResult.reason}`}
                    </span>
                  )}
                </div>
                <input
                  type="date"
                  className="text-input settings-date"
                  value={verifyDate}
                  onChange={(e) => {
                    setVerifyDate(e.target.value)
                    setVerifyResult(null)
                  }}
                  aria-label="Audit log day (UTC)"
                />
                <button type="button" className="btn-ghost" onClick={verifyLedger} disabled={verifying || !verifyDate}>
                  {verifying ? 'Verifying' : 'Verify'}
                </button>
              </div>
            </>
          )}

          {section === 'about' && (
            <>
              <h1 className="settings-title">About</h1>
              {updater ? (
                <div className="srow">
                  <div className="srow-text">
                    <span className="srow-label">Argos v{updater.currentVersion}</span>
                    <span className={`help ${updater.state === 'error' ? 'settings-error' : ''}`}>
                      {updaterStatusText()}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={checkForUpdates}
                    disabled={checking || updater.state === 'disabled' || updater.state === 'checking'}
                  >
                    Check for updates
                  </button>
                  {updater.state === 'downloaded' && (
                    <button type="button" className="btn-primary" onClick={() => window.electronAPI.updaterInstall()}>
                      Restart &amp; update
                    </button>
                  )}
                </div>
              ) : (
                <p className="help">Loading</p>
              )}
              <div className="srow">
                <div className="srow-text">
                  <span className="srow-label">Changelog</span>
                  <span className="help">What changed in each release.</span>
                </div>
                <button type="button" className="btn-ghost" onClick={() => setShowChangelog(true)}>
                  What&apos;s new
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showPerms && <PermissionsModal onClose={closeSheet(() => setShowPerms(false))} />}
      {showHooks && <HooksModal onClose={closeSheet(() => setShowHooks(false))} />}
      {showChangelog && <ChangelogModal onClose={closeSheet(() => setShowChangelog(false))} />}
      {showNotifyHook && <NotifyHookModal onClose={closeSheet(() => setShowNotifyHook(false))} />}
    </div>
  )
}
