// First, before anything reads userData: dev moves it aside. See dev-instance.ts.
import { isDevInstance, syncDevFromProd } from './dev-instance'
import { listExportCandidates, exportProfile, previewImport, applyImport } from './profile-transfer'
import type { ExportRequest, ImportRequest } from '../shared/profile-transfer'
import { app, BrowserWindow, ipcMain, dialog, Notification, globalShortcut, Menu, MenuItemConstructorOptions, clipboard, nativeTheme, nativeImage, session, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { appIconPath } from './app-icon'
import { hardenWebContents } from './window-security'
import { readClipboardFiles } from './clipboard-files'
import { resolvePolicy } from './ai-policy'
import { getEngine } from './providers/registry'
import { collectText } from './providers/collect'
import { buildPrompt } from './headless-prompt'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'
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
import { loadConfig, getConfig, setDefaultModel, setLimits, setUiPrefs, reresolveUiPrefs, setSystemPrefs, setOpsPrefs, setCompanionPrefs, opsDir, opsDirsView, getClaudeSettings, getClaudePermissions, setClaudePermissions, getClaudeHooks, setClaudeHooks, providerFor, UsageLimits, UiPrefs, UiPrefsPatch, SystemPrefs, OpsPrefsPatch } from './config'
import { buildModelsCatalog } from './models-catalog'
import {
  getAllProjects,
  listSessions,
  readSession,
  readChatTranscript,
  getUsage,
  listSources,
  searchSessions,
  readSessionPeek,
  localTranscriptExists
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
  getRepoName,
  getRemoteUrl,
  getFileDiff
} from './git'
import {
  listHosts,
  saveHost,
  deleteHost,
  getHost,
  testConnection,
  testClaude,
  secretStorageState,
  SshHostInput
} from './ssh'
import { connectionFieldsChanged } from './ssh-host-pure'
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
import { listDistros, testDistro, testDistroClaude, runWslOneShot, uncToWslPath, wslHistory, wslHome, listWslDriveMap, wslClipboardImageCapable, wslToLinuxPaths, wslShareRoot } from './wsl'
import { readTextFile, fsWriteFile, fsMkdir, fsRename, fsDelete } from './local-fs'
import { createLedger, RUN_LIST_MAX, type OpsLedger, type OpsReportKind } from './ops-audit'
import { HISTORY_RUN_ID_RE } from './ops-briefing-pure'
import { earlierRunsInScope } from './ops-tools'
import { handoverFileName } from './ops-handover-pure'
import { foldNotes } from './ops-notes-pure'
import { createExecutor, createSshBackend, type OpsExecutor } from './ops-exec'
import { createFakeBackend } from './ops-backend-fake'
import { loadRunbook, loadRunbookOnBase, readScript, scanRunbookLibrary } from './ops-runbook'
import { builtinRunbookDir } from './ops-builtin'
import { baseProposal, issueUrl, type BaseProposal } from './ops-proposal-pure'
import { summarizePolicy } from './ops-policy-pure'
import { interventionPrompt, referenceLine } from './ops-scope-pure'
import type { OpsScope } from './ops-types'
import {
  bridgeSessionFor,
  finishOpsRun,
  listOperatorScripts,
  openOpsSession,
  runOperatorScript,
  type ApprovalOpsContext,
  type OpsRunContext,
  type OpsSession
} from './ops-session'
import { newOpsToken, registerToken, revokeToken, startOpsBridge, stopOpsBridge } from './ops-bridge'
import { removeOpsMcpConfig, writeOpsMcpConfig } from './ops-mcp-config'
import { opsRelayCommand, type OpsCli } from './ops-mcp-config-pure'
import { OPS_MCP_FLAG, runOpsRelay } from './ops-relay'
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
import { getSessionMigration, setSessionMigration } from './store'
import { migrateLegacySessions, type MigrationState } from './session-migrate'
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
import {
  chatPopoutInView,
  chatPopoutSpec,
  chatPopoutWindows,
  closeChatPopout,
  focusChatPopout,
  openChatPopout,
  openChatPopouts,
  refreshPopoutTitle,
  updateChatPopout,
  type ChatPopoutSpec
} from './chat-popout'
import { noteTerminalBusy } from './run-indicators-pure'
import { successBadge, errorBadge, approvalBadge } from './badges'
import { createTray, quietUntilLabel, refreshTrayMenu, updateTrayShortcutLabel } from './tray'
import { companionStore, normalizeTodo } from './companion-store'
import { exportNote, removeExport, vaultInfo } from './companion-obsidian'
import { startCompanionScheduler, type CompanionScheduler } from './companion-scheduler'
import { snooze, type DueReminder, type SnoozeOption } from './companion-schedule-pure'
import { parseCapture, remindersForWhen } from './companion-nlu-pure'
import { nextTodo } from './companion-repeat-pure'
import {
  TERMINAL_ALERT_MS,
  TERMINAL_STALE_MS,
  chatSessionId,
  hookKey,
  isEmbeddedKey,
  shouldTell,
  terminalKey
} from './companion-terminal-pure'
import { buildWhenPrompt, MODEL_TIMEOUT_MS, needsModel, parsedFromModel } from './companion-nlu-gate-pure'
import { buildExplainPrompt, cleanExplanation, explainArgv, explainCacheKey, type OpsExplainLanguage } from './ops-explain-pure'
import { listForView, planCapture, todayQuery } from './companion-capture-pure'
import { isQuiet, parseQuietCommand, tomorrowAt } from './companion-quiet-pure'
import { isSaveThisCommand, parseSpanCommand } from './companion-focus-pure'
import { weekSummary, weekSummaryDue } from './companion-week-pure'
import { QUNS, userNotificationState } from './companion-win32'
import { activeSprint, activeSprintView, linkedItem, promote, sprintLinks, unlink, withSprintDone } from './companion-promote-pure'
import {
  applyCompanionPrefs,
  closeBubble,
  companionShortcut,
  companionVoiceShortcut,
  currentBubble,
  currentPetFacing,
  currentPetState,
  endPetDrag,
  hideCompanion,
  isCompanionBubble,
  isCompanionVisible,
  isSystemQuiet,
  openBubble,
  setSystemQuiet,
  petThePet,
  popupPetMenu,
  registerCompanionShortcut,
  registerVoiceShortcut,
  reregisterCompanionShortcut,
  sendToBubble,
  setBubbleSize,
  setCaptureThinking,
  setCompanionWindowHooks,
  setPetState,
  setVoicePhase,
  showCompanion,
  startPetDrag,
  throwBall,
  toggleCompanion
} from './companion-window'
import type { CompanionCaptureResult, CompanionList, CompanionPrefs, CompanionPromoteResult, CompanionPlanAlert, CompanionTerminalAlert, CompanionTodo, CompanionStateView, CompanionVoicePhase, CompanionWeekSummary, ParsedCapture } from './companion-types'
import { MAX_CLIP_BYTES } from './companion-voice-pure'
import { cancelVoiceInstall, disposeVoice, installVoiceModels, prepareVoice, setVoiceProgressListener, transcribe, voiceStatus } from './companion-voice'
import { currentLanguage, t } from './i18n'
import { initUpdater, getUpdaterState, checkNow, quitAndInstall } from './updater'
import { getPlanUsageForIpc, startPlanUsageWatcher } from './plan-usage'
import { getCodexAccountsUsage } from './codex-usage'
import {
  syncExplorerContextMenu,
  extractLaunchAction,
  hasToggleFlag,
  LaunchAction
} from './shell-integration'
import { refreshJumpList } from './jumplist'
import { extendLinuxPath, setOpenAtLogin } from './linux-desktop'
import { readJsonFile } from './json-file'
import {
  PROTOCOL,
  SessionTarget,
  type NotifyPayload,
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
// The companion's reminder timer; started after ready, stopped on will-quit.
let companionScheduler: CompanionScheduler | null = null

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
        // With Argos on screen he says it in his bubble; otherwise the toast, as before.
        if (!tellCompanionAboutHook(relayed)) showHookNotification(relayed, () => openDeepLink(relayed.link))
        return
      }
      // Windows delivers `argos://` through a second launch's argv.
      const target = extractDeepLink(commandLine)
      if (target) {
        openSessionTarget(target)
        return
      }
      // `--toggle` (a hotkey launching the exe): a window already in front of you goes
      // away; one hidden in the tray, minimized or behind another window comes forward.
      if (hasToggleFlag(commandLine) && mainWindow && !mainWindowInactive()) {
        mainWindow.minimize()
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

// Terminals whose CLI is working right now, fed from terminal:create's onBusy (plan H5).
// They drive the out-of-window indicators: taskbar progress and the attention
// badge. (Not `busyTerminals`: that is terminal.ts's own list, which the renderer
// seeds itself from.)
const busyTerminalSet = new Set<string>()

/** What the taskbar progress bar counts. */
function runsInFlight(): number {
  return busyTerminalSet.size
}

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

/** You are looking at this chat: the main window is active, or the chat's own pop-out is. */
function chatInView(terminalId: string): boolean {
  return !mainWindowInactive() || chatPopoutInView(terminalId)
}

// Taskbar progress: an indeterminate bar while any terminal is working, cleared to
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
    kind === 'success' ? t('main.taskbar.runFinished') : kind === 'error' ? t('main.taskbar.runFailed') : t('main.taskbar.approvalNeeded')
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

// The user came back to the main window, which already holds every pending approval (its
// modal or plan sheet got each request when it was made). A toast over the app asking the
// same thing is noise: withdraw it, from the toast only, and leave the requests pending.
function withdrawToastApprovals(): void {
  if (toastApprovals.size === 0) return
  for (const id of toastApprovals) sendToToast('approval:resolved', id)
  toastApprovals.clear()
  hideToast()
}

const sessionsDir = path.join(app.getPath('userData'), 'sessions')
// Where the pre-2.0 migration puts each SDK chat's transcript, and its original JSON.
const chatExportsDir = path.join(app.getPath('userData'), 'exports', 'chats')
const sessionsBackupDir = path.join(app.getPath('userData'), 'sessions-pre-2.0')

function ensureDirs(): void {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true })
}

/**
 * The pre-2.0 chat migration (plan §3): started once at startup, right after ensureDirs.
 * session:list waits on it, so the renderer never sees a session in the old shape.
 * Never rejects: a file that fails is left as it was and retried next launch.
 */
let sessionsMigrated: Promise<void> = Promise.resolve()

function startSessionMigration(): void {
  sessionsMigrated = migrateLegacySessions({
    sessionsDir,
    backupDir: sessionsBackupDir,
    exportsDir: chatExportsDir,
    writeState: (state) => setSessionMigration(state)
  })
    .then((r) => {
      if (r.exported || r.upgraded || r.failed.length) {
        console.log(`[sessions] pre-2.0 migration: ${r.exported} exported, ${r.upgraded} upgraded, ${r.failed.length} failed`)
      }
    })
    .catch((e) => console.warn('[sessions] pre-2.0 migration failed:', e))
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
      label: t('main.menu.view'),
      submenu: [
        { role: 'reload', label: t('main.menu.reload') },
        { role: 'forceReload', label: t('main.menu.forceReload') },
        { role: 'toggleDevTools', label: t('main.menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('main.menu.resetZoom') },
        { role: 'zoomIn', label: t('main.menu.zoomIn') },
        { role: 'zoomOut', label: t('main.menu.zoomOut') }
      ]
    },
    {
      label: t('main.menu.window'),
      submenu: [
        { role: 'minimize', label: t('main.menu.minimize') },
        { role: 'close', label: t('main.menu.close') }
      ]
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
    // Packaged Windows takes the multi-size .ico embedded in Argos.exe: any PNG handed
    // to the window left the taskbar button on Windows' blank page. Dev has no such exe.
    icon:
      app.isPackaged && process.platform === 'win32'
        ? undefined
        : nativeImage.createFromPath(appIconPath()).resize({ width: 256, height: 256 }),
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
    withdrawToastApprovals()
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
        title: t('main.notify.trayHint.title'),
        body: t('main.notify.trayHint.body')
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
  startSessionMigration()
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
      onToggleCompanion: toggleCompanion,
      isCompanionVisible,
      onCompanionToday: showCompanionToday,
      onCompanionQuiet: setCompanionQuiet,
      companionQuietUntil,
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
    showMain: showUsageView,
    tell: (a) =>
      tellCompanionPlan({ key: `plan:${a.accountKey}:${a.windowKey}`, account: a.account, pct: a.pct, detail: a.body })
  })
  // The companion: its windows are created on first show; the summon shortcut and the
  // reminder timer start now, and "stay on screen" puts the pet up straight away.
  setCompanionWindowHooks({
    onVisibilityChanged: refreshTrayMenu,
    onBubbleClosed: showNextCompanionAlert,
    hasPendingAlerts: () => companionAlerts.length > 0
  })
  registerCompanionShortcut(getConfig().companion.shortcut)
  registerVoiceShortcut(getConfig().companion.voice, getConfig().companion.voiceShortcut)
  installMicrophonePermission()
  // Still muted from before the restart: he comes up with the crescent.
  if (companionQuietUntil() !== null) setPetState('shh')
  if (getConfig().companion.stayOnScreen) showCompanion()
  companionScheduler = startCompanionScheduler({
    store: companionStore(),
    deliver: (items) => queueCompanionAlerts(items.map((reminder) => ({ mode: 'reminder', reminder }))),
    deliverCatchUp: (reminders, reason) => queueCompanionAlerts([{ mode: 'catchup', reminders, reason }]),
    // Ran out (or was switched off): he sits up, and the tray and panel stop saying "quiet".
    // What it held back is delivered right after, in the same tick.
    onDndLifted: () => {
      if (currentPetState() === 'shh') setPetState('idle')
      refreshTrayMenu()
      companionChanged()
      showNextCompanionAlert()
    }
  })
  // Friday from five on (plan §13.3, T1): the week in one line, once.
  setInterval(checkWeekSummary, 60_000)
  checkWeekSummary()
  startSystemQuietWatcher()
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
  // exe path stays fresh across updates, and, independent of the toggle, clear the
  // entries left behind under the app's former name — one reg.exe run for both. Skip in
  // dev — electron.exe as the target would leave a checkout-specific command in the
  // user's registry.
  if (!is.dev) {
    void syncExplorerContextMenu(getConfig().system.explorerContextMenu ? true : undefined, {
      removeLegacy: true
    })
  }

  // Windows Jump List (recent projects + New terminal), refreshed on save below.
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
  companionScheduler?.stop()
  disposeVoice()
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
// ─── A chat popped out into its own window (chat-popout.ts) ────────────────────
const isPopoutSpec = (v: unknown): v is ChatPopoutSpec => {
  const s = v as Partial<ChatPopoutSpec> | null
  const optStr = (x: unknown) => x === undefined || typeof x === 'string'
  return (
    !!s &&
    typeof s.sessionId === 'string' &&
    s.sessionId !== '' &&
    typeof s.terminalId === 'string' &&
    s.terminalId !== '' &&
    typeof s.name === 'string' &&
    (s.provider === 'claude' || s.provider === 'codex' || s.provider === 'gemini') &&
    [s.cwd, s.accountId, s.wslDistro, s.remoteHostId, s.resumeSessionId, s.pinSessionId].every(optStr)
  )
}
ipcMain.handle('popout:open', (_, spec: unknown) => {
  if (!isPopoutSpec(spec)) return false
  const backgroundColor = getConfig().ui.theme === 'light' ? '#f7f5f1' : '#141312'
  // Seeded with the chat's current run state, so the title is right before the next change.
  openChatPopout(spec, backgroundColor, (sessionId) => sendToMainWindow('popout:closed', sessionId), {
    busy: busyTerminals().includes(spec.terminalId),
    waiting: waitingTerminals().includes(spec.terminalId)
  })
  return true
})
ipcMain.handle('popout:update', (_, sessionId: unknown, patch: unknown) => {
  if (typeof sessionId !== 'string' || !patch || typeof patch !== 'object') return false
  const name = (patch as { name?: unknown }).name
  if (typeof name !== 'string') return false
  return updateChatPopout(sessionId, { name })
})
ipcMain.handle('popout:spec', (_, sessionId: unknown) => (typeof sessionId === 'string' ? chatPopoutSpec(sessionId) : null))
ipcMain.handle('popout:focus', (_, sessionId: unknown) => (typeof sessionId === 'string' ? focusChatPopout(sessionId) : false))
ipcMain.handle('popout:close', (_, sessionId: unknown) => (typeof sessionId === 'string' ? closeChatPopout(sessionId) : false))
ipcMain.handle('popout:list', () => openChatPopouts())

ipcMain.on('overlay:submit', (_, payload: { prompt: string }) => {
  if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) return
  hideOverlay()
  showMainWindow()
  sendToMainWindow('app:overlay-prompt', { prompt: payload.prompt })
})
ipcMain.on('overlay:open-session', (_, sessionId: string) => {
  if (typeof sessionId !== 'string' || !sessionId) return
  hideOverlay()
  showMainWindow()
  sendToMainWindow('app:open-session', sessionId)
})

// ─── Companion IPC (companion-window.ts) ────────────────────────────────────────

/** What the pet has to say, one bubble at a time; a bubble already open is never cut off. */
type CompanionAlert =
  | { mode: 'reminder'; reminder: DueReminder }
  | { mode: 'catchup'; reminders: DueReminder[]; reason: 'launch' | 'dnd' }
  /** `at`: when it was queued, so one that waited behind reminders too long is dropped. */
  | { mode: 'terminal'; alert: CompanionTerminalAlert; at: number }
  | { mode: 'plan'; alert: CompanionPlanAlert }
  | { mode: 'week'; summary: CompanionWeekSummary }
const companionAlerts: CompanionAlert[] = []
/** The todo whose reminder bubble is up, so done/snooze/dismiss on it moves the queue on. */
let companionReminderId: string | null = null

function queueCompanionAlerts(alerts: CompanionAlert[]): void {
  // Reminders go ahead of every queued terminal alert; those keep their order behind.
  for (const a of alerts) {
    const firstTerminal = a.mode === 'terminal' ? -1 : companionAlerts.findIndex((q) => q.mode === 'terminal')
    if (firstTerminal >= 0) companionAlerts.splice(firstTerminal, 0, a)
    else companionAlerts.push(a)
  }
  try {
    // A reminder does not wait behind word of a terminal: that bubble gives way, and the
    // bubble-closed hook puts the reminder up.
    if (alerts.some((a) => a.mode !== 'terminal') && currentBubble()?.mode === 'terminal') closeBubble()
    showNextCompanionAlert()
  } catch (e) {
    // No pet window (it failed to create): fall back to plain notifications.
    console.error('[companion] could not show the bubble:', e)
    notifyQueuedAlerts()
  }
}

// ─── Terminal alerts (companion-terminal-pure.ts, plan §7 item 3) ───────────────

/** Per embedded terminal, the Claude session it runs, so a hook about it lands on its key. */
const terminalClaudeSessions = new Map<string, string>()
/** What the pet already said about each chat this turn; cleared when it gets busy again. */
const toldTerminals = new Map<string, CompanionTerminalAlert['kind']>()
/** What "Abrir" does, per alert key. */
const terminalOpeners = new Map<string, () => void>()
let terminalAlertTimer: ReturnType<typeof setTimeout> | null = null

/** On, the pet up and not quiet. Hidden or quiet, he does not pop up for a terminal. */
function companionTakesTerminalAlerts(): boolean {
  return getConfig().companion.terminalAlerts && isCompanionVisible() && companionQuietUntil() === null && !isSystemQuiet()
}

// ─── Windows' own quiet (plan §13.3, V) ─────────────────────────────────────────

const SYSTEM_QUIET_POLL_MS = 5000
/** Focus Assist's quiet hours, a busy app, a full-screen game or a presentation. */
const QUIET_STATES = new Set<number>([QUNS.BUSY, QUNS.RUNNING_D3D_FULL_SCREEN, QUNS.PRESENTATION_MODE, QUNS.QUIET_TIME, QUNS.APP])
/** The screen is full: a bubble would be over a game or a slide, so reminders go as notifications. */
const FULL_SCREEN_STATES = new Set<number>([QUNS.RUNNING_D3D_FULL_SCREEN, QUNS.PRESENTATION_MODE, QUNS.APP])
let screenIsFull = false

/** Every few seconds, Windows' word on notifications; with the preference off, nothing is asked. */
function startSystemQuietWatcher(): void {
  const tick = (): void => {
    if (!getConfig().companion.focusAssist) {
      screenIsFull = false
      setSystemQuiet(false)
      return
    }
    const state = userNotificationState()
    const quiet = state !== null && QUIET_STATES.has(state)
    screenIsFull = state !== null && FULL_SCREEN_STATES.has(state)
    const was = isSystemQuiet()
    setSystemQuiet(quiet)
    // Lifted: what waited comes out.
    if (was && !quiet) showNextCompanionAlert()
  }
  setInterval(tick, SYSTEM_QUIET_POLL_MS)
  tick()
}

/** Queued reminders, catch-ups, plan and week alerts as plain notifications (the pet cannot say them). */
function notifyQueuedAlerts(): void {
  for (const a of companionAlerts.splice(0)) {
    if (a.mode === 'terminal') continue
    if (a.mode === 'plan') {
      notifyCompanion(a.alert.account, a.alert.detail)
      continue
    }
    if (a.mode === 'week') {
      const { done, late, open } = a.summary
      notifyCompanion(t('main.companion.week.title'), t('main.companion.week.body', { done, late, open }))
      continue
    }
    for (const r of a.mode === 'reminder' ? [a.reminder] : a.reminders) notifyCompanion(r.title, '')
  }
}

/**
 * Have the pet say a terminal alert. False when he is not taking them, so the caller does
 * what it did before (the toast). True also when it was skipped as already said.
 */
function tellCompanionTerminal(alert: CompanionTerminalAlert, open: () => void): boolean {
  if (!companionTakesTerminalAlerts()) return false
  // Only an embedded chat is deduped: nothing ever clears what was said about one outside
  // Argos, so it would go quiet for good after its first word.
  if (isEmbeddedKey(alert.key)) {
    if (!shouldTell(toldTerminals.get(alert.key), alert.kind)) return true
    toldTerminals.set(alert.key, alert.kind)
  }
  terminalOpeners.set(alert.key, open)
  const up = currentBubble()
  if (up?.mode === 'terminal' && up.payload.alert.key === alert.key) {
    showTerminalBubble(alert)
    return true
  }
  const entry: CompanionAlert = { mode: 'terminal', alert, at: Date.now() }
  const i = companionAlerts.findIndex((a) => a.mode === 'terminal' && a.alert.key === alert.key)
  if (i >= 0) companionAlerts[i] = entry
  else companionAlerts.push(entry)
  showNextCompanionAlert()
  return true
}

/** Up without focus, and gone on its own after TERMINAL_ALERT_MS if nobody answers. */
function showTerminalBubble(alert: CompanionTerminalAlert): void {
  setPetState('alert')
  openBubble({ mode: 'terminal', payload: { alert } })
  if (terminalAlertTimer) clearTimeout(terminalAlertTimer)
  terminalAlertTimer = setTimeout(() => {
    terminalAlertTimer = null
    const up = currentBubble()
    if (up?.mode === 'terminal' && up.payload.alert.key === alert.key) closeBubble()
  }, TERMINAL_ALERT_MS)
}

/** The chat got busy again (you answered it): what was said about its last turn is stale. */
function forgetTerminalAlert(key: string): void {
  toldTerminals.delete(key)
  terminalOpeners.delete(key)
  for (let i = companionAlerts.length - 1; i >= 0; i--) {
    const a = companionAlerts[i]
    if (a.mode === 'terminal' && a.alert.key === key) companionAlerts.splice(i, 1)
  }
  const up = currentBubble()
  if (up?.mode === 'terminal' && up.payload.alert.key === key) closeBubble()
}

// ─── Plan alerts (plan-alerts-pure.ts decides the 85 % / 95 % thresholds) ───────

/** On, the pet up and not quiet. Otherwise the plan watcher shows its notification. */
function companionTakesPlanAlerts(): boolean {
  return getConfig().companion.planAlerts && isCompanionVisible() && companionQuietUntil() === null
}

/**
 * Have the pet say a plan threshold alert. False when he is not taking them, so the watcher
 * shows the notification. It waits ahead of terminal alerts, is never stale, and stays up
 * until answered (it matters, like a reminder).
 */
function tellCompanionPlan(alert: CompanionPlanAlert): boolean {
  if (!companionTakesPlanAlerts()) return false
  const up = currentBubble()
  if (up?.mode === 'plan' && up.payload.alert.key === alert.key) {
    openBubble({ mode: 'plan', payload: { alert } })
    return true
  }
  // The same window crossing again (85 % then 95 %): the newer number replaces the queued one.
  const i = companionAlerts.findIndex((a) => a.mode === 'plan' && a.alert.key === alert.key)
  if (i >= 0) {
    companionAlerts[i] = { mode: 'plan', alert }
    showNextCompanionAlert()
  } else {
    queueCompanionAlerts([{ mode: 'plan', alert }])
  }
  return true
}

/** The main window on the usage view: a plan notification's click and the bubble's "Abrir". */
function showUsageView(): void {
  showMainWindow()
  sendToMainWindow('app:open-view', 'usage')
}

/** A chat's name from its session file, for the bubble's title. */
function chatName(sessionId: string): string {
  try {
    const s = readJsonFile<{ name?: unknown }>(path.join(sessionsDir, `${sessionId}.json`))
    if (typeof s.name === 'string' && s.name.trim()) return s.name.trim()
  } catch {
    /* no file yet: the chat was never saved */
  }
  return t('main.companion.terminal.untitled')
}

function openChat(sessionId: string): void {
  showMainWindow()
  sendToMainWindow('app:open-session', sessionId)
}

/**
 * An embedded chat finished its turn, or its CLI asked for you (OSC 9). Said only while
 * the main window is away: looking at Argos, you see the chat's own dot.
 */
function companionTerminalIdle(terminalId: string, kind: CompanionTerminalAlert['kind']): void {
  const sessionId = chatSessionId(terminalId)
  // A chat in view, in the main window or its own pop-out, shows its own dot.
  if (!sessionId || chatInView(terminalId)) return
  tellCompanionTerminal({ key: terminalKey(terminalId), kind, title: chatName(sessionId), detail: '', ops: isOpsTerminal(terminalId) }, () =>
    openChat(sessionId)
  )
}

/** A terminal running an ops intervention right now (plan §13.3, T3). */
function isOpsTerminal(terminalId: string): boolean {
  const ops = terminalOps.get(terminalId)
  return !!ops && !ops.ctx.ended
}

/**
 * An ops run asked for the operator (a secret, a command to run by hand): with the main
 * window away, the pet says the intervention needs you. The ops session id is the
 * terminal's id (openTerminalOps), so the alert lands on that chat's key.
 */
function tellCompanionOpsWaiting(terminalId: string, detail: string): void {
  const sessionId = chatSessionId(terminalId)
  if (!sessionId || !mainWindowInactive()) return
  tellCompanionTerminal({ key: terminalKey(terminalId), kind: 'waiting', title: chatName(sessionId), detail, ops: true }, () => openChat(sessionId))
}

/** A Claude Code hook notification, for the pet to say. False: show the toast as before. */
function tellCompanionAboutHook(p: NotifyPayload): boolean {
  const target = p.link ? parseDeepLink(p.link) : null
  const key = hookKey(target?.sessionId ?? null, terminalClaudeSessions, p.title)
  const sessionId = key.startsWith('term:') ? chatSessionId(key.slice('term:'.length)) : null
  // An embedded chat while you are looking at Argos: the toast does what it always did.
  // The chat's own pop-out in front counts too, but only for that chat.
  if (sessionId && chatInView(key.slice('term:'.length))) return false
  return tellCompanionTerminal({ key, kind: p.urgent ? 'waiting' : 'finished', title: p.title, detail: p.body }, () =>
    sessionId ? openChat(sessionId) : openDeepLink(p.link)
  )
}

/**
 * Put up the next queued alert, if the bubble is free. Also the bubble-closed hook. While
 * quiet, what was already queued waits too (the scheduler holds back anything newer), and
 * comes out when it lifts.
 */
function showNextCompanionAlert(): void {
  // A bubble still up keeps its reminder id, so settleCompanionReminder can close it.
  if (currentBubble()) return
  companionReminderId = null
  // The screen is full (plan §13.3, V2): a reminder is a notification, not a bubble over a game.
  if (screenIsFull) {
    notifyQueuedAlerts()
    return
  }
  if (companionQuietUntil() !== null || isSystemQuiet()) return
  let next = companionAlerts.shift()
  // Word of a terminal that waited too long behind reminders is old news.
  while (next?.mode === 'terminal' && Date.now() - next.at > TERMINAL_STALE_MS) next = companionAlerts.shift()
  if (!next) return
  if (next.mode === 'terminal') {
    showTerminalBubble(next.alert)
    return
  }
  setPetState('alert')
  if (next.mode === 'plan') {
    openBubble({ mode: 'plan', payload: { alert: next.alert } })
  } else if (next.mode === 'week') {
    openBubble({ mode: 'week', payload: { summary: next.summary } })
  } else if (next.mode === 'reminder') {
    companionReminderId = next.reminder.todoId
    const queued = companionAlerts.filter((a) => a.mode === 'reminder').length
    openBubble({ mode: 'reminder', payload: { reminder: next.reminder, queued } })
  } else {
    openBubble({ mode: 'catchup', payload: { reminders: next.reminders, reason: next.reason } })
  }
}

/**
 * The week in one line (plan §13.3, T1): on Friday from five, once a week, with the pet
 * up it goes in his bubble (with Copy for the standup); hidden or quiet, as a notification.
 */
function checkWeekSummary(): void {
  try {
    const store = companionStore()
    const now = Date.now()
    if (!weekSummaryDue(now, store.getState().lastWeekSummaryAt)) return
    store.setState({ lastWeekSummaryAt: now })
    const summary = weekSummary(store.listTodos(), now)
    if (isCompanionVisible() && companionQuietUntil() === null) {
      queueCompanionAlerts([{ mode: 'week', summary }])
    } else if (Notification.isSupported()) {
      const { done, late, open } = summary
      new Notification({ title: t('main.companion.week.title'), body: t('main.companion.week.body', { done, late, open }) }).show()
    }
  } catch (e) {
    console.error('[companion] week summary failed:', e)
  }
}

/** A todo was answered or removed: drop its queued reminders and, if it is up, move on. */
function settleCompanionReminder(todoId: string): void {
  for (let i = companionAlerts.length - 1; i >= 0; i--) {
    const a = companionAlerts[i]
    if (a.mode === 'reminder' && a.reminder.todoId === todoId) companionAlerts.splice(i, 1)
  }
  if (companionReminderId === todoId && currentBubble()?.mode === 'reminder') closeBubble()
}

function companionList(): CompanionList {
  const store = companionStore()
  const now = Date.now()
  const sprints = listSprints()
  const todos = store.listTodos()
  // A promoted todo reads `done` through from its sprint item (plan §6.1).
  const view = listForView(withSprintDone(todos, sprints, now), store.listNotes(), now)
  return {
    ...view,
    sprintLinks: sprintLinks(todos, sprints),
    activeSprint: activeSprintView(activeSprint(sprints, now)),
    dndUntil: companionQuietUntil()
  }
}

/** When quiet mode ends, or null when it is off (or already ran out). */
function companionQuietUntil(): number | null {
  try {
    const until = companionStore().getState().dndUntil
    return isQuiet(until, Date.now()) ? until! : null
  } catch {
    return null
  }
}

/**
 * Quiet mode on until `untilMs`, or off with null (plan §3.3): the one path for the
 * bubble's `shh`, the tray, the pet's menu and `companion:dnd`. On: the scheduler holds
 * reminders back and he lies down with the crescent. Off: the end is set to now and the
 * scheduler lifts it on the poke, so whatever waited comes out the same way as when it
 * runs out on its own (one catch-up for two or more); its onDndLifted sits him up.
 */
function setCompanionQuiet(untilMs: number | null): number | null {
  const now = Date.now()
  const dndUntil = untilMs !== null && untilMs > now ? untilMs : null
  const store = companionStore()
  const wasOn = isQuiet(store.getState().dndUntil, now)
  if (dndUntil !== null) {
    store.setState({ dndUntil })
    setPetState('shh')
  } else if (wasOn && companionScheduler) {
    store.setState({ dndUntil: now })
  } else {
    store.setState({ dndUntil: null })
    if (currentPetState() === 'shh') setPetState('idle')
  }
  companionScheduler?.poke()
  refreshTrayMenu()
  companionChanged()
  return dndUntil
}

/** "O que tenho hoje" (tray, pet menu): the pet up, its bubble answering for today, ready to type. */
function showCompanionToday(): void {
  // A reminder or catch-up that is up stays until it is answered.
  const open = currentBubble()
  if (open && open.mode !== 'input' && open.mode !== 'confirm') {
    showCompanion()
    return
  }
  openBubble({ mode: 'input', payload: { query: todayQuery(companionStore().listTodos(), Date.now()) } })
}

/** The right-click menu on the dog (plan §3.3), built fresh each time. */
function companionPetMenuTemplate(): MenuItemConstructorOptions[] {
  const until = companionQuietUntil()
  const quietItems: MenuItemConstructorOptions[] =
    until !== null
      ? [{ label: t('main.companion.quietOff', { until: quietUntilLabel(until) }), click: () => setCompanionQuiet(null) }]
      : [
          { label: t('main.companion.quietHour'), click: () => setCompanionQuiet(Date.now() + 60 * 60_000) },
          {
            label: t('main.companion.quietTomorrow'),
            click: () => setCompanionQuiet(tomorrowAt(Date.now(), getConfig().companion.morningHour))
          }
        ]
  return [
    { label: t('main.companion.today'), click: showCompanionToday },
    { label: t('main.companion.ball'), click: throwBall },
    { type: 'separator' },
    ...quietItems,
    { type: 'separator' },
    { label: t('main.companion.openPanel'), click: openCompanionPanel },
    // With "stay on screen" on, until the next summon or reminder brings him back.
    { label: t('main.companion.hide'), click: hideCompanion },
    { label: t('main.companion.settings'), click: openCompanionSettings }
  ]
}

/** "Abrir" / "Ver todos" / the pet's menu: the list in the main window (CompanionView). */
function openCompanionPanel(): void {
  closeBubble()
  showMainWindow()
  sendToMainWindow('app:open-view', 'companion')
}

/** Settings, on its Companheiro section, in the main window. */
function openCompanionSettings(): void {
  closeBubble()
  showMainWindow()
  sendToMainWindow('app:open-view', 'settings/companion')
}

/** A sprint changed: promoted todos read their status through it, and the active sprint may differ. */
function companionSprintChanged(): void {
  try {
    companionChanged()
  } catch (e) {
    console.error('[companion] could not refresh after a sprint change:', e)
  }
}

/** A promoted todo still pointing at a live sprint item: the sprint owns its `done`. */
function isSprintOwned(todo: CompanionTodo): boolean {
  return !!todo.sprintItemId && linkedItem(todo, listSprints()) !== null
}

/** After any change: the main window's panel and the bubble refresh from this. */
function companionChanged(): void {
  const list = companionList()
  sendToMainWindow('companion:changed', list)
  sendToBubble('companion:changed', list)
}

const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 200
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The parse of a line that was a command, not a capture (quiet, focus, timer). */
const EMPTY_PARSED: ParsedCapture = { intent: 'todo', title: '', when: null, remindAt: [], isExplicitReminder: false, confidence: 1, matchedSpan: null }

ipcMain.handle('companion:list', () => companionList())
/** Captures waiting on the model for their date, by the bubble's capture id, so Esc can cancel one. */
const companionModelCaptures = new Map<string, AbortController>()

ipcMain.handle('companion:capture', async (e, payload: unknown): Promise<CompanionCaptureResult | null> => {
  const p = payload as { text?: unknown; source?: unknown; id?: unknown } | null
  if (!p || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 2000) return null
  let text = p.text
  const source = p.source === 'voice' ? 'voice' : 'text'
  const prefs = getConfig().companion
  // "shh 1h", "silêncio até amanhã", "acorda": the whole line is a quiet command (plan §3.3).
  const quiet = parseQuietCommand(text, { now: Date.now(), morningHour: prefs.morningHour })
  if (quiet) {
    const quietUntil = setCompanionQuiet('off' in quiet ? null : quiet.untilMs)
    return { kind: 'quiet', quietUntil, parsed: EMPTY_PARSED }
  }
  // "foca 25" / "timer 5 min" (plan §13.3, T2 and T5): a reminder that many minutes out,
  // and for a focus, quiet until just before it, so it arrives as a plain reminder.
  const span = parseSpanCommand(text)
  if (span) {
    const now = Date.now()
    const endsAt = now + span.ms
    const minutes = Math.round(span.ms / 60_000)
    const todo: CompanionTodo = {
      id: randomUUID(),
      title: t(span.kind === 'focus' ? 'main.companion.focusTitle' : 'main.companion.timerTitle', { n: minutes }),
      dueAt: endsAt,
      duePrecision: 'minute',
      remindAt: [endsAt],
      done: false,
      createdAt: now,
      source
    }
    companionStore().saveTodo(todo)
    companionScheduler?.poke()
    companionChanged()
    if (span.kind === 'timer') return { kind: 'todo', todo, parsed: EMPTY_PARSED }
    const quietUntil = setCompanionQuiet(endsAt - 1000)
    return { kind: 'focus', todo, quietUntil, parsed: EMPTY_PARSED }
  }
  // "guarda isto" (plan §13.3, T4): what is on the clipboard, as a note. Nothing there: nothing saved.
  if (isSaveThisCommand(text)) {
    const clip = clipboard.readText().trim()
    if (!clip) return null
    text = `nota: ${clip.slice(0, 2000)}`
  }
  let parsed = parseCapture(text, { now: Date.now(), leadMinutes: prefs.leadMinutes, morningHour: prefs.morningHour })
  // Layer 2 (plan §5.1): the grammar is unsure, so this one line goes to the model — only
  // with "Perguntar ao modelo" on. Never longer than MODEL_TIMEOUT_MS; any failure keeps
  // the local parse. Esc in the bubble cancels, and then nothing is saved. Only from the
  // bubble, which shows the wait; the panel's quick add stays instant.
  if (prefs.askModel && isCompanionBubble(e.sender) && needsModel(text, parsed)) {
    const id = isId(p.id) ? p.id : randomUUID()
    const abort = new AbortController()
    companionModelCaptures.set(id, abort)
    sendToBubble('companion:capture-thinking', id)
    setCaptureThinking(true)
    try {
      const answer = await askModelForWhen(text, Date.now(), prefs, parsed, abort)
      if (abort.signal.reason === 'cancelled') return { kind: 'cancelled', parsed }
      if (answer) parsed = answer
    } finally {
      companionModelCaptures.delete(id)
      setCaptureThinking(false)
    }
  }
  const now = Date.now()
  const store = companionStore()
  const plan = planCapture({ text, source, parsed, todos: store.listTodos(), now, newId: randomUUID })
  if (plan.kind === 'note') {
    store.saveNote(plan.note)
    // Also into the Obsidian vault when one is set (plan §6.2); a failure leaves the note
    // in notes.json only, and "Exportar as que faltam" in Settings picks it up later.
    const obsidianPath = exportNote(plan.note, prefs)
    if (obsidianPath) {
      plan.note = { ...plan.note, obsidianPath }
      store.saveNote(plan.note)
    }
  }
  if (plan.kind === 'todo') {
    store.saveTodo(plan.todo)
    companionScheduler?.poke()
  }
  if (plan.kind === 'note' || plan.kind === 'todo') companionChanged()
  return plan
})
// Esc while the model reads a capture's date: the capture never happens.
ipcMain.handle('companion:capture-cancel', (_, id: unknown) => {
  if (!isId(id)) return false
  const abort = companionModelCaptures.get(id)
  if (!abort) return false
  abort.abort('cancelled')
  return true
})
// Ctrl+Z on the receipt card (plan §5.4): the capture never happened.
ipcMain.handle('companion:undo', (_, id: unknown, kind: unknown) => {
  if (!isId(id) || (kind !== 'todo' && kind !== 'note')) return false
  const store = companionStore()
  const note = kind === 'note' ? store.listNotes().find((n) => n.id === id) : undefined
  const removed = kind === 'todo' ? store.deleteTodo(id) : store.deleteNote(id)
  if (removed && note) removeExport(note)
  if (removed) {
    if (kind === 'todo') {
      settleCompanionReminder(id)
      companionScheduler?.poke()
    }
    companionChanged()
  }
  return removed
})
ipcMain.handle('companion:update', (_, raw: unknown) => {
  let todo = normalizeTodo(raw)
  if (!todo || !isId(todo.id)) return null
  const stored = companionStore().listTodos().find((x) => x.id === todo!.id)
  // The link is only set by promote and cleared by unlink; the list's read-through
  // `done` of a promoted todo is a view, never written back.
  if (stored?.sprintItemId) {
    todo = { ...todo, sprintId: stored.sprintId, sprintItemId: stored.sprintItemId, done: stored.done, doneAt: stored.doneAt ?? null }
  } else {
    todo = { ...todo, sprintId: null, sprintItemId: null }
  }
  companionStore().saveTodo(todo)
  companionScheduler?.poke()
  companionChanged()
  return todo
})
ipcMain.handle('companion:delete', (_, id: unknown) => {
  if (!isId(id)) return false
  const store = companionStore()
  const removed = store.deleteTodo(id) || store.deleteNote(id)
  if (removed) {
    settleCompanionReminder(id)
    companionScheduler?.poke()
    companionChanged()
  }
  return removed
})
// Settings' Obsidian row: whether the picked folder is a vault, and a catch-up export of
// every note not written yet (made before the export was on, or while the vault was away).
ipcMain.handle('companion:obsidian-info', (_, dir: unknown) => vaultInfo(typeof dir === 'string' ? dir : ''))
ipcMain.handle('companion:obsidian-export', () => {
  const prefs = getConfig().companion
  if (!prefs.obsidianVault) return { exported: 0, failed: 0 }
  const store = companionStore()
  let exported = 0
  let failed = 0
  for (const note of store.listNotes()) {
    if (note.obsidianPath) continue
    const obsidianPath = exportNote(note, prefs)
    if (obsidianPath) {
      store.saveNote({ ...note, obsidianPath })
      exported++
    } else {
      failed++
    }
  }
  if (exported) companionChanged()
  return { exported, failed }
})
ipcMain.handle('companion:done', (_, id: unknown, done: unknown) => {
  if (!isId(id) || typeof done !== 'boolean') return null
  const store = companionStore()
  const todo = store.listTodos().find((t) => t.id === id)
  if (!todo) return null
  // Promoted: the sprint item owns `done`; it is ticked in the Sprint view.
  if (isSprintOwned(todo)) return null
  const now = Date.now()
  const next: CompanionTodo = { ...todo, done, doneAt: done ? now : null }
  // A repeating todo: ticked, the next occurrence is added (once); un-ticked, it goes
  // again, unless it was already ticked or promoted on its own.
  if (done && !todo.done && todo.repeat && !todo.repeatNextId) {
    const prefs = getConfig().companion
    const spawned = nextTodo(todo, now, randomUUID(), (when, explicit) =>
      remindersForWhen(when, explicit, { now, leadMinutes: prefs.leadMinutes, morningHour: prefs.morningHour })
    )
    if (spawned) {
      store.saveTodo(spawned)
      next.repeatNextId = spawned.id
    }
  } else if (!done && todo.repeatNextId) {
    const spawned = store.listTodos().find((t) => t.id === todo.repeatNextId)
    if (spawned && !spawned.done && !spawned.sprintItemId) {
      store.deleteTodo(spawned.id)
      settleCompanionReminder(spawned.id)
    }
    // The link is kept while the spawned one lives on (ticked or promoted), so ticking this
    // one again does not add a second copy of it.
    if (!spawned || (!spawned.done && !spawned.sprintItemId)) next.repeatNextId = null
  }
  store.saveTodo(next)
  companionScheduler?.poke()
  if (done) {
    setPetState('happy')
    settleCompanionReminder(id)
  }
  companionChanged()
  return next
})
ipcMain.handle('companion:snooze', (_, id: unknown, option: unknown) => {
  if (!isId(id)) return null
  const o = option as { minutes?: unknown; tomorrowMorning?: unknown; at?: unknown } | null
  let snoozeOption: SnoozeOption | null = null
  if (o && isFiniteNumber(o.minutes) && o.minutes > 0 && o.minutes <= 7 * 24 * 60) {
    snoozeOption = { minutes: o.minutes }
  } else if (o && o.tomorrowMorning === true) {
    snoozeOption = { tomorrowMorning: true, morningHour: getConfig().companion.morningHour }
  } else if (o && isFiniteNumber(o.at) && o.at > Date.now()) {
    snoozeOption = { at: o.at }
  }
  if (!snoozeOption) return null
  const store = companionStore()
  const todo = store.listTodos().find((t) => t.id === id)
  if (!todo) return null
  const next = snooze(todo, Date.now(), snoozeOption)
  store.saveTodo(next)
  companionScheduler?.poke()
  settleCompanionReminder(id)
  companionChanged()
  return next
})
// "Promover para o sprint" (plan §6.1): one way, once. The new item goes in through the
// same saveSprint as `sprint:save`; the Sprint view reads the folder each time it mounts,
// and it cannot be open while the panel is, so it shows the item on the next visit.
ipcMain.handle('companion:promote', (_, id: unknown): CompanionPromoteResult => {
  if (!isId(id)) return { ok: false, reason: 'not-found' }
  const store = companionStore()
  const todo = store.listTodos().find((x) => x.id === id)
  if (!todo) return { ok: false, reason: 'not-found' }
  const now = Date.now()
  const sprints = listSprints()
  if (linkedItem(todo, sprints)) return { ok: false, reason: 'already' }
  const sprint = activeSprint(sprints, now)
  if (!sprint) return { ok: false, reason: 'no-active-sprint' }
  const result = promote(todo, sprint, now, randomUUID, { dueLabel: t('companion.promote.dueLabel') })
  if (!result.changed) return { ok: false, reason: 'already' }
  // The sprint first: a todo pointing at an item that was never written would read 'missing'.
  saveSprint(result.sprint)
  store.saveTodo(result.todo)
  // The sprint speaks for it now: no reminder pops for it, queued or showing.
  settleCompanionReminder(todo.id)
  for (let i = companionAlerts.length - 1; i >= 0; i--) {
    const a = companionAlerts[i]
    if (a.mode !== 'catchup') continue
    a.reminders = a.reminders.filter((r) => r.todoId !== todo.id)
    if (a.reminders.length === 0) companionAlerts.splice(i, 1)
  }
  companionScheduler?.poke()
  companionChanged()
  return { ok: true, sprintId: sprint.id, sprintItemId: result.todo.sprintItemId!, sprintName: sprint.name }
})
// "Desligar": the sprint item was deleted, so the todo goes back to being a plain one.
ipcMain.handle('companion:unlink', (_, id: unknown) => {
  if (!isId(id)) return null
  const store = companionStore()
  const todo = store.listTodos().find((x) => x.id === id)
  if (!todo || !todo.sprintItemId || isSprintOwned(todo)) return null
  const next = unlink(todo, Date.now())
  store.saveTodo(next)
  companionScheduler?.poke()
  companionChanged()
  return next
})
// The reminder bubble's close: it stays fired, the next one comes up.
ipcMain.handle('companion:dismiss', (_, id: unknown) => {
  if (!isId(id)) return false
  settleCompanionReminder(id)
  return true
})
ipcMain.handle('companion:dnd', (_, untilMs: unknown) => {
  if (untilMs !== null && !isFiniteNumber(untilMs)) return null
  return setCompanionQuiet(untilMs)
})
// The page zoom a companion window inherited from the main window's UI size: Chromium
// zooms every window of one origin together. The companion page cancels it (main.tsx).
ipcMain.handle('companion:zoom', (e) => e.sender.getZoomFactor())

ipcMain.handle('companion:state', (): CompanionStateView => ({
  dndUntil: companionStore().getState().dndUntil ?? null,
  shortcut: companionShortcut(),
  voiceShortcut: companionVoiceShortcut(),
  prefs: getConfig().companion,
  petState: currentPetState(),
  petFacing: currentPetFacing(),
  bubble: currentBubble()
}))
ipcMain.on('companion:bubble-size', (_, size: unknown) => {
  const s = size as { width?: unknown; height?: unknown } | null
  if (s && isFiniteNumber(s.width) && isFiniteNumber(s.height)) setBubbleSize({ width: s.width, height: s.height })
})
ipcMain.on('companion:bubble-close', () => closeBubble())
ipcMain.on('companion:drag-start', () => startPetDrag())
ipcMain.on('companion:drag-end', () => endPetDrag())
// A click on the dog: open the bubble for typing, or close it if it already is. A
// reminder or catch-up that is up stays until it is answered.
ipcMain.on('companion:summon', () => {
  const open = currentBubble()
  if (!open) showCompanion({ focusInput: true })
  else if (open.mode === 'input') closeBubble()
})
// A long press on the dog: a wag, and nothing opens.
ipcMain.on('companion:pet', () => petThePet())
ipcMain.on('companion:open-main', () => openCompanionPanel())
// "Abrir" on a terminal bubble: that chat in the main window.
ipcMain.on('companion:terminal-open', (_, key: unknown) => {
  if (typeof key !== 'string' || !key || key.length > 1000) return
  const open = terminalOpeners.get(key)
  closeBubble()
  open?.()
})
// "Abrir" on a plan alert bubble: the usage view in the main window.
ipcMain.on('companion:plan-open', () => {
  closeBubble()
  showUsageView()
})
// A right-click on the dog: the native menu at the cursor (the pet window never takes focus).
ipcMain.on('companion:pet-menu', () => popupPetMenu(Menu.buildFromTemplate(companionPetMenuTemplate())))

// ─── Companion dictation (companion-voice.ts, plan §4.2) ────────────────────────

const VOICE_PHASES: readonly CompanionVoicePhase[] = ['idle', 'recording', 'transcribing']

setVoiceProgressListener((status) => {
  sendToBubble('companion:voice-progress', status)
  sendToMainWindow('companion:voice-progress', status)
})
ipcMain.handle('companion:voice-status', () => voiceStatus())
ipcMain.handle('companion:voice-install', () => installVoiceModels())
ipcMain.handle('companion:voice-cancel-install', () => cancelVoiceInstall())
ipcMain.handle('companion:voice-transcribe', async (e, clip: unknown) => {
  // Only the bubble records; only it may ask, and only with voice on.
  if (!isCompanionBubble(e.sender) || !getConfig().companion.voice) return { ok: false, error: 'unavailable' }
  const bytes =
    clip instanceof ArrayBuffer ? new Uint8Array(clip) : clip instanceof Uint8Array ? clip : null
  if (!bytes) return { ok: false, error: 'invalid' }
  if (bytes.byteLength > MAX_CLIP_BYTES) return { ok: false, error: 'too-long' }
  return transcribe(bytes)
})
// Recording started: load the recognizer meanwhile, so the first dictation does not wait.
ipcMain.on('companion:voice-prepare', (e) => {
  if (isCompanionBubble(e.sender) && getConfig().companion.voice) prepareVoice()
})
ipcMain.on('companion:voice-phase', (e, phase: unknown) => {
  if (!isCompanionBubble(e.sender) || !VOICE_PHASES.includes(phase as CompanionVoicePhase)) return
  setVoicePhase(phase as CompanionVoicePhase)
})

/**
 * The microphone, for the companion's bubble only, audio only, and only with dictation
 * on (plan §8). Every other permission keeps Electron's default answer, as it had before
 * any handler existed — the terminals' clipboard writes depend on it. The check handler
 * is set too: navigator.permissions and some getUserMedia paths consult it, not the
 * request handler.
 */
function installMicrophonePermission(): void {
  const ses = session.defaultSession
  const micAllowed = (contents: Electron.WebContents | null): boolean =>
    !!contents && getConfig().companion.voice && isCompanionBubble(contents)
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') return callback(true)
    const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []
    callback(micAllowed(contents) && types.length > 0 && types.every((t) => t === 'audio'))
  })
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media') return true
    return micAllowed(contents) && (details as { mediaType?: string }).mediaType !== 'video'
  })
}

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

ipcMain.handle('app:set-zoom', (e, factor: number) => {
  const f = Math.max(0.6, Math.min(1.4, factor || 1))
  // The window that asked: the main one, or a popped-out chat following the same setting.
  e.sender.setZoomFactor(f)
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

// Companion reminders when the pet window could not be created (see queueCompanionAlerts).
function notifyCompanion(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => showMainWindow())
  n.show()
}

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
  if (!result.migrated) {
    const error = result.detail ?? 'nothing was copied'
    console.error(`[dev-sync] ${error}`)
    return { ok: false, error }
  }
  loadAuthState()
  loadAccounts()
  loadProviderAccounts()
  loadConfig()
  reloadStore()
  if (result.detail) console.log(`[dev-userdata] ${result.detail}`)
  setTimeout(() => mainWindow?.webContents.reload(), 50)
  return { ok: true }
})

// ─── Profile export / import ────────────────────────────────────────────────

// One `.argos` file with the profile and the chosen projects' chats (see
// profile-transfer.ts). Both dialogs are shown from here, so a path never comes from
// the renderer except the one the import preview itself handed back.
ipcMain.handle('profile:export-candidates', () => listExportCandidates())
ipcMain.handle('profile:export', (_, req: ExportRequest) => exportProfile(mainWindow, req))
ipcMain.handle('profile:import-preview', () => previewImport(mainWindow))
// Relaunch on the merged profile, through the same clean quit as the tray's Quit:
// terminals, ops runs and ssh sessions are closed by before-quit. The delay lets the
// IPC reply reach the renderer first.
function relaunchAfterImport(): void {
  setTimeout(() => {
    app.relaunch()
    isQuitting = true
    app.quit()
  }, 300)
}
ipcMain.handle('profile:import', async (_, req: ImportRequest) => {
  const result = await applyImport(req)
  // With skips the app stays up so the renderer can list them; it relaunches through
  // profile:relaunch once the user has read them.
  if (result.ok && result.skipped.length === 0) relaunchAfterImport()
  return result
})
ipcMain.handle('profile:relaunch', () => relaunchAfterImport())
ipcMain.handle('profile:show-file', (_, filePath: string) => {
  if (typeof filePath === 'string' && filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
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
  if (!opsLedger) opsLedger = createLedger(path.join(app.getPath('userData'), 'ops-audit'), t)
  return opsLedger
}

function getOpsExecutor(): OpsExecutor {
  // ARGOS_OPS_FAKE=1 runs the whole gate + ledger path against the in-memory backend, so
  // screenshots and demos need no server (plan §9 Phase 3).
  // ARGOS_OPS_FAKE_OUT: a text file whose contents the fake returns as stdout of every command.
  if (!opsExecutor) {
    const fakeOut = process.env.ARGOS_OPS_FAKE_OUT
    const fake = () => createFakeBackend(fakeOut ? { exec: () => ({ stdout: fs.readFileSync(fakeOut, 'utf-8') }) } : {})
    opsExecutor = createExecutor(process.env.ARGOS_OPS_FAKE === '1' ? fake() : createSshBackend())
  }
  return opsExecutor
}

/** Stored hosts as the gate and the reports see them: no secrets, no auth fields. */
function opsHostRefs(): { id: string; name: string; host: string }[] {
  return listHosts().map((h) => ({ id: h.id, name: h.name, host: h.host }))
}

/** `user@host:port` for the approval modal's header. */
/** The operator named in each host's syslog line: the OS account running Argos. */
function opsOperator(): string {
  try {
    return os.userInfo().username
  } catch {
    return 'unknown'
  }
}

function opsHostAddress(hostId: string): string {
  const h = listHosts().find((x) => x.id === hostId)
  return h ? `${h.username}@${h.host}:${h.port}` : hostId
}

// The runbooks shipped with Argos: the read-only despiste (`path`, the default way to start
// an intervention) and the base intervention (`intervention`, docs/BASE_INTERVENTION_PLAN.md).
ipcMain.handle('ops:builtin-runbook', () => ({ path: builtinRunbookDir('diagnosis'), intervention: builtinRunbookDir('intervention') }))

// `onBase`: load the runbook added to the base intervention, as the run would see it.
ipcMain.handle('ops:load-runbook', async (_, dir: string, opts?: { onBase?: boolean }) => {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: t('main.ipc.ops.noRunbookFolder') }
  const onBase = !!(opts && typeof opts === 'object' && opts.onBase === true) && !isBuiltinRunbookPath(dir)
  const r = onBase ? await loadRunbookOnBase(dir, builtinRunbookDir('intervention')) : await loadRunbook(dir)
  if (!r.ok) return { ok: false, error: r.error, ...(r.errors ? { errors: r.errors } : {}) }
  const rb = r.runbook
  // The start screen describes the runbook picked, not the base it is added to: its own
  // RUNBOOK.md, after the base's in the merged guidelines, gives the paragraph.
  const own = onBase ? await loadRunbook(dir) : null
  const guidelines = own?.ok ? own.runbook.guidelines : rb.guidelines
  return {
    ok: true,
    name: rb.ref.name,
    path: rb.ref.path,
    hosts: rb.hosts.map((h) => ({ id: h.host.id, name: h.host.name, host: h.host.host, groups: h.groups })),
    warnings: rb.warnings,
    ...(rb.ref.platform ? { platform: rb.ref.platform } : {}),
    strict: rb.policy.strict,
    summary: summarizePolicy(rb.policy, guidelines)
  }
})

// "Open RUNBOOK.md" / "Open policy.json" on the start screen. Only a folder that loads as
// a runbook, and only those two names, so this cannot be pointed at an arbitrary file.
// The runbooks folder of Settings, listed: its direct subfolders that look like runbooks,
// each then loaded by the renderer with ops:load-runbook. No folder set is an empty list.
ipcMain.handle('ops:scan-runbooks', async () => {
  const dir = opsDirsView().runbooksDir
  if (!dir) return { ok: true, dir: null, entries: [] }
  const r = await scanRunbookLibrary(dir)
  return r.ok ? { ok: true, dir, entries: r.entries } : r
})

ipcMain.handle('ops:open-runbook-file', async (_, dir: string, which: string) => {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: t('main.ipc.ops.noRunbookFolder') }
  if (which !== 'RUNBOOK.md' && which !== 'policy.json') return { ok: false, error: t('main.ipc.ops.notRunbookFile', { name: String(which) }) }
  const r = await loadRunbook(dir)
  if (!r.ok) return { ok: false, error: r.error }
  const error = await shell.openPath(path.join(r.runbook.ref.path, which))
  return error ? { ok: false, error } : { ok: true }
})

// The start screen's "Earlier on <server>": run summaries from the ledger, newest first.
ipcMain.handle('ops:runs', async (_, opts?: { hostId?: string; limit?: number }) => {
  const o = opts && typeof opts === 'object' ? opts : {}
  return getOpsLedger().listRuns({
    ...(typeof o.hostId === 'string' && o.hostId !== '' ? { hostId: o.hostId } : {}),
    ...(typeof o.limit === 'number' ? { limit: o.limit } : {})
  })
})

/**
 * "Add to Argos" (docs/BASE_INTERVENTION_PLAN.md §6): what an ended run's own runbook
 * allows that the base intervention does not. Null for a built-in runbook, a run that
 * has not ended or made no call, or a runbook that adds nothing. Everything comes from the
 * ledger and the folders on disk; the renderer only names the run.
 */
async function baseProposalFor(runId: string): Promise<{ ok: true; proposal: BaseProposal | null } | { ok: false; error: string }> {
  const r = await getOpsLedger().readRun(runId)
  if (!r.ok) return { ok: false, error: r.error }
  const events = r.lines.map((l) => l.event)
  const start = events.find((e) => e.kind === 'run.start')
  const end = events.find((e) => e.kind === 'run.end')
  if (start?.kind !== 'run.start' || end?.kind !== 'run.end') return { ok: true, proposal: null }
  const decided = events.flatMap((e) => (e.kind === 'call.decided' ? [e] : []))
  if (decided.length === 0 || isBuiltinRunbookPath(start.runbook.path)) return { ok: true, proposal: null }
  const [own, base] = await Promise.all([loadRunbook(start.runbook.path), loadRunbook(builtinRunbookDir('intervention'))])
  if (!own.ok) return { ok: false, error: own.error }
  if (!base.ok) return { ok: false, error: t('runbook.load.baseFailed', { error: base.error }) }
  const proposal = baseProposal({
    base: base.runbook.policy,
    runbook: own.runbook.policy,
    runbookName: own.runbook.ref.name,
    usedRules: decided.flatMap((e) => (e.rule ? [e.rule] : [])),
    outcome: end.aborted ? 'aborted' : end.ok ? 'ok' : 'failed',
    argosVersion: app.getVersion(),
    hostWords: listHosts().flatMap((h) => [h.name, h.host])
  })
  return { ok: true, proposal }
}

ipcMain.handle('ops:base-proposal', async (_, runId: string) => {
  if (!isRunId(runId)) return { ok: false, error: t('main.ipc.ops.invalidRunId') }
  const r = await baseProposalFor(runId)
  if (!r.ok || !r.proposal) return r.ok ? { ok: true, proposal: null } : r
  const p = r.proposal
  return {
    ok: true,
    proposal: { rules: p.rules.length, scripts: p.scripts.length, used: [...p.rules, ...p.scripts].filter((x) => x.used).length }
  }
})

// Opens the prefilled GitHub issue in the browser. The URL is built here from the ledger,
// never taken from the renderer; a body too long for a URL goes to the clipboard.
ipcMain.handle('ops:open-base-issue', async (_, runId: string) => {
  if (!isRunId(runId)) return { ok: false, error: t('main.ipc.ops.invalidRunId') }
  const r = await baseProposalFor(runId)
  if (!r.ok) return r
  if (!r.proposal) return { ok: false, error: t('main.ipc.ops.nothingToPropose') }
  // The issue is in English like the rest of its body, whatever the UI language.
  const { url, viaClipboard } = issueUrl(r.proposal, 'The proposal was too long for the link: Argos copied it to the clipboard, paste it here.')
  if (viaClipboard) clipboard.writeText(r.proposal.body)
  await shell.openExternal(url)
  return { ok: true, viaClipboard }
})

const isReportKind = (k: unknown): k is OpsReportKind => k === 'internal' || k === 'client' || k === 'handover'

ipcMain.handle('ops:report', async (_, runId: string, kind: OpsReportKind, runbookPath?: string) => {
  if (typeof runId !== 'string' || runId === '') return { ok: false, error: t('main.ipc.ops.noRunId') }
  if (!isReportKind(kind)) return { ok: false, error: t('main.ipc.ops.unknownReportKind', { kind: String(kind) }) }
  // The ledger has no policy, so the host roles of the client report ("servidor de base
  // de dados") come from the runbook when the caller names it.
  const extraWarnings: string[] = []
  let opts: { hostGroups: Record<string, string[]>; hosts: { id: string; name: string; host: string }[] } | undefined
  if (typeof runbookPath === 'string' && runbookPath !== '') {
    const rb = await loadRunbook(runbookPath)
    if (rb.ok) opts = { hostGroups: rb.runbook.policy.hosts, hosts: opsHostRefs() }
    else if (kind === 'client') extraWarnings.push(t('main.ipc.ops.reportHostsAnonymised', { error: rb.error }))
  }
  const r = await getOpsLedger().report(runId, kind, opts)
  return r.ok ? { ...r, warnings: [...extraWarnings, ...r.warnings] } : r
})

// Saves a rendered report as a new file in the configured folders (Settings, `config.ops`):
// the internal and client reports in the reports folder (default `~/argos/reports`) as
// `<YYYY-MM-DD>-<runId>[-cliente].md`, the handover in the interventions folder (default
// `~/argos/interventions`) as `INC-<YYYY-MM-DD>-<cliente>-<tema>.md`, like the operator's
// own files. Argos never writes under a runbook folder, the built-in one or any other.
// It only ever creates a file: `wx` refuses an existing one rather than editing it, and a
// taken handover name gets `-2`, `-3`… instead.
ipcMain.handle('ops:save-report', async (_, runId: string, kind: OpsReportKind, runbookPath?: string) => {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)) return { ok: false, error: t('main.ipc.ops.invalidRunId') }
  if (!isReportKind(kind)) return { ok: false, error: t('main.ipc.ops.unknownReportKind', { kind: String(kind) }) }
  // The runbook only supplies the host roles; nothing is written under it. Without one the
  // report is saved as rendered (the client report then shows hosts as [servidor]).
  let opts: { hostGroups: Record<string, string[]>; hosts: { id: string; name: string; host: string }[] } | undefined
  if (typeof runbookPath === 'string' && runbookPath !== '') {
    const rb = await loadRunbook(runbookPath)
    if (!rb.ok) return { ok: false, error: t('main.ipc.ops.saveRunbookUnloadable', { error: rb.error }) }
    opts = { hostGroups: rb.runbook.policy.hosts, hosts: opsHostRefs() }
  }
  const ledger = getOpsLedger()
  const r = await ledger.report(runId, kind, opts)
  if (!r.ok) return r
  // Date the file by the run's start, so a report saved days later still sorts by the run.
  const lines = await ledger.readRun(runId)
  const start = lines.ok ? lines.lines.find((l) => l.event.kind === 'run.start') : undefined
  const startAt = start?.at
  const date = (startAt && /^\d{4}-\d{2}-\d{2}/.test(startAt) ? startAt : new Date().toISOString()).slice(0, 10)
  const dir = opsDir(kind === 'handover' ? 'handoversDir' : 'reportsDir')
  let names: string[]
  if (kind === 'handover') {
    const ev = start?.event.kind === 'run.start' ? start.event : undefined
    // The server the run was scoped to, or its only one: it names a file without a client.
    const scoped = ev?.scope?.kind === 'host' ? ev.scope.hostId : undefined
    const host = scoped ? ev?.hosts.find((h) => h.id === scoped) : ev?.hosts.length === 1 ? ev.hosts[0] : undefined
    const summary = lines.ok ? foldNotes(lines.lines, runId).summary : undefined
    const base = handoverFileName({
      startedAt: startAt ?? new Date().toISOString(),
      runbook: ev?.runbook.name ?? '',
      ...(ev?.client !== undefined ? { client: ev.client } : {}),
      ...(ev?.task !== undefined ? { task: ev.task } : {}),
      ...(host?.name ? { host: host.name } : {}),
      ...(summary ? { summary } : {})
    }).replace(/\.md$/, '')
    names = [`${base}.md`, ...Array.from({ length: 98 }, (_, i) => `${base}-${i + 2}.md`)]
  } else {
    names = [`${date}-${runId}${kind === 'client' ? '-cliente' : ''}.md`]
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: t('main.ipc.ops.reportSaveFailed', { error: e instanceof Error ? e.message : String(e) }) }
  }
  let file = ''
  for (const name of names) {
    file = path.join(dir, name)
    try {
      await fs.promises.writeFile(file, r.markdown, { encoding: 'utf-8', flag: 'wx' })
      return { ok: true, path: file }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') continue
      return { ok: false, error: t('main.ipc.ops.reportSaveFailed', { error: e instanceof Error ? e.message : String(e) }) }
    }
  }
  return { ok: false, error: t('main.ipc.ops.reportExists', { file }) }
})

// "Abrir pasta" for the ops folders of Settings: only those, by name, so this cannot
// open an arbitrary path. The reports and handovers folders are created first, so a fresh
// install can open them; the runbooks folder is someone's repo, opened only when set.
ipcMain.handle('ops:open-folder', async (_, which: string) => {
  if (which === 'runbooks') {
    const dir = opsDirsView().runbooksDir
    if (!dir) return { ok: false, error: t('main.ipc.ops.noRunbooksFolder') }
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true, path: dir }
  }
  if (which !== 'reports' && which !== 'handovers') return { ok: false, error: t('main.ipc.ops.unknownFolder', { which: String(which) }) }
  const dir = opsDir(which === 'reports' ? 'reportsDir' : 'handoversDir')
  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const error = await shell.openPath(dir)
  return error ? { ok: false, error } : { ok: true, path: dir }
})

ipcMain.handle('ops:verify', (_, date: string) => getOpsLedger().verify(date))
ipcMain.handle('ops:ledger-info', () => getOpsLedger().info())

// The "?" on an ops approval (ops-explain-pure.ts): one command, explained by a separate
// one-shot call that sees only its words. Same policy and provider as standup:generate;
// no run, host or task goes with it. Answers are kept per words and language for the
// app's life, and a second click while one is on its way waits for that one.
const OPS_EXPLAIN_TIMEOUT_MS = 45_000
const OPS_EXPLAIN_CACHE_MAX = 200
const opsExplainCache = new Map<string, string>()
const opsExplainInFlight = new Map<string, Promise<{ ok: true; text: string } | { ok: false; error: string }>>()

async function explainOpsCommand(argv: string[], language: OpsExplainLanguage): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const abort = new AbortController()
  const env = buildSubprocessEnv()
  const policy = resolvePolicy({ profile: 'headless-reasoning' })
  const providerId = providerFor(policy.model)
  if (providerId !== 'claude') Object.assign(env, providerAccountEnv(providerId))
  const timer = setTimeout(() => abort.abort('timeout'), OPS_EXPLAIN_TIMEOUT_MS)
  const aborted = new Promise<null>((resolve) => abort.signal.addEventListener('abort', () => resolve(null), { once: true }))
  try {
    const stream = getEngine(providerId).run({
      prompt: buildPrompt(buildExplainPrompt(argv, language), undefined, undefined, '') as string,
      ...policy,
      cwd: os.homedir(),
      env,
      abortController: abort,
      permissionMode: 'bypassPermissions'
    })
    const collected = collectText(stream)
    collected.catch(() => {})
    const out = await Promise.race([collected, aborted])
    if (!out) return { ok: false, error: t('main.ipc.ops.explainTimeout') }
    if (out.isError) return { ok: false, error: out.errorText || t('main.ipc.ops.explainFailed') }
    const text = cleanExplanation(out.text)
    return text ? { ok: true, text } : { ok: false, error: t('main.ipc.ops.explainFailed') }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

ipcMain.handle('ops:explain-command', async (_, argvIn: unknown) => {
  const checked = explainArgv(argvIn)
  if (!checked.ok) return { ok: false, error: checked.error }
  const language: OpsExplainLanguage = currentLanguage() === 'pt-PT' ? 'pt-PT' : 'en'
  const key = explainCacheKey(checked.argv, language)
  const cached = opsExplainCache.get(key)
  if (cached !== undefined) return { ok: true, text: cached }
  let pending = opsExplainInFlight.get(key)
  if (!pending) {
    pending = explainOpsCommand(checked.argv, language).finally(() => opsExplainInFlight.delete(key))
    opsExplainInFlight.set(key, pending)
  }
  const r = await pending
  if (r.ok) {
    if (opsExplainCache.size >= OPS_EXPLAIN_CACHE_MAX) opsExplainCache.delete(opsExplainCache.keys().next().value as string)
    opsExplainCache.set(key, r.text)
  }
  return r
})

// A reopened ops chat's timeline: every ledger line of its runs, shaped like the live
// `ops:event` so the renderer folds both the same way.
ipcMain.handle('ops:session-events', async (_, appSessionId: string) => {
  if (typeof appSessionId !== 'string' || appSessionId === '') return { ok: false, error: t('main.ipc.ops.noSessionId') }
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
  /** The intervention as asked for, so a remount with the same one reattaches. */
  interventionKey: string
  initialPrompt: string
  /** The Claude session the CLI continues (a resume whose transcript is on disk) or
   *  creates under; exactly one is set. Logged as run.start.cliSessionId. */
  resumeSessionId?: string
  pinSessionId?: string
  /** A resume only: the first message for the chain's create step, should --resume fail. */
  resumeFallbackPrompt?: string
  provider: OpsCli
  /** The runbook runs added to the base intervention: the CLI gets the base's folder. */
  onBase: boolean
  token: string
  endpoint: string
  mcpConfigPath: string
  /** userData/ops-mcp/<terminalId>/<runId>: the config, removed with the token. */
  dir: string
  guarantee: 'tools-and-local-shell' | 'tools-only'
  ctx: OpsRunContext
  /** The gate and tool handlers, so the operator can run a runbook script from the UI. */
  session: OpsSession
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
      /** The CLI's first message, for the renderer to pass to the terminal (initialPrompt). */
      initialPrompt: string
      /** Exactly one of these: the Claude session to continue, or the new id to create
       *  under. The renderer passes it to the terminal as is. */
      resumeSessionId?: string
      pinSessionId?: string
    }
  | { ok: false; error: string }

/** One intervention as the start screen describes it (docs/INTERVENTIONS_PLAN.md §2). */
interface OpsIntervention {
  runbookPath: string
  scope: OpsScope
  task: string
  ticket?: string
  client?: string
  /** "Hand over to a runbook": the diagnosis run this intervention follows. */
  parentRunId?: string
  /** "Retomar" (INTERVENTION_HISTORY_PLAN §2): the earlier run this one continues. */
  resumesRunId?: string
  /** Earlier runs the operator pointed to on the start screen (≤ 5). */
  relatedRunIds?: string[]
  /** "Somar à base": the runbook runs added to the base intervention shipped with Argos
   *  (docs/BASE_INTERVENTION_PLAN.md §5). Never set for a built-in runbook. */
  onBase?: boolean
}

/** A run id is a UUID; anything else is not one Argos wrote. */
const isRunId = (x: unknown): x is string => typeof x === 'string' && HISTORY_RUN_ID_RE.test(x)

/** How many related runs one intervention may name. */
const RELATED_RUNS_MAX = 5

function parseIntervention(v: unknown): OpsIntervention | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: t('main.ipc.ops.noIntervention') }
  const o = v as Record<string, unknown>
  if (typeof o.runbookPath !== 'string' || o.runbookPath.trim() === '') return { error: t('main.ipc.ops.noRunbookFolder') }
  const sc = o.scope as Record<string, unknown> | null | undefined
  let scope: OpsScope
  if (sc && sc.kind === 'open') scope = { kind: 'open' }
  else if (sc && sc.kind === 'host' && typeof sc.hostId === 'string' && sc.hostId !== '') scope = { kind: 'host', hostId: sc.hostId }
  else return { error: t('main.ipc.ops.interventionNoServer') }
  if (typeof o.task !== 'string') return { error: t('main.ipc.ops.interventionNoTask') }
  const text = (x: unknown, max: number): string | undefined =>
    typeof x === 'string' && x.trim() !== '' ? x.trim().slice(0, max) : undefined
  const ticket = text(o.ticket, 200)
  const client = text(o.client, 200)
  const parentRunId = isRunId(o.parentRunId) ? o.parentRunId : undefined
  const resumesRunId = isRunId(o.resumesRunId) ? o.resumesRunId : undefined
  // Invalid ids dropped, duplicates and the resumed run left out, at most five.
  const relatedRunIds = Array.isArray(o.relatedRunIds)
    ? [...new Set(o.relatedRunIds.filter(isRunId))].filter((id) => id !== resumesRunId).slice(0, RELATED_RUNS_MAX)
    : []
  return {
    runbookPath: o.runbookPath,
    scope,
    task: o.task.trim().slice(0, 4000),
    ...(ticket ? { ticket } : {}),
    ...(client ? { client } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(resumesRunId ? { resumesRunId } : {}),
    ...(relatedRunIds.length ? { relatedRunIds } : {}),
    // A built-in runbook is never added to the base: the diagnosis is read-only by design,
    // and the base on itself is just the base.
    ...(o.onBase === true && !isBuiltinRunbookPath(o.runbookPath) ? { onBase: true } : {})
  }
}

/** Whether a folder is one of the runbooks shipped with Argos. */
function isBuiltinRunbookPath(dir: string): boolean {
  const norm = (p: string): string => path.resolve(p).toLowerCase()
  return (['diagnosis', 'intervention'] as const).some((name) => norm(builtinRunbookDir(name)) === norm(dir))
}

function terminalOpsReply(s: TerminalOpsSession): TerminalOpsResult {
  return {
    ok: true,
    runId: s.runId,
    // MCP_TOOL_TIMEOUT: Claude Code gives an MCP call far less than a modal wait plus a
    // ten-minute exec by default; the other CLIs take their timeouts from the config file.
    env: { ARGOS_OPS_PIPE: s.endpoint, ARGOS_OPS_TOKEN: s.token, MCP_TOOL_TIMEOUT: String(3 * OPS_MAX_TIMEOUT_MS) },
    mcpConfigPath: s.mcpConfigPath,
    guarantee: s.guarantee,
    initialPrompt: s.initialPrompt,
    ...(s.resumeSessionId ? { resumeSessionId: s.resumeSessionId } : {}),
    ...(s.pinSessionId ? { pinSessionId: s.pinSessionId } : {})
  }
}

/**
 * The Claude session of a new ops run (INTERVENTION_HISTORY_PLAN §2): resuming a run whose
 * session id is logged and whose transcript is still on disk continues that conversation;
 * anything else creates under a new pinned id. Undefined when the run to resume is not in
 * the ledger: a resume of a run this machine never saw is refused, not guessed at.
 */
async function opsSessionFor(
  intervention: OpsIntervention
): Promise<{ ok: true; resumeSessionId?: string; pinSessionId?: string } | { ok: false; error: string }> {
  const { resumesRunId, runbookPath } = intervention
  if (!resumesRunId) return { ok: true, pinSessionId: randomUUID() }
  const r = await getOpsLedger().readRun(resumesRunId)
  if (!r.ok) return { ok: false, error: t('main.ipc.ops.ledgerUnreadable', { error: r.error }) }
  const start = r.lines.find((l) => l.event.kind === 'run.start')
  if (start?.event.kind !== 'run.start') return { ok: false, error: t('main.ipc.ops.resumeRunUnknown', { runId: resumesRunId }) }
  const sid = start.event.cliSessionId
  // The terminal runs in the runbook folder under the default Claude config (no account).
  if (sid && localTranscriptExists(runbookPath, sid)) return { ok: true, resumeSessionId: sid }
  return { ok: true, pinSessionId: randomUUID() }
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

/**
 * "Hand over to a runbook": log run.handover in the diagnosis an intervention follows, then
 * end that diagnosis as finished (run.end ok, not aborted like a Stop). Called once the
 * intervention's run has opened, so the line names it, and before its CLI starts. A
 * diagnosis still live in a terminal logs through its own session (its timeline sees the
 * line) and the renderer closes its CLI after; one already ended gets the line appended
 * to the ledger after its run.end, which readers fold by run id like any other line. A
 * diagnosis already handed over (a Restart of the intervention) is left as it is.
 */
async function handOverParent(parentRunId: string, childRunId: string, runbook: string, childTerminalId: string): Promise<void> {
  const event = { kind: 'run.handover' as const, runId: parentRunId, childRunId, runbook }
  const live = [...terminalOps.entries()].find(([id, s]) => id !== childTerminalId && s.runId === parentRunId && !s.ctx.ended)
  if (live) {
    await live[1].ctx.log(event)
    await endTerminalOps(live[0], { ok: true })
    return
  }
  const ledger = getOpsLedger()
  const lines = await ledger.readRun(parentRunId)
  if (!lines.ok) return
  const start = lines.lines.find((l) => l.event.kind === 'run.start')
  if (start?.event.kind !== 'run.start' || lines.lines.some((l) => l.event.kind === 'run.handover')) return
  const r = await ledger.append(event)
  if (!r.ok) return
  try {
    send('ops:event', { appSessionId: start.event.appSessionId, runId: parentRunId, line: JSON.parse(r.raw) })
  } catch {
    // The timeline is a view; the ledger line is already on disk.
  }
}

async function openTerminalOps(terminalId: string, intervention: OpsIntervention): Promise<TerminalOpsResult> {
  // Claude Code only (39badc7): the one CLI whose own shell and file tools can be switched off.
  const provider: OpsCli = 'claude'
  const { runbookPath, scope, task, ticket, client, parentRunId, resumesRunId, relatedRunIds, onBase } = intervention
  const interventionKey = JSON.stringify([
    runbookPath,
    scope,
    task,
    ticket ?? '',
    client ?? '',
    parentRunId ?? '',
    resumesRunId ?? '',
    relatedRunIds ?? [],
    !!onBase
  ])
  const existing = terminalOps.get(terminalId)
  if (existing && !existing.ctx.ended) {
    // A remount reattaches to the same live pty, whose CLI holds this token: hand back the
    // same session, or the running relay is orphaned.
    if (existing.interventionKey === interventionKey) return terminalOpsReply(existing)
    await endTerminalOps(terminalId, { ok: false, aborted: true, error: 'replaced by a new ops session on the same terminal' })
  }

  // Which Claude session the CLI runs in, decided before the run opens so run.start logs it.
  const cli = await opsSessionFor(intervention)
  if (!cli.ok) return cli
  const cliSessionId = cli.resumeSessionId ?? cli.pinSessionId

  const abort = new AbortController()
  const opened = await openOpsSession({
    appSessionId: terminalId,
    runbookPath,
    scope,
    task,
    ...(ticket ? { ticket } : {}),
    ...(client ? { client } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(resumesRunId ? { resumesRunId } : {}),
    ...(relatedRunIds?.length ? { relatedRunIds } : {}),
    ...(cliSessionId ? { cliSessionId } : {}),
    model: `${provider} CLI (terminal)`,
    ledger: getOpsLedger(),
    executor: getOpsExecutor(),
    t,
    abort,
    loadRunbook: onBase ? (dir: string) => loadRunbookOnBase(dir, builtinRunbookDir('intervention')) : loadRunbook,
    readScript,
    hostAddress: opsHostAddress,
    syslog: { operator: opsOperator(), sshUser: (hostId) => listHosts().find((h) => h.id === hostId)?.username ?? '' },
    ask: async ({ tool, input, ops: context }) => {
      const d = await requestToolApproval(terminalId, tool, input, abort.signal, context)
      return { allow: d.allow, ...(d.stop ? { stop: true } : {}), ...(d.skipSteps?.length ? { skipSteps: d.skipSteps } : {}) }
    },
    askSecret: (req) => requestOpsSecret(terminalId, req, abort.signal),
    askOperator: (req) => requestOpsOperator(terminalId, req, abort.signal),
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
    // A resume that continues its conversation says so on the --resume step; the create
    // step behind it (should the resume fail) gets the variant for a model that remembers
    // nothing. Any other launch has one message, for the create step.
    const promptOpts = {
      planRequired: ctx.planRequired,
      ...(relatedRunIds?.length ? { related: relatedRunIds } : {}),
      ...(onBase ? { baseDir: builtinRunbookDir('intervention') } : {})
    }
    const freshPrompt = interventionPrompt(task, {
      ...promptOpts,
      ...(resumesRunId ? { resume: { runId: resumesRunId, conversation: false } } : {})
    })
    const s: TerminalOpsSession = {
      runId: ctx.runId,
      runbookPath,
      interventionKey,
      initialPrompt:
        resumesRunId && cli.resumeSessionId
          ? interventionPrompt(task, { ...promptOpts, resume: { runId: resumesRunId, conversation: true } })
          : freshPrompt,
      ...(cli.resumeSessionId ? { resumeSessionId: cli.resumeSessionId, resumeFallbackPrompt: freshPrompt } : {}),
      ...(cli.pinSessionId ? { pinSessionId: cli.pinSessionId } : {}),
      provider,
      onBase: !!onBase,
      token,
      endpoint,
      mcpConfigPath: config.path,
      dir,
      guarantee: provider === 'claude' ? 'tools-and-local-shell' : 'tools-only',
      ctx,
      session: opened,
      abort
    }
    terminalOps.set(terminalId, s)
    // Only now is the intervention's run known to start, so the diagnosis's line can name it.
    if (parentRunId) await handOverParent(parentRunId, ctx.runId, ctx.runbook.ref.name, terminalId)
    return terminalOpsReply(s)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    removeOpsMcpConfig(dir)
    // The ledger stays in English; the operator gets it in their language.
    await finishOpsRun(ctx, { ok: false, costUsd: 0, error: `Could not start the ops bridge: ${detail}` })
    return { ok: false, error: t('main.ipc.ops.bridgeFailed', { error: detail }) }
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

// The Scripts list of a live ops session, and the operator's click on one. A run goes
// through the same gate, approvals and ledger as the model's call; only the plan is skipped.
ipcMain.handle('ops:scripts', (_, terminalId: string) => {
  const s = typeof terminalId === 'string' ? terminalOps.get(terminalId) : undefined
  if (!s || s.ctx.ended) return { ok: false, error: t('main.ipc.ops.noLiveSession') }
  return { ok: true, scripts: listOperatorScripts(s.ctx) }
})

// The script as it is on disk, for the eye in the Scripts list. readScript checks the
// name against the policy and the file against its pinned hash, so what is shown is what
// would run.
ipcMain.handle('ops:script-source', async (_, terminalId: string, name: unknown) => {
  const s = typeof terminalId === 'string' ? terminalOps.get(terminalId) : undefined
  if (!s || s.ctx.ended) return { ok: false, error: t('main.ipc.ops.noLiveSession') }
  if (typeof name !== 'string') return { ok: false, error: t('main.ipc.ops.scriptNameRequired') }
  const r = await s.ctx.readScript(s.ctx.runbook, name)
  return r.ok ? { ok: true, text: r.content.toString('utf-8'), sha256: r.sha256 } : { ok: false, error: r.error }
})

ipcMain.handle('ops:run-script', async (_, terminalId: string, name: unknown, hostId: unknown, args: unknown) => {
  const s = typeof terminalId === 'string' ? terminalOps.get(terminalId) : undefined
  if (!s || s.ctx.ended) return { ok: false, error: t('main.ipc.ops.noLiveSession') }
  if (typeof name !== 'string' || typeof hostId !== 'string') return { ok: false, error: t('main.ipc.ops.scriptAndHostRequired') }
  const list = Array.isArray(args) && args.every((a) => typeof a === 'string') ? (args as string[]) : []
  const r = await runOperatorScript(s.session, name, hostId, list)
  return { ok: !r.isError, text: r.text }
})

// The run header's "Refer to an intervention…" (INTERVENTION_HISTORY_PLAN §4): the
// operator points a live run at an earlier one. Only a run the model could itself read
// through past_interventions (one that touched a host in this run's scope), logged as
// run.referenced before the line is handed back; the renderer types the line into the CLI.
ipcMain.handle('ops:reference', async (_, terminalId: unknown, refRunId: unknown) => {
  const s = typeof terminalId === 'string' ? terminalOps.get(terminalId) : undefined
  if (!s || s.ctx.ended) return { ok: false, error: t('main.ipc.ops.noLiveSession') }
  if (!isRunId(refRunId)) return { ok: false, error: t('main.ipc.ops.invalidRunId') }
  const all = await earlierRunsInScope(s.ctx, RUN_LIST_MAX)
  if (!all.ok) return { ok: false, error: t('main.ipc.ops.ledgerUnreadable', { error: all.error }) }
  const item = all.runs.find((r) => r.runId === refRunId)
  if (!item) return { ok: false, error: t('main.ipc.ops.referenceOutOfScope') }
  const logged = await s.ctx.log({ kind: 'run.referenced', runId: s.runId, refRunId, by: 'operator' })
  if (!logged.ok) return { ok: false, error: t('main.ipc.ops.referenceNotLogged') }
  return { ok: true, line: referenceLine(item) }
})

// A terminal can only be typed into one line at a time (raw "\n" is not bracketed paste
// on ConPTY), so a long prompt — the standup's board and history — is written to a file
// under userData/prompts and the terminal is told to read it. One file per session,
// overwritten on each use; nothing else reads the folder.
ipcMain.handle(
  'prompts:write',
  async (_, sessionId: string, text: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false, error: t('main.ipc.prompts.invalidSessionId') }
    if (typeof text !== 'string' || text.length > 512 * 1024) return { ok: false, error: t('main.ipc.prompts.textInvalid') }
    try {
      const dir = path.join(app.getPath('userData'), 'prompts')
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${sessionId}.md`)
      await fs.promises.writeFile(file, text, 'utf8')
      return { ok: true, path: file }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
)

ipcMain.handle('ops:terminal-session', async (_, terminalId: string, intervention: unknown) => {
  if (typeof terminalId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(terminalId)) return { ok: false, error: t('main.ipc.ops.invalidTerminalId') }
  const parsed = parseIntervention(intervention)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const pending = terminalOpsOpening.get(terminalId)
  if (pending) return pending
  const opening = openTerminalOps(terminalId, parsed).finally(() => terminalOpsOpening.delete(terminalId))
  terminalOpsOpening.set(terminalId, opening)
  return opening
})

// ─── Approvals (ops) ──────────────────────────────────────────────────────────

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
  // A popped-out chat's terminal lives in its own window: it needs its pty's output and
  // exit too. Each terminal filters by id, so the other windows ignore what is not theirs.
  if (channel.startsWith('terminal:')) for (const w of chatPopoutWindows()) w.webContents.send(channel, payload)
}

// Pending tool-approval prompts, keyed by an approval id, awaiting a renderer decision.
interface ApprovalDecision {
  allow: boolean
  updatedInput?: Record<string, unknown>
  /** Ops calls only: "deny and stop the run" (plan §3.4). */
  stop?: boolean
  /** Ops plans only: 0-based indices of the plan steps the operator skipped. */
  skipSteps?: number[]
}
// Each entry keeps the request exactly as it was sent, so a reloaded renderer can pull
// it back (`ops:pending`) instead of leaving the run waiting on a prompt nobody sees.
const pendingApprovals = new Map<string, { req: Record<string, unknown>; finish: (d: ApprovalDecision) => void }>()

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
    const req = { appSessionId, approvalId, tool, input, ...(ops ? { ops } : {}) }
    pendingApprovals.set(approvalId, { req, finish })
    signal.addEventListener('abort', onAbort, { once: true })
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
  (
    _,
    payload: { approvalId: string; allow: boolean; updatedInput?: Record<string, unknown>; stop?: boolean; skipSteps?: unknown }
  ) => {
    const resolver = pendingApprovals.get(payload.approvalId)?.finish
    if (resolver) {
      pendingApprovals.delete(payload.approvalId)
      resolver({
        allow: payload.allow,
        updatedInput: payload.updatedInput,
        // Only whole numbers get through; the session drops any that name no skippable step.
        ...(payload.allow === true && Array.isArray(payload.skipSteps)
          ? { skipSteps: payload.skipSteps.filter((i): i is number => Number.isInteger(i)) }
          : {}),
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
const pendingSecrets = new Map<string, { req: Record<string, unknown>; finish: (value: string | null) => void }>()
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
    const payload = { appSessionId, requestId, hostId: req.hostId, hostName: req.hostName, prompt: req.prompt }
    pendingSecrets.set(requestId, { req: payload, finish })
    signal.addEventListener('abort', onAbort, { once: true })
    send('ops:secret-request', payload)
    flagAttention('approval')
    tellCompanionOpsWaiting(appSessionId, req.prompt)
  })
}

ipcMain.handle('ops:secret-response', (_, payload: { requestId: string; value: string | null }) => {
  const resolver = payload && typeof payload.requestId === 'string' ? pendingSecrets.get(payload.requestId)?.finish : undefined
  if (resolver) resolver(typeof payload.value === 'string' ? payload.value : null)
  return { ok: true }
})

// Pending ask_operator requests of ops runs: a command the model may not run, waiting
// for the operator to run it in their own session and paste the output. Keyed by a
// request id; `askId` is the ledger's id for the same ask. Main window only: the answer
// is a paste. A stopped run or a closed terminal resolves it as declined.
const pendingOperatorAsks = new Map<string, { req: Record<string, unknown>; finish: (output: string | null) => void }>()
let operatorAskSeq = 0

function requestOpsOperator(
  appSessionId: string,
  req: { runId: string; askId: string; cmd: string; why: string; hostId?: string; hostName?: string; expect?: string },
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  operatorAskSeq += 1
  const requestId = `operator_${operatorAskSeq}_${Date.now().toString(36)}`
  return new Promise((resolve) => {
    const finish = (output: string | null) => {
      signal.removeEventListener('abort', onAbort)
      pendingOperatorAsks.delete(requestId)
      resolve(output)
    }
    const onAbort = () => finish(null)
    const payload = {
      appSessionId,
      runId: req.runId,
      requestId,
      askId: req.askId,
      cmd: req.cmd,
      why: req.why,
      ...(req.hostId !== undefined ? { hostId: req.hostId } : {}),
      ...(req.hostName !== undefined ? { hostName: req.hostName } : {}),
      ...(req.expect !== undefined ? { expect: req.expect } : {})
    }
    pendingOperatorAsks.set(requestId, { req: payload, finish })
    signal.addEventListener('abort', onAbort, { once: true })
    send('ops:operator-request', payload)
    flagAttention('approval')
    tellCompanionOpsWaiting(appSessionId, req.why || req.cmd)
  })
}

ipcMain.handle('ops:operator-response', (_, payload: { requestId: string; output: string | null }) => {
  const resolver = payload && typeof payload.requestId === 'string' ? pendingOperatorAsks.get(payload.requestId)?.finish : undefined
  if (resolver) resolver(typeof payload.output === 'string' ? payload.output : null)
  return { ok: true }
})

// Every ops prompt still waiting, each exactly as it was sent on its channel. A renderer
// that reloads (Ctrl+R, a crash, an HMR remount) lost its queues; it pulls them back from
// here on mount. `toastApprovalIds` says which approvals the toast window is showing.
ipcMain.handle('ops:pending', () => ({
  approvals: [...pendingApprovals.values()].map((p) => p.req),
  secrets: [...pendingSecrets.values()].map((p) => p.req),
  operatorAsks: [...pendingOperatorAsks.values()].map((p) => p.req),
  toastApprovalIds: [...toastApprovals]
}))

// ─── SSH hosts / remote ─────────────────────────────────────────────────────

ipcMain.handle('ssh:list', () => listHosts())
// The pooled sftp connection was opened with the old host, port, user and secret, so a
// change to any of them (or deleting the host) must close it; the next use reconnects.
ipcMain.handle('ssh:save', (_, host: SshHostInput) => {
  const prev = host.id ? getHost(host.id) : null
  const res = saveHost(host)
  if (res.ok && prev && connectionFieldsChanged(prev, host)) void sftpDisconnect(prev.id)
  return res
})
ipcMain.handle('ssh:delete', (_, id: string) => {
  void sftpDisconnect(id)
  return deleteHost(id)
})
ipcMain.handle('ssh:test', (_, id: string) => testConnection(id))
ipcMain.handle('ssh:test-claude', (_, id: string) => testClaude(id))
ipcMain.handle('ssh:secret-storage', () => secretStorageState())
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
ipcMain.handle('wsl:home', (_, distro: string) => wslHome(distro))
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
 * the overlay and the toast each paint themselves from the same
 * palette, and they read it exactly once when they mount. Before this, the only way
 * they picked up a theme change was by being recreated — which is fine for a change
 * the user just made in the main window's settings, and useless for the OS flipping
 * to dark at sunset while all three windows are alive.
 */
function broadcastUiPrefs(ui: UiPrefs): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:ui', ui)
  }
}

ipcMain.handle('config:set-ui', (_, prefs: UiPrefsPatch) => {
  const prevLanguage = currentLanguage()
  const ui = setUiPrefs(prefs)
  broadcastUiPrefs(ui)
  // Menus are built once with their labels baked in; rebuild them in the new language.
  if (currentLanguage() !== prevLanguage) {
    installApplicationMenu()
    refreshTrayMenu()
    refreshJumpList()
  }
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
    void syncExplorerContextMenu(system.explorerContextMenu)
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
// The companion's prefs: cleaned in config.ts, applied to the live windows, and the
// summon shortcut re-registered when it changed. Returns the accelerator that won.
ipcMain.handle('config:set-companion', (_, patch: unknown) => {
  const prev = getConfig().companion
  const companion = setCompanionPrefs(patch)
  applyCompanionPrefs(companion)
  if (companion.shortcut !== prev.shortcut) reregisterCompanionShortcut(companion.shortcut)
  if (companion.shortcut !== prev.shortcut || companion.voice !== prev.voice || companion.voiceShortcut !== prev.voiceShortcut) {
    registerVoiceShortcut(companion.voice, companion.voiceShortcut)
  }
  return { companion, registeredShortcut: companionShortcut(), registeredVoiceShortcut: companionVoiceShortcut() }
})
// The ops folders (reports, handovers, runbooks) and the loose runbooks: null or '' resets
// a folder to its default (no runbooks folder), null empties the loose list. Returns the
// stored prefs and the effective folders, so Settings can show the default it fell back to.
ipcMain.handle('config:set-ops', (_, patch: OpsPrefsPatch) => {
  const r = setOpsPrefs(patch)
  return r.ok ? { ...r, dirs: opsDirsView() } : r
})
ipcMain.handle('config:ops-dirs', () => opsDirsView())
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
  const out = new Set<string>()
  const infos = new Map(listTerminals().map((t) => [t.id, t]))
  for (const id of busyTerminalSet) {
    // The pty's own working folder, whatever opened it (a chat, an ops terminal).
    const cwd = infos.get(id)?.cwd
    if (cwd) out.add(cwd)
    // A chat's terminal is `chatterm_<sessionId>` (renderer lib/terminal-id.ts): its
    // session's project folder, in case the CLI was started below or beside it.
    const m = /^chatterm_([A-Za-z0-9_-]{1,128})$/.exec(id)
    if (!m) continue
    try {
      const s = readJsonFile<{ projectPath?: string }>(path.join(sessionsDir, `${m[1]}.json`))
      if (s.projectPath) out.add(s.projectPath)
    } catch {
      // Unsaved session — nothing to read a path from.
    }
  }
  return [...out]
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
 * A terminal's CLI started or stopped working (plan H5): the taskbar bar and, on
 * busy→idle with the window out of view, the success badge. Decorative: never let it
 * disturb the terminal.
 */
function onTerminalBusy(id: string, busy: boolean): void {
  try {
    const change = noteTerminalBusy(busyTerminalSet, id, busy)
    if (change.kind === 'none') return
    updateRunIndicators()
    if (change.kind === 'started') {
      forgetTerminalAlert(terminalKey(id))
      return
    }
    // flagAttention is a no-op while the window has focus.
    flagAttention('success')
    companionTerminalIdle(id, 'finished')
  } catch {
    /* indicators are decorative */
  }
}

/** A pty that went away without an idle transition: drop it from the count, quietly. */
function dropBusyTerminal(id: string): void {
  if (!busyTerminalSet.delete(id)) return
  updateRunIndicators()
}

ipcMain.handle(
  'terminal:create',
  async (
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
      /** The chat's first message, for a Claude launch to take on its command line. */
      initialPrompt?: string
      cols: number
      rows: number
    }
  ) => {
    // Returns { ok, shell, cliLaunched, reused, buffer }. The scrollback of a reused pty comes
    // back in this invoke result rather than over 'terminal:data' on purpose — that way the
    // renderer controls the ordering itself and can replay history before any live chunk.
    // A resumed ops intervention's create-step fallback message is main's own, from the
    // terminal's ops session, never the renderer's (see TerminalOpsSession).
    const live = opts?.ops ? terminalOps.get(id) : undefined
    const fallback =
      live && !live.ctx.ended && live.resumeSessionId && live.resumeSessionId === opts.resumeSessionId ? live.resumeFallbackPrompt : undefined
    // Whether the CLI also gets the base intervention's folder is main's own too: it comes
    // from the live ops session, whatever the renderer sent.
    const ops = opts?.ops ? { env: opts.ops.env, mcpConfigPath: opts.ops.mcpConfigPath, onBase: !!(live && !live.ctx.ended && live.onBase) } : undefined
    const r = await createTerminal(
      id,
      { ...opts, ...(ops ? { ops } : {}), resumeFallbackPrompt: fallback },
      (tid, data) => send('terminal:data', { id: tid, data }),
      (tid, exitCode) => {
        send('terminal:exit', { id: tid, exitCode })
        // terminal.ts forgets an exited pty's busy state without an idle transition.
        dropBusyTerminal(tid)
        refreshPopoutTitle(tid, { busy: false, waiting: false })
        terminalClaudeSessions.delete(tid)
        forgetTerminalAlert(terminalKey(tid))
        // One ops run per CLI launch: the pty going away ends it.
        void endTerminalOps(tid, exitCode === 0 ? { ok: true } : { ok: false, error: `the terminal exited with code ${exitCode}` })
      },
      // Pushed on the transition rather than polled: the renderer turns this straight into
      // a running dot, and a poll slow enough to be cheap would be too slow to be right.
      (tid, busy) => {
        send('terminal:busy', { id: tid, busy })
        refreshPopoutTitle(tid, { busy })
        onTerminalBusy(tid, busy)
      },
      // The CLI asking for the user back, read out of its own output — see
      // terminal-osc-pure.ts. `waiting` separates "it needs you" from "it is done".
      (tid, waiting) => {
        send('terminal:notify', { id: tid, waiting })
        refreshPopoutTitle(tid, { waiting })
        try {
          companionTerminalIdle(tid, waiting ? 'waiting' : 'finished')
        } catch {
          /* the pet is decorative here too */
        }
      }
    )
    // A Claude chat's session id, so Claude Code's hook about it lands on this terminal.
    const claudeSid = opts?.resumeSessionId || opts?.pinSessionId
    if (r.ok && claudeSid && (opts.provider ?? 'claude') === 'claude') terminalClaudeSessions.set(id, claudeSid)
    // A fresh pty with another CLI (a reused one keeps whatever it already runs).
    else if (r.ok && !r.reused && (opts.provider ?? 'claude') !== 'claude') terminalClaudeSessions.delete(id)
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
// A run still open at that point was cut short (Restart kills the pty without an ops:stop
// first, aborting any exec in flight), so it ends as aborted. A run already ended (a Stop,
// the pty's own exit) is no longer in terminalOps and finishOpsRun logs run.end only once,
// so its outcome is never rewritten.
const TERMINAL_CLOSED = { ok: false, aborted: true, error: 'the terminal was closed' } as const
ipcMain.handle('terminal:kill', (_, id: string) => {
  const r = killTerminal(id)
  dropBusyTerminal(id)
  terminalClaudeSessions.delete(id)
  forgetTerminalAlert(terminalKey(id))
  void endTerminalOps(id, TERMINAL_CLOSED)
  return r
})
ipcMain.on('terminal:kill-deferred', (_, id: string) => {
  killTerminalDeferred(id)
  if (!terminalOps.has(id)) return
  // The deferred kill fires after 250 ms unless a re-create for the same id cancels it
  // (a remount); only a terminal that is really gone ends its run.
  setTimeout(() => {
    if (!listTerminals().some((t) => t.id === id)) void endTerminalOps(id, TERMINAL_CLOSED)
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
  ) => {
    const sid = resumeSessionId || pinSessionId
    if (provider === 'claude' && typeof sid === 'string' && sid) terminalClaudeSessions.set(id, sid)
    // Another CLI in a pty that ran Claude: a hook about that old session is not about it.
    else if (provider !== 'claude') terminalClaudeSessions.delete(id)
    return startCliInTerminal(id, provider, resumeSessionId, pinSessionId)
  }
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

// ─── Planner ──────────────────────────────────────────────────────────────────

ipcMain.handle('planner:list', () => listWeeks())
ipcMain.handle('planner:get', (_, weekStart: string) => getWeek(weekStart))
ipcMain.handle('planner:save', (_, week: WeekPlan) => saveWeek(week))
ipcMain.handle('planner:delete', (_, weekStart: string) => deleteWeek(weekStart))

// ─── Sprints (Scrum board / standups / burndown) ───────────────────────────────

ipcMain.handle('sprint:list', () => listSprints())
ipcMain.handle('sprint:get', (_, id: string) => getSprint(id))
ipcMain.handle('sprint:save', (_, sprint: Sprint) => {
  const saved = saveSprint(sprint)
  companionSprintChanged()
  return saved
})
ipcMain.handle('sprint:delete', (_, id: string) => {
  const left = deleteSprint(id)
  companionSprintChanged()
  return left
})

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

/**
 * The companion's layer 2 (plan §5.1): one line plus the date context to the model, the
 * answer checked and turned into a ParsedCapture; null on any failure (no account,
 * offline, a model error, bad JSON, the timeout, Esc). Shaped like `standup:generate`:
 * same policy, same provider resolution — the companion has no account picker, so it is
 * the provider's default account — and nothing else from the app goes with it.
 */
async function askModelForWhen(
  text: string,
  now: number,
  prefs: CompanionPrefs,
  local: ParsedCapture,
  abort: AbortController
): Promise<ParsedCapture | null> {
  const env = buildSubprocessEnv()
  const policy = resolvePolicy({ profile: 'headless-reasoning' })
  const providerId = providerFor(policy.model)
  if (providerId !== 'claude') Object.assign(env, providerAccountEnv(providerId))
  const timer = setTimeout(() => abort.abort('timeout'), MODEL_TIMEOUT_MS)
  // An engine that ignores the abort must not hold the capture past the timeout.
  const aborted = new Promise<null>((resolve) => {
    if (abort.signal.aborted) resolve(null)
    else abort.signal.addEventListener('abort', () => resolve(null), { once: true })
  })
  try {
    const prompt = buildWhenPrompt({
      text,
      now,
      language: currentLanguage() === 'pt-PT' ? 'pt-PT' : 'en',
      leadMinutes: prefs.leadMinutes,
      morningHour: prefs.morningHour
    })
    const stream = getEngine(providerId).run({
      prompt: buildPrompt(prompt, undefined, undefined, '') as string,
      ...policy,
      cwd: os.homedir(),
      env,
      abortController: abort,
      permissionMode: 'bypassPermissions'
    })
    const collected = collectText(stream)
    // Lost to the timeout or Esc, its later rejection is nobody's to handle.
    collected.catch(() => {})
    const out = await Promise.race([collected, aborted])
    if (!out || abort.signal.aborted) return null
    if (out.isError) {
      console.warn('[companion] the model could not read the date:', out.errorText || 'model error')
      return null
    }
    const parsed = parsedFromModel(extractJson(out.text), local, { now, leadMinutes: prefs.leadMinutes, morningHour: prefs.morningHour })
    if (!parsed) console.warn('[companion] the model answered with an unusable date')
    return parsed
  } catch (err: unknown) {
    if (!abort.signal.aborted) console.warn('[companion] the model could not read the date:', err instanceof Error ? err.message : String(err))
    return null
  } finally {
    clearTimeout(timer)
  }
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

      if (isError) return { ok: false as const, error: errorText || t('main.ipc.ai.modelError'), costUsd }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd }
      } catch {
        return { ok: false as const, error: t('main.ipc.ai.unparsableJson'), raw: text, costUsd }
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
      if (isError) return { ok: false as const, error: errorText || t('main.ipc.ai.modelError'), costUsd, commitCount: commits.length }
      try {
        const data = extractJson(text)
        return { ok: true as const, data, costUsd, commitCount: commits.length }
      } catch {
        return { ok: false as const, error: t('main.ipc.ai.unparsableJson'), raw: text, costUsd, commitCount: commits.length }
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
        error: t('main.ipc.ai.noForgeMcp'),
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
      if (!res.ok) return { ok: false as const, error: res.error || t('main.ipc.ai.wslBackfillFailed'), costUsd: 0 }
      try {
        const parsed = extractJson(res.text)
        if (payload.probe) return { ok: true as const, data: { ...(parsed as object), forge }, costUsd: 0 }
        const { items, warning } = filterBackfillRows(parsed, payload.kind ?? 'issues', forge)
        return { ok: true as const, data: { ...(parsed as object), items, forge }, warning, costUsd: 0 }
      } catch {
        return { ok: false as const, error: t('main.ipc.ai.unparsableJson'), raw: res.text, costUsd: 0 }
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
      if (isError) return { ok: false as const, error: errorText || t('main.ipc.ai.modelError'), costUsd }
      try {
        const data = extractJson(text)
        if (payload.probe) return { ok: true as const, data: { ...(data as object), forge }, costUsd }
        const { items, warning } = filterBackfillRows(data, payload.kind ?? 'issues', forge)
        return { ok: true as const, data: { ...(data as object), items, forge }, warning, costUsd }
      } catch {
        return { ok: false as const, error: t('main.ipc.ai.unparsableJson'), raw: text, costUsd }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg, costUsd: 0 }
    }
  }
)

// ─── Git ──────────────────────────────────────────────────────────────────────

ipcMain.handle('git:status', (_, cwd: string) => getStatus(cwd))
ipcMain.handle('git:file-diff', (_, cwd: string, filePath: string) => getFileDiff(cwd, filePath))
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
        await fs.promises.writeFile(posixToWslUnc(wslDistro, posix, wslShareRoot(wslDistro)), image.toPNG())
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

ipcMain.handle('session:list', async () => {
  await sessionsMigrated
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
  // so a burst of saves only rebuilds once.
  refreshJumpList()
  return { success: true }
})

// The pre-2.0 migration's record and where its transcripts are (Settings → General).
ipcMain.handle('sessions:migration-info', async () => {
  await sessionsMigrated
  return { state: getSessionMigration<MigrationState>(), exportsDir: chatExportsDir }
})

/**
 * Open a migrated chat's transcript, show it in its folder, or (no path) open the
 * folder itself. Only inside the exports folder: this is not a general file opener.
 */
ipcMain.handle('sessions:open-export', async (_, filePath?: string, reveal?: boolean) => {
  const target = typeof filePath === 'string' && filePath ? path.resolve(filePath) : chatExportsDir
  const rel = path.relative(chatExportsDir, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: t('main.ipc.exports.notChatExport') }
  if (!fs.existsSync(target)) return { ok: false, error: t('main.ipc.exports.fileGone') }
  if (reveal) {
    shell.showItemInFolder(target)
    return { ok: true }
  }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('session:delete', (_, sessionId: string) => {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length === 0 || sessionId.length > 128) {
    return { success: false, reason: 'invalid-id' }
  }
  const filePath = path.join(sessionsDir, `${sessionId}.json`)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  return { success: true }
})

