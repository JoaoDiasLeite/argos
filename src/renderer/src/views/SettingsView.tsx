// Settings, as a screen.
//
// It was a single scrolling modal, and the appearance model outgrew it: thirty presets,
// two independently themed sides, three fonts and two sizes do not fit in a 420px dialog
// that also has to hold auth, system integration and the updater. So it owns the content
// area now — its own nav column where the chat Sidebar would be, with the icon rail left
// where it is — and Permissions / Hooks / Session notifications stay sub-modals opened
// from within it, exactly as before.
//
// Everything here reads a prop and writes through a callback, with two deliberate
// exceptions kept from the modal: `system` and `updater` are fetched here rather than
// threaded through App.tsx, because App has never held them and nothing else needs them.

import { useEffect, useRef, useState } from 'react'
import { ModelInfo, SystemPrefs, UiPrefs, UiPrefsPatch, UpdaterState } from '../types'
import ModelPicker from '../components/ModelPicker'
import PermissionsModal from '../components/PermissionsModal'
import HooksModal from '../components/HooksModal'
import NotifyHookModal from '../components/NotifyHookModal'
import AppearanceSettings from '../components/AppearanceSettings'
import './views.css'
import './SettingsView.css'

type SectionId = 'appearance' | 'general' | 'connection' | 'system' | 'about'

interface Props {
  models: ModelInfo[]
  defaultModel: string
  onSetDefaultModel: (modelId: string) => void
  ui: UiPrefs | null
  onSetUi: (patch: UiPrefsPatch) => void
  onManageAccounts: () => void
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

export default function SettingsView({
  models,
  defaultModel,
  onSetDefaultModel,
  ui,
  onSetUi,
  onManageAccounts,
  onBack
}: Props) {
  const [section, setSection] = useState<SectionId>('appearance')
  const pane = useRef<HTMLDivElement>(null)

  // Switching section is a page change, not a scroll — landing halfway down System
  // because Appearance was scrolled is the one thing a nav like this gets wrong.
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 })
  }, [section])

  const [showPerms, setShowPerms] = useState(false)
  const [showHooks, setShowHooks] = useState(false)
  const [showNotifyHook, setShowNotifyHook] = useState(false)

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
        return 'Checking…'
      case 'available':
        return `Downloading v${updater.version ?? ''}…`
      case 'not-available':
        return 'Up to date.'
      case 'downloaded':
        return `Update v${updater.version ?? ''} downloaded — restarts to apply.`
      case 'error':
        return updater.error || 'Update check failed.'
      default:
        return ''
    }
  }

  const toggleRow = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (next: boolean) => void
  ) => (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-hint">{hint}</span>
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

  return (
    <div className="settings-screen">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className="settings-back" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back to app
        </button>

        <h2 className="settings-nav-title">Settings</h2>

        <div className="settings-nav-items">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
              {ui ? (
                <AppearanceSettings ui={ui} onSetUi={onSetUi} />
              ) : (
                <p className="field-hint">Loading preferences…</p>
              )}
            </>
          )}

          {section === 'general' && (
            <>
              <h1 className="settings-title">General</h1>

              <section className="settings-card">
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-label">Default model</span>
                    <span className="settings-row-hint">
                      New chats use this model. Change it per-chat from the header. Adaptive
                      thinking, tools enabled (file edits auto-approved).
                    </span>
                  </div>
                  <ModelPicker models={models} value={defaultModel} onChange={onSetDefaultModel} />
                </div>

                {ui && (
                  <>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Density</span>
                        <span className="settings-row-hint">
                          How much breathing room lists and rows get.
                        </span>
                      </div>
                      <div className="seg-control">
                        <button
                          className={ui.density === 'comfortable' ? 'on' : ''}
                          onClick={() => onSetUi({ density: 'comfortable' })}
                        >
                          Comfortable
                        </button>
                        <button
                          className={ui.density === 'compact' ? 'on' : ''}
                          onClick={() => onSetUi({ density: 'compact' })}
                        >
                          Compact
                        </button>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Mode</span>
                        <span className="settings-row-hint">
                          Chat gives you Argos&rsquo;s own composer and transcript. Terminal runs
                          every chat as the CLI itself — no composer, no Quick chat. Also on the
                          toggle at the top of the sidebar.
                        </span>
                      </div>
                      <div className="seg-control">
                        <button
                          className={ui.workMode === 'chat' ? 'on' : ''}
                          onClick={() => onSetUi({ workMode: 'chat' })}
                        >
                          Chat
                        </button>
                        <button
                          className={ui.workMode === 'terminal' ? 'on' : ''}
                          onClick={() => onSetUi({ workMode: 'terminal' })}
                        >
                          Terminal
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </section>

              <section className="settings-card">
                <h3 className="settings-h">Claude Code settings</h3>
                <p className="field-hint">
                  Edit allow / deny / ask lists and lifecycle hooks in{' '}
                  <code className="settings-code">~/.claude/settings.json</code>.
                </p>
                <div className="settings-actions">
                  <button className="btn-secondary small" onClick={() => setShowPerms(true)}>
                    Permissions…
                  </button>
                  <button className="btn-secondary small" onClick={() => setShowHooks(true)}>
                    Hooks…
                  </button>
                  <button className="btn-secondary small" onClick={() => setShowNotifyHook(true)}>
                    Session notifications…
                  </button>
                </div>
              </section>
            </>
          )}

          {section === 'connection' && (
            <>
              <h1 className="settings-title">Connection</h1>
              <p className="settings-lead">
                Which logins this app runs chats under. Claude, Codex and Antigravity each sign
                in through their own CLI — add them under Accounts.
              </p>

              <section className="settings-card">
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-row-label">Accounts</span>
                    <span className="settings-row-hint">
                      Add Claude, Codex and Antigravity logins, and switch which one a chat runs
                      under.
                    </span>
                  </div>
                  <button className="btn-primary small" onClick={onManageAccounts}>
                    Manage accounts…
                  </button>
                </div>
              </section>
            </>
          )}

          {section === 'system' && (
            <>
              <h1 className="settings-title">System</h1>
              {system ? (
                <>
                  <section className="settings-card">
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
                  </section>

                  <section className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Quick launcher shortcut</span>
                        <span className="settings-row-hint">
                          Opens the launcher from anywhere, even when Argos is hidden.
                        </span>
                      </div>
                      <select
                        className="text-input settings-select"
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
                      </select>
                    </div>
                    {registeredShortcut ? (
                      <p className="field-hint">Registered: {registeredShortcut}</p>
                    ) : (
                      <p className="field-hint settings-error">
                        Could not register a quick-launcher shortcut — it may be in use by
                        another app.
                      </p>
                    )}
                  </section>
                </>
              ) : (
                <p className="field-hint">Loading system preferences…</p>
              )}
            </>
          )}

          {section === 'about' && (
            <>
              <h1 className="settings-title">About</h1>
              {updater ? (
                <section className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-label">Argos v{updater.currentVersion}</span>
                      <span className={`settings-row-hint ${updater.state === 'error' ? 'settings-error' : ''}`}>
                        {updaterStatusText()}
                      </span>
                    </div>
                    <div className="settings-actions">
                      <button
                        className="btn-secondary small"
                        onClick={checkForUpdates}
                        disabled={checking || updater.state === 'disabled' || updater.state === 'checking'}
                      >
                        Check for updates
                      </button>
                      {updater.state === 'downloaded' && (
                        <button
                          className="btn-primary small"
                          onClick={() => window.electronAPI.updaterInstall()}
                        >
                          Restart &amp; update
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              ) : (
                <p className="field-hint">Loading…</p>
              )}
            </>
          )}
        </div>
      </div>

      {showPerms && <PermissionsModal onClose={() => setShowPerms(false)} />}
      {showHooks && <HooksModal onClose={() => setShowHooks(false)} />}
      {showNotifyHook && <NotifyHookModal onClose={() => setShowNotifyHook(false)} />}
    </div>
  )
}
