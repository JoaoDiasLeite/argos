import { app, BrowserWindow, ipcMain, dialog, Notification, globalShortcut, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { resolvePolicy } from './ai-policy'
import { getEngine } from './providers/registry'
import { collectText } from './providers/collect'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  loadAuthState,
  setMode,
  setApiKey,
  getApiKey,
  clearApiKey,
  getAuthStatus,
  buildSubprocessEnv,
  AuthMode
} from './auth'
import { loadConfig, getConfig, setDefaultModel, setLimits, setUiPrefs, setSystemPrefs, getClaudeSettings, getClaudePermissions, setClaudePermissions, getClaudeHooks, setClaudeHooks, providerFor, UsageLimits, UiPrefs, SystemPrefs } from './config'
import { buildModelsCatalog } from './models-catalog'
import { getAllProjects, listSessions, readSession, getUsage, listSources, searchSessions } from './claude-data'
import {
  listMcpServers,
  upsertGlobalMcpServer,
  removeGlobalMcpServer,
  mcpServersForProject
} from './mcp'
import { listAgents, saveAgent, deleteAgent, AgentDef } from './agents'
import { listWeeks, getWeek, saveWeek, deleteWeek, WeekPlan } from './planner'
import { listSprints, getSprint, saveSprint, deleteSprint, Sprint } from './sprints'
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  deleteCheckpoint,
  compareCheckpoints,
  exportPatch
} from './checkpoints'
import { getStatus, getDiff, stageFile, unstageFile, stageAll, commit, getLog, createWorktree } from './git'
import { listCommands } from './commands'
import {
  listHosts,
  saveHost,
  deleteHost,
  testConnection,
  testClaude,
  runRemote,
  stopRemote,
  SshHost
} from './ssh'
import { listSshKeys, generateKey, readPublicKey } from './ssh-keys'
import {
  sftpConnect,
  sftpList,
  sftpRead,
  sftpWrite,
  sftpMkdir,
  sftpRename,
  sftpDelete,
  sftpDownload,
  sftpUpload,
  sftpHistory,
  sftpDisconnect,
  sftpDisconnectAll
} from './sftp'
import {
  remoteShellCreate,
  remoteShellWrite,
  remoteShellResize,
  remoteShellKill,
  remoteShellKillAll
} from './remote-shell'
import { listDistros, testDistro, testDistroClaude, runWsl, stopWsl, runWslOneShot, uncToWslPath, wslHistory } from './wsl'
import { readTextFile, fsWriteFile, fsMkdir, fsRename, fsDelete } from './local-fs'
import { getHiddenDistros, setDistroHidden, getRoomsLayout, setRoomsLayout, RoomsLayout } from './store'
import {
  loadAccounts,
  listAccountStatus,
  accountConfigDir,
  addAccount,
  renameAccount,
  removeAccount,
  setDefaultAccount,
  loginAccount
} from './accounts'
import { repairClaudeCliIfBroken } from './claude-cli'
import { migrateUserDataDir } from './migrate-userdata'
import { checkAgentCliStatus, loginAgentCli, AgentCliId } from './agent-clis'
import {
  loadProviderAccounts,
  listProviderAccountStatus,
  providerAccountEnv,
  addProviderAccount,
  renameProviderAccount,
  removeProviderAccount,
  setDefaultProviderAccount,
  loginProviderAccount,
  AgentProvider
} from './provider-accounts'
import {
  listScheduledRuns,
  upsertScheduledRun,
  deleteScheduledRun,
  setScheduledRunEnabled,
  runScheduledRunNow,
  startScheduler,
  ScheduledRun
} from './scheduler'
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killTerminalDeferred,
  startCliInTerminal,
  killAllTerminals
} from './terminal'
import { createOverlayWindow, hideOverlay, toggleOverlay, registerOverlayShortcut, reregisterOverlayShortcut, overlayShortcut } from './overlay'
import { createToastWindow, showToast, hideToast, sendToToast } from './toast'
import { createPillWindow, showPill, hidePill, hidePillSoon, sendToPill } from './pill'
import { successBadge, errorBadge, approvalBadge } from './badges'
import { createTray, updateTrayShortcutLabel } from './tray'
import { initUpdater, getUpdaterState, checkNow, quitAndInstall } from './updater'
import { getPlanUsageForIpc, startPlanUsageWatcher } from './plan-usage'
import { getCodexAccountsUsage } from './codex-usage'
import {
  setExplorerContextMenu,
  removeLegacyExplorerContextMenu,
  extractLaunchAction,
  LaunchAction
} from './shell-integration'
import { refreshJumpList } from './jumplist'
import { readJsonFile } from './json-file'

let mainWindow: BrowserWindow | null = null
// True once the user (or OS) actually intends to exit — lets the close handler
// distinguish "hide to tray" from a real quit.
let isQuitting = false
// Close-to-tray only engages when a tray icon actually exists, so the app can
// never be stranded running invisibly.
let hasTray = false
let trayHintShown = false

// Second launches (e.g. clicking the exe while the app lives in the tray) focus
// the running instance instead of spawning a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, commandLine) => {
    showMainWindow()
    routeLaunchAction(extractLaunchAction(commandLine))
  })
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Turn a --folder / --new-chat launch (from the Explorer menu, Jump List, or CLI)
// into a new chat in the renderer. A folder path only rides along if it still exists;
// otherwise fall through to a plain new chat. sendToMainWindow tolerates a still-
// loading renderer, so this is safe to call before the window has finished loading.
function routeLaunchAction(action: LaunchAction | null): void {
  if (!action) return
  showMainWindow()
  if (action.type === 'folder' && fs.existsSync(action.path)) {
    sendToMainWindow('app:new-chat', action.path)
  } else {
    sendToMainWindow('app:new-chat')
  }
}

// In-flight agent runs keyed by app session id, so we can stop them.
const activeRuns = new Map<string, AbortController>()

// The provider that last ran each app session. A resume token is provider-specific
// (a Claude session id ≠ a Codex thread id ≠ a Gemini session id), so if a session
// switches provider mid-conversation we must NOT feed the old provider's token to
// the new engine — we start it fresh instead. (Reload-then-immediately-switch can't
// be detected here since the token's origin provider isn't persisted; that rare
// case falls back to the engine rejecting an unknown token.)
const sessionProvider = new Map<string, string>()

// True while the main window is destroyed/hidden/minimized/unfocused. When a run
// needs attention (approval, completion) in this state we surface it out-of-window
// via the toast and taskbar so it never stalls invisibly in the tray.
function mainWindowInactive(): boolean {
  return (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized() ||
    !mainWindow.isFocused()
  )
}

// Taskbar progress: an indeterminate bar while any run is in flight, cleared to
// none at zero. setProgressBar is a no-op on unsupported platforms — safe to call.
function updateRunIndicators(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (activeRuns.size > 0) mainWindow.setProgressBar(2, { mode: 'indeterminate' })
  else mainWindow.setProgressBar(-1)
}

// Attention cue for a state change (run finished / approval pending) that happened
// while the window wasn't focused: flash the taskbar button and stamp an overlay
// dot. Cleared on the main window's focus event. All calls are guarded/no-op-safe.
function flagAttention(kind: 'success' | 'error' | 'approval'): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return
  mainWindow.flashFrame(true)
  const badge =
    kind === 'success' ? successBadge() : kind === 'error' ? errorBadge() : approvalBadge()
  const desc =
    kind === 'success' ? 'Run finished' : kind === 'error' ? 'Run failed' : 'Approval needed'
  mainWindow.setOverlayIcon(badge, desc)
}

// Pending toast approvals by id, so the toast stays up until the last one clears.
const toastApprovals = new Set<string>()

// Resolve an approval everywhere: prune the toast's pending set, tell BOTH windows
// to drop it (whichever UI didn't answer), and hide the toast once none remain.
function resolveApprovalEverywhere(approvalId: string): void {
  toastApprovals.delete(approvalId)
  sendToMainWindow('approval:resolved', approvalId)
  sendToToast('approval:resolved', approvalId)
  if (toastApprovals.size === 0) hideToast()
}

const sessionsDir = path.join(app.getPath('userData'), 'sessions')

function ensureDirs(): void {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true })
}

/**
 * Replace Electron's default application menu with a minimal one.
 *
 * The window is frameless and draws its own title bar, so this menu is never *seen* on
 * Windows/Linux (autoHideMenuBar, and no menu bar in a frameless window anyway) — it exists
 * purely for the accelerators it binds.
 *
 * Which is exactly why the default had to go: it ships an Edit submenu whose `role: 'paste'`
 * binds CmdOrCtrl+V to webContents.paste(). In a normal app that's a nice fallback, but on top
 * of the chat/remote terminals it fired a main-process paste *in addition to* xterm's own
 * paste handling of the same keystroke — so pasted text arrived twice, once raw and once
 * bracketed (\x1b[200~…), garbling whatever the CLI was reading. So: NO Edit roles here.
 *
 * Nothing is lost by dropping them. Chromium handles Ctrl+C/V/X/A/Z natively inside text
 * inputs and textareas without any menu accelerator, so the app's own fields are unaffected;
 * see ChatTerminal.tsx / RemoteTerminal.tsx for the terminal side of the same fix.
 */
function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    // macOS puts Quit/Hide/Services in the first submenu, and dropping it there would leave
    // the app with no Cmd+Q. It carries no clipboard roles, so it's safe to keep.
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  // Mirrors global.css --bg-0 for each theme, so the native window background
  // (visible briefly before the renderer paints) doesn't flash the wrong theme.
  const backgroundColor = getConfig().ui.theme === 'light' ? '#f7f5f1' : '#141312'
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Frameless with a custom title bar (see TitleBar.tsx) drawn by the renderer;
    // the window itself is opaque, flat-themed chrome — no OS backdrop material.
    frame: false,
    resizable: true,
    backgroundColor,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Startup visibility: launched with --hidden (e.g. via the "start with Windows" login
  // item) or the user's "start minimized to tray" preference skips the initial show().
  // Guard on hasTray too, and fall back to showing after a grace period below, so the
  // app can never end up stranded with no window and no tray to bring one back.
  const startHidden =
    (process.argv.includes('--hidden') || getConfig().system.startMinimized)
  mainWindow.on('ready-to-show', () => {
    if (startHidden && hasTray) return
    mainWindow!.show()
  })
  // Focusing the window means the user is here now: stop flashing and clear the
  // taskbar overlay badge that was cueing a background run's state change.
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false)
    mainWindow?.setOverlayIcon(null, '')
    // The app is visible/focused now, so the background-activity pill is redundant.
    hidePill()
  })
  // If a run is in flight when the user hides or minimizes the window mid-run, bring
  // up the pill at that moment so background activity stays visible.
  mainWindow.on('hide', () => {
    if (activeRuns.size > 0) showPill()
  })
  mainWindow.on('minimize', () => {
    if (activeRuns.size > 0) showPill()
  })
  // Keep the renderer's maximize/restore icon and corner rounding in sync.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  // Close hides to the tray so scheduled routines and in-flight runs keep going.
  // A real exit happens via the tray's Quit item or an OS-initiated quit.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    // Close-to-tray only engages when a tray exists AND the user hasn't opted out via
    // settings. Otherwise treat this like a real quit so the app fully exits instead
    // of lingering invisibly with no way back in.
    if (!hasTray || !getConfig().system.closeToTray) {
      isQuitting = true
      return
    }
    e.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true
      new Notification({
        title: 'Argos is still running',
        body: 'The app keeps running in the system tray. Use the tray icon to reopen or quit.'
      }).show()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // A closed main window means exit when there's no tray (the hidden aux windows
    // would otherwise keep the app alive and window-all-closed would never fire) or
    // when the close handler above already decided this close is a real quit
    // (close-to-tray disabled in settings).
    if ((isQuitting || !hasTray) && process.platform !== 'darwin') {
      isQuitting = true
      app.quit()
    }
  })

  hardenWebContents(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Must run before anything touches userData (ensureDirs and the load* calls below): the app
  // was previously named claude-gui, so Electron now points at a fresh, empty directory. See
  // migrate-userdata.ts — it's a copy, and it no-ops once the marker is in place.
  const dataImport = migrateUserDataDir(
    // The literal former name, not the current one — this is the directory we're importing FROM.
    path.join(app.getPath('appData'), 'claude-gui'),
    app.getPath('userData')
  )
  if (dataImport.detail) console.log(`[userdata] ${dataImport.detail}`)
  // Matches build.appId. Windows ties toast notifications and jumplist entries to this id, so
  // a value that disagrees with the installed app's identity silently misroutes both.
  electronApp.setAppUserModelId('com.argos.app')
  ensureDirs()
  loadAuthState()
  // A Claude Code self-update that renamed the CLI but never wrote the replacement leaves every
  // launch failing with a raw shell error (most visibly in a chat terminal). Put it back before
  // anything tries to run it.
  const cliRepair = repairClaudeCliIfBroken()
  if (cliRepair.detail) console.log(`[claude-cli] ${cliRepair.detail}`)
  loadAccounts()
  loadProviderAccounts()
  loadConfig()
  // Fire and forget: builds the merged model catalog (bundled + models.json +
  // live discovery) and publishes it to config.ts, so pricing for a model we
  // only learn about at runtime is in place before the first turn is costed.
  buildModelsCatalog().catch(() => {})
  startScheduler()
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  // Before any window exists, so the default menu's clipboard accelerators never get a chance
  // to bind (see installApplicationMenu for why that matters to the terminals).
  installApplicationMenu()
  createWindow()
  createOverlayWindow()
  createToastWindow()
  createPillWindow()
  // No-op in dev (see updater.ts) — schedules its own delayed first check + interval.
  initUpdater(sendToMainWindow)
  const shortcut = registerOverlayShortcut(getConfig().system.overlayShortcut)
  hasTray = !!createTray(
    {
      onShowMain: showMainWindow,
      onNewChat: () => {
        showMainWindow()
        sendToMainWindow('app:new-chat')
      },
      onToggleOverlay: toggleOverlay,
      onQuit: () => {
        isQuitting = true
        app.quit()
      }
    },
    shortcut
  )
  // Live plan usage: refresh in the background (initial fetch ~30s in, then every 10
  // minutes), push updates to the renderer, keep the tray tooltip current, and fire
  // threshold notifications from the main process so they surface while tray-resident.
  startPlanUsageWatcher({
    broadcast: (r) => sendToMainWindow('plan:update', r),
    showMain: () => {
      showMainWindow()
      sendToMainWindow('app:open-view', 'usage')
    }
  })
  // Keep the Windows registry "run at login" entry in sync with config on every
  // startup (covers the case where it was changed outside this app, or the app
  // was reinstalled). Skipped in dev — electron.exe as the login target would
  // pollute the registry with a path that's meaningless outside this checkout.
  if (!is.dev) {
    app.setLoginItemSettings({
      openAtLogin: getConfig().system.openAtLogin,
      args: ['--hidden']
    })
  }
  // Safety net: if startup visibility logic above skipped show() but the tray
  // failed to materialize (or is still spinning up), never strand the user with
  // no window and no tray to bring one back.
  setTimeout(() => {
    if (!hasTray && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
  }, 1500)
  app.on('activate', () => showMainWindow())

  // Explorer context menu: re-register on every launch when enabled so the stored
  // exe path stays fresh across updates. Skip in dev — electron.exe as the target
  // would leave a checkout-specific command in the user's registry.
  if (!is.dev && getConfig().system.explorerContextMenu) {
    void setExplorerContextMenu(true)
  }
  // Independent of the toggle: clear the entries left behind under the app's former name.
  if (!is.dev) void removeLegacyExplorerContextMenu()

  // Windows Jump List (recent projects + New chat), refreshed on save below.
  refreshJumpList()

  // A --folder / --new-chat first launch (Explorer menu or Jump List while the app
  // wasn't already running): route it once the window exists. sendToMainWindow defers
  // until the renderer has loaded.
  routeLaunchAction(extractLaunchAction(process.argv))
})

app.on('window-all-closed', () => {
  killAllTerminals()
  remoteShellKillAll()
  sftpDisconnectAll()
  if (!hasTray && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  killAllTerminals()
  remoteShellKillAll()
  sftpDisconnectAll()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ─── Quick-launcher overlay IPC ────────────────────────────────────────────────

// Deliver an event to the main window, tolerating the (startup/reload) edge where
// the renderer hasn't finished loading yet.
function sendToMainWindow(channel: string, payload?: unknown): void {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', () => {
      // Small grace period so the React app has mounted its IPC listeners.
      setTimeout(() => {
        if (!target.isDestroyed()) target.webContents.send(channel, payload)
      }, 400)
    })
  } else {
    target.webContents.send(channel, payload)
  }
}

ipcMain.on('overlay:hide', () => hideOverlay())
ipcMain.handle('overlay:shortcut', () => overlayShortcut())
ipcMain.on('overlay:open-main', () => {
  hideOverlay()
  showMainWindow()
})
// From the approval toast's "Open app" button. Reuses the overlay's open-main path
// but does NOT hide the toast — the approval:resolved broadcast cleans it up once
// the user answers in the modal.
ipcMain.on('toast:open-main', () => {
  hideOverlay()
  showMainWindow()
})
// From the status pill's "open" button: jump back to the app and drop the (now
// redundant) pill. The main window's focus handler also hides it, but do it here
// too so it goes away immediately even if focus is momentarily delayed.
ipcMain.on('pill:open-main', () => {
  hidePill()
  showMainWindow()
})
ipcMain.on('overlay:submit', (_, payload: { prompt: string; quick?: boolean }) => {
  if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) return
  hideOverlay()
  showMainWindow()
  sendToMainWindow('app:overlay-prompt', { prompt: payload.prompt, quick: !!payload.quick })
})
ipcMain.on('overlay:open-session', (_, sessionId: string) => {
  if (typeof sessionId !== 'string' || !sessionId) return
  hideOverlay()
  showMainWindow()
  sendToMainWindow('app:open-session', sessionId)
})

// ─── Notifications ────────────────────────────────────────────────────────────

// ─── Window controls (custom frameless title bar) ─────────────────────────────

ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize-toggle', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
ipcMain.handle('window:get-bounds', () => mainWindow?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 })
ipcMain.on('window:set-bounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
  mainWindow?.setBounds(bounds)
})

ipcMain.handle('app:set-zoom', (_, factor: number) => {
  const f = Math.max(0.6, Math.min(1.4, factor || 1))
  mainWindow?.webContents.setZoomFactor(f)
  return f
})

ipcMain.handle('app:notify', (_, payload: { title: string; body: string }) => {
  if (!Notification.isSupported()) return { shown: false }
  const n = new Notification({ title: payload.title, body: payload.body, silent: false })
  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  n.show()
  return { shown: true }
})

// ─── Auto-update ────────────────────────────────────────────────────────────

ipcMain.handle('updater:state', () => getUpdaterState())
ipcMain.handle('updater:check', () => checkNow())
ipcMain.handle('updater:install', () => quitAndInstall())

// ─── Auth IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('auth:status', () => getAuthStatus())
ipcMain.handle('auth:set-mode', (_, mode: AuthMode) => {
  setMode(mode)
  return getAuthStatus()
})
ipcMain.handle('auth:set-api-key', (_, key: string) => {
  setApiKey(key)
  return getAuthStatus()
})
ipcMain.handle('auth:clear-api-key', () => {
  clearApiKey()
  return getAuthStatus()
})
ipcMain.handle('auth:has-api-key', () => getApiKey() !== null)

// ─── Accounts (multiple Claude Code logins) ──────────────────────────────────

ipcMain.handle('accounts:list', () => listAccountStatus())
ipcMain.handle('accounts:add', (_, name: string) => addAccount(name))
ipcMain.handle('accounts:rename', (_, id: string, name: string) => {
  renameAccount(id, name)
  return listAccountStatus()
})
ipcMain.handle('accounts:remove', (_, id: string) => removeAccount(id))
ipcMain.handle('accounts:set-default', (_, id: string) => setDefaultAccount(id))
ipcMain.handle('accounts:login', (_, id: string) => loginAccount(id))

// ─── Agent CLI login status (Codex / Gemini) ─────────────────────────────────

ipcMain.handle('agentcli:status', (_, id: AgentCliId) => checkAgentCliStatus(id))
ipcMain.handle('agentcli:login', (_, id: AgentCliId) => loginAgentCli(id))

// ─── Provider accounts (multiple Codex / Gemini logins) ─────────────────────

ipcMain.handle('provider-accounts:list', (_, provider: AgentProvider) => listProviderAccountStatus(provider))
ipcMain.handle('provider-accounts:add', (_, provider: AgentProvider, name: string) => addProviderAccount(provider, name))
ipcMain.handle('provider-accounts:rename', (_, provider: AgentProvider, id: string, name: string) => {
  renameProviderAccount(provider, id, name)
  return listProviderAccountStatus(provider)
})
ipcMain.handle('provider-accounts:remove', (_, provider: AgentProvider, id: string) => {
  removeProviderAccount(provider, id)
  return listProviderAccountStatus(provider)
})
ipcMain.handle('provider-accounts:set-default', (_, provider: AgentProvider, id: string) => {
  setDefaultProviderAccount(provider, id)
  return listProviderAccountStatus(provider)
})
ipcMain.handle('provider-accounts:login', (_, provider: AgentProvider, id: string) => loginProviderAccount(provider, id))

// Codex plan-usage badge — the Codex analog of 'cc:plan-usage' above, one entry
// per Codex account keyed by account id (see codex-usage.ts).
ipcMain.handle('codex-usage:get', (_, force?: boolean) => getCodexAccountsUsage(!!force))

// ─── Agent run ─────────────────────────────────────────────────────────────

interface SendPayload {
  appSessionId: string
  claudeSessionId?: string
  prompt: string
  projectPath?: string
  model?: string
  systemPrompt?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  allowedTools?: string[]
  useMcp?: boolean
  /**
   * Light mode = full SDK isolation: no tools, no MCP, and no filesystem settings
   * (so global plugin/skill marketplaces like superpowers never load). Normal chats
   * still skip the `user` settings tier to avoid dragging those plugins into context.
   */
  lightMode?: boolean
  /** 'ask' = prompt before mutating tools; 'auto' = current auto-accept behavior. */
  approvalMode?: 'ask' | 'auto'
  /** Pasted/attached images to include with this turn. */
  images?: { mediaType: string; data: string }[]
  /** Attached text files — appended to the prompt as delimited blocks. */
  files?: { name: string; content: string }[]
  /** If set, run on this remote SSH host instead of locally. */
  remoteHostId?: string
  /** If set, run inside this WSL distro instead of locally. */
  wslDistro?: string
  /** Extra working directories exposed to the engine (Claude --add-dir). */
  additionalDirs?: string[]
  /** Run this local chat inside a fresh git worktree of projectPath. */
  useWorktree?: boolean
  /** Previously-created worktree cwd for this chat — reused across turns. */
  worktreePath?: string
  /** Which Claude Code account (config dir) to run under. Undefined = machine default. */
  accountId?: string
  /** Which Codex account to run under, when the active model is a Codex model. */
  codexAccountId?: string
  /** Which Gemini account to run under, when the active model is a Gemini model. */
  geminiAccountId?: string
}

/**
 * Append attached text files to the prompt as clearly delimited blocks, AFTER the
 * user's own text. Works for both the plain-string and structured (image) paths.
 */
function appendFiles(text: string, files: { name: string; content: string }[] | undefined): string {
  if (!files || files.length === 0) return text
  const blocks = files
    .map((f) => `--- Attached file: ${f.name} ---\n${f.content}\n--- End of ${f.name} ---`)
    .join('\n\n')
  return text ? `${text}\n\n${blocks}` : blocks
}

/**
 * Build the `prompt` for query(). A plain string is the proven fast path; when images are
 * attached we must use the structured streaming-input form (one user message with text +
 * image content blocks). The generator completing signals end-of-input so the run finishes.
 * Attached text files are folded into the text portion in either case.
 */
function buildPrompt(
  text: string,
  images: { mediaType: string; data: string }[] | undefined,
  files: { name: string; content: string }[] | undefined,
  sessionId: string
): string | AsyncIterable<unknown> {
  const fullText = appendFiles(text, files)
  if (!images || images.length === 0) return fullText
  const content: unknown[] = [{ type: 'text', text: fullText }]
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
  }
  async function* gen(): AsyncIterable<unknown> {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: sessionId
    }
  }
  return gen()
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

// Tools that change the filesystem or run commands — these require approval in 'ask' mode.
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

// Pending tool-approval prompts, keyed by an approval id, awaiting a renderer decision.
interface ApprovalDecision {
  allow: boolean
  updatedInput?: Record<string, unknown>
}
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>()

let approvalSeq = 0
function nextApprovalId(): string {
  approvalSeq += 1
  return `appr_${approvalSeq}_${approvalSeq * 2654435761 % 1000000}`
}

ipcMain.handle(
  'agent:approval-response',
  (_, payload: { approvalId: string; allow: boolean; updatedInput?: Record<string, unknown> }) => {
    const resolver = pendingApprovals.get(payload.approvalId)
    if (resolver) {
      pendingApprovals.delete(payload.approvalId)
      resolver({ allow: payload.allow, updatedInput: payload.updatedInput })
    }
    // Whoever answered (main-window modal OR toast), tell both UIs to drop it.
    resolveApprovalEverywhere(payload.approvalId)
    return { ok: true }
  }
)

ipcMain.on('agent:send', async (_event, payload: SendPayload) => {
  const { appSessionId, claudeSessionId, prompt, projectPath } = payload

  // Remote/WSL runs take a plain prompt string (no structured image path), so fold any
  // attached text files straight into the prompt text here.
  const promptWithFiles = appendFiles(prompt, payload.files)

  // Remote host: drive the remote machine's Claude Code over SSH instead of the local SDK.
  if (payload.remoteHostId) {
    runRemote(appSessionId, payload.remoteHostId, promptWithFiles, payload.model, claudeSessionId, projectPath, {
      onEvent: (e) => send('agent:event', e),
      onDone: (d) => send('agent:done', { appSessionId, ...d }),
      onError: (msg) => send('agent:error', { appSessionId, error: msg })
    })
    return
  }

  // WSL distro: drive that distro's Claude Code via wsl.exe.
  if (payload.wslDistro) {
    runWsl(appSessionId, payload.wslDistro, promptWithFiles, payload.model, claudeSessionId, projectPath, undefined, {
      onEvent: (e) => send('agent:event', e),
      onDone: (d) => send('agent:done', { appSessionId, ...d }),
      onError: (msg) => send('agent:error', { appSessionId, error: msg })
    })
    return
  }

  const abort = new AbortController()
  activeRuns.set(appSessionId, abort)
  updateRunIndicators()

  // Surface background activity in the status pill if the app isn't in view. Display
  // is best-effort — never let it interfere with the run.
  try {
    if (mainWindowInactive()) {
      showPill()
      sendToPill('pill:update', {
        state: 'running',
        sessionName: prompt.slice(0, 40),
        tool: null
      })
    }
  } catch {
    /* pill is decorative — ignore any failure */
  }

  // Worktree: a `useWorktree` chat runs inside a fresh git worktree of projectPath. Create
  // it lazily on the first send, reuse it on later turns (worktreePath), and notify the
  // renderer so it persists the path onto the session. Best-effort — fall back to the repo
  // root if creation fails, so a run never dies over a worktree hiccup.
  let effectiveCwd = projectPath
  if (payload.useWorktree && projectPath && fs.existsSync(projectPath)) {
    if (payload.worktreePath && fs.existsSync(payload.worktreePath)) {
      effectiveCwd = payload.worktreePath
    } else {
      const wt = await createWorktree(projectPath, appSessionId)
      if (wt.ok && wt.path) {
        effectiveCwd = wt.path
        send('agent:worktree', { appSessionId, path: wt.path, branch: wt.branch })
      }
    }
  }

  const cwd = effectiveCwd && fs.existsSync(effectiveCwd) ? effectiveCwd : os.homedir()
  const policy = resolvePolicy({
    profile: payload.lightMode ? 'interactive-light' : 'interactive-chat',
    requestedModel: payload.model
  })

  // Account: a non-default account points the engine at its own CLAUDE_CONFIG_DIR (its own
  // subscription login). Strip any API key so the account's OAuth login is what's used.
  const env = buildSubprocessEnv()
  const configDir = accountConfigDir(payload.accountId)
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir
    delete env.ANTHROPIC_API_KEY
  }
  const mcpServers = payload.useMcp ? mcpServersForProject(projectPath) : undefined
  const askMode = payload.approvalMode !== 'auto' && payload.permissionMode !== 'bypassPermissions'

  // In 'ask' mode, prompt the renderer before any mutating tool runs.
  const canUseTool = askMode
    ? async (toolName: string, input: Record<string, unknown>) => {
        if (!MUTATING_TOOLS.has(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        const approvalId = nextApprovalId()
        const req = { appSessionId, approvalId, tool: toolName, input }
        send('agent:approval-request', req)
        // If the main window can't show the modal right now (hidden/unfocused in the
        // tray), also surface the request in the always-on-top toast and cue the
        // taskbar, so the run doesn't stall where nobody can see it.
        if (mainWindowInactive()) {
          toastApprovals.add(approvalId)
          sendToToast('toast:approval', req)
          showToast()
          flagAttention('approval')
        }
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          pendingApprovals.set(approvalId, resolve)
          abort.signal.addEventListener('abort', () => {
            if (pendingApprovals.delete(approvalId)) {
              resolveApprovalEverywhere(approvalId)
              resolve({ allow: false })
            }
          })
        })
        return decision.allow
          ? { behavior: 'allow' as const, updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny' as const, message: 'Denied by user.' }
      }
    : undefined

  // Drop a resume token that belongs to a different provider than this run targets.
  const providerId = providerFor(policy.model)
  // Non-Claude accounts have no CLAUDE_CONFIG_DIR equivalent to fall back on — inject
  // CODEX_HOME when the active model is Codex and needs one. Gemini's login lives in the
  // OS keyring as a single machine-wide account, so providerAccountEnv('gemini', ...)
  // always returns {} and no env override is injected for it.
  if (providerId === 'codex') Object.assign(env, providerAccountEnv('codex', payload.codexAccountId))
  else if (providerId === 'gemini') Object.assign(env, providerAccountEnv('gemini', payload.geminiAccountId))
  const prevProvider = sessionProvider.get(appSessionId)
  const resumeToken =
    claudeSessionId && (!prevProvider || prevProvider === providerId) ? claudeSessionId : undefined
  sessionProvider.set(appSessionId, providerId)

  // Whether the run ended in error, so the pill's grace period can be longer for
  // failures (set in the catch / cleared on the normal completion path).
  let runErrored = false
  try {
    const stream = getEngine(providerId).run({
      prompt: buildPrompt(prompt, payload.images, payload.files, claudeSessionId ?? '') as string,
      model: policy.model,
      cwd,
      env,
      abortController: abort,
      includePartialMessages: true,
      settingSources: policy.settingSources,
      permissionMode: askMode ? 'default' : payload.permissionMode ?? 'acceptEdits',
      ...(canUseTool ? { canUseTool } : {}),
      // A custom agent's prompt replaces Claude Code's; otherwise take whatever
      // the profile decided (see CLAUDE_CODE_PROMPT in ai-policy.ts).
      ...(payload.systemPrompt
        ? { systemPrompt: payload.systemPrompt }
        : policy.systemPrompt
          ? { systemPrompt: policy.systemPrompt }
          : {}),
      ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {}),
      ...(payload.additionalDirs && payload.additionalDirs.length
        ? { additionalDirectories: payload.additionalDirs.filter((d) => fs.existsSync(d)) }
        : {}),
      ...(mcpServers && Object.keys(mcpServers).length
        ? { mcpServers: mcpServers as Record<string, never> }
        : {}),
      ...(resumeToken ? { resume: resumeToken } : {})
    })

    let capturedSessionId = claudeSessionId

    for await (const message of stream) {
      switch (message.type) {
        case 'init': {
          if (message.sessionId) capturedSessionId = message.sessionId
          send('agent:event', {
            appSessionId,
            kind: 'system',
            claudeSessionId: capturedSessionId,
            tools: message.tools
          })
          break
        }

        case 'text-delta': {
          send('agent:event', { appSessionId, kind: 'text', content: message.text })
          break
        }

        case 'thinking-delta': {
          send('agent:event', { appSessionId, kind: 'thinking', content: message.text })
          break
        }

        case 'tool-use': {
          send('agent:event', {
            appSessionId,
            kind: 'tool-use',
            tool: message.name,
            input: message.input,
            toolId: message.id
          })
          // Cheap live status for the pill; the hidden window just ignores it.
          sendToPill('pill:update', { state: 'running', tool: message.name })
          break
        }

        case 'tool-result': {
          send('agent:event', {
            appSessionId,
            kind: 'tool-result',
            toolId: message.toolUseId,
            content: message.content,
            isError: message.isError
          })
          break
        }

        case 'result': {
          if (message.sessionId) capturedSessionId = message.sessionId
          // Cue the taskbar if the user has stepped away while this run finished.
          flagAttention(message.isError ? 'error' : 'success')
          sendToPill('pill:update', { state: message.isError ? 'error' : 'done' })
          send('agent:done', {
            appSessionId,
            claudeSessionId: capturedSessionId,
            costUsd: message.costUsd,
            isError: message.isError,
            errorText: message.errorText,
            inputTokens: message.usage.inputTokens,
            outputTokens: message.usage.outputTokens,
            cacheReadTokens: message.usage.cacheReadTokens,
            cacheCreationTokens: message.usage.cacheCreationTokens
          })
          break
        }

        case 'error': {
          flagAttention('error')
          send('agent:error', { appSessionId, error: message.message })
          break
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    flagAttention('error')
    send('agent:error', { appSessionId, error: msg })
    runErrored = true
    sendToPill('pill:update', { state: 'error' })
  } finally {
    activeRuns.delete(appSessionId)
    updateRunIndicators()
    // Once nothing is running, let the finished/errored state linger briefly then
    // hide. A new run starting in the grace period cancels this via showPill().
    if (activeRuns.size === 0) hidePillSoon(runErrored ? 4000 : 2500)
  }
})

ipcMain.handle('agent:stop', (_, appSessionId: string) => {
  const ctrl = activeRuns.get(appSessionId)
  if (ctrl) {
    ctrl.abort()
    activeRuns.delete(appSessionId)
    updateRunIndicators()
    // Reflect the stop in the pill and let it fade after the short success grace.
    sendToPill('pill:update', { state: 'done' })
    if (activeRuns.size === 0) hidePillSoon(2500)
    return { stopped: true }
  }
  if (stopRemote(appSessionId)) return { stopped: true }
  if (stopWsl(appSessionId)) return { stopped: true }
  return { stopped: false }
})

// ─── SSH hosts / remote ─────────────────────────────────────────────────────

ipcMain.handle('ssh:list', () => listHosts())
ipcMain.handle('ssh:save', (_, host: SshHost) => saveHost(host))
ipcMain.handle('ssh:delete', (_, id: string) => deleteHost(id))
ipcMain.handle('ssh:test', (_, id: string) => testConnection(id))
ipcMain.handle('ssh:test-claude', (_, id: string) => testClaude(id))
ipcMain.handle('ssh:keys-list', () => listSshKeys())
ipcMain.handle('ssh:keys-generate', (_, name: string, comment?: string) => generateKey(name, comment))
ipcMain.handle('ssh:keys-public', (_, privatePath: string) => readPublicKey(privatePath))

// ─── SFTP (Remote Session file browser) ────────────────────────────────────

ipcMain.handle('sftp:connect', (_, hostId: string) => sftpConnect(hostId))
ipcMain.handle('sftp:list', (_, hostId: string, dir: string) => sftpList(hostId, dir))
ipcMain.handle('sftp:read', (_, hostId: string, p: string) => sftpRead(hostId, p))
ipcMain.handle('sftp:write', (_, hostId: string, p: string, content: string) => sftpWrite(hostId, p, content))
ipcMain.handle('sftp:mkdir', (_, hostId: string, dir: string) => sftpMkdir(hostId, dir))
ipcMain.handle('sftp:rename', (_, hostId: string, from: string, to: string) => sftpRename(hostId, from, to))
ipcMain.handle('sftp:delete', (_, hostId: string, p: string) => sftpDelete(hostId, p))
ipcMain.handle('sftp:download', (_, hostId: string, p: string) => sftpDownload(hostId, p))
ipcMain.handle('sftp:upload', (_, hostId: string, dir: string) => sftpUpload(hostId, dir))
ipcMain.handle('sftp:history', (_, hostId: string) => sftpHistory(hostId))
ipcMain.handle('sftp:disconnect', (_, hostId: string) => sftpDisconnect(hostId))

// ─── WSL ──────────────────────────────────────────────────────────────────

ipcMain.handle('wsl:list', () => listDistros())
ipcMain.handle('wsl:test', (_, distro: string) => testDistro(distro))
ipcMain.handle('wsl:test-claude', (_, distro: string) => testDistroClaude(distro))
ipcMain.handle('wsl:hidden', () => getHiddenDistros())
ipcMain.handle('wsl:set-hidden', (_, distro: string, hidden: boolean) => setDistroHidden(distro, hidden))
ipcMain.handle('wsl:history', (_, distro: string) => wslHistory(distro))

// ─── Rooms (persisted board layout) ───────────────────────────────────────────

ipcMain.handle('rooms:get-layout', () => getRoomsLayout())
ipcMain.handle('rooms:set-layout', (_, layout: RoomsLayout) => {
  setRoomsLayout(layout)
  return true
})

// ─── Config / Models ──────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => ({
  ...getConfig(),
  claudeSettings: getClaudeSettings()
}))
ipcMain.handle('config:models', () => buildModelsCatalog())
ipcMain.handle('config:set-default-model', (_, modelId: string) => {
  setDefaultModel(modelId)
  return getConfig()
})
ipcMain.handle('config:set-limits', (_, limits: Partial<UsageLimits>) => setLimits(limits))
ipcMain.handle('config:set-ui', (_, prefs: Partial<UiPrefs>) => setUiPrefs(prefs))
ipcMain.handle('config:set-system', (_, prefs: Partial<SystemPrefs>) => {
  const prevOpenAtLogin = getConfig().system.openAtLogin
  const prevShortcut = getConfig().system.overlayShortcut
  const prevExplorerMenu = getConfig().system.explorerContextMenu
  const system = setSystemPrefs(prefs)

  // Add/remove the Explorer folder context-menu entries when the toggle changed.
  // Skipped in dev (electron.exe path is meaningless outside this checkout).
  if (
    !is.dev &&
    prefs.explorerContextMenu !== undefined &&
    prefs.explorerContextMenu !== prevExplorerMenu
  ) {
    void setExplorerContextMenu(system.explorerContextMenu)
  }

  // Only touch the registry when the pref actually changed, and never in dev (see
  // the startup call for why: electron.exe isn't a meaningful login target there).
  if (!is.dev && prefs.openAtLogin !== undefined && prefs.openAtLogin !== prevOpenAtLogin) {
    app.setLoginItemSettings({ openAtLogin: system.openAtLogin, args: ['--hidden'] })
  }

  // Re-register the global shortcut only when it changed, and reflect the winner
  // (which may differ from what was requested, e.g. if it's already taken) in
  // both the tray menu label and the response so the UI can show the truth.
  if (prefs.overlayShortcut !== undefined && prefs.overlayShortcut !== prevShortcut) {
    const registered = reregisterOverlayShortcut(system.overlayShortcut)
    updateTrayShortcutLabel(registered)
  }

  return { system, registeredShortcut: overlayShortcut() }
})
ipcMain.handle('config:get-permissions', () => getClaudePermissions())
ipcMain.handle('config:set-permissions', (_, perms: unknown) => setClaudePermissions(perms))
ipcMain.handle('config:get-hooks', () => getClaudeHooks())
ipcMain.handle('config:set-hooks', (_, hooks: unknown) => setClaudeHooks(hooks))

// ─── Claude Code data (real projects / sessions / usage, local + WSL) ──────────

ipcMain.handle('cc:sources', () => listSources())
ipcMain.handle('cc:list-projects', () => getAllProjects())
ipcMain.handle('cc:list-sessions', (_, sourceId: string, encodedDir: string) =>
  listSessions(sourceId, encodedDir)
)
ipcMain.handle('cc:read-session', (_, sourceId: string, encodedDir: string, sessionId: string) =>
  readSession(sourceId, encodedDir, sessionId)
)
ipcMain.handle('cc:usage', (_, force = false) => getUsage(force))
ipcMain.handle('cc:plan-usage', (_, force = false) => getPlanUsageForIpc(!!force))
ipcMain.handle('cc:search', (_, query: string) => searchSessions(query))

// ─── MCP ────────────────────────────────────────────────────────────────────

ipcMain.handle('mcp:list', () => listMcpServers())
ipcMain.handle('mcp:upsert', (_, name: string, cfg: Record<string, unknown>) =>
  upsertGlobalMcpServer(name, cfg)
)
ipcMain.handle('mcp:remove', (_, name: string) => removeGlobalMcpServer(name))

// ─── Agents ───────────────────────────────────────────────────────────────────

ipcMain.handle('agents:list', () => listAgents())
ipcMain.handle('agents:save', (_, agent: AgentDef) => saveAgent(agent))
ipcMain.handle('agents:delete', (_, id: string) => {
  deleteAgent(id)
  return listAgents()
})

// ─── Scheduler / Routines ─────────────────────────────────────────────────────

ipcMain.handle('scheduler:list', () => listScheduledRuns())
ipcMain.handle('scheduler:upsert', (_, run: ScheduledRun) => upsertScheduledRun(run))
ipcMain.handle('scheduler:delete', (_, id: string) => deleteScheduledRun(id))
ipcMain.handle('scheduler:set-enabled', (_, id: string, enabled: boolean) =>
  setScheduledRunEnabled(id, enabled)
)
ipcMain.handle('scheduler:run-now', (_, id: string) => runScheduledRunNow(id))

// ─── Terminal (embedded PTY) ────────────────────────────────────────────────

ipcMain.handle(
  'terminal:create',
  (
    _,
    id: string,
    opts: {
      cwd?: string
      accountId?: string
      wslDistro?: string
      remoteHostId?: string
      provider?: 'claude' | 'codex' | 'gemini'
      resumeSessionId?: string
      cols: number
      rows: number
    }
  ) =>
    // Returns { ok, shell, cliLaunched, reused, buffer }. The scrollback of a reused pty comes
    // back in this invoke result rather than over 'terminal:data' on purpose — that way the
    // renderer controls the ordering itself and can replay history before any live chunk.
    createTerminal(
      id,
      opts,
      (tid, data) => send('terminal:data', { id: tid, data }),
      (tid, exitCode) => send('terminal:exit', { id: tid, exitCode })
    )
)
ipcMain.on('terminal:write', (_, id: string, data: string) => writeTerminal(id, data))
ipcMain.on('terminal:resize', (_, id: string, cols: number, rows: number) =>
  resizeTerminal(id, cols, rows)
)
ipcMain.handle('terminal:kill', (_, id: string) => killTerminal(id))
ipcMain.on('terminal:kill-deferred', (_, id: string) => killTerminalDeferred(id))
ipcMain.handle(
  'terminal:start-cli',
  (_, id: string, provider: 'claude' | 'codex' | 'gemini', resumeSessionId?: string) =>
    startCliInTerminal(id, provider, resumeSessionId)
)

// ─── Remote shell (Remote Session SSH terminal, over the SFTP connection) ──────

ipcMain.handle('remote-shell:create', (_, id: string, hostId: string, cols: number, rows: number) =>
  remoteShellCreate(
    id,
    hostId,
    cols,
    rows,
    (tid, data) => send('remote-shell:data', { id: tid, data }),
    (tid, code) => send('remote-shell:exit', { id: tid, code })
  )
)
ipcMain.on('remote-shell:write', (_, id: string, data: string) => remoteShellWrite(id, data))
ipcMain.on('remote-shell:resize', (_, id: string, cols: number, rows: number) =>
  remoteShellResize(id, cols, rows)
)
ipcMain.handle('remote-shell:kill', (_, id: string) => remoteShellKill(id))

// ─── Chat compaction (summarize a long session into a fresh one) ───────────────

ipcMain.handle(
  'chat:summarize',
  async (_, payload: { transcript: string; model?: string; accountId?: string }) => {
    const abort = new AbortController()
    const env = buildSubprocessEnv()
    const configDir = accountConfigDir(payload.accountId)
    if (configDir) {
      env.CLAUDE_CONFIG_DIR = configDir
      delete env.ANTHROPIC_API_KEY
    }
    const policy = resolvePolicy({ profile: 'headless-reasoning', requestedModel: payload.model })
    const prompt = `Summarize the following conversation so it can seed a fresh session with minimal tokens while preserving everything needed to continue. Write a dense, structured brief (markdown) covering: the goal/task, key decisions and constraints, current state, important file paths or identifiers, and open next steps. Omit chit-chat. Output ONLY the summary.\n\n=== CONVERSATION ===\n${payload.transcript}`
    try {
      const stream = getEngine(providerFor(policy.model)).run({
        prompt,
        ...policy,
        cwd: os.homedir(),
        env,
        abortController: abort,
        permissionMode: 'bypassPermissions'
      })
      const { text, isError, errorText } = await collectText(stream)
      if (isError) return { ok: false as const, error: errorText || 'Claude returned an error.' }
      return { ok: true as const, summary: text.trim() }
    } catch (err: unknown) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  }
)

// ─── Planner ──────────────────────────────────────────────────────────────────

ipcMain.handle('planner:list', () => listWeeks())
ipcMain.handle('planner:get', (_, weekStart: string) => getWeek(weekStart))
ipcMain.handle('planner:save', (_, week: WeekPlan) => saveWeek(week))
ipcMain.handle('planner:delete', (_, weekStart: string) => deleteWeek(weekStart))

// ─── Sprints (Scrum board / standups / burndown) ───────────────────────────────

ipcMain.handle('sprint:list', () => listSprints())
ipcMain.handle('sprint:get', (_, id: string) => getSprint(id))
ipcMain.handle('sprint:save', (_, sprint: Sprint) => saveSprint(sprint))
ipcMain.handle('sprint:delete', (_, id: string) => deleteSprint(id))

type PlannerAssistMode = 'review' | 'draft' | 'reflect' | 'rebalance' | 'import'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function serializeWeek(week: WeekPlan): string {
  const lines: string[] = []
  lines.push(`Week of ${week.weekStart} (Monday).`)
  if (week.intention?.trim()) lines.push(`Intention for the week: ${week.intention.trim()}`)
  lines.push('')
  lines.push('Weekly priorities:')
  if (week.priorities.length === 0) lines.push('  (none set)')
  for (const p of week.priorities) lines.push(`  - [${p.id}] ${p.title}`)
  lines.push('')
  for (let d = 0; d < 7; d++) {
    const dayTasks = week.tasks.filter((t) => t.day === d)
    lines.push(`${DAY_NAMES[d]}:`)
    if (dayTasks.length === 0) lines.push('  (empty)')
    for (const t of dayTasks) {
      const bits: string[] = []
      if (t.timeOfDay) bits.push(`${t.timeOfDay}${t.endTime ? `–${t.endTime}` : ''}`)
      if (t.durationMin) bits.push(`${t.durationMin}min`)
      if (t.effort) bits.push(t.effort)
      if (t.priorityId) {
        const pr = week.priorities.find((p) => p.id === t.priorityId)
        if (pr) bits.push(`priority:"${pr.title}"`)
      }
      const meta = bits.length ? ` (${bits.join(', ')})` : ''
      lines.push(`  - [${t.id}]${t.done ? ' [done]' : ''} ${t.title}${meta}`)
    }
  }
  const backlog = week.tasks.filter((t) => t.day === null)
  if (backlog.length) {
    lines.push('')
    lines.push('Unscheduled backlog:')
    for (const t of backlog) lines.push(`  - [${t.id}] ${t.title}`)
  }
  return lines.join('\n')
}

function buildAssistPrompt(mode: PlannerAssistMode, week: WeekPlan, notes?: string): string {
  const ctx = serializeWeek(week)
  const note = notes?.trim() ? `\n\nUser's notes / goals for this request:\n${notes.trim()}` : ''
  const common =
    'You are a sharp, experienced executive planning coach. Be specific, realistic, and concise. ' +
    'Respond with ONLY a single JSON object, no markdown fences, no prose outside the JSON.'

  switch (mode) {
    case 'review':
      return `${common}

Here is the user's current weekly plan:

${ctx}${note}

Critique this plan. Return JSON of exactly this shape:
{
  "score": <integer 0-100, how well-balanced and realistic the week is>,
  "summary": "<2-3 sentence overall read of the week>",
  "warnings": ["<concrete risk, e.g. overloaded day, no buffer, missing priority>", ...],
  "suggestions": [{ "title": "<short actionable suggestion>", "detail": "<one sentence why/how>" }, ...]
}
Focus on overload, unrealistic days, missing weekly priorities, lack of deep-work blocks, and no recovery time. 3-6 warnings/suggestions max.`

    case 'draft':
      return `${common}

The user wants you to draft a balanced week from their goals.${note}

Current state (may be partial — build on it, don't discard existing tasks unless they conflict):

${ctx}

Return JSON of exactly this shape:
{
  "intention": "<one-line theme for the week>",
  "priorities": [{ "title": "<weekly priority, 2-4 total>" }, ...],
  "tasks": [{ "title": "<task>", "day": <0-6 Mon-Sun>, "effort": "light|medium|deep", "timeOfDay": "<start HH:MM or null>", "endTime": "<end HH:MM or null>", "durationMin": <minutes or null>, "priorityTitle": "<matching priority title or null>" }, ...]
}
Distribute deep work across mornings, avoid stacking everything on Monday, leave Friday afternoon and the weekend lighter, and keep each weekday realistic (no more than ~3 deep tasks/day).`

    case 'reflect':
      return `${common}

The week is ending. Here is the plan with completion status:

${ctx}${note}

Reflect on planned vs. done. Return JSON of exactly this shape:
{
  "summary": "<2-3 sentence honest reflection>",
  "wins": ["<what went well>", ...],
  "misses": ["<what slipped and a likely reason>", ...],
  "adjustments": ["<concrete change to try next week>", ...]
}`

    case 'rebalance':
      return `${common}

The user feels this week is unbalanced. Redistribute existing tasks across the week WITHOUT inventing new tasks or deleting any.

${ctx}${note}

Return JSON of exactly this shape:
{
  "summary": "<one sentence on what you rebalanced>",
  "moves": [{ "id": "<existing task id>", "day": <0-6 Mon-Sun, or null for backlog>, "reason": "<short why>" }, ...]
}
Only include tasks whose day you are changing. Spread load evenly, protect mornings for deep work, and keep the weekend light.`

    case 'import':
      return `${common}

The user has attached a screenshot/image of a calendar or weekly schedule. Read it carefully and convert it into a structured weekly plan. Map each calendar entry to the correct weekday (Monday=0 … Sunday=6). Use the event's start time as timeOfDay (24h "HH:MM") and infer durationMin from the block length when visible. Group recurring or themed entries into 2-4 weekly priorities. Ignore the image's own week-of date; map purely by weekday.${note}

Existing plan for context (you may ignore it and build fresh from the image):

${ctx}

Return JSON of exactly this shape:
{
  "intention": "<one-line theme inferred from the calendar, or empty>",
  "priorities": [{ "title": "<weekly priority, 2-4 total>" }, ...],
  "tasks": [{ "title": "<event/task as written>", "day": <0-6 Mon-Sun>, "effort": "light|medium|deep", "timeOfDay": "<start HH:MM or null>", "endTime": "<end HH:MM or null>", "durationMin": <minutes or null>, "priorityTitle": "<matching priority title or null>" }, ...]
}
Transcribe every visible event. Capture both the start (timeOfDay) and end (endTime) of each block when the calendar shows them. If a label is unreadable, use your best guess and keep it short. Do not invent events that aren't in the image.`
  }
}

function extractJson(text: string): unknown {
  let t = text.trim()
  // Strip ```json … ``` fences if the model added them anyway.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  // Otherwise grab the first {...} span.
  if (!t.startsWith('{')) {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) t = t.slice(start, end + 1)
  }
  return JSON.parse(t)
}

ipcMain.handle(
  'planner:assist',
  async (
    _,
    payload: {
      mode: PlannerAssistMode
      week: WeekPlan
      notes?: string
      images?: { mediaType: string; data: string }[]
      model?: string
      accountId?: string
    }
  ) => {
    const abort = new AbortController()
    const env = buildSubprocessEnv()
    const policy = resolvePolicy({ profile: 'headless-reasoning', requestedModel: payload.model })
    // Account env depends on which provider the resolved model belongs to — `accountId` is
    // interpreted as an account of THAT provider, not always Claude.
    const providerId = providerFor(policy.model)
    if (providerId === 'claude') {
      const configDir = accountConfigDir(payload.accountId)
      if (configDir) {
        env.CLAUDE_CONFIG_DIR = configDir
        delete env.ANTHROPIC_API_KEY
      }
    } else {
      Object.assign(env, providerAccountEnv(providerId, payload.accountId))
    }
    try {
      const stream = getEngine(providerFor(policy.model)).run({
        prompt: buildPrompt(buildAssistPrompt(payload.mode, payload.week, payload.notes), payload.images, undefined, '') as string,
        ...policy,
        cwd: os.homedir(),
        env,
        abortController: abort,
        permissionMode: 'bypassPermissions'
      })

      const { text, costUsd, isError, errorText } = await collectText(stream)

      if (isError) return { ok: false as const, error: errorText || 'Claude returned an error.', costUsd }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd }
      } catch {
        return { ok: false as const, error: 'Could not parse Claude’s response as JSON.', raw: text, costUsd }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0 }
    }
  }
)

// ─── Standup generation (git log + board state → draft standup) ─────────────────

function buildStandupPrompt(
  date: string,
  commits: { date: string; subject: string }[],
  boardSummary?: string
): string {
  const commitLines =
    commits.length > 0
      ? commits.map((c) => `  - ${c.date}: ${c.subject}`).join('\n')
      : '  (no recent commits found)'
  const board = boardSummary?.trim() ? `\n\nSprint board (supplementary context only):\n${boardSummary.trim()}` : ''
  return `You are helping a developer write their daily standup for ${date}. Their git commits are the record of what they ACTUALLY worked on — use them as the PRIMARY source. The sprint board is only extra context, and is often empty; never let an empty board be the answer.

Recent git commits (newest first, author-filtered):
${commitLines}${board}

Be concise, concrete, first person, plain past/present tense — no fluff. Derive the standup from the commits:
- "yesterday": what actually got done, summarised from the commits dated on or just before ${date} — group related commits into outcomes, don't just echo commit subjects or hashes.
- "today": infer what they'll continue from the direction of the most recent commits (and any in-progress board items). If the board has nothing in progress, infer from the commit momentum — do NOT write that the board is empty or that there are no items.
- "blockers": only if clearly evident from the commits/board, otherwise an empty string.

If there are genuinely no commits AND no board context, say so plainly in "yesterday" and leave "today"/"blockers" empty — but if there are commits, always ground the standup in them.

Respond with ONLY a single JSON object, no markdown fences, no prose outside the JSON:
{
  "yesterday": "<what got done — 1-4 short bullet-like sentences separated by newlines>",
  "today": "<what you plan to work on today>",
  "blockers": "<blockers if any are evident, otherwise an empty string>"
}`
}

ipcMain.handle(
  'standup:generate',
  async (
    _,
    payload: {
      projectPath?: string
      date: string
      boardSummary?: string
      model?: string
      accountId?: string
    }
  ) => {
    const abort = new AbortController()
    const env = buildSubprocessEnv()
    const policy = resolvePolicy({ profile: 'headless-reasoning', requestedModel: payload.model })
    // Account env depends on which provider the resolved model belongs to — `accountId` is
    // interpreted as an account of THAT provider, not always Claude.
    const providerId = providerFor(policy.model)
    if (providerId === 'claude') {
      const configDir = accountConfigDir(payload.accountId)
      if (configDir) {
        env.CLAUDE_CONFIG_DIR = configDir
        delete env.ANTHROPIC_API_KEY
      }
    } else {
      Object.assign(env, providerAccountEnv(providerId, payload.accountId))
    }
    let commits: { date: string; subject: string }[] = []
    try {
      if (payload.projectPath) {
        // 7-day window (not 3) so a standup still has commit context across weekends/gaps —
        // the prompt scopes "yesterday" to commits on or just before the standup date itself.
        commits = (await getLog(payload.projectPath, 7, true)).map((c) => ({ date: c.date, subject: c.subject }))
      }
    } catch {
      /* git is best-effort context — a failure just means no commits in the digest */
    }
    try {
      const stream = getEngine(providerFor(policy.model)).run({
        prompt: buildPrompt(buildStandupPrompt(payload.date, commits, payload.boardSummary), undefined, undefined, '') as string,
        ...policy,
        cwd: os.homedir(),
        env,
        abortController: abort,
        permissionMode: 'bypassPermissions'
      })
      const { text, costUsd, isError, errorText } = await collectText(stream)
      if (isError) return { ok: false as const, error: errorText || 'Claude returned an error.', costUsd, commitCount: commits.length }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd, commitCount: commits.length }
      } catch {
        return { ok: false as const, error: 'Could not parse Claude’s response as JSON.', raw: text, costUsd, commitCount: commits.length }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0, commitCount: commits.length }
    }
  }
)

// ─── Backlog backfill (GitLab MCP → sprint items) ───────────────────────────────

function buildBacklogBackfillPrompt(instructions?: string): string {
  const extra = instructions?.trim()
    ? `\n\nAdditional filter / instructions from the user: ${instructions.trim()}`
    : ''
  return `You have access to this project's configured MCP servers, including a GitLab server. Using ONLY the GitLab MCP tools (and read-only file tools), fetch the currently OPEN issues for this project's GitLab repository so they can seed a sprint backlog. This is strictly READ-ONLY — do NOT create, edit, close, label, or comment on anything.${extra}

Work out the correct GitLab project/repository from: the user's instructions above if they name a project or group, otherwise the git remote in the current directory, otherwise list the projects available via the MCP and pick the best match. Respond with ONLY a single JSON object — no markdown fences, no prose outside the JSON:
{
  "items": [
    { "title": "<issue title>", "points": <small integer story-point estimate, or null>, "notes": "<issue reference like #123 plus a one-line summary, or an empty string>" }
  ]
}
If you cannot reach GitLab or there are no open issues, return { "items": [] }.`
}

function buildProjectProbePrompt(instructions?: string): string {
  const extra = instructions?.trim()
    ? `\n\nThe user suggests this project/group: ${instructions.trim()}`
    : ''
  return `You have access to this project's configured MCP servers, including a GitLab server. Load it and determine which single GitLab project this backlog should be attributed to. Decide it from: the user's suggestion below if given, otherwise the git remote of the repository in the current directory, otherwise the GitLab server's own configured/default project. This is strictly READ-ONLY — only inspect, do not modify anything.${extra}

Respond with ONLY a single JSON object — no markdown fences, no prose outside the JSON:
{
  "project": "<full path like group/subgroup/name, or best human identifier>",
  "projectId": <numeric GitLab project id, or null>,
  "url": "<project web URL, or empty string>",
  "openIssueCount": <number of open issues if known, or null>,
  "source": "git-remote" | "mcp-default" | "instructions" | "guess",
  "note": "<one short sentence explaining how you determined it>"
}
If you cannot determine a project, return { "project": "", "source": "guess", "note": "<why>" }.`
}

// Heuristically identify the GitLab MCP among all configured servers (local + WSL).
function looksLikeGitlab(s: { name: string; url?: string; config?: Record<string, unknown> }): boolean {
  if (/git.?lab|wm-git/i.test(s.name)) return true
  if (s.url && /gitlab/i.test(s.url)) return true
  const env = (s.config as { env?: Record<string, unknown> } | undefined)?.env
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (/gitlab/i.test(k) || /gitlab/i.test(String(v))) return true
    }
  }
  return false
}

ipcMain.handle(
  'sprint:backfill',
  async (
    _,
    payload: { projectPath?: string; instructions?: string; model?: string; accountId?: string; probe?: boolean }
  ) => {
    const model = payload.model || getConfig().defaultModel
    const promptText = payload.probe
      ? buildProjectProbePrompt(payload.instructions)
      : buildBacklogBackfillPrompt(payload.instructions)

    // Find the GitLab MCP wherever it lives — local ~/.claude.json OR a WSL distro's.
    let servers: { name: string; source: string; url?: string; config?: Record<string, unknown> }[] = []
    try {
      servers = await listMcpServers()
    } catch {
      servers = []
    }
    const gitlab = servers.find(looksLikeGitlab)
    if (!gitlab) {
      return {
        ok: false as const,
        error: 'No GitLab MCP server was found in Claude Code (checked local and WSL). Configure the GitLab MCP, then try again.',
        costUsd: 0
      }
    }

    // ── WSL-hosted MCP: run that distro's own `claude -p` so its stdio server loads.
    // `source` is the distro name for WSL servers, 'local' otherwise.
    if (gitlab.source && gitlab.source !== 'local') {
      const cwd = uncToWslPath(payload.projectPath) ?? undefined
      const res = await runWslOneShot(gitlab.source, promptText, {
        model,
        // MCP server + read-only file tools (to read a repo's .git/config); no Bash/Write.
        allowedTools: [`mcp__${gitlab.name}`, 'Read', 'Grep', 'Glob'],
        cwd,
        timeoutMs: 180000
      })
      if (!res.ok) return { ok: false as const, error: res.error || 'The WSL backfill run failed.', costUsd: 0 }
      try {
        return { ok: true as const, data: extractJson(res.text), costUsd: 0 }
      } catch {
        return { ok: false as const, error: 'Could not parse Claude’s response as JSON.', raw: res.text, costUsd: 0 }
      }
    }

    // ── Local MCP: SDK path with the project's (+ global) mcpServers.
    const mcpServers = mcpServersForProject(payload.projectPath)
    const abort = new AbortController()
    const env = buildSubprocessEnv()
    const policy = resolvePolicy({
      profile: 'mcp-ask',
      requestedModel: payload.model,
      mcpServerNames: Object.keys(mcpServers)
    })
    // Account env depends on which provider the resolved model belongs to — `accountId` is
    // interpreted as an account of THAT provider, not always Claude.
    const providerId = providerFor(policy.model)
    if (providerId === 'claude') {
      const configDir = accountConfigDir(payload.accountId)
      if (configDir) {
        env.CLAUDE_CONFIG_DIR = configDir
        delete env.ANTHROPIC_API_KEY
      }
    } else {
      Object.assign(env, providerAccountEnv(providerId, payload.accountId))
    }
    try {
      const stream = getEngine(providerFor(policy.model)).run({
        prompt: buildPrompt(promptText, undefined, undefined, '') as string,
        ...policy,
        cwd: payload.projectPath || os.homedir(),
        env,
        abortController: abort,
        permissionMode: 'bypassPermissions',
        mcpServers: mcpServers as Record<string, unknown>
      })
      const { text, costUsd, isError, errorText } = await collectText(stream)
      if (isError) return { ok: false as const, error: errorText || 'Claude returned an error.', costUsd }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd }
      } catch {
        return { ok: false as const, error: 'Could not parse Claude’s response as JSON.', raw: text, costUsd }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0 }
    }
  }
)

// ─── Agent suggestions (history digest) ────────────────────────────────────

const AGENT_ICON_OPTIONS = ['🤖', '🧠', '🔧', '🔍', '📝', '🚀', '🛡️', '⚡', '📊', '🧪']
const AGENT_TOOL_OPTIONS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite']

/**
 * Build a compact, privacy-conscious digest of recent sessions for the suggestion prompt.
 * Only short excerpts (first-prompt snippet, tool counts) leave the machine — never full
 * message content. Capped at ~6000 chars, dropping the oldest lines first if needed.
 */
function buildHistoryDigest(): { digest: string; sessionCount: number } {
  let files: string[]
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return { digest: '', sessionCount: 0 }
  }

  type SessionLike = {
    id: string
    name?: string
    messages?: { role: string; content?: string; toolCalls?: { tool: string }[] }[]
    projectPath?: string
    updatedAt?: number
  }

  const sessions: SessionLike[] = []
  for (const f of files) {
    try {
      const s = readJsonFile<SessionLike>(path.join(sessionsDir, f))
      if (s && Array.isArray(s.messages) && s.messages.length > 0) sessions.push(s)
    } catch {
      // Skip corrupt/unreadable session files.
    }
  }

  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const recent = sessions.slice(0, 40)

  const overallTools = new Map<string, number>()
  const projects = new Set<string>()
  const lines: string[] = []

  for (const s of recent) {
    const toolCounts = new Map<string, number>()
    let firstUserPrompt = ''
    for (const m of s.messages ?? []) {
      for (const tc of m.toolCalls ?? []) {
        toolCounts.set(tc.tool, (toolCounts.get(tc.tool) ?? 0) + 1)
        overallTools.set(tc.tool, (overallTools.get(tc.tool) ?? 0) + 1)
      }
      if (!firstUserPrompt && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        firstUserPrompt = m.content.trim()
      }
    }
    const projectBase = s.projectPath ? path.basename(s.projectPath) : 'no-project'
    projects.add(projectBase)
    const promptSnippet = firstUserPrompt.slice(0, 140).replace(/\s+/g, ' ')
    const toolsStr = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${n}`)
      .join(' ')
    const name = (s.name || 'Untitled').replace(/\s+/g, ' ').trim()
    lines.push(
      `- [${projectBase}] "${name}" | first user prompt: "${promptSnippet}" | tools: ${toolsStr || 'none'}`
    )
  }

  const header = [
    `Sessions analyzed: ${recent.length}`,
    `Distinct projects: ${[...projects].slice(0, 20).join(', ') || 'none'}`,
    `Overall tool usage: ${[...overallTools.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(' ') || 'none'}`,
    ''
  ].join('\n')

  // Keep the whole digest under ~6000 chars, dropping the oldest (end of list) lines first.
  const MAX_CHARS = 6000
  let body = lines.join('\n')
  while (header.length + body.length > MAX_CHARS && lines.length > 0) {
    lines.pop()
    body = lines.join('\n')
  }

  return { digest: header + body, sessionCount: recent.length }
}

function buildAgentSuggestPrompt(digest: string): string {
  return `You are helping configure reusable "agents" inside a Claude Code GUI. Each agent is a saved preset with a name, icon, system prompt, and a set of allowed tools, that the user can launch for recurring kinds of work.

Below is a digest of the user's recent chat sessions (project name, session name, their first prompt, and which tools were used). Based on real patterns in this history, propose 3-5 agent definitions the user would plausibly reuse. Be specific to what they actually do — do not propose generic-sounding agents unrelated to the digest.

History digest:
${digest}

Respond with ONLY a single JSON object, no markdown fences, no prose outside the JSON, of exactly this shape:
{
  "suggestions": [
    {
      "name": "<short agent name, max 30 chars>",
      "icon": "<one of: ${AGENT_ICON_OPTIONS.join(' ')}>",
      "systemPrompt": "<2-4 sentences, second person ('You are...'), specific to the user's observed patterns>",
      "allowedTools": ["<subset of: ${AGENT_TOOL_OPTIONS.join(', ')}>"],
      "reason": "<one short sentence on why, referencing their history>"
    }
  ]
}`
}

ipcMain.handle('agents:suggest', async (_, payload: { accountId?: string } = {}) => {
  const abort = new AbortController()
  const env = buildSubprocessEnv()
  const configDir = accountConfigDir(payload.accountId)
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir
    delete env.ANTHROPIC_API_KEY
  }
  try {
    const { digest } = buildHistoryDigest()
    const policy = resolvePolicy({ profile: 'headless-reasoning', requestedModel: 'claude-haiku-4-5' })
    const stream = getEngine(providerFor(policy.model)).run({
      prompt: buildAgentSuggestPrompt(digest),
      ...policy,
      cwd: os.homedir(),
      env,
      abortController: abort,
      permissionMode: 'bypassPermissions'
    })

    const { text, costUsd, isError, errorText } = await collectText(stream)

    if (isError) return { ok: false as const, error: errorText || 'Claude returned an error.', costUsd }
    try {
      const data = extractJson(text)
      return { ok: true as const, data, costUsd }
    } catch {
      return { ok: false as const, error: 'Could not parse Claude’s response as JSON.', costUsd }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false as const, error: msg, costUsd: 0 }
  }
})

// ─── CLAUDE.md ──────────────────────────────────────────────────────────────

const CONTEXT_FILE: Record<'claude' | 'codex' | 'gemini', string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md'
}
const CONTEXT_GLOBAL_DIR: Record<'claude' | 'codex' | 'gemini', string> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini'
}

ipcMain.handle(
  'claudemd:read',
  (_, projectPath?: string, provider: 'claude' | 'codex' | 'gemini' = 'claude') => {
    const fileName = CONTEXT_FILE[provider]
    const targets: { scope: string; path: string }[] = []
    if (projectPath) targets.push({ scope: 'project', path: path.join(projectPath, fileName) })
    targets.push({
      scope: 'global',
      path: path.join(os.homedir(), CONTEXT_GLOBAL_DIR[provider], fileName)
    })
    return targets.map((t) => ({
      scope: t.scope,
      path: t.path,
      exists: fs.existsSync(t.path),
      content: fs.existsSync(t.path) ? fs.readFileSync(t.path, 'utf-8') : ''
    }))
  }
)

ipcMain.handle('claudemd:write', (_, filePath: string, content: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return { success: true }
})

// ─── Checkpoints ──────────────────────────────────────────────────────────────

ipcMain.handle(
  'checkpoint:create',
  (_, sessionId: string, label: string, files: string[], messageCount: number) =>
    createCheckpoint(sessionId, label, files, messageCount, Date.now())
)
ipcMain.handle('checkpoint:list', (_, sessionId: string) => listCheckpoints(sessionId))
ipcMain.handle('checkpoint:restore', (_, sessionId: string, id: string) =>
  restoreCheckpoint(sessionId, id, Date.now())
)
ipcMain.handle('checkpoint:delete', (_, sessionId: string, id: string) =>
  deleteCheckpoint(sessionId, id)
)
ipcMain.handle('checkpoint:compare', (_, sessionId: string, idA: string, idB: string) =>
  compareCheckpoints(sessionId, idA, idB)
)
ipcMain.handle(
  'checkpoint:save-patch',
  async (_, sessionId: string, idA: string, idB: string) => {
    const patch = exportPatch(sessionId, idA, idB)
    if (!patch) return { saved: false, reason: 'no-diff' }
    if (!mainWindow) return { saved: false, reason: 'no-window' }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save patch file',
      defaultPath: `checkpoint-${idA}.patch`,
      filters: [
        { name: 'Patch files', extensions: ['patch', 'diff'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return { saved: false, reason: 'canceled' }
    try {
      fs.writeFileSync(result.filePath, patch, 'utf-8')
    } catch {
      return { saved: false, reason: 'write-error' }
    }
    return { saved: true, filePath: result.filePath }
  }
)

// ─── Git ──────────────────────────────────────────────────────────────────────

ipcMain.handle('git:status', (_, cwd: string) => getStatus(cwd))
ipcMain.handle('git:diff', (_, cwd: string, filePath: string, staged: boolean) =>
  getDiff(cwd, filePath, staged)
)
ipcMain.handle('git:stage', (_, cwd: string, filePath: string) => stageFile(cwd, filePath))
ipcMain.handle('git:unstage', (_, cwd: string, filePath: string) => unstageFile(cwd, filePath))
ipcMain.handle('git:stage-all', (_, cwd: string) => stageAll(cwd))
ipcMain.handle('git:commit', (_, cwd: string, message: string) => commit(cwd, message))

// ─── File System ──────────────────────────────────────────────────────────────

ipcMain.handle('fs:read-dir', (_, dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        type: e.isDirectory() ? 'directory' : 'file'
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:read-file', (_, filePath: string) => {
  try {
    return { content: fs.readFileSync(filePath, 'utf-8') }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:open-folder', async (_, defaultPath?: string) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    ...(defaultPath ? { defaultPath } : {})
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// Size/binary-guarded text read (same result shape as sftp:read), used by the file editor —
// unlike fs:read-file above it never hands back a multi-megabyte or binary blob.
ipcMain.handle('fs:read-text', (_, filePath: string) => readTextFile(filePath))

// Guarded local-fs mutation IPC — backs the WSL "Connect" file browser (LocalBrowser),
// which reads via the existing fs:read-dir/fs:read-file above and writes via these. See
// local-fs.ts for the empty-path / filesystem-root guards.
ipcMain.handle('fs:write-file', (_, filePath: string, content: string) => fsWriteFile(filePath, content))
ipcMain.handle('fs:mkdir', (_, dirPath: string) => fsMkdir(dirPath))
ipcMain.handle('fs:rename', (_, from: string, to: string) => fsRename(from, to))
ipcMain.handle('fs:delete', (_, targetPath: string) => fsDelete(targetPath))

// ─── Sessions ─────────────────────────────────────────────────────────────────

ipcMain.handle('session:list', () => {
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonFile<any>(path.join(sessionsDir, f)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
})

ipcMain.handle('session:save', (_, session: unknown) => {
  const s = session as { id: string }
  if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id) || s.id.length === 0 || s.id.length > 128) {
    return { success: false, reason: 'invalid-id' }
  }
  fs.writeFileSync(path.join(sessionsDir, `${s.id}.json`), JSON.stringify(session, null, 2))
  // Keep the "Recent projects" Jump List current. Debounced inside refreshJumpList,
  // so the burst of saves during a streaming turn only rebuilds once.
  refreshJumpList()
  return { success: true }
})

ipcMain.handle('session:delete', (_, sessionId: string) => {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length === 0 || sessionId.length > 128) {
    return { success: false, reason: 'invalid-id' }
  }
  const filePath = path.join(sessionsDir, `${sessionId}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  return { success: true }
})

// ─── Commands / Skills discovery ──────────────────────────────────────────────

ipcMain.handle('commands:list', (_, projectPath?: string) => listCommands(projectPath))

// ─── Session export ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

ipcMain.handle(
  'session:export',
  async (
    _,
    session: {
      name: string
      messages: {
        role: string
        content: string
        thinking?: string
        toolCalls?: { tool: string; input: unknown; result?: string; isError?: boolean }[]
        timestamp: number
      }[]
      projectPath?: string
    },
    format: 'md' | 'html'
  ) => {
    if (!mainWindow) return { saved: false }

    const title = session.name || 'Chat export'
    const date = new Date().toLocaleString()

    if (format === 'md') {
      const lines: string[] = []
      lines.push(`# ${title}`)
      if (session.projectPath) lines.push(`\n_Project: ${session.projectPath}_`)
      lines.push(`\n_Exported: ${date}_\n`)
      lines.push('---\n')
      for (const msg of session.messages) {
        const role = msg.role === 'user' ? '## User' : '## Assistant'
        const ts = new Date(msg.timestamp).toLocaleTimeString()
        lines.push(`${role} _(${ts})_\n`)
        if (msg.thinking) lines.push(`> _Thinking:_ ${msg.thinking}\n`)
        if (msg.content) lines.push(msg.content)
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            lines.push(`\n**Tool:** \`${tc.tool}\``)
            lines.push(`\`\`\`json\n${JSON.stringify(tc.input, null, 2)}\n\`\`\``)
            if (tc.result !== undefined) {
              lines.push(`**Result${tc.isError ? ' (error)' : ''}:**`)
              lines.push(`\`\`\`\n${tc.result.slice(0, 2000)}\n\`\`\``)
            }
          }
        }
        lines.push('\n---\n')
      }
      const content = lines.join('\n')
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export chat as Markdown',
        defaultPath: `${title.replace(/[/\\?%*:|"<>]/g, '-')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      try {
        fs.writeFileSync(result.filePath, content, 'utf-8')
      } catch {
        return { saved: false, reason: 'write-error' }
      }
      return { saved: true, filePath: result.filePath }
    }

    // HTML export
    const msgHtml = session.messages.map((msg) => {
      const role = msg.role === 'user' ? 'user' : 'assistant'
      const ts = new Date(msg.timestamp).toLocaleTimeString()
      let body = ''
      if (msg.thinking) body += `<div class="thinking"><strong>Thinking:</strong> ${escapeHtml(msg.thinking)}</div>`
      if (msg.content) body += `<div class="content"><pre>${escapeHtml(msg.content)}</pre></div>`
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          body += `<div class="tool-call"><span class="tool-name">Tool: ${escapeHtml(tc.tool)}</span>`
          let inputStr = ''
          try { inputStr = JSON.stringify(tc.input, null, 2) } catch { inputStr = String(tc.input) }
          body += `<pre class="tool-input">${escapeHtml(inputStr)}</pre>`
          if (tc.result !== undefined) {
            body += `<div class="tool-result ${tc.isError ? 'error' : ''}"><strong>Result${tc.isError ? ' (error)' : ''}:</strong><pre>${escapeHtml(tc.result.slice(0, 2000))}</pre></div>`
          }
          body += '</div>'
        }
      }
      return `<div class="message ${role}"><div class="msg-header"><span class="role">${role}</span><span class="ts">${escapeHtml(ts)}</span></div><div class="msg-body">${body}</div></div>`
    }).join('\n')

    const meta = session.projectPath ? `<div class="meta">Project: ${escapeHtml(session.projectPath)}</div>` : ''
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; max-width: 860px; margin: 0 auto; padding: 24px 16px; background: #1c1b19; color: #efece8; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #7c766e; font-size: 12px; margin-bottom: 4px; }
  .exported { color: #7c766e; font-size: 12px; margin-bottom: 24px; }
  .message { margin-bottom: 16px; border-radius: 8px; overflow: hidden; border: 1px solid #302c28; }
  .msg-header { display: flex; justify-content: space-between; padding: 8px 12px; background: #252320; font-size: 12px; }
  .role { font-weight: 600; text-transform: capitalize; }
  .message.user .role { color: #df7a52; }
  .message.assistant .role { color: #7c83ff; }
  .ts { color: #7c766e; }
  .msg-body { padding: 12px; }
  pre { background: #141312; border: 1px solid #302c28; border-radius: 4px; padding: 10px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
  .content pre { background: transparent; border: none; padding: 0; margin: 0; }
  .thinking { color: #8c7fd6; font-style: italic; font-size: 12px; margin-bottom: 8px; }
  .tool-call { margin-top: 10px; border-left: 3px solid #48423a; padding-left: 10px; }
  .tool-name { font-weight: 600; font-size: 12px; color: #e3a857; }
  .tool-result.error pre { color: #e36460; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${meta}
<div class="exported">Exported: ${date}</div>
${msgHtml}
</body>
</html>`

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export chat as HTML',
      defaultPath: `${title.replace(/[/\\?%*:|"<>]/g, '-')}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }, { name: 'All files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      fs.writeFileSync(result.filePath, htmlContent, 'utf-8')
    } catch {
      return { saved: false, reason: 'write-error' }
    }
    return { saved: true, filePath: result.filePath }
  }
)

// Strip characters illegal in Windows file names (also fine on macOS/Linux).
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>]/g, '-').trim()
  return cleaned || 'chat'
}

ipcMain.handle('app:export-markdown', async (_, defaultFileName: string, content: string) => {
  if (!mainWindow) return { saved: false }
  const fileName = sanitizeFileName(defaultFileName).replace(/\.md$/i, '') + '.md'
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export chat as Markdown',
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false }
  try {
    fs.writeFileSync(result.filePath, content, 'utf-8')
  } catch {
    return { saved: false }
  }
  return { saved: true, path: result.filePath }
})
