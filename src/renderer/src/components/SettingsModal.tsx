import { useEffect, useRef, useState } from 'react'
import { AuthStatus, AuthMode, ModelInfo, UiPrefs, SystemPrefs, UpdaterState } from '../types'
import ModelPicker from './ModelPicker'
import { useModalA11y } from '../hooks/useModalA11y'
import PermissionsModal from './PermissionsModal'
import HooksModal from './HooksModal'
import NotifyHookModal from './NotifyHookModal'
import './SettingsModal.css'

interface Props {
  auth: AuthStatus | null
  models: ModelInfo[]
  defaultModel: string
  onSetDefaultModel: (modelId: string) => void
  ui: UiPrefs | null
  onSetUi: (patch: Partial<UiPrefs>) => void
  onClose: () => void
  onChanged: () => Promise<AuthStatus> | void
  onManageAccounts: () => void
}

export default function SettingsModal({
  auth,
  models,
  defaultModel,
  onSetDefaultModel,
  ui,
  onSetUi,
  onClose,
  onChanged,
  onManageAccounts
}: Props) {
  const [mode, setMode] = useState<AuthMode>(auth?.mode ?? 'claude-code')
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedKey, setSavedKey] = useState(false)
  const [showPerms, setShowPerms] = useState(false)
  const [showHooks, setShowHooks] = useState(false)
  const [showNotifyHook, setShowNotifyHook] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  // System integration prefs live in config.ts alongside `ui`, but App.tsx doesn't
  // currently fetch/thread them through — fetch them here on mount instead, so
  // App.tsx's props stay untouched. `registeredShortcut` reflects what the OS
  // actually granted (may differ from the requested accelerator).
  const [system, setSystem] = useState<SystemPrefs | null>(null)
  const [registeredShortcut, setRegisteredShortcut] = useState('')
  const [systemBusy, setSystemBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getConfig().then((cfg) => {
      if (cancelled) return
      setSystem(cfg.system)
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

  // About / auto-update: fetch the current state on mount, then subscribe to
  // 'updater:event' pushes for as long as the modal is open (checks can complete
  // long after this modal was opened, e.g. the 4-hourly background check).
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

  const claudeDetected = auth?.claudeCodeDetected ?? false
  const hasApiKey = auth?.hasApiKey ?? false

  const selectMode = async (m: AuthMode) => {
    setMode(m)
    setBusy(true)
    await window.electronAPI.setAuthMode(m)
    await onChanged()
    setBusy(false)
  }

  const saveKey = async () => {
    if (!key.trim()) return
    setBusy(true)
    await window.electronAPI.setApiKey(key.trim())
    await onChanged()
    setBusy(false)
    setSavedKey(true)
    setKey('')
    setTimeout(() => setSavedKey(false), 1500)
  }

  const removeKey = async () => {
    setBusy(true)
    await window.electronAPI.clearApiKey()
    await onChanged()
    setBusy(false)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="settings-modal-title">Connection</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="auth-option-group">
            {/* Claude Code login */}
            <button
              className={`auth-option ${mode === 'claude-code' ? 'selected' : ''}`}
              onClick={() => selectMode('claude-code')}
              disabled={busy}
            >
              <div className="auth-option-radio">
                <span className={mode === 'claude-code' ? 'on' : ''} />
              </div>
              <div className="auth-option-body">
                <div className="auth-option-title">
                  Use my Claude Code account
                  {claudeDetected ? (
                    <span className="status-pill ok">Detected</span>
                  ) : (
                    <span className="status-pill warn">Not found</span>
                  )}
                </div>
                <div className="auth-option-desc">
                  Reuses the login from the Claude Code CLI on this machine — no API key
                  needed. {!claudeDetected && 'Run `claude` once and log in, then reopen this app.'}
                </div>
              </div>
            </button>

            {/* API key */}
            <button
              className={`auth-option ${mode === 'api-key' ? 'selected' : ''}`}
              onClick={() => selectMode('api-key')}
              disabled={busy}
            >
              <div className="auth-option-radio">
                <span className={mode === 'api-key' ? 'on' : ''} />
              </div>
              <div className="auth-option-body">
                <div className="auth-option-title">
                  Use an API key
                  {hasApiKey && <span className="status-pill ok">Saved</span>}
                </div>
                <div className="auth-option-desc">
                  Bills your Anthropic Console account. Stored encrypted in your OS keychain.
                </div>
              </div>
            </button>
          </div>

          <div className="form-group">
            <label>Claude accounts</label>
            <div className="model-setting-row">
              <button className="btn-primary small" onClick={onManageAccounts}>
                Manage accounts…
              </button>
              <span className="field-hint inline">
                Add more Claude logins and switch which one a chat runs under.
              </span>
            </div>
          </div>

          {mode === 'api-key' && (
            <div className="form-group api-key-section">
              <label>Anthropic API Key</label>
              <p className="field-hint">
                Get a key from{' '}
                <a href="https://console.anthropic.com/account/keys" target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>
              </p>
              <div className="key-input-wrapper">
                <input
                  type={show ? 'text' : 'password'}
                  className="key-input"
                  placeholder={hasApiKey ? '•••••••• (saved) — enter to replace' : 'sk-ant-...'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                  spellCheck={false}
                />
                <button className="icon-btn show-btn" onClick={() => setShow((v) => !v)} title={show ? 'Hide' : 'Show'} aria-label={show ? 'Hide key' : 'Show key'}>
                  {show ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="key-actions">
                <button className="btn-primary small" onClick={saveKey} disabled={!key.trim() || busy}>
                  {savedKey ? '✓ Saved' : 'Save key'}
                </button>
                {hasApiKey && (
                  <button className="btn-text" onClick={removeKey} disabled={busy}>
                    Remove saved key
                  </button>
                )}
              </div>
            </div>
          )}

          {ui && (
            <div className="form-group">
              <label>Appearance</label>
              <div className="appearance-grid">
                <div className="seg-field">
                  <span>Theme</span>
                  <div className="seg-control">
                    <button className={ui.theme === 'dark' ? 'on' : ''} onClick={() => onSetUi({ theme: 'dark' })}>Dark</button>
                    <button className={ui.theme === 'light' ? 'on' : ''} onClick={() => onSetUi({ theme: 'light' })}>Light</button>
                  </div>
                </div>
                <div className="seg-field">
                  <span>Density</span>
                  <div className="seg-control">
                    <button className={ui.density === 'comfortable' ? 'on' : ''} onClick={() => onSetUi({ density: 'comfortable' })}>Comfortable</button>
                    <button className={ui.density === 'compact' ? 'on' : ''} onClick={() => onSetUi({ density: 'compact' })}>Compact</button>
                  </div>
                </div>
                <div className="seg-field">
                  <span>Text size</span>
                  <div className="seg-control">
                    <button className={ui.fontSize === 'sm' ? 'on' : ''} onClick={() => onSetUi({ fontSize: 'sm' })}>S</button>
                    <button className={ui.fontSize === 'md' ? 'on' : ''} onClick={() => onSetUi({ fontSize: 'md' })}>M</button>
                    <button className={ui.fontSize === 'lg' ? 'on' : ''} onClick={() => onSetUi({ fontSize: 'lg' })}>L</button>
                  </div>
                </div>
                <div className="seg-field">
                  <span>Open new chats in</span>
                  <div className="seg-control">
                    <button className={ui.defaultChatView === 'chat' ? 'on' : ''} onClick={() => onSetUi({ defaultChatView: 'chat' })}>Chat</button>
                    <button className={ui.defaultChatView === 'terminal' ? 'on' : ''} onClick={() => onSetUi({ defaultChatView: 'terminal' })}>Terminal</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {ui && (
            <div className="form-group">
              <label>Color theme</label>
              <div className="palette-grid">
                {([
                  ['warm-rust', 'Warm Rust', '#141312', '#252320', '#df7a52'],
                  ['graphite-indigo', 'Graphite Indigo', '#121316', '#21242d', '#7c83ff'],
                  ['midnight-violet', 'Midnight Violet', '#0f0e16', '#1e1c2b', '#a78bfa'],
                  ['slate-teal', 'Slate Teal', '#0f1414', '#1e2726', '#2dd4bf'],
                  ['charcoal-amber', 'Charcoal Amber', '#131211', '#242220', '#e3a857'],
                  ['arctic-sky', 'Arctic Sky', '#0f1318', '#1d242e', '#4f9cf5'],
                  ['rose-noir', 'Rose Noir', '#151113', '#261f23', '#ec6a93'],
                  ['evergreen', 'Evergreen', '#0f1411', '#1d2620', '#34d27f'],
                  ['ruby-ember', 'Ruby Ember', '#141110', '#25201f', '#e85c6b'],
                  ['ocean-cyan', 'Ocean Cyan', '#0d1417', '#1a262b', '#25c4dd'],
                  ['harbor', 'Harbor', '#0e1822', '#1d2c3a', '#f9c24a'],
                  ['dusk-copper', 'Dusk Copper', '#14121a', '#27232f', '#d97c52'],
                  ['sage-stone', 'Sage Stone', '#111412', '#20251f', '#8ac06a'],
                  ['solar-dune', 'Solar Dune', '#181411', '#2c2520', '#f5a742']
                ] as const).map(([id, name, b0, b1, ac]) => (
                  <button
                    key={id}
                    className={`palette-swatch ${(ui.palette || 'warm-rust') === id ? 'on' : ''}`}
                    onClick={() => onSetUi({ palette: id })}
                    title={name}
                  >
                    <span className="palette-chip">
                      <span style={{ background: b0 }} />
                      <span style={{ background: b1 }} />
                      <span style={{ background: ac }} />
                    </span>
                    <span className="palette-name">{name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-group model-info">
            <label>Default model</label>
            <div className="model-setting-row">
              <ModelPicker models={models} value={defaultModel} onChange={onSetDefaultModel} />
              <span className="field-hint inline">New chats use this model. Change per-chat from the header.</span>
            </div>
            <p className="field-hint">Adaptive thinking · tools enabled (file edits auto-approved).</p>
          </div>

          <div className="form-group">
            <label>Claude Code settings</label>
            <div className="cc-settings-row">
              <button className="btn-secondary small" onClick={() => setShowPerms(true)}>
                Permissions…
              </button>
              <button className="btn-secondary small" onClick={() => setShowHooks(true)}>
                Hooks…
              </button>
              <button className="btn-secondary small" onClick={() => setShowNotifyHook(true)}>
                Session notifications…
              </button>
              <span className="field-hint inline">
                Edit allow / deny / ask lists and lifecycle hooks in <code className="settings-code">~/.claude/settings.json</code>.
              </span>
            </div>
          </div>

          {system && (
            <div className="form-group">
              <label>System</label>
              <div className="appearance-grid">
                <div className="seg-field">
                  <span>Start with Windows</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={system.openAtLogin}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ openAtLogin: e.target.checked })}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="seg-field">
                  <span>Start minimized to tray</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={system.startMinimized}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ startMinimized: e.target.checked })}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="seg-field">
                  <span>Close button hides to tray</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={system.closeToTray}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ closeToTray: e.target.checked })}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
                <div className="seg-field">
                  <span>Show &lsquo;Open with Argos&rsquo; in the Explorer folder menu</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={system.explorerContextMenu}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ explorerContextMenu: e.target.checked })}
                    />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                </div>
              </div>

              <div className="shortcut-field">
                <div className="seg-field">
                  <span>Quick launcher shortcut</span>
                  <select
                    className="shortcut-select"
                    value={system.overlayShortcut}
                    disabled={systemBusy}
                    onChange={(e) => updateSystem({ overlayShortcut: e.target.value })}
                  >
                    <option value="">Auto (Alt+Space)</option>
                    <option value="Alt+Space">Alt+Space</option>
                    <option value="Ctrl+Shift+Space">Ctrl+Shift+Space</option>
                    <option value="Ctrl+Alt+Space">Ctrl+Alt+Space</option>
                    <option value="Ctrl+Alt+K">Ctrl+Alt+K</option>
                  </select>
                </div>
                {registeredShortcut ? (
                  <p className="field-hint shortcut-status">Registered: {registeredShortcut}</p>
                ) : (
                  <p className="field-hint shortcut-status shortcut-status-error">
                    Could not register a quick-launcher shortcut — it may be in use by another app.
                  </p>
                )}
              </div>
            </div>
          )}

          {updater && (
            <div className="form-group">
              <label>About</label>
              <div className="cc-settings-row">
                <span className="field-hint inline">Argos v{updater.currentVersion}</span>
                <button
                  className="btn-secondary small"
                  onClick={checkForUpdates}
                  disabled={checking || updater.state === 'disabled' || updater.state === 'checking'}
                >
                  Check for updates
                </button>
                {updater.state === 'downloaded' && (
                  <button
                    className="btn-secondary small"
                    onClick={() => window.electronAPI.updaterInstall()}
                  >
                    Restart & update
                  </button>
                )}
              </div>
              <p className={`field-hint ${updater.state === 'error' ? 'shortcut-status-error' : ''}`}>
                {updaterStatusText()}
              </p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>

      {showPerms && <PermissionsModal onClose={() => setShowPerms(false)} />}
      {showHooks && <HooksModal onClose={() => setShowHooks(false)} />}
      {showNotifyHook && <NotifyHookModal onClose={() => setShowNotifyHook(false)} />}
    </div>
  )
}
