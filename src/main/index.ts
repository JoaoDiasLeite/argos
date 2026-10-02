// First, before anything reads userData: dev moves it aside. See dev-instance.ts.
import { isDevInstance, syncDevFromProd } from './dev-instance'
import { app, BrowserWindow, ipcMain, dialog, Notification, globalShortcut, Menu, MenuItemConstructorOptions, clipboard, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { hardenWebContents } from './window-security'
import { readClipboardFiles } from './clipboard-files'
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
import { loadConfig, getConfig, setDefaultModel, setLimits, setUiPrefs, reresolveUiPrefs, setSystemPrefs, getClaudeSettings, getClaudePermissions, setClaudePermissions, getClaudeHooks, setClaudeHooks, providerFor, UsageLimits, UiPrefs, UiPrefsPatch, SystemPrefs } from './config'
import { buildModelsCatalog } from './models-catalog'
import {
  getAllProjects,
  listSessions,
  readSession,
  readChatTranscript,
  getUsage,
  listSources,
  searchSessions,
  readSessionPeek
} from './claude-data'
import { writeTagsForSession } from './tags-sweep'
import {
  archiveSession,
  deleteSession,
  moveSession,
  renameSession,
  renameChatSession,
  unarchiveSession
} from './session-lifecycle'
import { deleteProject, moveProjectFolder } from './project-lifecycle'
import { listLiveSessions } from './live-sessions'
import { adoptTerminalSessions } from './session-adoption'
import {
  deleteLabel,
  foldIn,
  getLabels,
  labelUsage,
  mergeLabel,
  renameLabel,
  setLabelColor
} from './labels'
import {
  listMcpServers,
  upsertGlobalMcpServer,
  removeGlobalMcpServer,
  mcpServersForProject
} from './mcp'
import { listWeeks, getWeek, saveWeek, deleteWeek, WeekPlan } from './planner'
import { listSprints, getSprint, saveSprint, deleteSprint, Sprint } from './sprints'
import {
  BackfillKind,
  buildBacklogBackfillPrompt,
  buildProjectProbePrompt,
  filterBackfillRows
} from './sprint-backfill-pure'
import { Forge, forgeFromRemote, pickForgeServer } from './forge-pure'
import {
  getStatus,
  getLog,
  createWorktree,
  getRepoName,
  getRemoteUrl
} from './git'
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
import { listDistros, testDistro, testDistroClaude, runWsl, stopWsl, runWslOneShot, uncToWslPath, wslHistory, listWslDriveMap, wslClipboardImageCapable, wslToLinuxPaths } from './wsl'
import { readTextFile, fsWriteFile, fsMkdir, fsRename, fsDelete } from './local-fs'
import { needsApproval } from './tool-approval-pure'
import { createLedger, type OpsLedger } from './ops-audit'
import { createExecutor, createSshBackend, type OpsExecutor } from './ops-exec'
import { createFakeBackend } from './ops-backend-fake'
import { loadRunbook, readScript } from './ops-runbook'
import { finishOpsRun, prepareOpsRun, type ApprovalOpsContext, type OpsRunContext } from './ops-run'
import { bridgeSessionFor, openOpsSession } from './ops-session'
import { newOpsToken, registerToken, revokeToken, startOpsBridge, stopOpsBridge } from './ops-bridge'
import { removeOpsMcpConfig, writeOpsMcpConfig } from './ops-mcp-config'
import { opsRelayCommand, type OpsCli } from './ops-mcp-config-pure'
import { OPS_MCP_FLAG, runOpsRelay } from './ops-relay'
import type { CanUseTool } from './providers/types'
import { OPS_MAX_TIMEOUT_MS } from './ops-types'
import { posixToWslUnc } from './local-fs-pure'
import {
  getHiddenDistros,
  setDistroHidden,
  getProjectNames,
  setProjectName,
  getFavoriteProjects,
  setProjectFavorite,
  setProjectArchived,
  reloadStore
} from './store'
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
  providerAccountConfigDir,
  addProviderAccount,
  renameProviderAccount,
  removeProviderAccount,
  setDefaultProviderAccount,
  loginProviderAccount,
  AgentProvider
} from './provider-accounts'
import { listCodexThreads } from './codex-threads'
import {
  pickThreadsForChats,
  titleForThread,
  type LinkableChat
} from './codex-thread-link-pure'
import {
  busyTerminals,
  waitingTerminals,
  createTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killTerminalDeferred,
  listTerminals,
  startCliInTerminal,
  killAllTerminals
} from './terminal'
import { createOverlayWindow, hideOverlay, toggleOverlay, registerOverlayShortcut, reregisterOverlayShortcut, overlayShortcut } from './overlay'
import { createToastWindow, showToast, hideToast, sendToToast } from './toast'
import { createPillWindow, showPill, hidePill, hidePillSoon, sendToPill } from './pill'
import { noteTerminalBusy, runIndicatorCount } from './run-indicators-pure'
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
import { extendLinuxPath, setOpenAtLogin } from './linux-desktop'
import { readJsonFile } from './json-file'
import {
  PROTOCOL,
  SessionTarget,
  extractDeepLink,
  hookSettingsBlock,
  notifyHookCommand,
  notifyHookInstalled,
  notifyHookMode,
  parseDeepLink,
  withNotifyHook,
  wslHookCommand
} from './notify-hook-pure'
import {
  notifyPayloadFrom,
  runNotifyRelay,
  runNotifyShow,
  showHookNotification
} from './notify-hook'

// Before anything spawns a CLI: a desktop launcher hands Linux apps the session PATH,
// which often lacks where claude, codex and gemini are installed.
extendLinuxPath()

let mainWindow: BrowserWindow | null = null
// True once the user (or OS) actually intends to exit — lets the close handler
// distinguish "hide to tray" from a real quit.
let isQuitting = false
// Close-to-tray only engages when a tray icon actually exists, so the app can
// never be stranded running invisibly.
let hasTray = false
let trayHintShown = false

// This process was started by Claude Code's Notification hook, not by a user. It
// runs a few lines and exits — no windows, no tray — so every startup
// path below is guarded on it. See notify-hook.ts.
const notifyMode = notifyHookMode(process.argv)

// `argos --ops-mcp`: the ops MCP relay a terminal CLI started (ops-relay.ts), speaking MCP
// on stdio. Like the hook roles it opens nothing, takes no lock and starts no service.
// The configs Argos writes start the relay under ELECTRON_RUN_AS_NODE instead, which never
// reaches this file (see ops-mcp-config-pure.ts for why); this is the fallback for a hand
// launch.
const opsMcpMode = process.argv.includes(OPS_MCP_FLAG)
if (opsMcpMode) void runOpsRelay({ exit: (code) => app.exit(code) })

// Second launches (e.g. clicking the exe while the app lives in the tray) focus
// the running instance instead of spawning a duplicate. The hook process does its
// own lock handling — it uses the result to find out whether Argos is running.
if (!notifyMode && !opsMcpMode) {
  if (!app.requestSingleInstanceLock()) {
    // Otherwise a second `npm run dev` just returns to the prompt, under a screen of
    // Chromium cache errors from the directory the running instance holds.
    if (isDevInstance) {
      console.log('[dev] Argos dev is already running (focused its window); this launch exits.')
    }
    app.quit()
  } else {
    app.on('second-instance', (_e, commandLine, _cwd, additionalData) => {
      // A notification relayed by a hook process: show it where the app already is.
      // Emphatically without showMainWindow() — a session on another desktop asking
      // for attention is not a reason to throw a window in front of what you are
      // doing. That is what the click is for.
      const relayed = notifyPayloadFrom(additionalData)
      if (relayed) {
        showHookNotification(relayed, () => openDeepLink(relayed.link))
        return
      }
      // Windows delivers `argos://` through a second launch's argv.
      const target = extractDeepLink(commandLine)
      if (target) {
        openSessionTarget(target)
        return
      }
      showMainWindow()
      routeLaunchAction(extractLaunchAction(commandLine))
    })
  }
  // macOS hands protocol activations to the running app as an event rather than on
  // a second launch's argv, so both routes have to exist.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const target = parseDeepLink(url)
    if (target) openSessionTarget(target)
  })
}

/** Focus the window on a conversation a notification (or any `argos://` link) named. */
function openSessionTarget(target: SessionTarget): void {
  showMainWindow()
  sendToMainWindow('app:open-cc-session', target)
}

function openDeepLink(link: string): void {
  const target = link ? parseDeepLink(link) : null
  if (target) openSessionTarget(target)
  else showMainWindow()
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

// Terminals whose CLI is working right now, fed from terminal:create's onBusy (plan H5).
// They drive the same out-of-window indicators as activeRuns. (Not `busyTerminals`:
// that is terminal.ts's own list, which the renderer seeds itself from.)
const busyTerminalSet = new Set<string>()

/** SDK runs plus busy terminals: what the taskbar, the pill and the hide/minimize cue count. */
function runsInFlight(): number {
  return runIndicatorCount(activeRuns.size, busyTerminalSet)
}

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
  if (runsInFlight() > 0) mainWindow.setProgressBar(2, { mode: 'indeterminate' })
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
 * **What WAS lost by dropping them, and how it is paid for.** This comment used to claim
 * Chromium handles Ctrl+C/V/X/A/Z natively inside inputs without a menu accelerator. It
 * does not: with no Edit roles anywhere, Ctrl+V was dead in every field in the app —
 * settings, filters, the composer — and the paste event never even reached the document.
 * The bug was invisible for as long as it was because the only report it produced was
 * "I can't paste images", which sounded like an image problem and was not.
 *
 * They are not coming back, because the accelerator is exactly what fired a second paste
 * on top of xterm's. Instead the renderer handles Ctrl+V itself (see lib/clipboard-paste.ts),
 * which reads through the IPC below and leaves terminals to their own bracketed-paste path.
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
  // Not the preference in dev: it arrives copied from prod, and a dev window that starts
  // hidden sits behind a tray icon indistinguishable from prod's.
  const startHidden =
    process.argv.includes('--hidden') || (!isDevInstance && getConfig().system.startMinimized)
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
    if (runsInFlight() > 0) showPill()
  })
  mainWindow.on('minimize', () => {
    if (runsInFlight() > 0) showPill()
  })
  // Keep the renderer's maximize/restore icon and corner rounding in sync.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  // Close hides to the tray so in-flight runs keep going.
  // A real exit happens via the tray's Quit item or an OS-initiated quit.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    // Close-to-tray only engages when a tray exists AND the user hasn't opted out via
    // settings. Otherwise treat this like a real quit so the app fully exits instead
    // of lingering invisibly with no way back in.
    // Dev always quits on close, for the same reason it never starts hidden: closing the
    // window should end the `npm run dev`, not leave it in a look-alike tray icon.
    if (!hasTray || isDevInstance || !getConfig().system.closeToTray) {
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

app.whenReady().then(async () => {
  // The ops relay runs on its own from the top of this file; nothing here is for it.
  if (opsMcpMode) return
  // The hook roles end here. Nothing below this block runs in them: they must not
  // migrate userData, repair the CLI, or open a window.
  if (notifyMode) {
    // Matches build.appId — on Windows a toast is routed by it, so a hook process
    // that skipped this would post a notification the OS attributes to nothing.
    electronApp.setAppUserModelId('com.argos.app')
    if (notifyMode.kind === 'relay') {
      await runNotifyRelay()
      app.exit(0)
      return
    }
    if (notifyMode.kind === 'show') {
      runNotifyShow(notifyMode.payload)
      return
    }
    app.exit(0)
    return
  }
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
  // `argos://session?…` — what a notification click follows. Registering it here (on
  // every launch, it is idempotent) is what lets a click start the app when it is
  // closed, which is the case the hook exists for. Not in dev: the registration is
  // machine-wide, and a dev launch taking it would send the installed app's
  // notification clicks to this checkout's electron.exe.
  if (!is.dev) app.setAsDefaultProtocolClient(PROTOCOL)
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
  // Follow the OS's light/dark for `ui.mode === 'system'`. nativeTheme fires 'updated'
  // for more than that (accent colour, high-contrast), and it fires regardless of the
  // user's mode, so reresolveUiPrefs decides whether anything actually moved and only
  // then does this write to disk and repaint the windows.
  nativeTheme.on('updated', () => {
    const { ui, changed } = reresolveUiPrefs()
    if (changed) broadcastUiPrefs(ui)
  })
  // Fire and forget: builds the merged model catalog (bundled + models.json +
  // live discovery) and publishes it to config.ts, so pricing for a model we
  // only learn about at runtime is in place before the first turn is costed.
  buildModelsCatalog().catch(() => {})
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  // Before any window exists, so the default menu's clipboard accelerators never get a chance
  // to bind (see installApplicationMenu for why that matters to the terminals).
  installApplicationMenu()
  createWindow()
  // A click that started the app (rather than focusing a running one) arrives here,
  // on this launch's own argv. sendToMainWindow tolerates a renderer that is still
  // loading, so this is safe before the window has finished painting.
  const launchTarget = extractDeepLink(process.argv)
  if (launchTarget) openSessionTarget(launchTarget)
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
  // Keep the "run at login" entry (Windows registry, or the XDG autostart file on
  // Linux) in sync with config on every startup (covers the case where it was
  // changed outside this app, or the app was reinstalled or updated to a new
  // path). Skipped in dev — electron as the login target would register a path
  // that's meaningless outside this checkout.
  if (!is.dev) {
    setOpenAtLogin(getConfig().system.openAtLogin, ['--hidden'])
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
  endAllTerminalOps('the terminals were closed')
  remoteShellKillAll()
  sftpDisconnectAll()
  if (!hasTray && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  killAllTerminals()
  remoteShellKillAll()
  // Before the ssh sessions go: an ops exec ended by the disconnect would otherwise read
  // as a dropped connection rather than an abort.
  opsExecutor?.abortAll('app quit')
  endAllTerminalOps('app quit')
  void stopOpsBridge()
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

// ─── Dev instance ───────────────────────────────────────────────────────────

ipcMain.handle('dev:is-dev', () => isDevInstance)
// Re-copies prod's data over dev's (see dev-instance.ts), reloads the modules that keep
// it in memory, then reloads the window so the renderer reads it all again.
ipcMain.handle('dev:sync-from-prod', () => {
  const result = syncDevFromProd()
  if (!result.migrated) return { ok: false, error: result.detail ?? 'nothing was copied' }
  loadAuthState()
  loadAccounts()
  loadProviderAccounts()
  loadConfig()
  reloadStore()
  if (result.detail) console.log(`[dev-userdata] ${result.detail}`)
  setTimeout(() => mainWindow?.webContents.reload(), 50)
  return { ok: true }
})

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

// ─── Ops runs (docs/OPS_AGENT_PLAN.md) ──────────────────────────────────────

// One ledger and one executor for the whole app, created on first use so a user who never
// opens an ops chat never gets an ops-audit folder. One executor matters: its per-host
// queue is what keeps two ops chats from running on the same host at once.
let opsLedger: OpsLedger | null = null
let opsExecutor: OpsExecutor | null = null

function getOpsLedger(): OpsLedger {
  if (!opsLedger) opsLedger = createLedger(path.join(app.getPath('userData'), 'ops-audit'))
  return opsLedger
}

function getOpsExecutor(): OpsExecutor {
  // ARGOS_OPS_FAKE=1 runs the whole gate + ledger path against the in-memory backend, so
  // screenshots and demos need no server (plan §9 Phase 3).
  if (!opsExecutor) opsExecutor = createExecutor(process.env.ARGOS_OPS_FAKE === '1' ? createFakeBackend() : createSshBackend())
  return opsExecutor
}

/** Stored hosts as the gate and the reports see them: no secrets, no auth fields. */
function opsHostRefs(): { id: string; name: string; host: string }[] {
  return listHosts().map((h) => ({ id: h.id, name: h.name, host: h.host }))
}

/** `user@host:port` for the approval modal's header. */
function opsHostAddress(hostId: string): string {
  const h = listHosts().find((x) => x.id === hostId)
  return h ? `${h.username}@${h.host}:${h.port}` : hostId
}

ipcMain.handle('ops:load-runbook', async (_, dir: string) => {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: 'No runbook folder given.' }
  const r = await loadRunbook(dir)
  if (!r.ok) return { ok: false, error: r.error, ...(r.errors ? { errors: r.errors } : {}) }
  const rb = r.runbook
  return {
    ok: true,
    name: rb.ref.name,
    path: rb.ref.path,
    hosts: rb.hosts.map((h) => ({ id: h.host.id, name: h.host.name, host: h.host.host, groups: h.groups })),
    warnings: rb.warnings,
    ...(rb.ref.platform ? { platform: rb.ref.platform } : {}),
    strict: rb.policy.strict
  }
})

ipcMain.handle('ops:report', async (_, runId: string, kind: 'internal' | 'client', runbookPath?: string) => {
  if (typeof runId !== 'string' || runId === '') return { ok: false, error: 'No run id given.' }
  if (kind !== 'internal' && kind !== 'client') return { ok: false, error: `Unknown report kind: ${String(kind)}` }
  // The ledger has no policy, so the host roles of the client report ("servidor de base
  // de dados") come from the runbook when the caller names it.
  const extraWarnings: string[] = []
  let opts: { hostGroups: Record<string, string[]>; hosts: { id: string; name: string; host: string }[] } | undefined
  if (typeof runbookPath === 'string' && runbookPath !== '') {
    const rb = await loadRunbook(runbookPath)
    if (rb.ok) opts = { hostGroups: rb.runbook.policy.hosts, hosts: opsHostRefs() }
    else extraWarnings.push(`The runbook could not be loaded, so hosts are shown as [servidor]: ${rb.error}`)
  }
  const r = await getOpsLedger().report(runId, kind, opts)
  return r.ok ? { ...r, warnings: [...extraWarnings, ...r.warnings] } : r
})

// Saves a rendered report as `<runbook>/reports/<YYYY-MM-DD>-<runId>[-cliente].md`. This is
// the ONE place Argos writes under a runbook folder (docs/OPS_AGENT_PLAN.md §8), and it
// only ever creates a new file: `wx` refuses an existing one rather than editing it.
ipcMain.handle('ops:save-report', async (_, runId: string, kind: 'internal' | 'client', runbookPath: string) => {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) return { ok: false, error: 'Invalid run id.' }
  if (kind !== 'internal' && kind !== 'client') return { ok: false, error: `Unknown report kind: ${String(kind)}` }
  if (typeof runbookPath !== 'string' || runbookPath === '') return { ok: false, error: 'No runbook folder given.' }
  const rb = await loadRunbook(runbookPath)
  if (!rb.ok) return { ok: false, error: `The runbook could not be loaded, so nothing was saved: ${rb.error}` }
  const ledger = getOpsLedger()
  const r = await ledger.report(runId, kind, { hostGroups: rb.runbook.policy.hosts, hosts: opsHostRefs() })
  if (!r.ok) return r
  // Date the file by the run's start, so a report saved days later still sorts by the run.
  const lines = await ledger.readRun(runId)
  const startAt = lines.ok ? lines.lines.find((l) => l.event.kind === 'run.start')?.at : undefined
  const date = (startAt && /^\d{4}-\d{2}-\d{2}/.test(startAt) ? startAt : new Date().toISOString()).slice(0, 10)
  const dir = path.join(runbookPath, 'reports')
  const file = path.join(dir, `${date}-${runId}${kind === 'client' ? '-cliente' : ''}.md`)
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(file, r.markdown, { encoding: 'utf-8', flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return { ok: false, error: `A report already exists at ${file}; it was not overwritten.` }
    return { ok: false, error: `Could not save the report: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, path: file }
})

ipcMain.handle('ops:verify', (_, date: string) => getOpsLedger().verify(date))
ipcMain.handle('ops:ledger-info', () => getOpsLedger().info())

// A reopened ops chat's timeline: every ledger line of its runs, shaped like the live
// `ops:event` so the renderer folds both the same way.
ipcMain.handle('ops:session-events', async (_, appSessionId: string) => {
  if (typeof appSessionId !== 'string' || appSessionId === '') return { ok: false, error: 'No session id given.' }
  const r = await getOpsLedger().readSession(appSessionId)
  if (!r.ok) return r
  return { ok: true, events: r.lines.map((line) => ({ appSessionId, runId: line.event.runId, line })) }
})

// ─── Ops from the terminal (docs/OPS_AGENT_PLAN.md §9 Phase 5) ────────────────

// One ops session per terminal id: a run that starts here, before the CLI is launched,
// and ends when the pty exits or the terminal is closed. The CLI reaches it through the
// `ops` MCP relay, which connects to the bridge with this session's token.
interface TerminalOpsSession {
  runId: string
  runbookPath: string
  provider: OpsCli
  token: string
  endpoint: string
  mcpConfigPath: string
  /** userData/ops-mcp/<terminalId>/<runId>: the config, removed with the token. */
  dir: string
  guarantee: 'tools-and-local-shell' | 'tools-only'
  ctx: OpsRunContext
  abort: AbortController
}
const terminalOps = new Map<string, TerminalOpsSession>()
// A second request for the same terminal while the first is still checking hosts gets
// the first one's answer rather than a second run.
const terminalOpsOpening = new Map<string, Promise<TerminalOpsResult>>()

type TerminalOpsResult =
  | {
      ok: true
      runId: string
      env: Record<string, string>
      mcpConfigPath: string
      guarantee: 'tools-and-local-shell' | 'tools-only'
    }
  | { ok: false; error: string }

function terminalOpsReply(s: TerminalOpsSession): TerminalOpsResult {
  return {
    ok: true,
    runId: s.runId,
    // MCP_TOOL_TIMEOUT: Claude Code gives an MCP call far less than a modal wait plus a
    // ten-minute exec by default; the other CLIs take their timeouts from the config file.
    env: { ARGOS_OPS_PIPE: s.endpoint, ARGOS_OPS_TOKEN: s.token, MCP_TOOL_TIMEOUT: String(3 * OPS_MAX_TIMEOUT_MS) },
    mcpConfigPath: s.mcpConfigPath,
    guarantee: s.guarantee
  }
}

/** Log run.end for a terminal's ops session (once), revoke its token and remove its config. */
async function endTerminalOps(terminalId: string, r: { ok: boolean; error?: string; aborted?: boolean }): Promise<void> {
  const s = terminalOps.get(terminalId)
  if (!s) return
  terminalOps.delete(terminalId)
  revokeToken(s.token)
  // Ends a pending approval or sudo prompt and any exec still running on a host.
  s.abort.abort()
  removeOpsMcpConfig(s.dir)
  await finishOpsRun(s.ctx, { ok: r.ok, costUsd: 0, ...(r.aborted ? { aborted: true } : {}), ...(r.error ? { error: r.error } : {}) })
}

function endAllTerminalOps(reason: string): void {
  for (const id of [...terminalOps.keys()]) void endTerminalOps(id, { ok: false, aborted: true, error: reason })
}

async function openTerminalOps(terminalId: string, runbookPath: string, provider: OpsCli): Promise<TerminalOpsResult> {
  const existing = terminalOps.get(terminalId)
  if (existing && !existing.ctx.ended) {
    // A remount reattaches to the same live pty, whose CLI holds this token: hand back the
    // same session, or the running relay is orphaned.
    if (existing.runbookPath === runbookPath && existing.provider === provider) return terminalOpsReply(existing)
    await endTerminalOps(terminalId, { ok: true, error: 'replaced by a new ops session on the same terminal' })
  }

  const abort = new AbortController()
  const opened = await openOpsSession({
    appSessionId: terminalId,
    runbookPath,
    model: `${provider} CLI (terminal)`,
    ledger: getOpsLedger(),
    executor: getOpsExecutor(),
    abort,
    loadRunbook,
    readScript,
    hostAddress: opsHostAddress,
    ask: async ({ tool, input, ops: context }) => {
      const d = await requestToolApproval(terminalId, tool, input, abort.signal, context)
      return { allow: d.allow, ...(d.stop ? { stop: true } : {}) }
    },
    askSecret: (req) => requestOpsSecret(terminalId, req, abort.signal),
    onEvent: (line) => send('ops:event', { appSessionId: terminalId, runId: line.event.runId, line })
  })
  if (!opened.ok) return { ok: false, error: opened.error }

  const { ctx } = opened
  const dir = path.join(app.getPath('userData'), 'ops-mcp', terminalId, ctx.runId)
  try {
    const { endpoint } = await startOpsBridge({ socketDir: app.getPath('userData') })
    const token = newOpsToken()
    const env = { ARGOS_OPS_PIPE: endpoint, ARGOS_OPS_TOKEN: token }
    const config = writeOpsMcpConfig(dir, provider, opsRelayCommand(process.execPath, app.getAppPath(), path.join), env, {
      runbookPath: ctx.runbook.ref.path
    })
    registerToken(token, bridgeSessionFor(opened))
    const s: TerminalOpsSession = {
      runId: ctx.runId,
      runbookPath,
      provider,
      token,
      endpoint,
      mcpConfigPath: config.path,
      dir,
      guarantee: provider === 'claude' ? 'tools-and-local-shell' : 'tools-only',
      ctx,
      abort
    }
    terminalOps.set(terminalId, s)
    return terminalOpsReply(s)
  } catch (e) {
    const error = `Could not start the ops bridge: ${e instanceof Error ? e.message : String(e)}`
    removeOpsMcpConfig(dir)
    await finishOpsRun(ctx, { ok: false, costUsd: 0, error })
    return { ok: false, error }
  }
}

// The timeline's "Stop run" for a terminal's ops session (plan H4). endTerminalOps aborts
// the session's controller (a pending approval or sudo prompt, any exec in flight on a
// host), revokes the relay's token and logs run.end as aborted; the CLI itself keeps
// running, but its ops calls are refused from here on.
ipcMain.handle('ops:stop', async (_, terminalId: string): Promise<{ ok: boolean }> => {
  if (typeof terminalId !== 'string' || !terminalOps.has(terminalId)) return { ok: false }
  await endTerminalOps(terminalId, { ok: false, aborted: true, error: 'stopped by the operator' })
  return { ok: true }
})

ipcMain.handle('ops:terminal-session', async (_, terminalId: string, runbookPath: string, provider: OpsCli) => {
  if (typeof terminalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(terminalId)) return { ok: false, error: 'Invalid terminal id.' }
  if (typeof runbookPath !== 'string' || runbookPath.trim() === '') return { ok: false, error: 'No runbook folder given.' }
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini') return { ok: false, error: `Unknown CLI: ${String(provider)}` }
  const pending = terminalOpsOpening.get(terminalId)
  if (pending) return pending
  const opening = openTerminalOps(terminalId, runbookPath, provider).finally(() => terminalOpsOpening.delete(terminalId))
  terminalOpsOpening.set(terminalId, opening)
  return opening
})

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
  /**
   * Ops chat: the runbook folder this turn runs under (docs/OPS_AGENT_PLAN.md). Switches
   * the run to the ops-remote profile, the ops MCP server and the gate's canUseTool, and
   * ignores every tool, MCP, prompt and approval setting above.
   */
  runbookPath?: string
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

// Pending tool-approval prompts, keyed by an approval id, awaiting a renderer decision.
interface ApprovalDecision {
  allow: boolean
  updatedInput?: Record<string, unknown>
  /** Ops calls only: "deny and stop the run" (plan §3.4). */
  stop?: boolean
}
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>()

let approvalSeq = 0
function nextApprovalId(): string {
  approvalSeq += 1
  return `appr_${approvalSeq}_${approvalSeq * 2654435761 % 1000000}`
}

function requestToolApproval(
  appSessionId: string,
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  ops?: ApprovalOpsContext
): Promise<ApprovalDecision> {
  if (signal.aborted) return Promise.resolve({ allow: false })
  const approvalId = nextApprovalId()
  return new Promise((resolve) => {
    const finish = (decision: ApprovalDecision) => {
      signal.removeEventListener('abort', onAbort)
      pendingApprovals.delete(approvalId)
      resolveApprovalEverywhere(approvalId)
      resolve(decision)
    }
    const onAbort = () => finish({ allow: false })
    pendingApprovals.set(approvalId, finish)
    signal.addEventListener('abort', onAbort, { once: true })
    const req = { appSessionId, approvalId, tool, input, ...(ops ? { ops } : {}) }
    send('agent:approval-request', req)
    if (mainWindowInactive()) {
      toastApprovals.add(approvalId)
      sendToToast('toast:approval', req)
      showToast()
      flagAttention('approval')
    }
  })
}

ipcMain.handle(
  'agent:approval-response',
  (_, payload: { approvalId: string; allow: boolean; updatedInput?: Record<string, unknown>; stop?: boolean }) => {
    const resolver = pendingApprovals.get(payload.approvalId)
    if (resolver) {
      pendingApprovals.delete(payload.approvalId)
      resolver({
        allow: payload.allow,
        updatedInput: payload.updatedInput,
        // A stop is always a deny, whatever else the payload says.
        ...(payload.stop === true ? { stop: true, allow: false } : {})
      })
    }
    // Whoever answered (main-window modal OR toast), tell both UIs to drop it.
    resolveApprovalEverywhere(payload.approvalId)
    return { ok: true }
  }
)

// Pending secret prompts of ops runs (the sudo password of a host, plan §4), keyed by a
// request id. Main window only: a password never goes to the toast. The value lives in
// the run's memory and is never logged.
const pendingSecrets = new Map<string, (value: string | null) => void>()
let secretSeq = 0

function requestOpsSecret(
  appSessionId: string,
  req: { hostId: string; hostName: string; prompt: string },
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  secretSeq += 1
  const requestId = `secret_${secretSeq}_${Date.now().toString(36)}`
  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      signal.removeEventListener('abort', onAbort)
      pendingSecrets.delete(requestId)
      resolve(value)
    }
    const onAbort = () => finish(null)
    pendingSecrets.set(requestId, finish)
    signal.addEventListener('abort', onAbort, { once: true })
    send('ops:secret-request', { appSessionId, requestId, hostId: req.hostId, hostName: req.hostName, prompt: req.prompt })
    flagAttention('approval')
  })
}

ipcMain.handle('ops:secret-response', (_, payload: { requestId: string; value: string | null }) => {
  const resolver = payload && typeof payload.requestId === 'string' ? pendingSecrets.get(payload.requestId) : undefined
  if (resolver) resolver(typeof payload.value === 'string' ? payload.value : null)
  return { ok: true }
})

/** Forward a headless backend's event to the renderer. */
function relayAgentEvent(e: Record<string, unknown>): void {
  send('agent:event', e)
}

ipcMain.on('agent:send', async (_event, payload: SendPayload) => {
  const { appSessionId, claudeSessionId, prompt, projectPath } = payload

  // Remote/WSL runs take a plain prompt string (no structured image path), so fold any
  // attached text files straight into the prompt text here.
  const promptWithFiles = appendFiles(prompt, payload.files)

  // An ops chat runs here, on the local engine, and reaches servers only through the
  // gated ops tools. A remote or WSL transport would run the CLI with no gate at all, so
  // the combination is refused rather than quietly dropping the runbook.
  if (payload.runbookPath && (payload.remoteHostId || payload.wslDistro)) {
    send('agent:error', { appSessionId, error: 'Ops chats run locally; a runbook cannot be used on a remote or WSL chat.' })
    return
  }

  // Headless remote transports cannot pause at individual tools. Ask for the
  // whole run explicitly, without changing the session's permission preference.
  if ((payload.remoteHostId || payload.wslDistro) && payload.approvalMode !== 'auto') {
    const gate = new AbortController()
    activeRuns.set(appSessionId, gate)
    updateRunIndicators()
    const decision = await requestToolApproval(appSessionId, 'RemoteRun', {
      target: payload.wslDistro || payload.remoteHostId,
      folder: projectPath || 'Remote home directory',
      prompt,
      permissions: 'This run can edit files. Per-tool approvals are unavailable on this transport; commands follow the remote CLI policy.'
    }, gate.signal)
    activeRuns.delete(appSessionId)
    updateRunIndicators()
    if (!decision.allow || gate.signal.aborted) {
      send('agent:error', { appSessionId, error: 'Remote run was not approved.' })
      return
    }
  }

  // Remote host: drive the remote machine's Claude Code over SSH instead of the local SDK.
  if (payload.remoteHostId) {
    runRemote(appSessionId, payload.remoteHostId, promptWithFiles, payload.model, claudeSessionId, projectPath, {
      onEvent: relayAgentEvent,
      onDone: (d) => send('agent:done', { appSessionId, ...d }),
      onError: (msg) => send('agent:error', { appSessionId, error: msg })
    })
    return
  }

  // WSL distro: drive that distro's Claude Code via wsl.exe.
  if (payload.wslDistro) {
    runWsl(appSessionId, payload.wslDistro, promptWithFiles, payload.model, claudeSessionId, projectPath, undefined, {
      onEvent: relayAgentEvent,
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
  const opsMode = !!payload.runbookPath
  let effectiveCwd = projectPath
  if (!opsMode && payload.useWorktree && projectPath && fs.existsSync(projectPath)) {
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

  // An ops run's cwd is the runbook folder: Read/Grep/Glob may look there and nowhere else.
  const runbookDir = payload.runbookPath ? path.resolve(payload.runbookPath) : undefined
  const cwd = runbookDir ?? (effectiveCwd && fs.existsSync(effectiveCwd) ? effectiveCwd : os.homedir())
  const policy = resolvePolicy({
    profile: opsMode ? 'ops-remote' : payload.lightMode ? 'interactive-light' : 'interactive-chat',
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
  const mcpServers = !opsMode && payload.useMcp ? mcpServersForProject(projectPath) : undefined
  const askMode = payload.approvalMode !== 'auto' && payload.permissionMode !== 'bypassPermissions'

  // Ops: load the runbook, check the hosts, log run.start, and get the gate's canUseTool
  // and the ops MCP server. Any refusal ends the turn here, before the model is called.
  let ops: { ctx: OpsRunContext; systemAppend: string; mcpServer: unknown; canUseTool: CanUseTool } | null = null
  if (payload.runbookPath) {
    const fail = (error: string): void => {
      activeRuns.delete(appSessionId)
      updateRunIndicators()
      if (activeRuns.size === 0) hidePillSoon(4000)
      flagAttention('error')
      send('agent:error', { appSessionId, error })
    }
    if (providerFor(policy.model) !== 'claude') {
      fail('Ops chats run on Claude only.')
      return
    }
    const prepared = await prepareOpsRun({
      appSessionId,
      runbookPath: payload.runbookPath,
      model: policy.model,
      ...(payload.accountId ? { account: payload.accountId } : {}),
      ledger: getOpsLedger(),
      executor: getOpsExecutor(),
      abort,
      loadRunbook,
      readScript,
      hostAddress: opsHostAddress,
      ask: async ({ tool, input, ops: context }) => {
        const d = await requestToolApproval(appSessionId, tool, input, abort.signal, context)
        return { allow: d.allow, ...(d.stop ? { stop: true } : {}) }
      },
      askSecret: (req) => requestOpsSecret(appSessionId, req, abort.signal),
      onEvent: (line) => send('ops:event', { appSessionId, runId: line.event.runId, line })
    })
    if (!prepared.ok) {
      fail(prepared.error)
      return
    }
    if (abort.signal.aborted) {
      // Stopped while the hosts were being checked.
      await finishOpsRun(prepared.ctx, { ok: false, costUsd: 0, aborted: true })
      fail('The ops run was stopped before it started.')
      return
    }
    ops = prepared
    // A tool call may wait in the per-host queue and then run for the policy's timeout;
    // the CLI's default 60 s wait on an in-process MCP call would cut it off first.
    env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT ??= String(2 * OPS_MAX_TIMEOUT_MS)
    env.MCP_TOOL_TIMEOUT ??= String(2 * OPS_MAX_TIMEOUT_MS)
  }
  const opsCtx = ops?.ctx ?? null
  /** Log run.end for an ops run; a no-op otherwise, and only the first call counts. */
  const endOps = async (r: Parameters<typeof finishOpsRun>[1]): Promise<void> => {
    if (opsCtx) await finishOpsRun(opsCtx, r)
  }

  // In 'ask' mode, prompt the renderer before any tool that is not on the read-only
  // allowlist runs (see tool-approval-pure.ts for why it is an allowlist).
  const canUseTool = askMode
    ? async (toolName: string, input: Record<string, unknown>) => {
        if (!needsApproval(toolName)) {
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
      ...(ops
        ? {
            // The gate's canUseTool on every turn, whatever the chat's ask/auto toggle says
            // (plan §6): mutate+auto is what policy.json already expresses.
            permissionMode: 'default' as const,
            canUseTool: ops.canUseTool,
            ...(policy.systemPrompt ? { systemPrompt: { ...policy.systemPrompt, append: ops.systemAppend } } : {}),
            ...(policy.disallowedTools ? { disallowedTools: policy.disallowedTools } : {}),
            ...(policy.maxTurns !== undefined ? { maxTurns: policy.maxTurns } : {}),
            additionalDirectories: [cwd],
            mcpServers: { ops: ops.mcpServer }
          }
        : {
            permissionMode: askMode ? ('default' as const) : payload.permissionMode ?? 'acceptEdits',
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
              : {})
          }),
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
          await endOps({
            ok: !message.isError,
            costUsd: message.costUsd,
            usage: message.usage,
            ...(abort.signal.aborted ? { aborted: true } : {}),
            ...(message.isError && message.errorText ? { error: message.errorText } : {})
          })
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
          await endOps({ ok: false, costUsd: 0, error: message.message, ...(abort.signal.aborted ? { aborted: true } : {}) })
          flagAttention('error')
          send('agent:error', { appSessionId, error: message.message })
          break
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    await endOps({ ok: false, costUsd: 0, error: msg, ...(abort.signal.aborted ? { aborted: true } : {}) })
    flagAttention('error')
    send('agent:error', { appSessionId, error: msg })
    runErrored = true
    sendToPill('pill:update', { state: 'error' })
  } finally {
    // A stream that ended with neither a result nor an error still closes its run.
    await endOps({
      ok: false,
      costUsd: 0,
      ...(abort.signal.aborted ? { aborted: true } : { error: 'The run ended without a result.' })
    })
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
ipcMain.handle('sftp:upload', (_, hostId: string, dir: string, localPaths?: string[]) =>
  sftpUpload(hostId, dir, localPaths)
)
ipcMain.handle('sftp:history', (_, hostId: string) => sftpHistory(hostId))
ipcMain.handle('sftp:disconnect', (_, hostId: string) => sftpDisconnect(hostId))

// ─── WSL ──────────────────────────────────────────────────────────────────

ipcMain.handle('wsl:list', () => listDistros())
ipcMain.handle('wsl:test', (_, distro: string) => testDistro(distro))
ipcMain.handle('wsl:test-claude', (_, distro: string) => testDistroClaude(distro))
ipcMain.handle('wsl:hidden', () => getHiddenDistros())
ipcMain.handle('wsl:set-hidden', (_, distro: string, hidden: boolean) => setDistroHidden(distro, hidden))
ipcMain.handle('wsl:history', (_, distro: string) => wslHistory(distro))
ipcMain.handle('wsl:drive-map', () => listWslDriveMap())
// Asked when a WSL terminal opens, not when something is pasted into it: the probe boots
// the distro if it is cold, and a paste should never wait on that. See wsl.ts.
ipcMain.handle('wsl:clipboard-image-capable', (_, distro: string) => wslClipboardImageCapable(distro))
ipcMain.handle('wsl:to-linux-paths', (_, distro: string, paths: string[]) => wslToLinuxPaths(distro, paths))

// ─── Project names (sidebar custom display names) ─────────────────────────────

ipcMain.handle('projects:get-names', () => getProjectNames())
ipcMain.handle('projects:set-name', (_, key: string, name: string) => {
  setProjectName(key, name)
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
/**
 * Push the resolved appearance to EVERY window, not just the main one.
 *
 * Unlike the other pushes in this file, this one cannot go through sendToMainWindow:
 * the overlay, the toast and the status pill each paint themselves from the same
 * palette, and they read it exactly once when they mount. Before this, the only way
 * they picked up a theme change was by being recreated — which is fine for a change
 * the user just made in the main window's settings, and useless for the OS flipping
 * to dark at sunset while all four windows are alive.
 */
function broadcastUiPrefs(ui: UiPrefs): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:ui', ui)
  }
}

ipcMain.handle('config:set-ui', (_, prefs: UiPrefsPatch) => {
  const ui = setUiPrefs(prefs)
  broadcastUiPrefs(ui)
  return ui
})
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

  // Only touch the login entry when the pref actually changed, and never in dev (see
  // the startup call for why: electron.exe isn't a meaningful login target there).
  if (!is.dev && prefs.openAtLogin !== undefined && prefs.openAtLogin !== prevOpenAtLogin) {
    setOpenAtLogin(system.openAtLogin, ['--hidden'])
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
/**
 * Everything the Notifications panel needs to tell the user what to paste.
 *
 * It hands back text, and only text. `~/.claude/settings.json` is the user's file —
 * it holds their permissions, their own hooks, their env — and a merge written by
 * us is a merge we would have to get right every time against a schema that is not
 * ours. The block goes on the clipboard; the edit is theirs.
 */
ipcMain.handle('notify-hook:info', () => {
  const command = notifyHookCommand(process.execPath, app.isPackaged ? '' : app.getAppPath())
  const wsl = process.platform === 'win32' ? wslHookCommand(process.execPath) : null
  return {
    command,
    block: hookSettingsBlock(command),
    wslCommand: wsl,
    wslBlock: wsl ? hookSettingsBlock(wsl) : null,
    installed: notifyHookInstalled(getClaudeHooks()),
    settingsPath: path.join(os.homedir(), '.claude', 'settings.json')
  }
})

/**
 * Wires the hook in, through the same validating writer the Permissions and Hooks
 * panels already use — `setClaudeHooks` merges by event key (unknown events, and any
 * other `Notification` entries the user wrote, are carried through untouched) and
 * refuses to touch a settings.json it can't parse. `withNotifyHook` is what decides
 * *what* to merge: add if missing, update in place if the exe path moved.
 */
ipcMain.handle('notify-hook:install', () => {
  const command = notifyHookCommand(process.execPath, app.isPackaged ? '' : app.getAppPath())
  const wsl = process.platform === 'win32' ? wslHookCommand(process.execPath) : null
  const result = setClaudeHooks(withNotifyHook(getClaudeHooks(), command))
  return {
    ok: result.ok,
    error: result.error,
    command,
    block: hookSettingsBlock(command),
    wslCommand: wsl,
    wslBlock: wsl ? hookSettingsBlock(wsl) : null,
    installed: notifyHookInstalled(result.ok ? (result.hooks ?? {}) : getClaudeHooks()),
    settingsPath: path.join(os.homedir(), '.claude', 'settings.json')
  }
})

ipcMain.handle('config:get-hooks', () => getClaudeHooks())
ipcMain.handle('config:set-hooks', (_, hooks: unknown) => setClaudeHooks(hooks))

// ─── Claude Code data (real projects / sessions / usage, local + WSL) ──────────

ipcMain.handle('cc:sources', () => listSources())
ipcMain.handle('cc:list-projects', () => getAllProjects())
ipcMain.handle('cc:list-sessions', async (_, sourceId: string, encodedDir: string, archived = false) => {
  const sessions = await listSessions(sourceId, encodedDir, archived)
  // Accumulate the vocabulary as we go, so a tag applied from outside the app (the
  // CLI, another tool) gets a colour the first time it is seen. Best-effort by
  // design — it must never cost the caller the session list.
  try {
    foldIn(sessions.flatMap((s) => s.tags))
  } catch {
    /* colours only */
  }
  return sessions
})
ipcMain.handle(
  'cc:read-session',
  (_, sourceId: string, encodedDir: string, sessionId: string, archived = false) =>
    readSession(sourceId, encodedDir, sessionId, archived)
)
// Terminal-driven chats address a transcript by cwd + session id rather than by
// source/encodedDir — see readChatTranscript's own doc comment for the resolution.
ipcMain.handle(
  'cc:chat-transcript',
  (_, cwd: string, sessionId: string, preferSourceId?: string) =>
    readChatTranscript(cwd, sessionId, preferSourceId)
)
/**
 * Match Codex terminal chats to the conversations they started.
 *
 * The listing and the claim are both done here rather than in the renderer: the listing
 * spawns a process, and the claim has to see every chat at once to hand two chats in one
 * folder their own threads. `claimed` is the thread ids other chats already hold, so a
 * chat whose terminal is reopened cannot take one that is already spoken for.
 */
ipcMain.handle(
  'codex:link-threads',
  async (_, chats: LinkableChat[], claimed: string[], accountId?: string) => {
    if (!Array.isArray(chats) || !chats.length) return {}
    const configDir = providerAccountConfigDir('codex', accountId)
    const threads = await listCodexThreads(chats.map((c) => c.cwd), configDir)
    if (!threads.length) return {}
    const picked = pickThreadsForChats(chats, threads, new Set(claimed))
    const byId = new Map(threads.map((t) => [t.id, t]))
    const out: Record<string, { threadId: string; title: string | null }> = {}
    for (const [chatId, threadId] of Object.entries(picked)) {
      const thread = byId.get(threadId)
      if (thread) out[chatId] = { threadId, title: titleForThread(thread) }
    }
    return out
  }
)
ipcMain.handle('cc:usage', (_, force = false) => getUsage(force))
ipcMain.handle('cc:plan-usage', (_, force = false) => getPlanUsageForIpc(!!force))
// A scope narrows the sweep to one project AND narrows what counts as a hit to
// prose — see SearchScope. The renderer passes one or it doesn't; there is no third
// depth to pick from.
ipcMain.handle('cc:search', (_, query: string, scope?: { sourceId: string; encodedDir: string }) =>
  searchSessions(query, 100, scope?.sourceId && scope?.encodedDir ? scope : undefined)
)
ipcMain.handle(
  'cc:session-peek',
  (_, sourceId: string, encodedDir: string, sessionId: string, archived = false) =>
    readSessionPeek(sourceId, encodedDir, sessionId, archived)
)

// ─── Session lifecycle ────────────────────────────────────────────────────────
// Archiving is the reversible one and delete is not; both are file-level and go
// through the same path guard as every other transcript write.

ipcMain.handle('cc:session-archive', (_, sourceId: string, encodedDir: string, sessionId: string) =>
  archiveSession(sourceId, encodedDir, sessionId)
)
ipcMain.handle('cc:session-unarchive', (_, sourceId: string, encodedDir: string, sessionId: string) =>
  unarchiveSession(sourceId, encodedDir, sessionId)
)
ipcMain.handle(
  'cc:session-delete',
  (_, sourceId: string, encodedDir: string, sessionId: string, archived = false) =>
    deleteSession(sourceId, encodedDir, sessionId, archived)
)
ipcMain.handle(
  'cc:session-rename',
  (_, sourceId: string, encodedDir: string, sessionId: string, title: string, archived = false) =>
    renameSession(sourceId, encodedDir, sessionId, title, archived)
)
ipcMain.handle(
  'cc:chat-rename',
  (_, cwd: string, sessionId: string, title: string, preferSourceId?: string) =>
    renameChatSession(cwd, sessionId, title, preferSourceId)
)
ipcMain.handle(
  'cc:session-move',
  (
    _,
    sourceId: string,
    encodedDir: string,
    sessionId: string,
    toSourceId: string,
    toEncodedDir: string,
    archived = false
  ) => moveSession(sourceId, encodedDir, sessionId, toSourceId, toEncodedDir, archived)
)
ipcMain.handle('cc:favorites', () => getFavoriteProjects())
ipcMain.handle('cc:set-favorite', (_, sourceId: string, encodedDir: string, on: boolean) =>
  setProjectFavorite(sourceId, encodedDir, on)
)

// ─── Project lifecycle ────────────────────────────────────────────────────────
//
// Archiving a project is a preference — organisation, not files — and orthogonal to
// archiving a session, which moves one. Deleting a project is refused while it still
// holds a transcript, active or archived, so it can never wipe a conversation.

ipcMain.handle('cc:project-archive', (_, sourceId: string, encodedDir: string, on: boolean) =>
  setProjectArchived(sourceId, encodedDir, on)
)
ipcMain.handle('cc:project-delete', (_, sourceId: string, encodedDir: string) =>
  deleteProject(sourceId, encodedDir)
)

/**
 * Folders a run is working in right now.
 *
 * Renaming a folder out from under a running chat breaks it, so the move refuses
 * while one is in flight. This is a courtesy check, not the guarantee: a session
 * started but never saved has no file to read a path from, and an open terminal
 * holding the directory is invisible here entirely. The real backstop is the
 * operating system refusing the rename, which the move reports as it comes.
 */
function busyProjectPaths(): string[] {
  const out: string[] = []
  for (const id of activeRuns.keys()) {
    try {
      const s = readJsonFile<{ projectPath?: string }>(path.join(sessionsDir, `${id}.json`))
      if (s.projectPath) out.push(s.projectPath)
    } catch {
      // Unsaved session — nothing to read a path from.
    }
  }
  return out
}

ipcMain.handle('cc:project-move', (_, sourceId: string, encodedDir: string, toPath: string) =>
  moveProjectFolder(sourceId, encodedDir, toPath, busyProjectPaths())
)

// ─── Live sessions ────────────────────────────────────────────────────────────
// Read-only. Every field comes from Claude Code's own registry, and nothing here
// sends a signal to anything.

ipcMain.handle('cc:live-sessions', () => listLiveSessions())

// Also read-only: matches a chat terminal's pty to the live `claude` under it. See
// session-adoption.ts for why it refuses to guess.
ipcMain.handle('cc:adopt-sessions', (_, terminalIds: string[]) => adoptTerminalSessions(terminalIds))

// ─── Session tags + the label vocabulary ──────────────────────────────────────
//
// Conflicts come back as values, not exceptions: each one needs a different move in
// the UI (reload, offer a merge, report a partial sweep) and a catch would flatten
// them into one failure.

ipcMain.handle(
  'cc:set-session-tags',
  async (_, sourceId: string, encodedDir: string, sessionId: string, tags: unknown) => {
    try {
      // Routed rather than resolved here: a Codex conversation keeps its tags in
      // Argos's store, because its rollout is read back by a typed deserialiser and
      // must not carry a line Argos invented (see store.ts).
      const clean = await writeTagsForSession(sourceId, encodedDir, sessionId, tags)
      if (!clean) return { ok: false as const, error: 'not-found' as const }
      try {
        foldIn(clean)
      } catch {
        /* colours only */
      }
      return { ok: true as const, tags: clean }
    } catch (e) {
      return { ok: false as const, error: 'invalid' as const, message: (e as Error).message }
    }
  }
)

ipcMain.handle('cc:labels', () => getLabels())
ipcMain.handle('cc:label-set-color', (_, name: string, color?: string) => setLabelColor(name, color))
ipcMain.handle('cc:label-usage', (_, name: string) => labelUsage(name))
ipcMain.handle('cc:label-rename', (_, from: string, to: string) => renameLabel(from, to))
ipcMain.handle('cc:label-merge', (_, from: string, into: string) => mergeLabel(from, into))
ipcMain.handle('cc:label-delete', (_, name: string) => deleteLabel(name))

// ─── MCP ────────────────────────────────────────────────────────────────────

ipcMain.handle('mcp:list', () => listMcpServers())
ipcMain.handle('mcp:upsert', (_, name: string, cfg: Record<string, unknown>) =>
  upsertGlobalMcpServer(name, cfg)
)
ipcMain.handle('mcp:remove', (_, name: string) => removeGlobalMcpServer(name))

// ─── Terminal (embedded PTY) ────────────────────────────────────────────────

/**
 * A terminal's CLI started or stopped working (plan H5): the taskbar bar, the pill and,
 * on busy→idle with the window out of view, the success badge, as an SDK run's start and
 * end feed them. Decorative: never let it disturb the terminal.
 */
function onTerminalBusy(id: string, busy: boolean): void {
  try {
    const change = noteTerminalBusy(busyTerminalSet, id, busy, activeRuns.size)
    if (change.kind === 'none') return
    updateRunIndicators()
    if (change.kind === 'started') {
      if (mainWindowInactive()) {
        const info = listTerminals().find((t) => t.id === id)
        showPill()
        sendToPill('pill:update', {
          state: 'running',
          sessionName: info ? path.basename(info.cwd) || info.provider : 'Terminal',
          tool: null
        })
      }
      return
    }
    // flagAttention is a no-op while the window has focus.
    flagAttention('success')
    if (change.total === 0) {
      sendToPill('pill:update', { state: 'done' })
      hidePillSoon(2500)
    }
  } catch {
    /* indicators are decorative */
  }
}

/** A pty that went away without an idle transition: drop it from the count, quietly. */
function dropBusyTerminal(id: string): void {
  if (!busyTerminalSet.delete(id)) return
  updateRunIndicators()
  if (runsInFlight() === 0) hidePillSoon(2500)
}

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
      pinSessionId?: string
      /** An ops terminal: what ops:terminal-session returned (env + config), forwarded as is. */
      ops?: { env: Record<string, string>; mcpConfigPath: string }
      cols: number
      rows: number
    }
  ) => {
    // Returns { ok, shell, cliLaunched, reused, buffer }. The scrollback of a reused pty comes
    // back in this invoke result rather than over 'terminal:data' on purpose — that way the
    // renderer controls the ordering itself and can replay history before any live chunk.
    const r = createTerminal(
      id,
      opts,
      (tid, data) => send('terminal:data', { id: tid, data }),
      (tid, exitCode) => {
        send('terminal:exit', { id: tid, exitCode })
        // terminal.ts forgets an exited pty's busy state without an idle transition.
        dropBusyTerminal(tid)
        // One ops run per CLI launch: the pty going away ends it.
        void endTerminalOps(tid, exitCode === 0 ? { ok: true } : { ok: false, error: `the terminal exited with code ${exitCode}` })
      },
      // Pushed on the transition rather than polled: the renderer turns this straight into
      // a running dot, and a poll slow enough to be cheap would be too slow to be right.
      (tid, busy) => {
        send('terminal:busy', { id: tid, busy })
        onTerminalBusy(tid, busy)
      },
      // The CLI asking for the user back, read out of its own output — see
      // terminal-osc-pure.ts. `waiting` separates "it needs you" from "it is done".
      (tid, waiting) => send('terminal:notify', { id: tid, waiting })
    )
    // A session opened for a terminal that then failed to start would otherwise stay open
    // with no pty to end it.
    if (!r.ok && terminalOps.has(id)) void endTerminalOps(id, { ok: false, error: r.error ?? 'the terminal did not start' })
    return r
  }
)
// Which ptys are mid-burst right now. The renderer hears transitions only from the moment
// it subscribes, so it seeds itself from this — otherwise a chat already working when the
// window opened would stay dark until it next changed state.
ipcMain.handle('terminal:busy-list', () => busyTerminals())
// And which ones are waiting on the user, seeded for the same reason: a chat parked on an
// approval when the window opened would otherwise look like one that had simply finished.
ipcMain.handle('terminal:waiting-list', () => waitingTerminals())
ipcMain.on('terminal:write', (_, id: string, data: string) => writeTerminal(id, data))
ipcMain.on('terminal:resize', (_, id: string, cols: number, rows: number) =>
  resizeTerminal(id, cols, rows)
)
// killTerminal drops the pty without its onExit, so a closed ops terminal ends its run here.
ipcMain.handle('terminal:kill', (_, id: string) => {
  const r = killTerminal(id)
  dropBusyTerminal(id)
  void endTerminalOps(id, { ok: true })
  return r
})
ipcMain.on('terminal:kill-deferred', (_, id: string) => {
  killTerminalDeferred(id)
  if (!terminalOps.has(id)) return
  // The deferred kill fires after 250 ms unless a re-create for the same id cancels it
  // (a remount); only a terminal that is really gone ends its run.
  setTimeout(() => {
    if (!listTerminals().some((t) => t.id === id)) void endTerminalOps(id, { ok: true })
  }, 500)
})
// The ptys this process holds, for the terminal grid. No consumer count: unmounting
// a terminal view never kills anything, so there is nothing to reference-count.
ipcMain.handle('terminal:list', () => listTerminals())
ipcMain.handle(
  'terminal:start-cli',
  (
    _,
    id: string,
    provider: 'claude' | 'codex' | 'gemini',
    resumeSessionId?: string,
    pinSessionId?: string
  ) => startCliInTerminal(id, provider, resumeSessionId, pinSessionId)
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
      if (isError) return { ok: false as const, error: errorText || 'The model returned an error.' }
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

      if (isError) return { ok: false as const, error: errorText || 'The model returned an error.', costUsd }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd }
      } catch {
        return { ok: false as const, error: 'Could not parse the model’s response as JSON.', raw: text, costUsd }
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
      if (isError) return { ok: false as const, error: errorText || 'The model returned an error.', costUsd, commitCount: commits.length }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd, commitCount: commits.length }
      } catch {
        return { ok: false as const, error: 'Could not parse the model’s response as JSON.', raw: text, costUsd, commitCount: commits.length }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0, commitCount: commits.length }
    }
  }
)

// ─── Sprint backfill (a forge's MCP → sprint items) ─────────────────────────────

ipcMain.handle(
  'sprint:backfill',
  async (
    _,
    payload: {
      projectPath?: string
      instructions?: string
      model?: string
      accountId?: string
      probe?: boolean
      kind?: BackfillKind
      /** Overrides the forge derived from the git remote. */
      forge?: Forge
    }
  ) => {
    const model = payload.model || getConfig().defaultModel

    // Find the forge MCP wherever it lives — local ~/.claude.json OR a WSL distro's.
    let servers: { name: string; source: string; url?: string; config?: Record<string, unknown> }[] = []
    try {
      servers = await listMcpServers()
    } catch {
      servers = []
    }
    // Which forge this project actually uses decides which MCP to run against, and
    // every noun in the prompt. The caller can say; otherwise the git remote does.
    const fromRemote = payload.projectPath ? forgeFromRemote(await getRemoteUrl(payload.projectPath)) : null
    const picked = pickForgeServer(servers, payload.forge ?? fromRemote)
    if (!picked) {
      return {
        ok: false as const,
        error:
          'No GitLab or GitHub MCP server was found (checked local and WSL). Configure one in the CLI, then try again.',
        costUsd: 0
      }
    }
    const { server: forgeServer, forge } = picked

    const promptText = payload.probe
      ? buildProjectProbePrompt(payload.instructions, forge)
      : buildBacklogBackfillPrompt(payload.instructions, payload.kind ?? 'issues', forge)

    // ── WSL-hosted MCP: run that distro's own `claude -p` so its stdio server loads.
    // `source` is the distro name for WSL servers, 'local' otherwise.
    if (forgeServer.source && forgeServer.source !== 'local') {
      const cwd = uncToWslPath(payload.projectPath) ?? undefined
      const res = await runWslOneShot(forgeServer.source, promptText, {
        model,
        // MCP server + read-only file tools (to read a repo's .git/config); no Bash/Write.
        allowedTools: [`mcp__${forgeServer.name}`, 'Read', 'Grep', 'Glob'],
        cwd,
        timeoutMs: 180000
      })
      if (!res.ok) return { ok: false as const, error: res.error || 'The WSL backfill run failed.', costUsd: 0 }
      try {
        const parsed = extractJson(res.text)
        if (payload.probe) return { ok: true as const, data: { ...(parsed as object), forge }, costUsd: 0 }
        const { items, warning } = filterBackfillRows(parsed, payload.kind ?? 'issues', forge)
        return { ok: true as const, data: { ...(parsed as object), items, forge }, warning, costUsd: 0 }
      } catch {
        return { ok: false as const, error: 'Could not parse the model’s response as JSON.', raw: res.text, costUsd: 0 }
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
      if (isError) return { ok: false as const, error: errorText || 'The model returned an error.', costUsd }
      try {
        const data = extractJson(text)
        if (payload.probe) return { ok: true as const, data: { ...(data as object), forge }, costUsd }
        const { items, warning } = filterBackfillRows(data, payload.kind ?? 'issues', forge)
        return { ok: true as const, data: { ...(data as object), items, forge }, warning, costUsd }
      } catch {
        return { ok: false as const, error: 'Could not parse the model’s response as JSON.', raw: text, costUsd }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0 }
    }
  }
)

// ─── Git ──────────────────────────────────────────────────────────────────────

ipcMain.handle('git:status', (_, cwd: string) => getStatus(cwd))
ipcMain.handle('git:repo-name', (_, cwd: string) => getRepoName(cwd))

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

/**
 * The clipboard, for the renderer's own Ctrl+V handling.
 *
 * An image wins over text when both are present: a screenshot on the clipboard also
 * carries a text/html fragment, and pasting that markup into a composer instead of
 * the picture is never what was meant.
 *
 * Read here rather than through `navigator.clipboard` in the renderer because that
 * one needs a permission prompt this app has no way to answer, while the main
 * process can simply read it.
 *
 * Files copied in Explorer come back as their paths, for a terminal to type out; they
 * carry no text of their own, so without this such a paste did nothing at all.
 */
ipcMain.handle('clipboard:read', async () => {
  const image = clipboard.readImage()
  if (!image.isEmpty()) {
    return { image: { mediaType: 'image/png', data: image.toPNG().toString('base64') } }
  }
  const text = clipboard.readText()
  if (text) return { text }
  const files = await readClipboardFiles()
  return files.length ? { text, files } : { text }
})

/**
 * Put text on the clipboard on the renderer's behalf — used by the terminals' OSC 52
 * handler, where a CLI on the far side of a pty asks the terminal to copy for it. The
 * renderer's own `navigator.clipboard.writeText` wants a user gesture, and a sequence
 * arriving from the pty is not one.
 */
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text)
})

/**
 * Put the clipboard's image somewhere the terminal's CLI can actually reach, and
 * return the path to type at it.
 *
 * A WSL chat runs `claude` inside the distro, where the Windows clipboard does not
 * exist — Alt+V there answers "no image in clipboard found", correctly, because from
 * inside Linux there is none. Argos sits on the Windows side of that boundary and can
 * see it, so it writes the image across and hands back a path the CLI can open.
 *
 * For a distro the file goes to its own `/tmp` over the UNC share rather than through
 * `/mnt/c`: not every distro mounts the Windows drives, and the share is the same one
 * this app already reads sessions from.
 *
 * SSH is refused rather than fudged. The file would land on this machine while the CLI
 * looked for it on another, and a path that silently points at nothing is worse than a
 * refusal that says so.
 */
ipcMain.handle(
  'clipboard:image-to-file',
  async (_, wslDistro?: string, remoteHostId?: string) => {
    if (remoteHostId) return { ok: false as const, error: 'remote' as const }
    const image = clipboard.readImage()
    if (image.isEmpty()) return { ok: false as const, error: 'no-image' as const }
    const name = `argos-paste-${Date.now()}.png`
    try {
      if (wslDistro) {
        // Built with posixToWslUnc rather than by hand. Written by hand it was
        // `\\wsl.localhost\${d}\tmp\${n}`, where JS reads `\$` as an escaped dollar —
        // so the distro never interpolated — and `\t` as a tab. The write failed
        // every time, and the failure looked exactly like "no image on the clipboard".
        const posix = `/tmp/${name}`
        await fs.promises.writeFile(posixToWslUnc(wslDistro, posix), image.toPNG())
        return { ok: true as const, path: posix }
      }
      const full = path.join(os.tmpdir(), name)
      await fs.promises.writeFile(full, image.toPNG())
      return { ok: true as const, path: full }
    } catch (e) {
      return { ok: false as const, error: 'failed' as const, message: (e as Error).message }
    }
  }
)

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
      .flatMap((f) => {
        try { return [readJsonFile<any>(path.join(sessionsDir, f))] }
        catch { console.warn(`[sessions] Could not read ${f}`); return [] }
      })
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
  const filename = path.join(sessionsDir, `${s.id}.json`)
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify(session, null, 2))
  fs.renameSync(`${filename}.tmp`, filename)
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
