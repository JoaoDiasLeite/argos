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
  CompanionCharacter,
  CompanionPrefs,
  ClaudeHooks,
  ClaudePermissions,
  ModelInfo,
  OpsDirs,
  OpsPrefs,
  ProviderAccountStatus,
  SecretStorageState,
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
import ExportProfileModal from '../components/ExportProfileModal'
import ImportProfileModal from '../components/ImportProfileModal'
import type { ImportPreview } from '../../../shared/profile-transfer'
import AppearanceSettings from '../components/AppearanceSettings'
import Hint from '../components/Hint'
import NavRailSettings from '../components/NavRailSettings'
import CompanionVoiceSettings from './CompanionVoiceSettings'
import './views.css'
import './SettingsView.css'
import Select from '../components/Select'
import { migrateRecentRunbooks } from '../lib/runbook-library'
import { useT } from '../i18n'
import { IS_DARWIN, displayAccelerator } from '../lib/platform'
import { AUTO_COMPANION_SHORTCUT, AUTO_LAUNCHER_SHORTCUT } from '../lib/accelerator'
import { useLabs } from '../hooks/useLabs'
import { NO_TAPS, tapVersion } from '../lib/labs-unlock'
import { LANGUAGES, isLanguage, plural, type MessageKey } from '../../../shared/i18n'
import {
  lastSettingsSection,
  rememberSettingsSection,
  settingsSectionOf as sectionOf,
  type SettingsSectionId
} from '../lib/settings-sections'

type SectionId = SettingsSectionId

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
  /** Open on this section (a deep link, e.g. the companion's "Definições"); `n` changes per request. */
  target?: { section: string; n: number } | null
}

const SECTIONS: { id: SectionId; labelKey: MessageKey; icon: JSX.Element }[] = [
  {
    id: 'appearance',
    labelKey: 'settings.section.appearance',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
      </>
    )
  },
  {
    id: 'general',
    labelKey: 'settings.section.general',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
      </>
    )
  },
  {
    id: 'system',
    labelKey: 'settings.section.system',
    icon: (
      <>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    )
  },
  {
    // Argos the desktop pet: the filled paw from the rail.
    id: 'companion',
    labelKey: 'settings.section.companion',
    icon: (
      <>
        <g fill="currentColor" stroke="none">
          <path d="M12 11.6c-1.7 0-2.8 1.7-3.9 3.4-.9 1.3-2.3 2.3-2.3 3.9 0 1.5 1.2 2.4 2.6 2.4 1.3 0 2.2-.6 3.6-.6s2.3.6 3.6.6c1.4 0 2.6-.9 2.6-2.4 0-1.6-1.4-2.6-2.3-3.9-1.1-1.7-2.2-3.4-3.9-3.4z" />
          <ellipse cx="9.6" cy="6.4" rx="1.9" ry="2.6" transform="rotate(-10 9.6 6.4)" />
          <ellipse cx="14.4" cy="6.4" rx="1.9" ry="2.6" transform="rotate(10 14.4 6.4)" />
          <ellipse cx="5.4" cy="11" rx="1.7" ry="2.3" transform="rotate(-30 5.4 11)" />
          <ellipse cx="18.6" cy="11" rx="1.7" ry="2.3" transform="rotate(30 18.6 11)" />
        </g>
      </>
    )
  },
  {
    id: 'ops',
    labelKey: 'settings.section.ops',
    icon: (
      <>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
        <polyline points="9 12 11 14 15 10" />
      </>
    )
  },
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
  onBack,
  target
}: Props) {
  const t = useT()
  // A deep link wins; otherwise Settings reopens on the section it was last on.
  const [section, setSection] = useState<SectionId>(
    () => sectionOf(target?.section) ?? lastSettingsSection() ?? 'appearance'
  )
  useEffect(() => rememberSettingsSection(section), [section])

  useEffect(() => {
    const id = sectionOf(target?.section)
    if (id) setSection(id)
  }, [target])
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
  const [verifyResult, setVerifyResult] = useState<Awaited<ReturnType<typeof window.electronAPI.opsVerify>> | null>(null)
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

  // ── Interventions: where the runbooks are read from, and reports and handovers saved ──
  // `opsPrefs` holds only the custom values (Reset shows when one is set); `opsDirs` the
  // effective folders, defaults resolved by main.
  const [opsPrefs, setOpsPrefsState] = useState<OpsPrefs>({})
  const [opsDirs, setOpsDirs] = useState<OpsDirs | null>(null)
  const [opsDirError, setOpsDirError] = useState<{ key: keyof OpsPrefs; error: string } | null>(null)

  useEffect(() => {
    if (section !== 'ops') return
    let cancelled = false
    // The old start-screen recents become the loose runbooks first, so this list is not
    // empty only because the start screen has not been opened since.
    migrateRecentRunbooks()
      .then(() => Promise.all([window.electronAPI.getConfig(), window.electronAPI.opsDirs()]))
      .then(([config, dirs]) => {
        if (cancelled) return
        setOpsPrefsState(config.ops ?? {})
        setOpsDirs(dirs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [section])

  const patchOpsPrefs = async (key: keyof OpsPrefs, patch: Parameters<typeof window.electronAPI.setOpsPrefs>[0]) => {
    setOpsDirError(null)
    try {
      const r = await window.electronAPI.setOpsPrefs(patch)
      if (r.ok) {
        setOpsPrefsState(r.ops)
        setOpsDirs(r.dirs)
      } else setOpsDirError({ key, error: r.error })
    } catch (e) {
      setOpsDirError({ key, error: e instanceof Error ? e.message : String(e) })
    }
  }

  type OpsFolderKey = 'reportsDir' | 'handoversDir' | 'runbooksDir'
  const OPS_FOLDER: Record<OpsFolderKey, 'reports' | 'handovers' | 'runbooks'> = {
    reportsDir: 'reports',
    handoversDir: 'handovers',
    runbooksDir: 'runbooks'
  }

  const pickOpsDir = async (key: OpsFolderKey) => {
    const dir = await window.electronAPI.openFolder(opsDirs?.[key] ?? undefined)
    if (dir) await patchOpsPrefs(key, { [key]: dir })
  }

  const openOpsDir = async (key: OpsFolderKey) => {
    setOpsDirError(null)
    try {
      const r = await window.electronAPI.opsOpenFolder(OPS_FOLDER[key])
      if (!r.ok) setOpsDirError({ key, error: r.error })
    } catch (e) {
      setOpsDirError({ key, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const removeRunbookFolder = (dir: string) =>
    patchOpsPrefs('runbookFolders', { runbookFolders: (opsDirs?.runbookFolders ?? []).filter((p) => p !== dir) })

  const opsErrorLine = (key: keyof OpsPrefs) =>
    opsDirError?.key === key && (
      <span className="help settings-error" role="alert">
        {opsDirError.error}
      </span>
    )

  const opsDirRow = (key: 'reportsDir' | 'handoversDir', label: string) => (
    <div className="srow" key={key}>
      <div className="srow-text">
        <span className="srow-label">{label}</span>
        <code className="settings-path">{opsDirs?.[key] ?? ''}</code>
        {opsErrorLine(key)}
      </div>
      <div className="settings-btn-pair">
        <button type="button" className="btn-ghost small" onClick={() => void pickOpsDir(key)}>
          {t('settings.interventions.change')}
        </button>
        <button type="button" className="btn-ghost small" onClick={() => void openOpsDir(key)}>
          {t('settings.interventions.open')}
        </button>
        {opsPrefs[key] && (
          <button type="button" className="btn-ghost small" onClick={() => void patchOpsPrefs(key, { [key]: null })}>
            {t('settings.interventions.reset')}
          </button>
        )}
      </div>
    </div>
  )

  const runbooksDirRow = () => (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">{t('settings.interventions.runbooksDir')}<Hint text={t('settings.interventions.runbooksDirHelp')} /></span>
        {opsDirs?.runbooksDir ? (
          <code className="settings-path">{opsDirs.runbooksDir}</code>
        ) : (
          <span className="help">{t('settings.interventions.noRunbooksDir')}</span>
        )}
        {opsErrorLine('runbooksDir')}
      </div>
      <div className="settings-btn-pair">
        <button type="button" className="btn-ghost small" onClick={() => void pickOpsDir('runbooksDir')}>
          {t('settings.interventions.change')}
        </button>
        {opsDirs?.runbooksDir && (
          <>
            <button type="button" className="btn-ghost small" onClick={() => void openOpsDir('runbooksDir')}>
              {t('settings.interventions.open')}
            </button>
            <button type="button" className="btn-ghost small" onClick={() => void patchOpsPrefs('runbooksDir', { runbooksDir: null })}>
              {t('settings.interventions.remove')}
            </button>
          </>
        )}
      </div>
    </div>
  )

  const runbookFoldersRow = () => {
    const folders = opsDirs?.runbookFolders ?? []
    return (
      <div className="srow">
        <div className="srow-text">
          <span className="srow-label">{t('settings.interventions.runbookFolders')}</span>
          {folders.length === 0 ? (
            <span className="help">{t('settings.interventions.noRunbookFolders')}</span>
          ) : (
            <ul className="settings-runbook-list">
              {folders.map((dir) => (
                <li key={dir}>
                  <code className="settings-path">{dir}</code>
                  <button type="button" className="btn-ghost small" onClick={() => void removeRunbookFolder(dir)}>
                    {t('settings.interventions.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {opsErrorLine('runbookFolders')}
        </div>
      </div>
    )
  }

  const verifyLedger = async () => {
    setVerifying(true)
    setVerifyResult(null)
    setWeekResult(null)
    try {
      setVerifyResult(await window.electronAPI.opsVerify(verifyDate))
    } catch (e) {
      setVerifyResult({ ok: false, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setVerifying(false)
    }
  }

  // The last seven UTC days in one go: the same per-day check, summed up. An imported
  // day is counted apart, since its chain cannot prove where it was written.
  const [weekResult, setWeekResult] = useState<{
    intact: number
    empty: number
    imported: number
    broken: { date: string; reason: string }[]
  } | null>(null)
  const verifyWeek = async () => {
    setVerifying(true)
    setVerifyResult(null)
    setWeekResult(null)
    const out = { intact: 0, empty: 0, imported: 0, broken: [] as { date: string; reason: string }[] }
    try {
      for (let i = 0; i < 7; i++) {
        const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
        const r = await window.electronAPI.opsVerify(date)
        if (!r.ok) out.broken.push({ date, reason: r.reason })
        else if (r.imported) out.imported++
        else if (r.lines === 0) out.empty++
        else out.intact++
      }
    } catch (e) {
      out.broken.push({ date: utcToday(), reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setWeekResult(out)
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

  // ── Move to another machine ──
  const [showExport, setShowExport] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')

  const startImport = async () => {
    setImportBusy(true)
    setImportError('')
    try {
      const res = await window.electronAPI.profileImportPreview()
      if (res.ok) setImportPreview(res.preview)
      else if (!res.canceled) setImportError(t('settings.import.previewFailed', { error: res.error }))
    } catch (e) {
      setImportError(t('settings.import.previewFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setImportBusy(false)
    }
  }

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

  // ── Companion ──
  // `config.companion`, written through `config:set-companion`, which answers with the
  // summon key the OS actually granted ('' when none could be registered).
  const [companion, setCompanion] = useState<CompanionPrefs | null>(null)
  const [companionShortcut, setCompanionShortcut] = useState('')
  const [companionVoiceShortcut, setCompanionVoiceShortcut] = useState('')
  const [companionBusy, setCompanionBusy] = useState(false)

  useEffect(() => {
    if (section !== 'companion') return
    let cancelled = false
    window.electronAPI.companion
      .state()
      .then((s) => {
        if (cancelled) return
        setCompanion(s.prefs)
        setCompanionShortcut(s.shortcut)
        setCompanionVoiceShortcut(s.voiceShortcut)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [section])

  // Obsidian export (plan §6.2): whether the vault folder looks like a vault, the
  // subfolder as typed (saved on blur), and the last "export the rest" result.
  const [vault, setVault] = useState<{ exists: boolean; isVault: boolean } | null>(null)
  const [obsidianFolder, setObsidianFolder] = useState<string | null>(null)
  const [obsidianResult, setObsidianResult] = useState<{ exported: number; failed: number } | null>(null)
  const obsidianVault = companion?.obsidianVault ?? ''

  useEffect(() => {
    let cancelled = false
    setVault(null)
    if (!obsidianVault) return
    window.electronAPI.companion
      .obsidianInfo(obsidianVault)
      .then((info) => {
        if (!cancelled) setVault(info)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [obsidianVault])

  const pickVault = async () => {
    const dir = await window.electronAPI.openFolder(obsidianVault || undefined)
    if (!dir) return
    setObsidianResult(null)
    await updateCompanion({ obsidianVault: dir })
  }

  const saveObsidianFolder = async () => {
    if (obsidianFolder === null || !companion) return
    await updateCompanion({ obsidianFolder })
    // Main keeps the old value for a folder it refuses; show what was stored.
    setObsidianFolder(null)
  }

  const exportObsidian = async () => {
    setCompanionBusy(true)
    try {
      setObsidianResult(await window.electronAPI.companion.obsidianExport())
    } finally {
      setCompanionBusy(false)
    }
  }

  const updateCompanion = async (patch: Partial<CompanionPrefs>) => {
    setCompanionBusy(true)
    try {
      const res = await window.electronAPI.setCompanionPrefs(patch)
      setCompanion(res.companion)
      setCompanionShortcut(res.registeredShortcut)
      setCompanionVoiceShortcut(res.registeredVoiceShortcut)
    } finally {
      setCompanionBusy(false)
    }
  }

  // ── About / auto-update ──
  // Subscribed for as long as the screen is open, because a check can complete long
  // after it was started — the 4-hourly background one, for instance.
  const [updater, setUpdater] = useState<UpdaterState | null>(null)
  const [checking, setChecking] = useState(false)

  // The hidden "experimental features" switch: seven taps on the version reveal it, and it
  // stays shown while it is on so it can be turned off again.
  const labs = useLabs()
  const [labsRevealed, setLabsRevealed] = useState(false)
  const tapsRef = useRef(NO_TAPS)
  const [tapsLeft, setTapsLeft] = useState<number | null>(null)
  const tapsHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [labsBusy, setLabsBusy] = useState(false)
  useEffect(() => () => {
    if (tapsHintTimer.current) clearTimeout(tapsHintTimer.current)
  }, [])
  const tapVersionLabel = () => {
    const r = tapVersion(tapsRef.current, Date.now())
    tapsRef.current = r.state
    if (r.unlocked) setLabsRevealed(true)
    setTapsLeft(r.remaining)
    if (tapsHintTimer.current) clearTimeout(tapsHintTimer.current)
    if (r.remaining !== null) tapsHintTimer.current = setTimeout(() => setTapsLeft(null), 1500)
  }
  const setLabs = async (on: boolean) => {
    setLabsBusy(true)
    try {
      await window.electronAPI.setLabs(on)
    } finally {
      setLabsBusy(false)
    }
  }

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
        return t('settings.about.updater.disabled')
      case 'checking':
        return t('settings.about.updater.checking')
      case 'available':
        return updater.manual
          ? t('settings.about.updater.availableManual', { version: updater.version ?? '' })
          : t('settings.about.updater.downloading', { version: updater.version ?? '' })
      case 'not-available':
        return t('settings.about.updater.upToDate')
      case 'downloaded':
        return t('settings.about.updater.downloaded', { version: updater.version ?? '' })
      case 'error':
        return updater.error || t('settings.about.updater.failed')
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
    ? t('settings.general.permissions.value', {
        allow: permCounts.allow.length,
        deny: permCounts.deny.length,
        ask: permCounts.ask.length
      })
    : undefined
  const hooksValue = (() => {
    if (!hooks) return undefined
    const events = Object.keys(hooks).filter((k) => hooks[k]?.length > 0)
    if (events.length === 0) return t('settings.general.hooks.none')
    const n = events.reduce((sum, k) => sum + hooks[k].reduce((s, e) => s + (e.hooks?.length ?? 0), 0), 0)
    return t('settings.general.hooks.value', {
      hooks: plural(t, 'settings.general.hooks.count', n),
      events: plural(t, 'settings.general.hooks.events', events.length)
    })
  })()
  const notifyValue =
    notifyInstalled === null
      ? undefined
      : notifyInstalled
        ? t('settings.general.notifications.on')
        : t('settings.general.notifications.off')

  // ── Accounts row ──
  const accountsValue = (() => {
    if (!accounts) return undefined
    const n = accounts.length + (codexAccounts?.length ?? 0)
    const def = accounts.find((a) => a.id === defaultAccountId)?.name
    const count = plural(t, 'settings.connection.accounts.count', n)
    return def ? t('settings.connection.accounts.withDefault', { count, name: def }) : count
  })()

  // ── Row builders ──
  // A global shortcut's state, said only when it needs saying: nothing while the OS
  // granted what was asked for, a warning when it handed out a fallback because the
  // combination was taken, an error when none could be registered.
  const shortcutStatus = (wanted: string, registered: string, failed: string) => {
    if (!registered) return <span className="help settings-error">{failed}</span>
    if (displayAccelerator(registered) === displayAccelerator(wanted)) return null
    return (
      <span className="help settings-warn" role="status">
        {t('settings.shortcut.busy', { wanted: displayAccelerator(wanted), shortcut: displayAccelerator(registered) })}
      </span>
    )
  }

  const toggleRow = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (next: boolean) => void,
    busy = systemBusy
  ) => (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">{label}<Hint text={hint} /></span>
      </div>
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={label}
        />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      </label>
    </div>
  )

  const [secretStorage, setSecretStorage] = useState<SecretStorageState | null>(null)
  useEffect(() => {
    window.electronAPI.sshSecretStorage().then(setSecretStorage).catch(() => {})
  }, [])

  const editRow = (label: string, value: string | undefined, onClick: () => void, action = t('common.edit')) => (
    <div className="srow">
      <div className="srow-text">
        <span className="srow-label">
          {label}
          {value && <span className="srow-value">{value}</span>}
        </span>
      </div>
      <button
        type="button"
        className="btn-ghost small"
        onClick={onClick}
        aria-label={t('settings.row.actionAria', { action, label: label.toLowerCase() })}
      >
        {action}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  )

  return (
    <div className="settings-screen">
      <nav className="settings-nav" aria-label={t('settings.nav.ariaLabel')}>
        <button type="button" className="settings-back" onClick={onBack}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('settings.nav.back')}
        </button>

        <h2 className="settings-nav-title">{t('settings.nav.title')}</h2>

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
              {t(s.labelKey)}
            </button>
          ))}
        </div>

        {/* What used to be the About section: three rows did not earn a page of their own. */}
        <div className="settings-nav-foot">
          {updater && (
            <>
              {/* No affordance on purpose: tapping it is the hidden way in (see tapVersion). */}
              <span className="settings-version" onClick={tapVersionLabel}>
                {t('settings.about.version', { version: updater.currentVersion })}
                {tapsLeft !== null && (
                  <span className="settings-taps-left" role="status">
                    {plural(t, 'settings.about.labs.tapsLeft', tapsLeft)}
                  </span>
                )}
              </span>
              {updaterStatusText() && (
                <span className={`help ${updater.state === 'error' ? 'settings-error' : ''}`}>{updaterStatusText()}</span>
              )}
              <div className="settings-nav-foot-actions">
                <button
                  type="button"
                  className="btn-ghost small"
                  onClick={checkForUpdates}
                  disabled={checking || updater.state === 'disabled' || updater.state === 'checking'}
                >
                  {t('settings.about.checkUpdates')}
                </button>
                {updater.state === 'available' && updater.manual && (
                  <button type="button" className="btn-primary small" onClick={() => window.electronAPI.updaterInstall()}>
                    {t('settings.about.downloadUpdate')}
                  </button>
                )}
                {updater.state === 'downloaded' && (
                  <button type="button" className="btn-primary small" onClick={() => window.electronAPI.updaterInstall()}>
                    {t('settings.about.restartUpdate')}
                  </button>
                )}
                <button type="button" className="btn-ghost small" onClick={() => setShowChangelog(true)}>
                  {t('settings.about.changelog.button')}
                </button>
              </div>
            </>
          )}
          {/* Its explanation as plain text: a tooltip would be clipped by the nav's scroll box. */}
          {(labsRevealed || labs) && (
            <>
              <div className="srow">
                <div className="srow-text">
                  <span className="srow-label">{t('settings.about.labs.label')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={labs}
                    disabled={labsBusy}
                    onChange={(e) => void setLabs(e.target.checked)}
                    aria-label={t('settings.about.labs.label')}
                  />
                  <span className="toggle-track">
                    <span className="toggle-thumb" />
                  </span>
                </label>
              </div>
              <span className="help">{t('settings.about.labs.hint')}</span>
            </>
          )}
          <span className="help settings-credits">
            {t('settings.about.author')}
            <br />
            {t('settings.about.license')}
          </span>
        </div>
      </nav>

      <div className="settings-pane" ref={pane}>
        <div className="settings-column">
          {section === 'appearance' && (
            <>
              <h1 className="settings-title">{t('settings.section.appearance')}</h1>
              {ui ? <AppearanceSettings ui={ui} onSetUi={onSetUi} /> : <p className="help">{t('settings.appearance.loading')}</p>}
            </>
          )}

          {section === 'general' && (
            <>
              <h1 className="settings-title">{t('settings.section.general')}</h1>

              <div className="srow">
                <div className="srow-text">
                  <span className="srow-label">{t('settings.general.backgroundModel.label')}<Hint text={t('settings.general.backgroundModel.hint')} /></span>
                </div>
                <ModelPicker models={models} value={defaultModel} onChange={onSetDefaultModel} variant="select" />
              </div>
              {editRow(t('settings.connection.accounts.label'), accountsValue, onManageAccounts, t('settings.connection.accounts.manage'))}

              {ui && (
                <>
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">{t('settings.general.language.label')}<Hint text={t('settings.general.language.hint')} /></span>
                    </div>
                    <Select
                      className="settings-select"
                      value={ui.language ?? 'en'}
                      onChange={(e) => {
                        if (isLanguage(e.target.value)) onSetUi({ language: e.target.value })
                      }}
                      aria-label={t('settings.general.language.label')}
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.id} value={l.id} lang={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* What the rail shows and where the app opens. The weekly planner sits
                      here too: it is also a choice about what navigation offers. */}
                  <div className="eyebrow settings-eyebrow">{t('settings.general.navRail.eyebrow')}</div>
                  <NavRailSettings ui={ui} onSetUi={onSetUi} />
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">{t('settings.general.weekPlanner.label')}<Hint text={t('settings.general.weekPlanner.hint')} /></span>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={ui.showWeekPlanner}
                        onChange={(e) => onSetUi({ showWeekPlanner: e.target.checked })}
                        aria-label={t('settings.general.weekPlanner.label')}
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
                    <span className="srow-label">{t('settings.general.archived.label')}</span>
                    <span className="help">{plural(t, 'settings.general.archived.hint', archivedChats)}</span>
                  </div>
                  <button type="button" className="btn-ghost small" onClick={() => void window.electronAPI.openChatExport()}>
                    {t('settings.general.archived.openFolder')}
                  </button>
                </div>
              )}

              <div className="eyebrow settings-eyebrow">Claude Code</div>
              {editRow(t('settings.general.permissions.label'), permissionsValue, () => setShowPerms(true))}
              {editRow(t('settings.general.hooks.label'), hooksValue, () => setShowHooks(true))}
              {editRow(t('settings.general.notifications.label'), notifyValue, () => setShowNotifyHook(true))}
            </>
          )}

          {section === 'system' && (
            <>
              <h1 className="settings-title">{t('settings.section.system')}</h1>
              {system ? (
                <>
                  {/* Three switches about one thing (how Argos starts and what closing does) as
                      chips on one row. On macOS the close button always hides the window, as
                      in any Mac app (main-window-pure.ts), so that chip is not offered. */}
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">
                        {t('settings.system.startClose.label')}
                        <Hint
                          text={[
                            t('settings.system.startup.hint'),
                            t(IS_DARWIN ? 'settings.system.minimized.hintMac' : 'settings.system.minimized.hint'),
                            IS_DARWIN ? '' : t('settings.system.closeToTray.hint')
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        />
                      </span>
                      <div className="settings-chips" role="group" aria-label={t('settings.system.startClose.label')}>
                        <button
                          type="button"
                          className={`settings-chip${system.openAtLogin ? ' on' : ''}`}
                          aria-pressed={system.openAtLogin}
                          disabled={systemBusy}
                          onClick={() => updateSystem({ openAtLogin: !system.openAtLogin })}
                        >
                          {isWindows ? t('settings.system.startup.labelWindows') : t('settings.system.startup.label')}
                        </button>
                        <button
                          type="button"
                          className={`settings-chip${system.startMinimized ? ' on' : ''}`}
                          aria-pressed={system.startMinimized}
                          disabled={systemBusy}
                          onClick={() => updateSystem({ startMinimized: !system.startMinimized })}
                        >
                          {t(IS_DARWIN ? 'settings.system.minimized.labelMac' : 'settings.system.minimized.label')}
                        </button>
                        {!IS_DARWIN && (
                          <button
                            type="button"
                            className={`settings-chip${system.closeToTray ? ' on' : ''}`}
                            aria-pressed={system.closeToTray}
                            disabled={systemBusy}
                            onClick={() => updateSystem({ closeToTray: !system.closeToTray })}
                          >
                            {t('settings.system.closeToTray.label')}
                          </button>
                          )}
                      </div>
                    </div>
                  </div>
                  {isWindows &&
                    toggleRow(
                      t('settings.system.explorerMenu.label'),
                      t('settings.system.explorerMenu.hint'),
                      system.explorerContextMenu,
                      (explorerContextMenu) => updateSystem({ explorerContextMenu })
                    )}

                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">{t('settings.system.shortcut.label')}<Hint text={t('settings.system.shortcut.hint')} /></span>
                      {shortcutStatus(system.overlayShortcut || AUTO_LAUNCHER_SHORTCUT, registeredShortcut, t('settings.system.shortcut.failed'))}
                    </div>
                    <Select
                      className="settings-select"
                      value={system.overlayShortcut}
                      disabled={systemBusy}
                      onChange={(e) => updateSystem({ overlayShortcut: e.target.value })}
                      aria-label={t('settings.system.shortcut.label')}
                    >
                      <option value="">{t('settings.system.shortcut.auto', { shortcut: displayAccelerator(AUTO_LAUNCHER_SHORTCUT) })}</option>
                      <option value="Alt+Space">{displayAccelerator('Alt+Space')}</option>
                      <option value="Ctrl+Shift+Space">{displayAccelerator('Ctrl+Shift+Space')}</option>
                      <option value="Ctrl+Alt+Space">{displayAccelerator('Ctrl+Alt+Space')}</option>
                      <option value="Ctrl+Alt+K">{displayAccelerator('Ctrl+Alt+K')}</option>
                    </Select>
                  </div>
                </>
              ) : (
                <p className="help">{t('settings.system.loading')}</p>
              )}

              {secretStorage && (
                <div className="srow">
                  <div className="srow-text">
                    <span className="srow-label">
                      {t('settings.connection.secrets.label')}
                      <span className="srow-value">
                        {secretStorage.encrypted ? t('settings.connection.secrets.encrypted') : t('settings.connection.secrets.plain')}
                      </span>
                    </span>
                  </div>
                </div>
              )}

              <div className="eyebrow settings-eyebrow">{t('settings.transfer.eyebrow')}</div>
              <div className="srow">
                <div className="srow-text">
                  <span className="srow-label">{t('settings.transfer.label')}<Hint text={t('settings.transfer.hint')} /></span>
                  {importError && <span className="help settings-error">{importError}</span>}
                </div>
                <div className="settings-btn-pair">
                  <button type="button" className="btn-ghost small" onClick={() => setShowExport(true)}>
                    {t('settings.transfer.export')}
                  </button>
                  <button type="button" className="btn-ghost small" disabled={importBusy} onClick={startImport}>
                    {t('settings.transfer.import')}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === 'companion' && (
            <>
              <h1 className="settings-title">{t('settings.section.companion')}</h1>
              <p className="help settings-lead">{t('settings.companion.intro')}</p>
              {/* Reminders need the app running (plan §10, decision 8): nudge towards
                  starting with the system while that is off, through the System pref. */}
              {system && !system.openAtLogin && (
                <p className="help settings-notice">
                  {t('settings.companion.login.hint')}{' '}
                  <button type="button" className="settings-link" disabled={systemBusy} onClick={() => updateSystem({ openAtLogin: true })}>
                    {isWindows ? t('settings.companion.login.action') : t('settings.companion.login.actionOther')}
                  </button>
                </p>
              )}
              {companion ? (
                <>
                  <div className="settings-groups">
                  <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">{t('settings.companion.group.presence')}</div>
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">
                        {t('settings.companion.look.label')}
                        <Hint text={t('settings.companion.character.hint') + ' ' + t('settings.companion.size.hint')} />
                      </span>
                    </div>
                    <div className="settings-fields">
                      <Select
                        className="settings-select-s"
                        value={companion.character}
                        disabled={companionBusy}
                        onChange={(e) => updateCompanion({ character: e.target.value as CompanionCharacter })}
                        aria-label={t('settings.companion.look.animal')}
                      >
                        <option value="dog">{t('settings.companion.character.dog')}</option>
                        <option value="ferret">{t('settings.companion.character.ferret')}</option>
                      </Select>
                      <Select
                        className="settings-select-s"
                        value={companion.size}
                        disabled={companionBusy}
                        onChange={(e) => updateCompanion({ size: e.target.value as CompanionPrefs['size'] })}
                        aria-label={t('settings.companion.size.label')}
                      >
                        <option value="small">{t('settings.companion.size.small')}</option>
                        <option value="normal">{t('settings.companion.size.normal')}</option>
                        <option value="large">{t('settings.companion.size.large')}</option>
                      </Select>
                    </div>
                  </div>
                  {toggleRow(
                    t('settings.companion.stay.label'),
                    t('settings.companion.stay.hint'),
                    companion.stayOnScreen,
                    (stayOnScreen) => updateCompanion({ stayOnScreen }),
                    companionBusy
                  )}
                  {/* Only with the pet up all day: that is the only time he walks. */}
                  {companion.stayOnScreen &&
                    toggleRow(
                      t('settings.companion.walk.label'),
                      t('settings.companion.walk.hint'),
                      companion.walk,
                      (walk) => updateCompanion({ walk }),
                      companionBusy
                    )}
                  {companion.stayOnScreen &&
                    toggleRow(
                      t('settings.companion.follow.label'),
                      t('settings.companion.follow.hint'),
                      companion.follow,
                      (follow) => updateCompanion({ follow }),
                      companionBusy
                    )}
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">
                        {t('settings.companion.shortcut.label')}
                        <Hint text={t(IS_DARWIN ? 'settings.companion.shortcut.hintMac' : 'settings.companion.shortcut.hint')} />
                      </span>
                      {shortcutStatus(companion.shortcut || AUTO_COMPANION_SHORTCUT, companionShortcut, t('settings.companion.shortcut.failed'))}
                    </div>
                    {/* Never Ctrl+Shift+A: Teams takes it to accept a call (companion-window.ts). */}
                    <Select
                      className="settings-select"
                      value={companion.shortcut}
                      disabled={companionBusy}
                      onChange={(e) => updateCompanion({ shortcut: e.target.value })}
                      aria-label={t('settings.companion.shortcut.label')}
                    >
                      <option value="">{t('settings.companion.shortcut.auto', { shortcut: displayAccelerator(AUTO_COMPANION_SHORTCUT) })}</option>
                      <option value="Ctrl+Alt+A">{displayAccelerator('Ctrl+Alt+A')}</option>
                      <option value="Ctrl+Shift+Alt+A">{displayAccelerator('Ctrl+Shift+Alt+A')}</option>
                      <option value="Ctrl+Alt+Q">{displayAccelerator('Ctrl+Alt+Q')}</option>
                      <option value="Ctrl+Alt+J">{displayAccelerator('Ctrl+Alt+J')}</option>
                    </Select>
                  </div>

                  </div>
                  <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">{t('settings.companion.group.alerts')}</div>
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">
                        {t('settings.companion.alertWhen.label')}
                        <Hint text={t('settings.companion.terminalAlerts.hint') + ' ' + t('settings.companion.planAlerts.hint')} />
                      </span>
                    </div>
                    <div className="settings-chips plain" role="group" aria-label={t('settings.companion.alertWhen.label')}>
                      <button
                        type="button"
                        className={`settings-chip${companion.terminalAlerts ? ' on' : ''}`}
                        aria-pressed={companion.terminalAlerts}
                        disabled={companionBusy}
                        onClick={() => updateCompanion({ terminalAlerts: !companion.terminalAlerts })}
                      >
                        {t('settings.companion.alertWhen.chat')}
                      </button>
                      <button
                        type="button"
                        className={`settings-chip${companion.planAlerts ? ' on' : ''}`}
                        aria-pressed={companion.planAlerts}
                        disabled={companionBusy}
                        onClick={() => updateCompanion({ planAlerts: !companion.planAlerts })}
                      >
                        {t('settings.companion.alertWhen.plan')}
                      </button>
                    </div>
                  </div>
                  {/* macOS Focus cannot be read, but a full-screen app in front can
                      (companion-darwin.ts), so there the row speaks of that alone. */}
                  {toggleRow(
                    t(IS_DARWIN ? 'settings.companion.focusAssist.labelMac' : 'settings.companion.focusAssist.label'),
                    t(IS_DARWIN ? 'settings.companion.focusAssist.hintMac' : 'settings.companion.focusAssist.hint'),
                    companion.focusAssist,
                    (focusAssist) => updateCompanion({ focusAssist }),
                    companionBusy
                  )}

                  </div>
                  <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">{t('settings.companion.group.reminders')}</div>
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">
                        {t('settings.companion.times.label')}
                        <Hint
                          text={
                            t('settings.companion.leadTime.label') + ': ' + t('settings.companion.leadTime.hint') + ' ' +
                            t('settings.companion.morning.label') + ': ' + t('settings.companion.morning.hint')
                          }
                        />
                      </span>
                    </div>
                    <div className="settings-fields">
                      <label className="settings-field">
                        <span className="settings-field-cap">{t('settings.companion.leadTime.label')}</span>
                        <Select
                          className="settings-select-s"
                          value={String(companion.leadMinutes)}
                          disabled={companionBusy}
                          onChange={(e) => updateCompanion({ leadMinutes: Number(e.target.value) })}
                          aria-label={t('settings.companion.leadTime.label')}
                        >
                          {/* A value set by hand in config.json still shows. */}
                          {[...new Set([0, 5, 10, 15, 30, 60, companion.leadMinutes])]
                            .sort((a, b) => a - b)
                            .map((n) => (
                              <option key={n} value={n}>
                                {n === 0
                                  ? t('settings.companion.leadTime.atTime')
                                  : n === 60
                                    ? t('settings.companion.leadTime.hour')
                                    : t('settings.companion.leadTime.minutes', { n })}
                              </option>
                            ))}
                        </Select>
                      </label>
                      <label className="settings-field">
                        <span className="settings-field-cap">{t('settings.companion.morning.label')}</span>
                        <Select
                          className="settings-select-s"
                          value={String(companion.morningHour)}
                          disabled={companionBusy}
                          onChange={(e) => updateCompanion({ morningHour: Number(e.target.value) })}
                          aria-label={t('settings.companion.morning.label')}
                        >
                          {[...new Set([7, 8, 9, 10, 11, companion.morningHour])]
                            .sort((a, b) => a - b)
                            .map((h) => (
                              <option key={h} value={h}>
                                {String(h).padStart(2, '0') + ':00'}
                              </option>
                            ))}
                        </Select>
                      </label>
                    </div>
                  </div>
                  {toggleRow(
                    t('settings.companion.askModel.label'),
                    t('settings.companion.askModel.hint'),
                    companion.askModel,
                    (askModel) => updateCompanion({ askModel }),
                    companionBusy
                  )}

                  </div>
                  <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">{t('settings.companion.group.privacy')}</div>
                  {toggleRow(
                    t('settings.companion.capture.label'),
                    t('settings.companion.capture.hint'),
                    companion.hideFromCapture,
                    (hideFromCapture) => updateCompanion({ hideFromCapture }),
                    companionBusy
                  )}
                  {toggleRow(
                    t('settings.companion.voice.label'),
                    t('settings.companion.voice.hint'),
                    companion.voice,
                    (voice) => updateCompanion({ voice }),
                    companionBusy
                  )}
                  {companion.voice && (
                    <CompanionVoiceSettings
                      prefs={companion}
                      busy={companionBusy}
                      registeredShortcut={companionVoiceShortcut}
                      onChange={(patch) => void updateCompanion(patch)}
                    />
                  )}
                  <div className="srow">
                    <div className="srow-text">
                      <span className="srow-label">{t('settings.companion.obsidian.label')}<Hint text={t('settings.companion.obsidian.hint')} /></span>
                      {obsidianVault ? (
                        <code className="settings-path">{obsidianVault}</code>
                      ) : (
                        <span className="help">{t('settings.companion.obsidian.off')}</span>
                      )}
                      {vault && !vault.exists && (
                        <span className="help settings-error" role="alert">
                          {t('settings.companion.obsidian.missing')}
                        </span>
                      )}
                      {vault?.exists && !vault.isVault && (
                        <span className="help">{t('settings.companion.obsidian.notVault')}</span>
                      )}
                    </div>
                    <div className="settings-btn-pair">
                      <button type="button" className="btn-ghost small" disabled={companionBusy} onClick={() => void pickVault()}>
                        {obsidianVault ? t('settings.companion.obsidian.change') : t('settings.companion.obsidian.choose')}
                      </button>
                      {obsidianVault && (
                        <button
                          type="button"
                          className="btn-ghost small"
                          disabled={companionBusy}
                          onClick={() => {
                            setObsidianResult(null)
                            void updateCompanion({ obsidianVault: '' })
                          }}
                        >
                          {t('settings.companion.obsidian.turnOff')}
                        </button>
                      )}
                    </div>
                  </div>
                  {obsidianVault && (
                    <>
                      <div className="srow">
                        <div className="srow-text">
                          <span className="srow-label">{t('settings.companion.obsidian.folder.label')}<Hint text={t('settings.companion.obsidian.folder.hint')} /></span>
                        </div>
                        <input
                          className="text-input"
                          value={obsidianFolder ?? companion.obsidianFolder}
                          disabled={companionBusy}
                          placeholder={t('settings.companion.obsidian.folder.root')}
                          aria-label={t('settings.companion.obsidian.folder.label')}
                          onChange={(e) => setObsidianFolder(e.target.value)}
                          onBlur={() => void saveObsidianFolder()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                            if (e.key === 'Escape') setObsidianFolder(null)
                          }}
                        />
                      </div>
                      <div className="srow">
                        <div className="srow-text">
                          <span className="srow-label">{t('settings.companion.obsidian.export.label')}</span>
                          <span className="help">
                            {obsidianResult
                              ? obsidianResult.failed
                                ? t('settings.companion.obsidian.export.failed', { n: obsidianResult.exported, failed: obsidianResult.failed })
                                : obsidianResult.exported
                                  ? plural(t, 'settings.companion.obsidian.export.done', obsidianResult.exported)
                                  : t('settings.companion.obsidian.export.none')
                              : t('settings.companion.obsidian.export.hint')}
                          </span>
                        </div>
                        <button type="button" className="btn-ghost small" disabled={companionBusy || !vault?.exists} onClick={() => void exportObsidian()}>
                          {t('settings.companion.obsidian.export.action')}
                        </button>
                      </div>
                    </>
                  )}
                  </div>
                  </div>
                </>
              ) : (
                <p className="help">{t('settings.companion.loading')}</p>
              )}
            </>
          )}

          {section === 'ops' && (
            <>
              <h1 className="settings-title">{t('settings.section.ops')}</h1>
              <div className="settings-groups">
                <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">
                    {t('settings.ops.group.folders')}
                    <Hint text={t('settings.interventions.lead')} />
                  </div>
              {opsDirs ? (
                <>
                  {runbooksDirRow()}
                  {runbookFoldersRow()}
                  {opsDirRow('reportsDir', t('settings.interventions.reports'))}
                  {opsDirRow('handoversDir', t('settings.interventions.handovers'))}
                </>
              ) : (
                <p className="help">{t('common.loading')}</p>
              )}
                </div>
                <div className="settings-group">
                  <div className="eyebrow settings-eyebrow">
                    {t('settings.ops.group.audit')}
                    <Hint text={t('settings.ops.lead')} />
                  </div>
              {ledger ? (
                <div className="srow">
                  <div className="srow-text">
                    <span className="srow-label">{t('settings.ops.folder.label')}</span>
                    <code className="settings-path">{ledger.dir}</code>
                    <span className="help">
                      {t('settings.ops.folder.summary', {
                        files: plural(t, 'settings.ops.folder.files', ledger.files),
                        size: humanBytes(ledger.bytes)
                      })}
                    </span>
                  </div>
                  <div className="settings-btn-pair">
                    <button type="button" className="btn-ghost small" onClick={() => void window.electronAPI.opsOpenFolder('audit')}>
                      {t('settings.interventions.open')}
                    </button>
                    <button type="button" className="btn-ghost small" onClick={copyLedgerDir}>
                      {dirCopied ? t('settings.ops.folder.copied') : t('settings.ops.folder.copy')}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="help">{t('common.loading')}</p>
              )}

              <div className="srow settings-verify">
                <div className="srow-text">
                  <span className="srow-label">{t('settings.ops.verify.label')}<Hint text={t('settings.ops.verify.hint')} /></span>
                  {weekResult && (
                    <span className={`help settings-result ${weekResult.broken.length ? 'err' : weekResult.intact ? 'ok' : ''}`} role="status">
                      {weekResult.broken.length
                        ? weekResult.broken
                            .map((b) => t('settings.ops.verify.weekBroken', { date: b.date, reason: b.reason }))
                            .join(' ')
                        : t('settings.ops.verify.weekOk', {
                            intact: weekResult.intact,
                            empty: weekResult.empty,
                            imported: weekResult.imported
                          })}
                    </span>
                  )}
                  {verifyResult && (
                    <span
                      className={`help settings-result ${verifyResult.ok ? (verifyResult.lines === 0 || verifyResult.imported ? '' : 'ok') : 'err'}`}
                      role="status"
                    >
                      {verifyResult.ok
                        ? verifyResult.lines === 0
                          ? verifyResult.imported
                            ? ''
                            : t('settings.ops.verify.noEntries')
                          : t('settings.ops.verify.intact', { lines: plural(t, 'settings.ops.verify.lines', verifyResult.lines) })
                        : verifyResult.imported
                          ? verifyResult.brokenAt !== undefined
                            ? t('settings.ops.verify.importedBrokenAt', { line: verifyResult.brokenAt, reason: verifyResult.reason })
                            : t('settings.ops.verify.importedBroken', { reason: verifyResult.reason })
                          : verifyResult.brokenAt !== undefined
                            ? t('settings.ops.verify.brokenAt', { line: verifyResult.brokenAt, reason: verifyResult.reason })
                            : t('settings.ops.verify.broken', { reason: verifyResult.reason })}
                      {/* An imported day is never shown as plainly verified: its chain cannot prove where it was written. */}
                      {verifyResult.ok && verifyResult.imported && (
                        <>
                          {verifyResult.lines > 0 && ' · '}
                          {t('settings.ops.verify.imported', { lines: plural(t, 'settings.ops.verify.lines', verifyResult.imported.lines) })}
                          {verifyResult.imported.archive && verifyResult.imported.importedAt && (
                            <>
                              {' '}
                              {t('settings.ops.verify.importedSource', {
                                archive: verifyResult.imported.archive,
                                date: verifyResult.imported.importedAt.slice(0, 10)
                              })}
                            </>
                          )}
                        </>
                      )}
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
                  aria-label={t('settings.ops.verify.dayAria')}
                />
                <button type="button" className="btn-ghost small" onClick={verifyLedger} disabled={verifying || !verifyDate}>
                  {verifying ? t('settings.ops.verify.verifying') : t('settings.ops.verify.button')}
                </button>
                <button type="button" className="btn-ghost small" onClick={verifyWeek} disabled={verifying}>
                  {t('settings.ops.verify.week')}
                </button>
              </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showPerms && <PermissionsModal onClose={closeSheet(() => setShowPerms(false))} />}
      {showHooks && <HooksModal onClose={closeSheet(() => setShowHooks(false))} />}
      {showChangelog && <ChangelogModal onClose={closeSheet(() => setShowChangelog(false))} />}
      {showExport && <ExportProfileModal onClose={() => setShowExport(false)} />}
      {importPreview && <ImportProfileModal preview={importPreview} onClose={() => setImportPreview(null)} />}
      {showNotifyHook && <NotifyHookModal onClose={closeSheet(() => setShowNotifyHook(false))} />}
    </div>
  )
}
