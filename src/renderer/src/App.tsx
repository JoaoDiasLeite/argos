import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import {
  Session,
  AuthStatus,
  ModelInfo,
  CCSessionMeta,
  ApprovalRequest,
  CCAccountStatus,
  ProviderAccountStatus,
  ProviderId,
  PlannerTask,
  PlanUsageReport,
  CcSessionTarget,
  LiveSession
} from './types'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import ResizeHandles from './components/ResizeHandles'
import PaneGrid from './components/PaneGrid'
import { SessionPaneApi } from './hooks/useSessionPane'
import NavRail, { ALL_VIEWS, View, VIEW_GROUPS, groupOwnsView } from './components/NavRail'
import ServerTabs from './components/ServerTabs'
import ApprovalModal from './components/ApprovalModal'
import PlanReviewSheet from './components/PlanReviewSheet'
import SecretPrompt from './components/SecretPrompt'
import { readRecentRunbooks } from './components/ChatConfigBar'
import PendingRuns, { PendingRun } from './components/PendingRuns'
import FileEditor from './components/FileEditor'
import { readLocalFile, writeLocalFile } from './lib/local-file-io'
import { installEditingKeys } from './lib/clipboard-paste'
import TextContextMenu from './components/TextContextMenu'
import { applyTheme, zoomFor } from './lib/theme'
import CommandPalette, { CommandItem } from './components/CommandPalette'
import OnboardingModal from './components/OnboardingModal'
import AccountsModal from './components/AccountsModal'
import ChangelogModal from './components/ChangelogModal'
import ShortcutsModal from './components/ShortcutsModal'
import { modLabel } from './lib/shortcuts'
import { UiPrefs, UiPrefsPatch } from './types'
import { provOf, acctOf, originOf, nextChatAfterClose, isUnstarted, AccountDefaults } from './lib/account-scope'
import type {
  HomeAttention,
  HomeRunning,
  HomeRepo,
  HomeProject,
  HomeRecent,
  HomeStart,
  HomeStartChoice,
  HomeStartOptions
} from './views/HomeView'
import {
  projectKey,
  canonicalProjectPath,
  buildPosixDistroMap,
  parseWslUnc,
  ProjectKeyContext
} from './lib/project-key'
import { projectDisplayName, projectDisplayNames, RepoName } from './lib/project-name'
import { chatTerminalId, sessionIdFromTerminalId } from './lib/terminal-id'
import { usePanes } from './hooks/usePanes'
import { SESSION_DRAG_TYPE, type DropPlan } from './lib/pane-drop'
// The secondary views below are only ever mounted once the user navigates away
// from the default 'chat' view, so they're loaded lazily (React.lazy) instead
// of statically imported. That keeps their code — and the vendor libraries
// they alone pull in — out of the initial renderer chunk. See the Suspense
// fallback (`ViewLoading`) rendered while each view's chunk is fetched.
import { SshHostPublic, RemoteTarget } from './types'
import './styles/App.css'
// Pulled in directly (rather than left to each lazy view) so the `.view-loading`
// spinner below is styled even before any view chunk has finished loading.
import './views/views.css'

const ProjectsView = lazy(() => import('./views/ProjectsView'))
const UsageView = lazy(() => import('./views/UsageView'))
const McpView = lazy(() => import('./views/McpView'))
const PlannerView = lazy(() => import('./views/PlannerView'))
const RemoteView = lazy(() => import('./views/RemoteView'))
const RemoteSessionView = lazy(() => import('./views/RemoteSessionView'))
const OpsView = lazy(() => import('./views/OpsView'))
const OpsWorkspace = lazy(() => import('./views/OpsWorkspace'))
const SettingsView = lazy(() => import('./views/SettingsView'))
const HomeView = lazy(() => import('./views/HomeView'))

const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed'

/** Minimal, style-consistent fallback shown while a lazy view's chunk loads. */
function ViewLoading() {
  return (
    <div className="view-loading">
      <div className="view-spinner" />
      <div className="view-loading-text">Loading…</div>
    </div>
  )
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Same split as the sidebar's project-path subtitle (App.tsx already does this inline
// for s.projectPath elsewhere) — kept as a helper here since Home needs it in several places.
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/**
 * The main window's appearance. lib/theme.ts owns everything that is CSS; the two
 * things left here are the two that are main-window-only:
 *
 *  - density, because [data-density] rules target chat and sidebar rows that exist in
 *    no other window, and setting it in the overlay would silently restyle it;
 *  - zoom, because 'app:set-zoom' zooms the main window specifically — calling it from
 *    the overlay or the pill would resize the wrong window.
 */
function applyUi(ui: UiPrefs) {
  const root = document.documentElement
  applyTheme(root, ui)
  root.dataset.density = ui.density
  window.electronAPI.setZoom(zoomFor(ui))
}

/**
 * How long before a chat that could not be matched to a live CLI is tried again. Well
 * above the registry poll: adoption is a repair, not a heartbeat.
 */
const ADOPT_RETRY_MS = 60_000

function newSession(projectPath?: string, model?: string, accountId?: string): Session {
  const now = Date.now()
  // A folder given as a WSL share (`\\wsl.localhost\<distro>\…`) makes this a WSL chat,
  // and it has to be recorded as one. The terminal already behaves that way — the main
  // process reads the same spelling and runs the shell inside the distro — but nothing
  // wrote the distro down, so the chat stayed "local" with a Windows path: its transcript
  // is written in the distro, and every lookup on this side (terminal-chat sync, the
  // account a chat is filed under, the environment chip) went looking on the Windows
  // filesystem and found nothing. The symptom was a terminal chat that never picked up
  // its own name. A project group's "+" hands over exactly this spelling, because for a
  // WSL folder that is the one form a plain Windows process can use.
  const wsl = projectPath ? parseWslUnc(projectPath) : null
  return {
    id: generateId(),
    name: 'New chat',
    messages: [],
    projectPath: wsl ? wsl.posixPath : projectPath,
    wslDistro: wsl?.distro,
    remoteHostName: wsl ? `WSL · ${wsl.distro}` : undefined,
    model,
    accountId,
    // Name the Claude Code session this chat would start in a terminal, here, at birth —
    // not later, from the chat pane. The terminal is created during the chat's first
    // render, and a session id patched in from an effect arrives after that spawn has
    // already happened: the CLI starts bare, invents an id nobody told Argos about, and
    // the chat can never be matched back to it (no title, no transcript, and the sidebar
    // never shows it running). Deciding it up front removes the race instead of narrowing
    // it. Costs nothing when the chat never opens a terminal — an id nothing writes to is
    // an id nothing looks for. `claudeSessionId` still wins wherever both exist.
    terminalSessionId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  }
}

// Labels for the segmented sub-nav shown above a group's active view.
const MEMBER_LABELS: Record<string, string> = {
  mcp: 'MCP',
  remote: 'Remote & WSL',
  ops: 'Ops'
}

// An open Remote/WSL "Connect" session, rendered as a persistent tab (see the
// server-sessions-layer render below). A target can have SEVERAL sessions open at once, so
// the identity is (group, seq): `groupKey` is the target the session belongs to — which is
// what the tab strip groups by, Chrome-tab-group style — and `seq` is a per-group counter.
interface ServerSession {
  id: string
  groupKey: string
  target: RemoteTarget
  /** The target's name, shared by every session in the group. */
  title: string
  /** 1-based, per group. Never reused within a run, so a tab's number doesn't shift
   *  under the user when a sibling closes. */
  seq: number
}
function serverGroupKey(target: RemoteTarget): string {
  return target.kind === 'ssh' ? `srv:ssh:${target.host.id}` : `srv:wsl:${target.distro}`
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  // `focused`/`openInFocused` stand in for the old `activeId`/`setActiveId` state pair:
  // every one of setActiveId's call sites means "show me this chat", which is exactly
  // what openInFocused does (see lib/panes.ts for the exact semantics, including how
  // it treats an empty sessionId as "clear the panel").
  const {
    panes,
    layout,
    focused,
    sizes: paneSizes,
    openInFocused,
    // `openInNewPane` is not wired up here: every "new pane" in this app comes from a drop,
    // which brings its own position and layout and therefore goes through `insertPane`.
    insertPane,
    closePane,
    setFocus,
    setSizes,
    restore
  } = usePanes()
  const activeId = focused
  const setActiveId = openInFocused
  // Focus and visibility are different questions. `activeId` answers "which chat am I
  // typing in" (sidebar scope, modals, the Files tab); `visibleIds` answers "which chats
  // can I see", which is the right question for unread, approvals and the pending bar —
  // a chat you are looking at but not typing in still counts as read. With a single pane
  // the two sets coincide, which is what makes this distinction a no-op for now.
  const visibleIds = useMemo(() => new Set(panes.map((p) => p.sessionId)), [panes])
  // A stable dependency for the effects below: `visibleIds` is a new Set whenever `panes`
  // changes identity, and React could not compare a Set anyway.
  const visibleKey = useMemo(() => [...visibleIds].sort().join('|'), [visibleIds])
  /**
   * Terminal ids whose CLI is waiting on the user rather than working.
   *
   * Read from the notification the CLI writes into its own pty (see
   * terminal-osc-pure.ts), which is the only thing a chat driven from the terminal can
   * say about itself: a Codex approval prompt is drawn inside that terminal and never
   * reaches Argos's own approval queue, so a chat parked on one used to be
   * indistinguishable from one that had simply finished. Declared up here because
   * attentionIds reads it; it is filled beside the busy signal, far below.
   */
  const [waitingTerminalIds, setWaitingTerminalIds] = useState<Set<string>>(new Set())
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'sessions'>('sessions')
  // The chat list hidden to give the panes its width. Remembered across launches, like the
  // list's own width: it is a choice about how you like to work, not about this chat.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleSidebar = () =>
    setSidebarCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        // Storage unavailable — the toggle still works, it just won't be remembered.
      }
      return !c
    })
  // File opened from the sidebar's Files tab, shown in the FileEditor modal.
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  // Chats the user hid from the pending-requests bar; cleared per id when that chat next
  // starts working (see the busy-transition effect below).
  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(new Set())
  // Bumped every time we deliberately land on a new chat — part of the key Chat uses to
  // decide whether to show its setup pane again (see Chat).
  // Per session, not one global counter: with several panes on screen a global bump would
  // reach every pane at once. The values come from a
  // single shared sequence so that landing on chat B right after chat A still reads as a
  // change to the pane that followed you there (see useSessionPane).
  const [newChatNonces, setNewChatNonces] = useState<Record<string, number>>({})
  const newChatNonceSeq = useRef(0)
  const bumpNewChatNonce = useCallback((sid: string) => {
    if (!sid) return
    newChatNonceSeq.current += 1
    const n = newChatNonceSeq.current
    setNewChatNonces((prev) => ({ ...prev, [sid]: n }))
  }, [])
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  // Home is where the app opens: it answers "what needs me now" before you have to
  // pick a chat, and it is the one view whose content is about every chat at once.
  const [view, setView] = useState<View>('home')
  // Where Settings' "Back to app" goes. Settings is a full screen, so it displaces
  // whatever was showing, and the way out has to lead back there — not to Chat, which
  // is what a hardcoded fallback would give someone who opened Settings from Usage.
  // A ref rather than state: nothing renders from it, and it must not cause one.
  const preSettingsView = useRef<View>('chat')
  useEffect(() => {
    if (view !== 'settings') preSettingsView.current = view
  }, [view])
  // A conversation named by a notification click (`argos://session`). Held here
  // rather than passed straight through so a second click on the same conversation
  // still re-opens it: the object identity is what ProjectsView reacts to.
  const [ccTarget, setCcTarget] = useState<CcSessionTarget | null>(null)
  // The project Home asked Projects to open, by the same key Home groups repo rows by.
  // Stamped so clicking the same row twice, with a detour in between, still lands.
  const [projectFocus, setProjectFocus] = useState<{ key: string; at: number } | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [defaultModel, setDefaultModel] = useState('claude-opus-4-8')
  const [ui, setUi] = useState<UiPrefs | null>(null)
  // Prompts waiting to be typed into a chat's terminal, by session id. "Start this" has no
  // transcript to post into, so the text is parked here and ChatTerminal types it into the
  // CLI once that CLI is up. Cleared as soon as it is sent: a restart must not re-run the
  // task.
  const [terminalPrompts, setTerminalPrompts] = useState<Record<string, string>>({})
  const clearTerminalPrompt = useCallback((sid: string) => {
    setTerminalPrompts((prev) => {
      if (!(sid in prev)) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
  }, [])
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  // Sudo-password requests from ops runs, answered one at a time (head of the queue).
  const [secretQueue, setSecretQueue] = useState<{ appSessionId: string; requestId: string; hostId: string; hostName: string; prompt: string }[]>([])
  useEffect(() => window.electronAPI.onOpsSecretRequest((req) => setSecretQueue((q) => [...q, req])), [])
  const answerSecret = (requestId: string, value: string | null) => {
    void window.electronAPI.respondOpsSecret({ requestId, value })
    setSecretQueue((q) => q.filter((r) => r.requestId !== requestId))
  }
  // When each approvalId entered the queue, for Home's "since" — ApprovalRequest itself
  // carries no timestamp, and reading Date.now() at render time would restart the count
  // on every re-render instead of showing how long it has actually been pending.
  const approvalSinceRef = useRef<Map<string, number>>(new Map())
  const [accounts, setAccounts] = useState<CCAccountStatus[]>([])
  const [defaultAccountId, setDefaultAccountId] = useState('default')
  const [codexAccounts, setCodexAccounts] = useState<ProviderAccountStatus[]>([])
  const [codexDefaultAccountId, setCodexDefaultAccountId] = useState('default')
  const [geminiAccounts, setGeminiAccounts] = useState<ProviderAccountStatus[]>([])
  const [geminiDefaultAccountId, setGeminiDefaultAccountId] = useState('default')
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // Live plan usage pushed by the main-process watcher — feeds the sidebar badge.
  const [planReport, setPlanReport] = useState<PlanUsageReport | null>(null)
  // Codex plan-usage badge data, keyed by Codex account id — the Codex analog of
  // accountUsage below, but there's no watcher pushing this one (no persistent
  // main-process process to piggyback on), so it's fetched directly.
  const [codexAccountUsage, setCodexAccountUsage] = useState<
    Record<string, { utilization: number; resetsAt?: string; windowMinutes?: number }>
  >({})

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // The same mirror trick as activeIdRef, for the listeners registered once on mount that
  // have to ask "is this chat on screen?" rather than "is it the focused one?".
  const visibleIdsRef = useRef(visibleIds)
  visibleIdsRef.current = visibleIds
  // What is actually being read. The panes stay mounted behind Home and Projects, so a
  // chat in one is "visible" there without anyone looking at it — unread asks this instead.
  const seenIds = useMemo(() => (view === 'chat' ? visibleIds : new Set<string>()), [view, visibleIds])
  const seenIdsRef = useRef(seenIds)
  seenIdsRef.current = seenIds
  const seenKey = view === 'chat' ? visibleKey : ''
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  // Mirror of panes for the pane-focus keyboard shortcuts, registered once on mount
  // (same pattern as sessionsRef/activeIdRef).
  const panesRef = useRef(panes)
  panesRef.current = panes

  // Latest createSession, so the global ⌘N handler never calls a stale closure.
  // An optional projectPath overrides the inherited folder (used by --folder launches).
  const createSessionRef = useRef<(projectPath?: string) => void>(() => {})
  // Same, for what a notification click opens — it is registered once and has to see
  // fresh sessions and defaults (see openCcTarget).
  const openCcTargetRef = useRef<(target: CcSessionTarget) => void>(() => {})

  // Clear a chat's unread flag the moment it comes on screen, regardless of which of the
  // many setActiveId call sites got it there (sidebar click, opening from Projects, a
  // fork, …) — a single effect covers all of them instead of threading a "mark read" call
  // through every entry point. Visibility, not focus: a chat sitting in a pane you can see
  // has been read even while you type in the one beside it. Persists on its own: the
  // save-on-change effect below picks up the new object references.
  // Keyed on `seenKey`, since the Set itself is a fresh object on every render.
  useEffect(() => {
    const seen = seenIdsRef.current
    setSessions((prev) => {
      if (!prev.some((s) => s.unread && seen.has(s.id))) return prev
      return prev.map((s) => (s.unread && seen.has(s.id) ? { ...s, unread: false } : s))
    })
  }, [seenKey])

  const activeSession = sessions.find((s) => s.id === activeId)
  // Which CLI a session's model belongs to. A plain lookup, but it has callers that must
  // agree — the sidebar's scope and the embedded terminal.
  const providerOf = (s?: Session): ProviderId => provOf(models, s?.model || defaultModel)
  // The open file belongs to the chat's project tree, so it goes stale the moment we point at
  // a different folder or leave the chat view (where the Files tab lives) entirely.
  const activeProjectPath = activeSession?.projectPath
  useEffect(() => {
    setOpenFilePath(null)
  }, [activeProjectPath, view])
  // Sessions with a pending approval — drives the amber sidebar dot. Two sources, because
  // an approval can be raised in either place: Argos's own queue, for a run it is driving,
  // and the CLI's notification, for a chat driven from the terminal where the prompt is
  // drawn inside the terminal and never reaches that queue.
  const attentionIds = useMemo(() => {
    const out = new Set(approvalQueue.map((r) => r.appSessionId))
    for (const tid of waitingTerminalIds) {
      const sid = sessionIdFromTerminalId(tid)
      if (sid) out.add(sid)
    }
    return out
  }, [approvalQueue, waitingTerminalIds])

  const dismissRun = useCallback((sid: string) => {
    setDismissedRunIds((prev) => new Set(prev).add(sid))
  }, [])

  const refreshAuth = useCallback(async () => {
    const status = await window.electronAPI.authStatus()
    setAuth(status)
    return status
  }, [])

  const refreshAccounts = useCallback(async () => {
    const list = await window.electronAPI.accountsList()
    setAccounts(list.accounts)
    setDefaultAccountId(list.defaultAccountId)
    return list
  }, [])

  const refreshProviderAccounts = useCallback(async () => {
    const [codex, gemini] = await Promise.all([
      window.electronAPI.providerAccountsList('codex'),
      window.electronAPI.providerAccountsList('gemini')
    ])
    setCodexAccounts(codex.accounts)
    setCodexDefaultAccountId(codex.defaultAccountId)
    setGeminiAccounts(gemini.accounts)
    setGeminiDefaultAccountId(gemini.defaultAccountId)
  }, [])

  // Mount: load sessions, auth, models, config
  useEffect(() => {
    const init = async () => {
      const [saved, models, config] = await Promise.all([
        window.electronAPI.listSessions(),
        window.electronAPI.getModels(),
        window.electronAPI.getConfig()
      ])
      await refreshAuth()
      await refreshAccounts()
      await refreshProviderAccounts()
      setModels(models)
      setDefaultModel(config.defaultModel)
      setUi(config.ui)
      applyUi(config.ui)
      // No auto-created blank draft: with no saved chats the main area shows the
      // welcome pane until the user explicitly starts one.
      // Restore whatever pane layout was persisted, filtered to sessions that still
      // exist. Unconditionally, even with nothing saved: restoring is also what arms
      // persistence, so skipping it on a first run would leave the layout unsaved for
      // the whole session.
      const restored = restore(saved.map((s) => s.id))
      if (saved.length > 0) {
        setSessions(saved)
        // No panes came back (first run, or a wiped/invalid entry) — fall back to the
        // pre-panes behaviour of just focusing the first saved session.
        if (restored.panes.length === 0) {
          setActiveId(saved[0].id)
        }
      }
    }
    init()
  }, [refreshAuth, refreshAccounts, restore])

  // The main process pushes resolved prefs whenever they change — which includes the
  // one change no renderer can see for itself: the OS flipping light/dark while
  // ui.mode is 'system'. Re-applying here is also what keeps this window in step with
  // a save made from a settings screen in any other window.
  useEffect(() => {
    return window.electronAPI.onUiPrefs((next) => {
      setUi(next)
      applyUi(next)
    })
  }, [])

  // Persist changed sessions periodically (unread flags, names, links picked up by the
  // terminal sync). The explicit saves elsewhere cover what must not wait for a tick.
  const savedSessionsRef = useRef(new Map<string, Session>())
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    const timer = setInterval(() => {
      for (const session of sessionsRef.current) {
        if (!session.messages.length && !session.hasTerminalActivity) continue
        if (savedSessionsRef.current.get(session.id) === session) continue
        savedSessionsRef.current.set(session.id, session)
        window.electronAPI.saveSession(session).then((result) => {
          if (!result.success) throw new Error('Session could not be saved')
          setSaveError('')
        }).catch((error) => {
          savedSessionsRef.current.delete(session.id)
          setSaveError(String(error))
        })
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [])

  // Approval listeners — the queue is fed by ops runs (the gate in main), never by a chat.
  useEffect(() => {
    const offApproval = window.electronAPI.onApprovalRequest((data: ApprovalRequest) => {
      approvalSinceRef.current.set(data.approvalId, Date.now())
      setApprovalQueue((prev) => [...prev, data])
    })

    // An approval answered elsewhere (e.g. the always-on-top toast while this
    // window was hidden) — drop it here so the modal doesn't linger unanswered.
    const offResolved = window.electronAPI.onApprovalResolved((approvalId: string) => {
      approvalSinceRef.current.delete(approvalId)
      setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
    })

    return () => {
      offApproval()
      offResolved()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Answer a specific queued approval by id: send the response, prune it from the
  // queue. Used by the head-of-queue global modal (via respondApproval).
  const respondApprovalById = (approvalId: string, allow: boolean) => {
    const req = approvalQueue.find((r) => r.approvalId === approvalId)
    if (!req) return
    window.electronAPI.respondApproval({ approvalId, allow })
    approvalSinceRef.current.delete(approvalId)
    setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
  }

  // Ops calls only: deny this call and stop the whole run (main aborts the turn).
  const respondApprovalStopById = (approvalId: string) => {
    const req = approvalQueue.find((r) => r.approvalId === approvalId)
    if (!req) return
    window.electronAPI.respondApproval({ approvalId, allow: false, stop: true })
    approvalSinceRef.current.delete(approvalId)
    setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
  }

  // Global modal answers the HEAD of the queue — delegates to respondApprovalById.
  const respondApproval = (allow: boolean) => {
    const head = approvalQueue[0]
    if (head) respondApprovalById(head.approvalId, allow)
  }

  // Launch a new terminal chat from the quick-launcher overlay (global shortcut), the tray,
  // Home's start box or the planner. The chat is created with its folder, model and account
  // decided here — they are what the CLI launches under — and the prompt is handed to the
  // terminal to type once the CLI is up. `ready` is not consulted: signing in is the CLI's
  // business. The overlay's old `quick` flag is ignored.
  // TODO(B3b): becomes `startTerminal({ prompt, projectPath, provider, accountId, name })`.
  const startOverlayPrompt = useCallback(
    (payload: {
      prompt: string
      quick?: boolean
      // Home's start box passes an explicit choice (project/model/account) that overrides
      // what would otherwise be inferred from the active session — the tray and quick
      // launcher never pass these, so they keep deducing from the active session as before.
      projectPath?: string
      modelId?: string
      accountId?: string
      /** The chat's name; the prompt's first 40 characters when absent. */
      name?: string
    }) => {
      const prompt = payload.prompt.trim()
      if (!prompt) return
      const base = sessionsRef.current.find((s) => s.id === activeIdRef.current)
      const s = newSession(
        payload.projectPath ?? base?.projectPath,
        payload.modelId ?? defaultModel,
        payload.accountId ?? base?.accountId ?? defaultAccountId
      )
      s.name = (payload.name ?? prompt).slice(0, 40)
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      setView('chat')
      setTerminalPrompts((prev) => ({ ...prev, [s.id]: prompt }))
      window.electronAPI.saveSession(s)
    },
    [defaultModel, defaultAccountId]
  )
  const startOverlayPromptRef = useRef(startOverlayPrompt)
  startOverlayPromptRef.current = startOverlayPrompt

  // Tray & overlay events from the main process. Registered once; refs keep the
  // handlers seeing fresh state (same pattern as createSessionRef).
  useEffect(() => {
    const offNewChat = window.electronAPI.onNewChat((folderPath) => createSessionRef.current(folderPath))
    const offPrompt = window.electronAPI.onOverlayPrompt((p) => startOverlayPromptRef.current(p))
    const offCc = window.electronAPI.onOpenCcSession((target) => {
      if (!target?.encodedDir || !target?.sessionId) return
      openCcTargetRef.current(target)
    })
    const offOpen = window.electronAPI.onOpenSession((id) => {
      if (sessionsRef.current.some((s) => s.id === id)) {
        setActiveId(id)
        setView('chat')
      }
    })
    // Ctrl+V/A/C/X are the app's own to handle: the application menu carries no Edit
    // roles, and without them none of those keystrokes reached anything at all. See
    // lib/clipboard-paste.ts.
    const offPaste = installEditingKeys()
    const offPlan = window.electronAPI.onPlanUsage(setPlanReport)
    // Plan-limit notification clicks navigate here; validate against real views.
    // ALL_VIEWS is the list the View type itself is derived from, so a view added to
    // the rail is reachable from a deep link without anyone remembering to add it
    // here too — which is precisely what a second hand-written copy did not manage.
    const offView = window.electronAPI.onOpenView((v) => {
      if ((ALL_VIEWS as readonly string[]).includes(v)) setView(v as View)
    })
    // Prime the badge without waiting for the watcher's first (~30s) tick.
    window.electronAPI.ccPlanUsage(false).then(setPlanReport).catch(() => {})
    // Codex has no watcher — always safe to call even with zero Codex accounts
    // logged in, it just resolves {} quickly.
    window.electronAPI.codexUsage(false).then(setCodexAccountUsage).catch(() => {})
    return () => {
      offNewChat()
      offPrompt()
      offOpen()
      offCc()
      offPlan()
      offView()
      offPaste()
    }
  }, [])

  // Per-account 5h-window usage, keyed by managed account id — the account picker
  // shows each account's own number inside its dropdown row (instead of a single
  // ambient badge on the always-visible account chip).
  const accountUsage = useMemo(() => {
    const map: Record<string, { utilization: number; resetsAt?: string }> = {}
    if (!planReport) return map
    for (const acc of planReport.accounts) {
      const w = acc.windows.find((win) => win.key === 'five_hour')
      if (!w) continue
      const entry = { utilization: w.utilization, resetsAt: w.resetsAt }
      for (const id of acc.accountIds ?? []) map[id] = entry
      if (acc.isDefault) map['default'] = entry
    }
    return map
  }, [planReport])

  // projectPath, when a string, overrides the folder normally inherited from the
  // active session (e.g. an Explorer "Open with Argos" or Jump List launch).
  // The `typeof` guard lets this double as a plain onClick handler — a click event
  // arg is ignored rather than mistaken for a folder path.
  // An unused chat: never driven through the embedded terminal (see isUnstarted).
  // Preferring the active one keeps you where you are when it already qualifies.
  const blankDraft = (): Session | undefined => {
    if (activeSession && isUnstarted(activeSession)) return activeSession
    return sessions.find(isUnstarted)
  }

  const createSession = (projectPath?: unknown) => {
    const folder = typeof projectPath === 'string' ? projectPath : undefined
    // No folder named by whoever asked (the sidebar's own New terminal row, the welcome
    // pane, the command palette): don't infer one. A terminal is a CLI process that starts
    // where it is told and cannot be moved afterwards, so inheriting the folder from
    // whichever chat happened to be open is a guess the user is left to discover. Chat.tsx
    // asks instead (see needsTerminalSetup). A folder that WAS named — a project group's
    // "+", "Open with Argos", Home's start box — is a choice already made, and skips the
    // question.
    const ask = !folder
    // An untouched draft IS the new chat — a chat only earns its own row once it has been
    // used. So reuse a blank one rather than stacking another, repointing it at whichever
    // folder was asked for so a project group's "+" still lands you inside that project.
    const draft = blankDraft()
    if (draft) {
      if (ask) {
        // A reused draft already knowing where it runs would skip the question — it carries
        // a folder inherited before this change, or one picked in a setup pane that was left
        // without starting. Clear that, so New terminal means New terminal either way.
        setSessions((prev) =>
          prev.map((s) =>
            s.id === draft.id
              ? {
                  ...s,
                  projectPath: undefined,
                  additionalDirs: undefined,
                  useWorktree: false,
                  wslDistro: undefined,
                  remoteHostId: undefined,
                  remoteHostName: undefined
                }
              : s
          )
        )
      } else if (folder && draft.projectPath !== folder) {
        // Same WSL-share reading as newSession — a draft repointed at a distro folder has
        // to become a WSL chat too, or it inherits the very mismatch that fixes.
        const wsl = parseWslUnc(folder)
        setSessions((prev) =>
          prev.map((s) =>
            s.id === draft.id
              ? {
                  ...s,
                  projectPath: wsl ? wsl.posixPath : folder,
                  wslDistro: wsl?.distro,
                  remoteHostName: wsl ? `WSL · ${wsl.distro}` : undefined
                }
              : s
          )
        )
      }
      setActiveId(draft.id)
      setView('chat')
      bumpNewChatNonce(draft.id)
      return
    }
    const s = newSession(
      ask ? undefined : folder ?? activeSession?.projectPath,
      defaultModel,
      activeSession?.accountId ?? defaultAccountId
    )
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    // Bump the nonce so the chat pane asks its setup question afresh, the same way it does
    // for every other New terminal entry point.
    bumpNewChatNonce(s.id)
  }
  createSessionRef.current = createSession

  // Navigation from the nav rail / command palette, as opposed to the setView calls that
  // already pick a specific chat to land on (createSession, pickAccount, …).
  //
  // Arriving at the chat view creates nothing. A chat is a real thing — a CLI process
  // starting in some folder — and spawning one every time you passed through the view is
  // not something anyone asked for. A chat is created when you press New terminal, and
  // only then.
  //
  // What you get instead: the welcome pane, whatever was last active. A terminal is a live
  // CLI process, and dropping back into one you left running — at whatever prompt or
  // half-typed command it sits on — is not what pressing Chat in the rail asks for. The
  // terminal keeps running and stays one click away in the sidebar; the rail entry means
  // "New terminal, or pick one". An untouched draft is let go of rather than deleted: it
  // stays available for the next New terminal to reuse (see blankDraft).
  const goToView = (v: View) => {
    // Chat pressed while already in Chat: nothing to navigate to, so the click shows or
    // hides the chat list — the way to get it back once it is collapsed.
    if (v === 'chat' && view === 'chat') {
      toggleSidebar()
      return
    }
    if (v === 'chat' && view !== 'chat') {
      setActiveId('')
      setView('chat')
      return
    }
    setView(v)
  }

  const deleteSession = async (id: string) => {
    // Chat terminals outlive their pane (see ChatTerminal's effect cleanup), so deleting the
    // chat is what finally tears its pty down — otherwise it would linger until app quit.
    await window.electronAPI.terminalKill(chatTerminalId(id))
    await window.electronAPI.deleteSession(id)
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      const closed = prev.find((s) => s.id === id)
      // Land on another chat of the same account, or the welcome pane — no auto-draft.
      // Never the first chat in the list: the active chat decides the sidebar's account,
      // so that would switch accounts just for closing a chat.
      if (activeId === id) {
        const defaults: AccountDefaults = { defaultAccountId, codexDefaultAccountId, geminiDefaultAccountId }
        const successor = (closed && nextChatAfterClose(closed, next, models, defaults)?.id) || ''
        // Whatever happens, no pane may be left pointed at a chat that no longer exists.
        if (!successor) {
          // Nothing to land on: the pane goes (with a single pane, exactly the old
          // setActiveId('')).
          closePane(id)
        } else if (visibleIdsRef.current.has(successor)) {
          // The successor is already on screen in another pane, so opening it here would
          // only move the focus and orphan this one — close this pane, then focus it.
          closePane(id)
          setActiveId(successor)
        } else {
          // The successor takes this pane over in place, keeping its position.
          setActiveId(successor)
        }
      } else {
        // Not the chat you were typing in, but it may still have been on screen in another
        // pane — closePane is a no-op when no pane shows it.
        closePane(id)
      }
      return next
    })
  }

  // Leave the terminal that IS the chat. Unlike unmounting the pane,
  // this is explicit: the pty goes, because a terminal you closed should not still be
  // running behind the welcome pane. The chat stays in the sidebar — reopening it
  // starts a fresh terminal in the same folder.
  const closeChatTerminal = (sid: string) => {
    if (!sid) return
    window.electronAPI.terminalKill(chatTerminalId(sid))
    // Only this chat's pane: setActiveId('') means "clear every pane", which with two
    // terminals on screen would close the one whose button you did not press.
    closePane(sid)
  }

  const setSessionProject = (path: string) => {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, projectPath: path } : s)))
  }

  // Patch a session from the setup pane's config bar (folder, environment) or from the
  // terminal's own activity.
  const patchSession = (sid: string, patch: Partial<Session>) => {
    let patched: Session | undefined
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s
        patched = { ...s, ...patch }
        return patched
      })
    )
    // Saved at once rather than on the next autosave tick: without this a chat could vanish
    // on a restart right after hasTerminalActivity made it visible in the sidebar. The
    // terminal's session id has to survive the same way and for a sharper reason: it is
    // the only record of which Claude Code conversation that terminal started, and losing
    // it means the chat can never be matched back to its own transcript.
    if ((patch.hasTerminalActivity || patch.terminalSessionId || patch.terminalStartedAt) && patched) {
      window.electronAPI.saveSession(patched)
    }
  }

  // Account selection is app-level: it sets the DEFAULT account used for new chats.
  // Existing sessions keep their own accountId forever (a chat is permanently bound to
  // the account that created it — its Claude Code resume id only exists there). The one
  // exception: an unstarted draft (see isUnstarted) follows the switch, so an empty chat
  // inherits the account you just picked.
  const switchDefaultAccount = async (accountId: string) => {
    const { accounts: next, defaultAccountId: nextDefault } =
      await window.electronAPI.accountsSetDefault(accountId)
    setAccounts(next)
    setDefaultAccountId(nextDefault)
    const name = next.find((a) => a.id === accountId)?.name
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeIdRef.current && isUnstarted(s)
          ? { ...s, accountId, accountName: name }
          : s
      )
    )
    // Force a fresh plan-usage read so the sidebar badge reflects the newly
    // selected default account immediately, instead of showing the previous
    // account's number until the watcher's next (~5min) tick.
    window.electronAPI.ccPlanUsage(true).then(setPlanReport).catch(() => {})
  }

  // The provider the app-wide default model belongs to — drives which account store the
  // sidebar's account picker is scoped to.
  const defaultProvider: ProviderId = models.find((m) => defaultModel.startsWith(m.id))?.provider ?? 'claude'
  // The active chat's provider and that provider's account. Drives which CLI the embedded
  // terminal launches and under which account, and which account the sidebar row, its
  // usage badge and the session list are scoped to — so opening a chat bound to another
  // account moves the whole sidebar onto it rather than disagreeing with what's on screen.
  const activeChatProvider: ProviderId = providerOf(activeSession)
  const activeChatAccountId =
    activeChatProvider === 'codex'
      ? (activeSession?.codexAccountId ?? codexDefaultAccountId)
      : activeChatProvider === 'gemini'
        ? (activeSession?.geminiAccountId ?? geminiDefaultAccountId)
        : (activeSession?.accountId ?? defaultAccountId)
  const firstModelForProvider = (provider: ProviderId): string | undefined =>
    models.find((m) => m.provider === provider)?.id

  // Generalized version of switchDefaultAccount above, covering all three providers. Also
  // switches the app's default model to that provider's top model when the pick crosses a
  // provider boundary, so a newly-picked Codex/Gemini account is actually used by new chats.
  const switchDefaultProviderAccount = async (provider: ProviderId, accountId: string) => {
    if (provider === 'claude') {
      await switchDefaultAccount(accountId)
    } else {
      const { accounts: next, defaultAccountId: nextDefault } =
        await window.electronAPI.providerAccountsSetDefault(provider, accountId)
      if (provider === 'codex') {
        setCodexAccounts(next)
        setCodexDefaultAccountId(nextDefault)
        // Force-refresh past the cache — mirrors ccPlanUsage(true) in switchDefaultAccount
        // above, so the badge reflects the newly-picked account immediately.
        window.electronAPI.codexUsage(true).then(setCodexAccountUsage).catch(() => {})
      } else {
        setGeminiAccounts(next)
        setGeminiDefaultAccountId(nextDefault)
      }
      const name = next.find((a) => a.id === accountId)?.name
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeIdRef.current || !isUnstarted(s)) return s
          return provider === 'codex'
            ? { ...s, codexAccountId: accountId, codexAccountName: name }
            : { ...s, geminiAccountId: accountId, geminiAccountName: name }
        })
      )
    }
    if (provider !== defaultProvider) {
      const m = firstModelForProvider(provider)
      if (m) await handleSetDefaultModel(m)
    }
  }

  // Picking an account in the sidebar picker switches the whole view onto it, not just
  // the default for new chats: the row/list are scoped to the ACTIVE chat's account
  // (see selectedProvider below), so without this a pick on a different account looked
  // like it did nothing. So after setting the default (above) we move to a chat on that
  // account — the most recent one already there, else the active empty draft repurposed
  // onto it, else a fresh chat bound to it.
  const pickAccount = async (provider: ProviderId, accountId: string) => {
    // The chat this lands on is the active one in every branch below that keeps a chat at
    // all (it either stays put or has the active draft rebound onto the picked account);
    // the remaining branch goes to the welcome pane, where there is no chat to greet.
    bumpNewChatNonce(activeIdRef.current)
    await switchDefaultProviderAccount(provider, accountId)

    // Resolve chats with the just-picked account as this provider's default — state from
    // switchDefaultProviderAccount hasn't flushed yet, and an unbound legacy chat must
    // resolve the same way its terminal will (see account-scope.ts / useSessionPane).
    const effectiveDefaults: AccountDefaults = {
      defaultAccountId: provider === 'claude' ? accountId : defaultAccountId,
      codexDefaultAccountId: provider === 'codex' ? accountId : codexDefaultAccountId,
      geminiDefaultAccountId: provider === 'gemini' ? accountId : geminiDefaultAccountId
    }
    // The model a fresh chat here should use: keep the current default within the default
    // provider, else that provider's top model (matching the default-model switch above).
    const providerModel =
      provider === defaultProvider ? defaultModel : firstModelForProvider(provider) ?? defaultModel
    const list = provider === 'codex' ? codexAccounts : provider === 'gemini' ? geminiAccounts : accounts
    const name = list.find((a) => a.id === accountId)?.name
    const acctFields =
      provider === 'codex'
        ? { codexAccountId: accountId, codexAccountName: name }
        : provider === 'gemini'
          ? { geminiAccountId: accountId, geminiAccountName: name }
          : { accountId, accountName: name }

    // Already on this account with an unstarted draft (the switch may have rebound it) —
    // that IS the new-chat page, so stay put.
    const active = sessions.find((s) => s.id === activeIdRef.current)
    if (
      active &&
      isUnstarted(active) &&
      provOf(models, active.model) === provider &&
      acctOf(active, models, effectiveDefaults) === accountId
    ) {
      setView('chat')
      return
    }
    // Otherwise don't reopen a chat from the account you just switched away from — but
    // don't fabricate one either (picking an account is not pressing New chat). An
    // untouched draft is simply rebound onto the picked account; anything else steps
    // aside for the welcome pane, where New chat will inherit the account just picked.
    if (active && isUnstarted(active)) {
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, model: providerModel, ...acctFields } : s)))
    } else {
      setActiveId('')
    }
    setView('chat')
  }

  // Resume a real Claude Code session from the Projects view (local or WSL): a chat bound
  // to that conversation, whose terminal starts with `--resume`. Nothing is copied — the
  // CLI's transcript is the record.
  const resumeCCSession = async (cc: CCSessionMeta) => {
    const isWsl = cc.kind === 'wsl'
    // A WSL session whose recorded cwd is actually a Windows mount (/mnt/c/…, /c/Users/…)
    // is a legacy artifact — don't reuse it; let it default to the distro's $HOME.
    const isWinMount = /^\/mnt\/[a-z]\//i.test(cc.realPath) || /^\/[a-z]\/(Users|Windows)\//i.test(cc.realPath)
    const projectPath = isWsl && isWinMount ? undefined : cc.realPath
    // A session from a non-default account's source (id `account:<id>`, see
    // claude-data.ts getSources) must resume under THAT account's CLAUDE_CONFIG_DIR —
    // its transcript lives there, so resuming under defaultAccountId would look for the
    // session id in the wrong config dir and fail.
    const accountId = cc.sourceId.startsWith('account:')
      ? cc.sourceId.slice('account:'.length)
      : defaultAccountId
    // The model only decides which CLI launches, and this is a Claude Code conversation:
    // falling back to a default that belongs to another provider would start the wrong one.
    // TODO(B4): `provider: 'claude'` once Session carries it.
    const claudeModel =
      provOf(models, defaultModel) === 'claude' ? defaultModel : models.find((m) => m.provider === 'claude')?.id ?? defaultModel
    const s: Session = {
      id: generateId(),
      name: cc.title,
      messages: [],
      projectPath,
      claudeSessionId: cc.sessionId,
      model: cc.model || claudeModel,
      accountId,
      wslDistro: isWsl ? cc.distro : undefined,
      remoteHostName: isWsl ? `WSL · ${cc.distro}` : undefined,
      hasTerminalActivity: true,
      createdAt: cc.createdAt || Date.now(),
      updatedAt: Date.now()
    }
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    window.electronAPI.saveSession(s)
  }

  // What a notification click (or any `argos://session?…` link) opens: the conversation
  // it names, in the chat. It used to land on the Projects list with the conversation in
  // a reading panel beside it, which is not what a notification promises — it says a
  // session needs you, and the answer to that is the session, not a list of them.
  //
  // Three cases, in the order they are worth trying:
  const openCcTarget = async (target: CcSessionTarget) => {
    // Already a chat in the app. The common case by far: most notifications come from a
    // CLI running in an Argos terminal, and resuming that would fork a second copy of a
    // conversation that is still live in the first.
    const open = sessionsRef.current.find(
      (s) => s.claudeSessionId === target.sessionId || s.terminalSessionId === target.sessionId
    )
    if (open) {
      setActiveId(open.id)
      setView('chat')
      return
    }
    // Not in the app, but on disk: resume it into a chat, the same way picking it in
    // Projects does. Archived transcripts are tried too — a conversation can have been
    // archived between the notification firing and the click.
    try {
      const projects = await window.electronAPI.ccListProjects()
      const proj = projects.find(
        (p) =>
          p.encodedDir === target.encodedDir && (!target.sourceId || p.sourceId === target.sourceId)
      )
      if (proj) {
        for (const archived of [false, true]) {
          const list = await window.electronAPI.ccListSessions(proj.sourceId, proj.encodedDir, archived)
          const meta = list.find((s) => s.sessionId === target.sessionId)
          if (meta) {
            await resumeCCSession(meta)
            return
          }
        }
      }
    } catch {
      // Fall through — a failed read is not a reason to leave the click unanswered.
    }
    // Nowhere to be found (another source, a transcript this side cannot read, a project
    // that has since moved). The Projects list is where the user can go looking, which is
    // still an answer; a click that does nothing at all is not.
    setCcTarget(target)
    setView('projects')
  }
  openCcTargetRef.current = openCcTarget

  // Read each terminal chat's transcript from disk once the CLI it launched has written
  // one, for what the chat itself shows: its name (the CLI's title, while the chat is still
  // "New chat"), the conversation id the CLI settled on, how recently it moved (the sidebar
  // sorts on it) and whether it moved while nobody was looking (unread). The messages
  // themselves are not copied: the terminal is the transcript.
  //
  // How long each transcript was last time, by chat id — what "it grew" is measured
  // against. In memory only: the first read after a launch just records the length, so a
  // conversation that moved while the app was closed is not flagged unread on startup.
  const transcriptLengthRef = useRef<Map<string, number>>(new Map())
  const syncTerminalChats = useCallback(async () => {
    const candidates = sessionsRef.current.filter(
      (s) => s.projectPath && (s.claudeSessionId || s.terminalSessionId) && s.hasTerminalActivity
    )
    for (const s of candidates) {
      const sessionId = (s.claudeSessionId || s.terminalSessionId) as string
      // A chat recorded before newSession read the WSL share spelling: the folder is a
      // `\\wsl.localhost\<distro>\…` path with no distro beside it, so its terminal ran
      // inside the distro while this lookup searched the Windows filesystem — and found
      // nothing, forever. Repair it here rather than only reading around it: the distro is
      // what makes its account, its environment chip and its project group right too.
      const unc = s.wslDistro ? null : s.projectPath && parseWslUnc(s.projectPath)
      if (unc) {
        setSessions((prev) =>
          prev.map((cur) =>
            cur.id === s.id
              ? {
                  ...cur,
                  projectPath: unc.posixPath,
                  wslDistro: unc.distro,
                  remoteHostName: `WSL · ${unc.distro}`
                }
              : cur
          )
        )
        // Next tick reads the repaired session — no need to duplicate the lookup here.
        continue
      }
      const prefer = s.wslDistro ? `wsl:${s.wslDistro}` : undefined
      const transcript = await window.electronAPI.ccChatTranscript(s.projectPath as string, sessionId, prefer)
      if (!transcript) continue

      const nameFromTitle = transcript.title && s.name === 'New chat' ? transcript.title : undefined
      const length = transcript.messages.length
      const previous = transcriptLengthRef.current.get(s.id)
      transcriptLengthRef.current.set(s.id, length)
      const grew = previous !== undefined && length > previous
      const lastAt = transcript.messages[length - 1]?.timestamp
      const movedAt = lastAt && lastAt > s.updatedAt ? lastAt : undefined
      const sessionIdChanged = s.claudeSessionId !== sessionId
      const markUnread = grew && !s.unread && !seenIdsRef.current.has(s.id)
      // A tick where nothing moved would still produce a *new* session object every time
      // this runs — and this runs on a timer, which would re-save every terminal chat
      // forever for no reason.
      if (!sessionIdChanged && !nameFromTitle && !movedAt && !markUnread) continue

      setSessions((prev) =>
        prev.map((cur) => {
          if (cur.id !== s.id) return cur
          return {
            ...cur,
            claudeSessionId: sessionId,
            ...(nameFromTitle ? { name: nameFromTitle } : {}),
            ...(movedAt ? { updatedAt: movedAt } : {}),
            // The terminal wrote new turns while this chat wasn't on screen — reads
            // seenIdsRef (not seenIds) because syncTerminalChats has no deps and would
            // otherwise close over whichever panes were open when it was first created.
            ...(markUnread ? { unread: true } : {})
          }
        })
      )
    }
  }, [])

  /**
   * Give each Codex terminal chat the name of the conversation it started.
   *
   * The Codex half of syncTerminalChats. That one addresses a transcript by the session
   * id the chat pinned before its CLI launched, which a Codex chat has no way to do —
   * its CLI takes no `--session-id` — so there was nothing to look up and those chats
   * stayed called "New chat" for good. Here the conversation is claimed after the fact,
   * by folder and time, in main (see codex-thread-link-pure.ts for what it refuses).
   *
   * Gated on `codexLinkDirtyRef`, which the pty busy signal fills: a chat sitting idle
   * at its prompt cannot have gained a conversation, and every attempt costs an
   * app-server spawn. So this stays silent until a terminal has actually done something.
   */
  const codexLinkDirtyRef = useRef<Set<string>>(new Set())
  const syncCodexThreadLinks = useCallback(async () => {
    const dirty = codexLinkDirtyRef.current
    if (!dirty.size) return
    const candidates = sessionsRef.current.filter(
      (s) =>
        dirty.has(s.id) &&
        !s.codexThreadId &&
        s.projectPath &&
        s.terminalStartedAt &&
        s.hasTerminalActivity &&
        // The app-server this spawns runs on this machine, against this machine's Codex
        // home. A chat whose CLI lives inside a distro or on another box keeps its
        // conversation over there, where none of that applies.
        !s.wslDistro &&
        !s.remoteHostId &&
        provOf(models, s.model || defaultModel) === 'codex'
    )
    // Cleared for this round up front: a chat whose turn produced no thread is flagged
    // again by its next transition, and holding the flag would retry on every tick.
    for (const s of candidates) dirty.delete(s.id)
    if (!candidates.length) return

    // A thread another chat already holds is not available, however well it matches.
    const claimed = sessionsRef.current
      .map((s) => s.codexThreadId)
      .filter((id): id is string => !!id)

    // Grouped by account because each Codex login keeps its own history under its own
    // CODEX_HOME — one listing cannot answer for two of them.
    const byAccount = new Map<string | undefined, Session[]>()
    for (const s of candidates) {
      const key = s.codexAccountId ?? codexDefaultAccountId
      const list = byAccount.get(key)
      if (list) list.push(s)
      else byAccount.set(key, [s])
    }

    for (const [accountId, group] of byAccount) {
      let linked: Record<string, { threadId: string; title: string | null }>
      try {
        linked = await window.electronAPI.codexLinkThreads(
          group.map((s) => ({
            id: s.id,
            cwd: s.projectPath as string,
            startedAt: s.terminalStartedAt as number
          })),
          claimed,
          accountId
        )
      } catch {
        // Nothing claimed this round; the next transition flags these chats again.
        continue
      }
      if (!Object.keys(linked).length) continue
      setSessions((prev) => {
        const touched: Session[] = []
        const next = prev.map((s) => {
          const hit = linked[s.id]
          // Re-checked here rather than above: this resolves a round later, and a chat
          // that has been linked in the meantime owns what it has.
          if (!hit || s.codexThreadId) return s
          const updated: Session = {
            ...s,
            codexThreadId: hit.threadId,
            // Only a chat still carrying the placeholder is renamed. A name the user
            // typed, or one an earlier round already took from this conversation, is
            // not something a later listing gets to overwrite.
            ...(hit.title && s.name === 'New chat' ? { name: hit.title } : {})
          }
          touched.push(updated)
          return updated
        })
        // Saved at once rather than on the next autosave tick, so the link and the name are
        // never lost on a restart and re-claimed from scratch — against a listing that by
        // then has other chats' threads in it too.
        for (const s of touched) window.electronAPI.saveSession(s)
        return next
      })
    }
  }, [models, defaultModel, codexDefaultAccountId])

  // Runs on the same cadence, and for the same reason, as the transcript sync below: a
  // chat left working in the background has to catch up without being looked at. The
  // dirty-set gate inside makes an idle tick free.
  useEffect(() => {
    syncCodexThreadLinks()
  }, [activeId, visibleKey, syncCodexThreadLinks])
  useEffect(() => {
    const timer = setInterval(() => {
      syncCodexThreadLinks()
    }, 12000)
    return () => clearInterval(timer)
  }, [syncCodexThreadLinks])

  // Pull terminal chats' transcripts in on the cadence a terminal-driven conversation
  // actually changes on: right away and whenever the user switches to look at one (this
  // effect covers both — it runs on mount too), and otherwise every 12s so a chat left
  // running in the background still catches up. Reads sessions through sessionsRef
  // (inside syncTerminalChats itself) rather than closing over `sessions`, same as the
  // other interval effects in this file.
  // `visibleKey` as well as `activeId`: a pane that has just opened on a terminal chat has
  // to pull its transcript now, not on the next 12s tick.
  useEffect(() => {
    syncTerminalChats()
  }, [activeId, visibleKey, syncTerminalChats])
  useEffect(() => {
    const timer = setInterval(() => {
      syncTerminalChats()
    }, 12000)
    return () => clearInterval(timer)
  }, [syncTerminalChats])

  /**
   * Rename a chat from the sidebar.
   *
   * The name is Argos's, but a chat with a Claude Code conversation behind it gets the
   * same title written into that transcript — the same line `/rename` writes — so the
   * two never disagree about what the conversation is called. That write is best-effort:
   * the chat is renamed here whether or not a transcript exists to carry it.
   */
  const renameSessionById = useCallback((id: string, name: string) => {
    let patched: Session | undefined
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        patched = { ...s, name, updatedAt: Date.now() }
        return patched
      })
    )
    if (!patched) return
    window.electronAPI.saveSession(patched)
    const ccId = patched.claudeSessionId || patched.terminalSessionId
    if (ccId && patched.projectPath) {
      const prefer = patched.wslDistro ? `wsl:${patched.wslDistro}` : undefined
      window.electronAPI.ccChatRename(patched.projectPath, ccId, name, prefer)
    }
  }, [])

  /**
   * Bind a chat to the Claude Code session its terminal turned out to be running.
   *
   * Written straight to disk as well as to state: this is the only record of which
   * conversation that terminal holds, and a repair that lasts until the next restart is
   * not a repair. Only ever `terminalSessionId` — see the adoption effect for why a chat
   * with a `claudeSessionId` is left alone.
   */
  const adoptSessionId = useCallback((id: string, ccId: string) => {
    // The save is built from the ref, not from inside the updater: this runs from a
    // promise callback, where React may defer the updater past the save line.
    const current = sessionsRef.current.find((s) => s.id === id)
    if (!current) return
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, terminalSessionId: ccId } : s)))
    window.electronAPI.saveSession({ ...current, terminalSessionId: ccId })
  }, [])

  /**
   * Claude Code session ids the live registry currently reports as busy.
   *
   * Nothing in Argos itself knows whether a terminal chat's CLI is working or sitting
   * idle. The registry does, and since each terminal chat pins its own session id, its
   * rows can be matched back to chats.
   */
  const [liveBusyIds, setLiveBusyIds] = useState<Set<string>>(new Set())
  // Raw registry rows, kept alongside liveBusyIds so Home's "running" list can show
  // CLI sessions by name/source rather than just gating a busy id — same poll, no
  // second timer.
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([])
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const live = await window.electronAPI.ccLiveSessions()
        if (!alive) return
        setLiveSessions(live)
        setLiveBusyIds((prev) => {
          const next = new Set(live.filter((l) => l.status === 'busy').map((l) => l.sessionId))
          // Same-contents check: a fresh Set every few seconds would re-render the whole
          // sidebar on a tick where nothing actually changed.
          if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev
          return next
        })
      } catch {
        // A registry that can't be read just means no extra rows light up.
      }
    }
    poll()
    const timer = setInterval(poll, 6000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  /**
   * Terminal ids whose pty is producing output right now.
   *
   * The provider-agnostic half of "this chat is working". `liveBusyIds` above covers only
   * Claude Code, which publishes its own status and can be pinned to a session id; codex
   * and Antigravity publish nothing and codex cannot even be pinned (no `--session-id`),
   * so for those this is the only signal there is. Pushed from main on the transition, not
   * polled — see busyTerminals() there for why output is a sound proxy.
   */
  const [busyTerminalIds, setBusyTerminalIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    // Seeded like the busy set, and for the same reason: the notification that raised the
    // mark was emitted once, so a window that opens after it would never hear about a chat
    // already parked on an approval.
    window.electronAPI.terminalWaitingList().then((ids) => {
      if (alive && ids.length) setWaitingTerminalIds((prev) => new Set([...prev, ...ids]))
    }).catch(() => {
      // No seed just means the mark waits for the next notification.
    })
    const off = window.electronAPI.onTerminalNotify(({ id, waiting }) => {
      setWaitingTerminalIds((prev) => {
        if (prev.has(id) === waiting) return prev
        const next = new Set(prev)
        if (waiting) next.add(id)
        else next.delete(id)
        return next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => {
    let alive = true
    // Seeded as well as subscribed: transitions only start arriving once this listener is
    // registered, so without the seed a chat that was already working when the window
    // opened would stay dark until it happened to change state.
    window.electronAPI.terminalBusyList().then((ids) => {
      if (alive && ids.length) setBusyTerminalIds(new Set(ids))
    }).catch(() => {
      // No seed just means the first transition is what lights the chat up.
    })
    const off = window.electronAPI.onTerminalBusy(({ id, busy }) => {
      // Every transition is a moment a Codex chat may have gained a conversation: the
      // start of a turn creates one, and the end of a turn guarantees it is recorded.
      // Linking is gated on this so an idle terminal never spawns an app-server — see
      // syncCodexThreadLinks.
      const sid = sessionIdFromTerminalId(id)
      if (sid) codexLinkDirtyRef.current.add(sid)
      setBusyTerminalIds((prev) => {
        if (prev.has(id) === busy) return prev
        const next = new Set(prev)
        if (busy) next.add(id)
        else next.delete(id)
        return next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * Adopt the CLI a chat's terminal actually started, when the id the chat picked for it
   * did not take.
   *
   * A chat names its session before launching (see newSession), so this normally has
   * nothing to do. The launch chain can still fall through to a bare `claude` — a CLI too
   * old to know `--session-id`, or a terminal started by a build that predates the
   * pinning — and then the CLI invents an id the app was never told. The chat is left
   * holding an id that names no live process: no transcript, no title, no running dot,
   * and no way back, because nothing about that chat ever changes again.
   *
   * The link is descent: the pty is our own child, so the `claude` under it is that
   * chat's and nothing else is. Main does the matching (session-adoption.ts) and refuses
   * to guess when two live sessions share one terminal.
   *
   * Only for chats with no `claudeSessionId` of their own. A chat that has one launched
   * its terminal with `--resume` against a real conversation; rewriting its identity from
   * the process table, on the strength of a resume that appears to have failed, risks
   * pointing it at someone else's transcript to fix a missing dot.
   */
  const adoptTriedRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (!liveSessions.length) return
    const claimedBy = (ccId: string | undefined): boolean =>
      !!ccId &&
      sessionsRef.current.some((s) => s.claudeSessionId === ccId || s.terminalSessionId === ccId)
    // Nothing unclaimed is running, so nothing can be adopted — leave without paying for
    // the process-table read this would otherwise lead to.
    if (!liveSessions.some((l) => !l.foreign && !claimedBy(l.sessionId))) return

    const now = Date.now()
    const orphans = sessionsRef.current.filter(
      (s) =>
        s.hasTerminalActivity &&
        !s.claudeSessionId &&
        !s.wslDistro &&
        !s.remoteHostId &&
        !liveSessions.some((l) => l.sessionId === s.terminalSessionId) &&
        // Throttled per chat, well above the 6s poll: a chat whose terminal is closed
        // stays orphaned forever by definition, and retrying it every tick would make a
        // permanent background cost out of a one-off repair.
        now - (adoptTriedRef.current.get(s.id) ?? 0) > ADOPT_RETRY_MS
    )
    if (!orphans.length) return
    for (const s of orphans) adoptTriedRef.current.set(s.id, now)

    const chatOf = new Map(orphans.map((s) => [chatTerminalId(s.id), s.id]))
    window.electronAPI.ccAdoptSessions([...chatOf.keys()]).then((found) => {
      for (const [terminalId, ccId] of Object.entries(found)) {
        const chatId = chatOf.get(terminalId)
        // Re-checked here rather than above: this resolves a round later, and a chat
        // that claimed this id in the meantime (a transcript sync landing, say) owns it.
        if (!chatId || claimedBy(ccId)) continue
        adoptSessionId(chatId, ccId)
      }
    }).catch(() => {
      // Nothing adopted this round; the throttle above decides when to try again.
    })
  }, [liveSessions, adoptSessionId])

  /**
   * What the sidebar shows as running: any chat whose Claude Code session the registry
   * reports busy, or whose terminal is producing output.
   */
  const displayRunningIds = useMemo(() => {
    const out = new Set<string>()
    if (!liveBusyIds.size && !busyTerminalIds.size) return out
    for (const s of sessions) {
      const ccId = s.claudeSessionId || s.terminalSessionId
      if (ccId && liveBusyIds.has(ccId)) out.add(s.id)
      // Where Claude Code reports its own status that remains the more precise answer,
      // and this is here to cover the chats it says nothing about — every codex and
      // Antigravity terminal, and any Claude one whose registry entry could not be read.
      else if (busyTerminalIds.has(chatTerminalId(s.id))) out.add(s.id)
    }
    return out
  }, [liveBusyIds, busyTerminalIds, sessions])

  // Chats still working, for the window-wide pending bar. The chat you're already looking
  // at is left out — you can see it working, so listing it is just noise.
  // A chat that finished while you were elsewhere stays on as `done` until it is read: the
  // toast is gone by the time you're back, and this is where you were already looking.
  const pendingRuns = useMemo<PendingRun[]>(() => {
    const defaults: AccountDefaults = {
      defaultAccountId,
      codexDefaultAccountId,
      geminiDefaultAccountId
    }
    const running = sessions.filter(
      (s) =>
        !seenIds.has(s.id) &&
        (displayRunningIds.has(s.id) ? !dismissedRunIds.has(s.id) : !!s.unread)
    )
    // Which account each run is actually billed to, resolved exactly the way the terminal
    // resolves it (acctOf mirrors its fallbacks), so an unbound chat is never labelled
    // with an account it isn't running on.
    // Keyed by provider too: 'default' means a different login on Codex than it does on
    // Claude, so two runs sharing the bare id are still two accounts.
    //
    // The sidebar is scoped to ONE provider+account — the one you're on — so a run on any
    // other account is invisible there, and this bar is the only place it shows up. So the
    // account is named exactly when it isn't the one you're on: naming yours on every pill
    // is noise, and leaving another's off makes the run look like it belongs to this list,
    // where you then won't find it. Whether the bar happens to span accounts doesn't enter
    // into it — a WSL run beside a local one used to put "Personal" on the local pill even
    // while you were on Personal.
    const scopeKey = `${activeChatProvider}:${activeChatAccountId ?? 'default'}`
    return running.map((s) => {
      const attention = attentionIds.has(s.id)
      // A chat waiting on you has not finished, whatever its terminal has stopped doing.
      // A terminal chat parked on an approval goes quiet exactly like one that is done,
      // so without this the single state that needs you to act would be the one drawn,
      // counted and coloured as dealt with.
      const done = !attention && !displayRunningIds.has(s.id)
      // A chat inside a WSL distro, or on a box over SSH, runs against the CLI login that
      // lives THERE, and labelling it with the account it happens to carry states something
      // false. It is always named by where it runs: "it is working" and "it is working
      // inside Ubuntu-DevOps" are different facts, and the second is the one you need to go
      // and look in the right place.
      const origin = originOf(s)
      if (origin) {
        return { id: s.id, name: s.name, attention, done, account: origin.label }
      }
      const acctId = acctOf(s, models, defaults)
      const provider = provOf(models, s.model)
      const list =
        provider === 'codex' ? codexAccounts : provider === 'gemini' ? geminiAccounts : accounts
      const name = list.find((a) => a.id === acctId)?.name ?? s.accountName ?? acctId
      return {
        id: s.id,
        name: s.name,
        attention,
        done,
        account: `${provider}:${acctId}` === scopeKey ? undefined : name
      }
    })
  }, [
    sessions,
    displayRunningIds,
    dismissedRunIds,
    attentionIds,
    seenIds,
    models,
    accounts,
    defaultAccountId,
    codexAccounts,
    codexDefaultAccountId,
    geminiAccounts,
    geminiDefaultAccountId,
    activeChatProvider,
    activeChatAccountId
  ])

  // Dismissing a chat from the pending bar only hides that burst of work. Forgetting the
  // dismissal the moment the chat starts working again (idle → busy) means its next burst
  // surfaces instead of staying hidden for the rest of the session.
  const prevBusyRef = useRef(displayRunningIds)
  useEffect(() => {
    const started = [...displayRunningIds].filter((id) => !prevBusyRef.current.has(id))
    prevBusyRef.current = displayRunningIds
    if (!started.length) return
    setDismissedRunIds((prev) => {
      if (!started.some((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of started) next.delete(id)
      return next
    })
  }, [displayRunningIds])

  // The one signal every kind of chat shares for "it finished": leaving the running set.
  // A terminal chat's transcript sync only flags unread when it happens to run, which may
  // not be until you open the chat — too late for the pending bar to tell you about it.
  const prevRunningRef = useRef(displayRunningIds)
  useEffect(() => {
    const stopped = [...prevRunningRef.current].filter(
      (id) => !displayRunningIds.has(id) && !seenIdsRef.current.has(id)
    )
    prevRunningRef.current = displayRunningIds
    if (!stopped.length) return
    setSessions((prev) => {
      if (!prev.some((s) => stopped.includes(s.id) && !s.unread)) return prev
      return prev.map((s) => (stopped.includes(s.id) && !s.unread ? { ...s, unread: true } : s))
    })
  }, [displayRunningIds])

  // Hiding a finished chat from the bar is saying you've dealt with it.
  const dismissPending = useCallback(
    (sid: string) => {
      if (displayRunningIds.has(sid)) return dismissRun(sid)
      setSessions((prev) => prev.map((s) => (s.id === sid && s.unread ? { ...s, unread: false } : s)))
    },
    [displayRunningIds, dismissRun]
  )

  // ─── Home view data ────────────────────────────────────────────────────────
  // Everything below is either derived from state Argos already keeps (approvals,
  // running, plans, recent) or fetched only while Home is the visible view (repos'
  // git status) — Home is reachable from anywhere, so nothing here should poll when
  // nobody is looking at it.

  // Drive-letter → distro map, for resolving a session's projectPath to the same
  // projectKey the Sidebar groups by (see keyCtx there) — fetched once, not gated on
  // `view`, since it's cheap and the Sidebar is mounted the whole time anyway.
  const [homeWslDriveMap, setHomeWslDriveMap] = useState<Record<string, string>>({})
  useEffect(() => {
    window.electronAPI.wslDriveMap?.().then(setHomeWslDriveMap).catch(() => {})
  }, [])
  const homeKeyCtx = useMemo<ProjectKeyContext>(
    () => ({ driveMap: homeWslDriveMap, posixDistros: buildPosixDistroMap(sessions) }),
    [homeWslDriveMap, sessions]
  )

  // Custom project names (renames) — the same source the Sidebar reads, fetched only
  // while Home is visible so nothing here polls when nobody is looking at it.
  const [homeProjectNames, setHomeProjectNames] = useState<Record<string, string>>({})
  useEffect(() => {
    if (view !== 'home') return
    let cancelled = false
    window.electronAPI
      .ccProjectNames()
      .then((names) => {
        if (!cancelled) setHomeProjectNames(names)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [view])

  // One row per projectKey (not per raw path spelling — see project-key.ts), most
  // recently updated first, capped at 5 so the Home repo list stays a glance rather
  // than a second Projects view.
  const homeRepoEntries = useMemo(() => {
    const latest = new Map<string, { path: string; wslDistro?: string; updatedAt: number }>()
    for (const s of sessions) {
      if (!s.projectPath) continue
      const key = projectKey(s.projectPath, s.wslDistro, homeKeyCtx)
      const prev = latest.get(key)
      if (prev === undefined || s.updatedAt > prev.updatedAt) {
        latest.set(key, { path: s.projectPath, wslDistro: s.wslDistro, updatedAt: s.updatedAt })
      }
    }
    return [...latest.entries()]
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 5)
      .map(([key, v]) => ({
        key,
        // The canonical spelling, not whichever raw path the latest session happened to
        // record: gitStatus needs one real filesystem location for the group, and for a
        // WSL folder the UNC form is the one a plain Windows process (this renderer's
        // main process) can actually stat — a bare POSIX path is not a place Windows can
        // look. An ordinary Windows path already round-trips through canonicalProjectPath
        // unchanged, so this is a no-op for the common case.
        path: canonicalProjectPath(v.path, v.wslDistro, homeKeyCtx),
        // Carried forward for homeRecentProjects' lastUsed, so that memo doesn't have to
        // re-scan `sessions` to recover what this one already computed.
        updatedAt: v.updatedAt
      }))
  }, [sessions, homeKeyCtx])

  // Repo names (git remote, else toplevel) for the folders in homeRepoEntries — fetched
  // once per key while Home is visible; the main process caches the underlying git
  // calls, so re-running this effect on a later homeRepoEntries change is not polling.
  // A folder that fails (not a repo, git missing, a WSL drive that's gone away) just
  // keeps resolving to its basename.
  const [homeRepoNames, setHomeRepoNames] = useState<Record<string, RepoName>>({})
  // What has already been asked lives in a ref, not in `homeRepoNames`: keying the skip
  // on the state would re-run this effect on the first answer, while the other folders
  // are still in flight and none of them are in the map — so each of them would be asked
  // again, once per answer that lands.
  const homeRepoAsked = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (view !== 'home') return
    let cancelled = false
    for (const entry of homeRepoEntries) {
      if (homeRepoAsked.current.has(entry.key)) continue
      homeRepoAsked.current.add(entry.key)
      const key = entry.key
      window.electronAPI
        .gitRepoName(entry.path)
        .then((repo) => {
          if (cancelled) return
          setHomeRepoNames((prev) => ({ ...prev, [key]: repo }))
        })
        .catch(() => homeRepoAsked.current.delete(key))
    }
    return () => {
      cancelled = true
    }
  }, [view, homeRepoEntries])

  // The one name resolver Home uses everywhere a session's project shows
  // up outside the repo list itself — same precedence as the Sidebar (rename > repo name
  // > basename), so a folder renamed to "argos" reads as "argos" throughout the app.
  const resolveHomeProjectName = useCallback(
    (path: string, wslDistro?: string) => {
      const key = projectKey(path, wslDistro, homeKeyCtx)
      return projectDisplayName(key, path, { custom: homeProjectNames, repos: homeRepoNames })
    },
    [homeKeyCtx, homeProjectNames, homeRepoNames]
  )

  const homeAttention = useMemo<HomeAttention[]>(() => {
    const approvals: HomeAttention[] = approvalQueue.map((r) => {
      const session = sessions.find((s) => s.id === r.appSessionId)
      const input = r.input
      // Same reading ApprovalModal uses for its own body, so the two surfaces never
      // disagree about what a pending request is asking for.
      const target =
        r.tool === 'Bash'
          ? str(input.command)
          : input.file_path || input.path
            ? str(input.file_path ?? input.path)
            : str(input.target ?? input.prompt ?? input.permissions ?? '')
      return {
        id: r.approvalId,
        kind: 'approval',
        title: session?.name ?? 'Chat',
        detail: target,
        mono: r.tool === 'Bash',
        context: session?.projectPath
          ? resolveHomeProjectName(session.projectPath, session.wslDistro)
          : undefined,
        since: approvalSinceRef.current.get(r.approvalId),
        actionLabel: 'Review'
      }
    })
    return approvals
  }, [approvalQueue, sessions, resolveHomeProjectName])

  const homeRunning = useMemo<HomeRunning[]>(() => {
    const chats: HomeRunning[] = sessions
      .filter((s) => displayRunningIds.has(s.id))
      .map((s) => ({
        kind: 'chat',
        id: s.id,
        name: s.name,
        detail: models.find((m) => m.id === (s.model || defaultModel))?.label,
        attention: attentionIds.has(s.id)
      }))
    // A chat already covers its own Claude Code session, so the matching CLI row (same
    // correspondence displayRunningIds uses above) would just be the same run twice.
    const linkedCcIds = new Set(
      sessions.flatMap((s) => [s.claudeSessionId, s.terminalSessionId]).filter((id): id is string => !!id)
    )
    const cli: HomeRunning[] = liveSessions
      .filter((l) => l.status === 'busy' && !linkedCcIds.has(l.sessionId))
      .map((l) => ({
        kind: 'cli',
        id: l.sessionId,
        name: l.name,
        detail: l.sourceLabel,
        startedAt: l.startedAt
      }))
    return [...chats, ...cli]
  }, [sessions, displayRunningIds, attentionIds, liveSessions, models, defaultModel])

  // gitStatus per homeRepoEntries, kept apart from name resolution below: this effect
  // should only re-run when the entries themselves change, not every time a repo name
  // or rename arrives, or it would restart every row's spinner mid-flight.
  const [homeRepoStatus, setHomeRepoStatus] = useState<
    Record<string, { branch?: string; fileCount: number; loading?: boolean; error?: string }>
  >({})
  useEffect(() => {
    if (view !== 'home') return
    let cancelled = false
    setHomeRepoStatus(
      Object.fromEntries(homeRepoEntries.map((e) => [e.key, { fileCount: 0, loading: true }]))
    )
    // Each row settles on its own. One Promise.all resolved them all or none, so a single
    // slow gitStatus — a WSL path, a drive that has gone away — held every row in its
    // spinner, and the list looked broken rather than partly late.
    for (const entry of homeRepoEntries) {
      window.electronAPI
        .gitStatus(entry.path)
        .then((status) => {
          if (cancelled) return
          setHomeRepoStatus((prev) => ({
            ...prev,
            [entry.key]: { branch: status.branch, fileCount: status.files.length }
          }))
        })
        .catch(() => {
          if (cancelled) return
          setHomeRepoStatus((prev) => ({
            ...prev,
            [entry.key]: { fileCount: 0, error: 'Could not read status' }
          }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [view, homeRepoEntries])

  // Row names come from the same resolver as the rest of Home/Sidebar (rename > repo
  // name > basename), disambiguated by parent folder on collisions — replacing the local
  // labelFor() this used to have, which only knew about basenames.
  //
  // homeRepoEntries splits into two Home sections rather than one: `repos` for folders
  // known to have uncommitted work (or that failed to report status at all), and
  // `recentProjects` for everything else — clean repos and ones still loading. A loading
  // row can't be asserted to have changes yet, so it can never land in `repos`; it shows
  // up as a loading `recentProjects` row until gitStatus settles one way or the other.
  const [homeRepos, homeRecentProjects] = useMemo<[HomeRepo[], HomeProject[]]>(() => {
    const names = projectDisplayNames(homeRepoEntries, { custom: homeProjectNames, repos: homeRepoNames })
    const repos: HomeRepo[] = []
    const recentProjects: HomeProject[] = []
    for (const e of homeRepoEntries) {
      const status = homeRepoStatus[e.key]
      const name = names.get(e.key) ?? basename(e.path)
      if ((status?.fileCount ?? 0) > 0 || status?.error) {
        repos.push({
          key: e.key,
          name,
          branch: status?.branch,
          fileCount: status?.fileCount ?? 0,
          error: status?.error
        })
      } else {
        recentProjects.push({
          key: e.key,
          name,
          branch: status?.branch,
          lastUsed: e.updatedAt,
          loading: status?.loading
        })
      }
    }
    recentProjects.sort((a, b) => b.lastUsed - a.lastUsed)
    return [repos, recentProjects]
  }, [homeRepoEntries, homeProjectNames, homeRepoNames, homeRepoStatus])

  const homeRecent = useMemo<HomeRecent[]>(
    () =>
      // TODO(B3b): terminal chats, with `preview` from the session; the messages read
      // here only exist on pre-2.0 chats until the migration archives them.
      sessions
        .filter((s) => s.messages.length > 0 || s.hasTerminalActivity)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)
        .map((s) => {
          const last = s.messages[s.messages.length - 1]
          // The transcript is markdown; a one-line preview that keeps the fences and
          // hashes reads as noise, so the marks come out before the truncation.
          const flat = (last?.content ?? '')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[#*`>]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
          const preview = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
          return {
            id: s.id,
            name: s.name,
            projectName: s.projectPath ? resolveHomeProjectName(s.projectPath, s.wslDistro) : undefined,
            updatedAt: s.updatedAt,
            preview
          }
        }),
    [sessions, resolveHomeProjectName]
  )

  const homeStart = useMemo<HomeStart>(() => {
    // The chips describe where the prompt will actually land, so they read the same
    // source startOverlayPrompt does: the ACTIVE session, which is what it seeds the new
    // chat from — folder and account both — before falling back to the defaults. Reading
    // the most recently updated session instead would label the box with a project the
    // chat is not going to open in.
    const base = sessions.find((s) => s.id === activeId)
    const acctId = base?.accountId ?? defaultAccountId
    const accountName =
      defaultProvider === 'codex'
        ? codexAccounts.find((a) => a.id === codexDefaultAccountId)?.name
        : defaultProvider === 'gemini'
          ? geminiAccounts.find((a) => a.id === geminiDefaultAccountId)?.name
          : accounts.find((a) => a.id === acctId)?.name
    const modelId = defaultModel
    return {
      projectPath: base?.projectPath,
      projectName: base?.projectPath ? resolveHomeProjectName(base.projectPath, base.wslDistro) : undefined,
      modelId,
      modelLabel: models.find((m) => m.id === modelId)?.label,
      accountId: acctId,
      accountName
    }
  }, [
    sessions,
    activeId,
    models,
    defaultModel,
    defaultProvider,
    codexAccounts,
    codexDefaultAccountId,
    geminiAccounts,
    geminiDefaultAccountId,
    accounts,
    defaultAccountId,
    resolveHomeProjectName
  ])

  // Projects the start box can offer: only ones already opened in this app (never a disk
  // scan), newest-session-first — the same recency HomeRecent uses.
  //
  // Deduped by projectKey, not by the raw path: the same folder is recorded under more
  // than one spelling, and a picker offering `claude-gui` and `Claude-GUI` as two choices
  // would be asking the user to pick between a folder and itself.
  const homeStartOptions = useMemo<HomeStartOptions>(() => {
    const seen = new Set<string>()
    const projects: { path: string; name: string }[] = []
    for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!s.projectPath) continue
      const key = projectKey(s.projectPath, s.wslDistro, homeKeyCtx)
      if (seen.has(key)) continue
      seen.add(key)
      projects.push({ path: s.projectPath, name: resolveHomeProjectName(s.projectPath, s.wslDistro) })
    }
    // Every provider, not just the default one: the start box is where a run is chosen,
    // and a chat started here goes through the same engine lookup as any other, so
    // limiting it to Claude was a restriction with nothing behind it. The pill keeps
    // model and account on the same provider — see HomeView's `pickModel`.
    return {
      projects,
      models: models.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
      accounts: [
        ...accounts.map((a) => ({ id: a.id, name: a.name, provider: 'claude' as const })),
        ...codexAccounts.filter((a) => a.loggedIn).map((a) => ({ id: a.id, name: a.name, provider: 'codex' as const })),
        ...geminiAccounts.filter((a) => a.loggedIn).map((a) => ({ id: a.id, name: a.name, provider: 'gemini' as const }))
      ]
    }
  }, [sessions, homeKeyCtx, resolveHomeProjectName, models, accounts, codexAccounts, geminiAccounts])

  const onHomePickFolder = useCallback(async () => {
    return window.electronAPI.openFolder()
  }, [])

  const onHomeStart = useCallback(
    (prompt: string, choice: HomeStartChoice) => {
      startOverlayPrompt({
        prompt,
        projectPath: choice.projectPath,
        modelId: choice.modelId,
        accountId: choice.accountId
      })
    },
    [startOverlayPrompt]
  )

  // Review an approval — the one kind of row Home's attention list holds.
  const onHomeAct = (id: string) => {
    const req = approvalQueue.find((r) => r.approvalId === id)
    if (req) {
      setActiveId(req.appSessionId)
      setView('chat')
    }
  }

  // Open server (Remote/WSL) sessions, kept alive in a background layer (rendered below,
  // outside any `view ===` guard) so switching to Chat/Servers/etc. never tears down a live
  // terminal or SFTP connection — only closing a tab does. A target can have several
  // sessions open at once; the strip groups them per target.
  const [serverSessions, setServerSessions] = useState<ServerSession[]>([])
  const [activeServerSessionId, setActiveServerSessionId] = useState<string | null>(null)
  /** Per-session connection state, reported up by RemoteSessionView. Drives the Remote &
   *  WSL list's status dots: an open tab proves nothing on its own, since the connection
   *  may have been refused. */
  const [serverSessionStatus, setServerSessionStatus] = useState<
    Record<string, 'connecting' | 'connected' | 'error'>
  >({})
  /** Highest session number handed out per group so far — see openServerSession. */
  const seqCounterRef = useRef<Record<string, number>>({})

  /**
   * `newSession: false` (the default) focuses the target's most recent existing session and
   * only opens one if it has none — that's what clicking a row in the Remote & WSL list
   * does. The explicit Connect button passes true to always add another.
   */
  const openServerSession = (target: RemoteTarget, newSession = false) => {
    const groupKey = serverGroupKey(target)
    const existing = serverSessions.filter((s) => s.groupKey === groupKey)
    if (!newSession && existing.length > 0) {
      setActiveServerSessionId(existing[existing.length - 1].id)
      setView('remote-session')
      return
    }
    // A monotonic per-group counter in a ref, not max(existing.seq) + 1: two Connect
    // presses in one React batch would both read the same `serverSessions` and mint the
    // same id, and reusing a closed session's number would renumber the strip under the
    // user. The ref advances synchronously, so neither can happen.
    const seq = (seqCounterRef.current[groupKey] ?? 0) + 1
    seqCounterRef.current[groupKey] = seq
    const id = `${groupKey}#${seq}`
    const title = target.kind === 'ssh' ? target.host.name : target.distro
    setServerSessions((prev) => [...prev, { id, groupKey, target, title, seq }])
    setActiveServerSessionId(id)
    setView('remote-session')
  }
  const openRemoteSession = (host: SshHostPublic, newSession?: boolean) =>
    openServerSession({ kind: 'ssh', host }, newSession)
  const openWslSession = (distro: string, newSession?: boolean) =>
    openServerSession({ kind: 'wsl', distro }, newSession)

  // Close a session tab — the ONLY thing that tears it down (unmounting RemoteSessionView
  // triggers its remoteShellKill/terminalKill cleanups). Falls back to an adjacent remaining
  // tab, or back to the Remote & WSL list if none are left.
  const closeServerSession = (id: string) => {
    const idx = serverSessions.findIndex((s) => s.id === id)
    if (idx === -1) return
    const closed = serverSessions[idx]
    const next = serverSessions.filter((s) => s.id !== id)

    // The ssh2 connection is per HOST and shared by every session on it (SFTP and each
    // shell channel ride the same client — see getRemoteClient in main/sftp.ts), so it can
    // only be dropped once the last session for that host is gone. This is why the
    // disconnect lives here and not in RemoteSessionView's unmount cleanup, which has no
    // way of knowing whether a sibling session is still using the connection.
    if (closed.target.kind === 'ssh') {
      const hostId = closed.target.host.id
      const stillUsed = next.some((s) => s.target.kind === 'ssh' && s.target.host.id === hostId)
      if (!stillUsed) window.electronAPI.sftpDisconnect(hostId)
    }

    setServerSessions(next)
    setServerSessionStatus((prev) => {
      const { [id]: _gone, ...rest } = prev
      return rest
    })
    if (activeServerSessionId === id) {
      const fallback = next[idx] ?? next[idx - 1] ?? null
      setActiveServerSessionId(fallback ? fallback.id : null)
      // Nothing left to show → leave the (now empty) session layer. Only when we're
      // actually in it: the same close button also sits in the inline strip on the
      // Servers screens, and closing a tab from there shouldn't yank the user off
      // whichever Servers screen they're on.
      if (!fallback && view === 'remote-session') setView('remote')
    }
  }

  /** The group header's + button — another session on a target that already has one. */
  const addToTabGroup = (groupKey: string) => {
    const target = serverSessions.find((s) => s.groupKey === groupKey)?.target
    if (target) openServerSession(target, true)
  }


  // "New chat on host": a terminal chat whose CLI runs on that host over SSH.
  // TODO(B3b): `startTerminal({ remoteHostId })`.
  const connectRemote = (host: SshHostPublic) => {
    const s = newSession(host.remotePath, defaultModel, defaultAccountId)
    s.name = `${host.name} (remote)`
    s.remoteHostId = host.id
    s.remoteHostName = host.name
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
  }

  // "Ops chat" on an SSH host card: the Ops workspace for the most recent runbook that
  // names this host. None does → the most recent runbook anyway. The ops chat it used to
  // open ran on the SDK; ops now lives in the workspace's gated terminal only (H1).
  const connectOps = async (host: SshHostPublic) => {
    const recents = readRecentRunbooks()
    if (recents.length === 0) return
    let runbookPath = recents[0]
    for (const dir of recents) {
      try {
        const info = await window.electronAPI.opsLoadRunbook(dir)
        if (info.ok && info.hosts.some((h) => h.id === host.id)) {
          runbookPath = dir
          break
        }
      } catch {
        /* an unreadable runbook just doesn't match */
      }
    }
    openOpsWorkspace(runbookPath)
  }

  // Servers → Ops. The workspace is an extra of the Servers group, like a Remote/WSL
  // session; which runbook it shows lives here so the view itself stays a plain string.
  const [opsWorkspace, setOpsWorkspace] = useState<{ runbookPath: string } | null>(null)
  /** The ops terminal the workspace has on screen in Terminal mode — a plan for its run is
   *  reviewed in the workspace's side column, so the drawer steps aside for it. */
  const [opsTerminalVisibleId, setOpsTerminalVisibleId] = useState<string | null>(null)
  const openOpsWorkspace = (runbookPath: string) => {
    setOpsWorkspace({ runbookPath })
    setView('ops-workspace')
  }
  // The workspace's Chat mode: this runbook's ops chat (Claude model, runbookPath set), or
  // the newest existing one for the same runbook. Nothing renders it any more (see
  // renderChat below). TODO(B3b): goes with OpsWorkspace's chat mode.
  const openOpsChat = (runbookPath: string, name: string): string => {
    const existing = sessions.find((s) => s.runbookPath === runbookPath)
    if (existing) {
      setActiveId(existing.id)
      return existing.id
    }
    const model =
      provOf(models, defaultModel) === 'claude' ? defaultModel : models.find((m) => m.provider === 'claude')?.id ?? defaultModel
    const s = newSession(undefined, model, defaultAccountId)
    s.name = `${name} (ops)`
    s.runbookPath = runbookPath
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    return s.id
  }

  // TODO(B3b): `startTerminal({ wslDistro })`.
  const connectWsl = (distro: string, cwd?: string) => {
    const s = newSession(cwd, defaultModel, defaultAccountId)
    s.name = `${distro} (WSL)`
    s.wslDistro = distro
    s.remoteHostName = `WSL · ${distro}`
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
  }

  // A planner task opens a terminal in the active chat's folder with the task typed in.
  // One line on purpose: a raw newline written into the pty is Enter, not part of the
  // prompt (ConPTY does not bracket it).
  const runPlannerTask = (task: PlannerTask) => {
    const parts: string[] = [`Help me with this planned task: "${task.title}".`]
    if (task.notes) parts.push(`Notes: ${task.notes.replace(/\s*\n\s*/g, ' ')}`)
    if (task.effort) parts.push(`Effort level: ${task.effort}.`)
    if (typeof task.day === 'number') {
      const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      parts.push(`Scheduled for: ${dayNames[task.day]}.`)
    }
    parts.push('Please start working on it.')
    startOverlayPrompt({
      prompt: parts.join(' '),
      name: task.title,
      projectPath: activeSession?.projectPath,
      modelId: activeSession?.model || defaultModel,
      accountId: activeSession?.accountId ?? defaultAccountId
    })
  }

  // Sprint standup → "Discuss" opens a terminal with the day's standup + board and the
  // opener typed in, flattened onto one line (see runPlannerTask for why).
  // TODO(B3b): write `context` to userData/prompts/<sessionId>.md (main IPC) and type
  // "Read <path>, then: <opener>" instead; open with no folder rather than the active one.
  const startStandupChat = useCallback(
    (context: string, opener: string, name: string) => {
      const flat = context.replace(/\s*\n\s*/g, ' ').trim()
      startOverlayPrompt({ prompt: `${opener} Context: ${flat}`, name })
    },
    [startOverlayPrompt]
  )

  const handleSetDefaultModel = async (modelId: string) => {
    setDefaultModel(modelId)
    await window.electronAPI.setDefaultModel(modelId)
  }

  const updateUi = async (patch: UiPrefsPatch) => {
    const next = await window.electronAPI.setUiPrefs(patch)
    setUi(next)
    applyUi(next)
  }

  // Global shortcuts: Ctrl/Cmd-K toggles the command palette, Ctrl/Cmd-N starts a new
  // chat, Ctrl/Cmd-/ shows the shortcut sheet, Ctrl/Cmd-1..3 focuses a pane by position,
  // Ctrl/Cmd-Shift-W closes the focused pane. Anything added here belongs in
  // lib/shortcuts.ts too — that is what the sheet reads, and it cannot tell that a key
  // has moved. None of these filter by event target (matching Ctrl-K/N above) — none of them
  // type a literal character, so stealing them from a focused input/textarea/xterm is
  // harmless, and bubbling order means xterm's own handler (on the terminal element)
  // already ran by the time this window-level listener sees the event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createSessionRef.current()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        // Toggles, like the palette: the same key that asked for the sheet puts it away.
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['1', '2', '3'].includes(e.key)) {
        // Focus the 1st/2nd/3rd pane by position. A no-op past the end of `panes`
        // (e.g. Ctrl+3 with a single pane open) — nothing to focus, so don't preventDefault
        // and let the key fall through to whatever's typing it.
        const pane = panesRef.current[Number(e.key) - 1]
        if (pane) {
          e.preventDefault()
          setFocus(pane.sessionId)
        }
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
        // Close the focused pane only — just removes it from the layout, same as the
        // sidebar's close affordance; the session/chat itself is untouched. Closing the
        // last remaining pane correctly lands back on the welcome pane (closePane's job).
        if (activeIdRef.current) {
          e.preventDefault()
          closePane(activeIdRef.current)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Track window maximize state for the custom title bar (icon + corner rounding).
  useEffect(() => {
    window.electronAPI.windowIsMaximized().then(setMaximized)
    return window.electronAPI.onWindowMaximized(setMaximized)
  }, [])

  const paletteItems: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = []
    items.push({ id: 'new', title: 'New terminal', group: 'Actions', subtitle: '⌘N', run: createSession })
    items.push({
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      subtitle: modLabel('/'),
      group: 'Actions',
      run: () => setShortcutsOpen(true)
    })
    const views: { v: View; label: string }[] = [
      { v: 'chat', label: 'Chat' },
      { v: 'projects', label: 'Projects' },
      { v: 'planner', label: 'Planner' },
      { v: 'usage', label: 'Usage' },
      { v: 'mcp', label: 'MCP' },
      { v: 'remote', label: 'Remote & WSL' },
      { v: 'ops', label: 'Ops' }
    ]
    for (const { v, label } of views) items.push({ id: `view:${v}`, title: `Go to ${label}`, group: 'Views', run: () => goToView(v) })
    items.push({ id: 'settings', title: 'Open Settings', group: 'Views', run: () => setView('settings') })
    items.push({ id: 'accounts', title: 'Manage Claude accounts', group: 'Views', run: () => setAccountsOpen(true) })
    for (const s of sessions) {
      items.push({
        id: `sess:${s.id}`,
        title: s.name || 'New chat',
        subtitle: s.remoteHostName ?? s.projectPath?.split(/[\\/]/).filter(Boolean).pop(),
        group: 'Sessions',
        run: () => {
          setActiveId(s.id)
          setView('chat')
        }
      })
    }
    for (const a of accounts) {
      items.push({
        id: `account:${a.id}`,
        title: `Switch default account: ${a.name}`,
        subtitle: a.loggedIn ? a.email ?? 'new chats' : 'not logged in',
        group: 'Switch account',
        run: () => switchDefaultAccount(a.id)
      })
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, accounts])

  // What the Remote & WSL list's SSH dots are allowed to claim. A host counts as reachable
  // only once one of its sessions has actually connected; a host whose sessions have all
  // failed (ECONNREFUSED, auth, …) is reported as failing, so the dot can go red instead of
  // sitting green next to a visible "Could not connect" banner.
  const sshHostStatuses = serverSessions.flatMap((s) =>
    s.target.kind === 'ssh' ? [{ hostId: s.target.host.id, status: serverSessionStatus[s.id] }] : []
  )
  const connectedSshHosts = [
    ...new Set(sshHostStatuses.filter((h) => h.status === 'connected').map((h) => h.hostId))
  ]
  const failedSshHosts = [
    ...new Set(
      sshHostStatuses
        .filter((h) => h.status === 'error' && !connectedSshHosts.includes(h.hostId))
        .map((h) => h.hostId)
    )
  ]

  // The group the current view belongs to, if any — drives the sub-nav. Uses
  // groupOwnsView (not `members`) so a group's extra views — a Remote/WSL session under
  // Servers — count as in-group too, matching the rail's own highlight.
  const activeGroup = VIEW_GROUPS.find((g) => groupOwnsView(g, view))

  // ── Dragging a conversation from the sidebar onto the panes ─────────────────
  // Which conversation is being dragged, so PaneGrid can say what's going to happen BEFORE
  // the drop: during the drag `dataTransfer` only lets you read the *types*, never the id, so
  // whoever knows the session is whoever started dragging it.
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)

  // Applies the plan PaneGrid has already worked out (see lib/pane-drop.ts). Entirely composed
  // from the functions in lib/panes.ts — no model decision gets made here.
  const applyDrop = (plan: DropPlan, sessionId: string) => {
    // The drag is over, and this can't wait for the source's dragend: a pill in the pending bar
    // is unmounted by this very drop (the chat is now on screen, so it leaves the bar), and a
    // detached element never fires dragend — the grid then kept pointing at the new pane as
    // "Already open".
    setDraggingSessionId(null)
    if (plan.type === 'none') return
    if (plan.type === 'focus') {
      // Already in another pane: move focus, never duplicate (two terminals on one pty).
      setFocus(plan.sessionId)
      return
    }
    const ids = panes.map((p) => p.sessionId)
    if (plan.type === 'replace') {
      // openInFocused swaps the session of the *focused* pane, and the pane it was dropped
      // on may not be that one — focusing first is what turns "open here" into "open there".
      const target = ids[plan.index]
      if (target) setFocus(target)
      openInFocused(sessionId)
      return
    }
    // Inserting at a position, with the layout the gesture chose. This used to be a
    // close-the-tail-and-reopen-it dance, because the lib could only append at the end;
    // `insertPane` does it in one transition, and the property that dance was protecting is
    // now PaneGrid's: it keys panes by sessionId and places them by explicit grid lines, so a
    // pane that moves position is reconciled into its new slot rather than unmounted and
    // remounted (a remount would restart its xterm for nothing).
    insertPane(sessionId, plan.index, plan.layout)
  }

  // The welcome pane also accepts the drop, and has children (title, buttons) that
  // fire dragleave on every pass over them — hence the counter, same as in Chat and PaneGrid.
  const [welcomeDropOver, setWelcomeDropOver] = useState(false)
  const welcomeDragDepth = useRef(0)

  // An ops plan at the head of the queue is always the review sheet, never the modal or an
  // inline card: embedded in the Ops workspace when it belongs to the terminal on screen
  // there, else the drawer.
  const headApproval = approvalQueue[0]
  const headIsPlan = headApproval?.ops?.tool === 'plan'
  const workspacePlan =
    headIsPlan && view === 'ops-workspace' && headApproval.appSessionId === opsTerminalVisibleId ? headApproval : undefined
  const stopHeadApproval = headApproval?.ops ? () => respondApprovalStopById(headApproval.approvalId) : undefined

  // Everything a chat pane needs from the App, shared by every pane. A plain object,
  // not a useMemo: most of the actions below are plain consts rebuilt on every render,
  // so memoizing would compare thirty-odd references to never once skip the rebuild.
  // Omitting deps to buy a stable identity would be worse than useless — a stale api
  // binds a pane's actions to a session it no longer shows. If Chat is ever wrapped in
  // React.memo, make the actions stable first; only then does memoizing this pay.
  const paneApi: SessionPaneApi = {
    sessions,
    models,
    defaultModel,
    terminalPrompts,
    newChatNonces,
    saveError,
    defaultAccountId,
    codexDefaultAccountId,
    geminiDefaultAccountId,
    patchSession,
    closeChatTerminal,
    clearTerminalPrompt
  }

  return (
    <div className={`app-shell ${maximized ? 'maximized' : ''}`}>
      {!maximized && <ResizeHandles />}
      <TitleBar maximized={maximized} />
      <PendingRuns
        runs={pendingRuns}
        onOpen={(id) => {
          setActiveId(id)
          setView('chat')
        }}
        onDismiss={dismissPending}
        onDrag={setDraggingSessionId}
      />
      <div className="app">
        <NavRail
          view={view}
          onChange={goToView}
          onSettings={() => setView('settings')}
          onChangelog={() => setChangelogOpen(true)}
          onShortcuts={() => setShortcutsOpen(true)}
          serverSessionCount={serverSessions.length}
          chatRunningCount={displayRunningIds.size}
          attentionCount={approvalQueue.length}
          chatListHidden={sidebarCollapsed}
        />

      {view === 'chat' && (
        <>
          {sidebarCollapsed && (
            /* The way back, where the list used to be: a small tab growing out of the rail's
               edge. Pressing Chat in the rail does the same, but nothing on screen said so. */
            <button
              className="sidebar-expand-tab"
              onClick={toggleSidebar}
              title="Show the chat list"
              aria-label="Show the chat list"
            >
              {/* The collapse button's icon, mirrored: the arrow points back out. */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <line x1="9" y1="4" x2="9" y2="20" />
                <polyline points="13 9 16 12 13 15" />
              </svg>
            </button>
          )}
          {!sidebarCollapsed && (
            <Sidebar
              onCollapse={toggleSidebar}
              sessions={sessions}
              activeId={activeId}
              runningIds={displayRunningIds}
              attentionIds={attentionIds}
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              onSelectSession={setActiveId}
              onSessionDrag={setDraggingSessionId}
              onNewSession={createSession}
              onDeleteSession={deleteSession}
              onRenameSession={renameSessionById}
              projectPath={activeSession?.projectPath}
              onSetProject={setSessionProject}
              onOpenFile={setOpenFilePath}
              openFilePath={openFilePath ?? undefined}
              onOpenSettings={() => setView('settings')}
              auth={auth}
              accounts={accounts}
              models={models}
              selectedProvider={activeChatProvider}
              selectedAccountId={activeChatAccountId}
              codexAccounts={codexAccounts}
              geminiAccounts={geminiAccounts}
              codexDefaultAccountId={codexDefaultAccountId}
              geminiDefaultAccountId={geminiDefaultAccountId}
              onPickAccount={pickAccount}
              onManageAccounts={() => setAccountsOpen(true)}
              accountUsage={accountUsage}
              codexAccountUsage={codexAccountUsage}
              onExploreProjects={() => setView('projects')}
              defaultModel={defaultModel}
              defaultAccountId={defaultAccountId}
            />
          )}
          <div className="main-area">
            {!activeSession ? (
              /* No chat open yet: a terminal only appears once the user explicitly starts
                 or picks one. */
              <div
                className={`welcome-pane ${welcomeDropOver ? 'pane-drop-over' : ''}`}
                /* No panes means no zones: the only possible drop is "open this conversation",
                   so the whole area lights up and the gesture falls through to the usual openInFocused. */
                onDragEnter={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
                  e.preventDefault()
                  welcomeDragDepth.current += 1
                  setWelcomeDropOver(true)
                }}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDragLeave={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
                  welcomeDragDepth.current = Math.max(0, welcomeDragDepth.current - 1)
                  if (welcomeDragDepth.current === 0) setWelcomeDropOver(false)
                }}
                onDrop={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(SESSION_DRAG_TYPE)) return
                  e.preventDefault()
                  welcomeDragDepth.current = 0
                  setWelcomeDropOver(false)
                  setDraggingSessionId(null) // see applyDrop
                  const id = e.dataTransfer.getData(SESSION_DRAG_TYPE)
                  if (id) openInFocused(id)
                }}
              >
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.5" />
                  <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <h2>How can I help?</h2>
                <p>Start a new terminal, or pick a chat from the sidebar.</p>
                <div className="welcome-actions">
                  <button className="btn-primary" onClick={createSession}>
                    New terminal
                  </button>
                </div>
              </div>
            ) : (
            <PaneGrid
              panes={panes}
              layout={layout}
              focused={focused}
              sizes={paneSizes}
              api={paneApi}
              onFocus={setFocus}
              onClose={closePane}
              onSetSizes={setSizes}
              draggingSessionId={draggingSessionId}
              onDropSession={applyDrop}
            />
            )}
          </div>
        </>
      )}

      {view === 'home' && (
        <Suspense fallback={<ViewLoading />}>
          <HomeView
            attention={homeAttention}
            running={homeRunning}
            repos={homeRepos}
            recentProjects={homeRecentProjects}
            recent={homeRecent}
            start={homeStart}
            startOptions={homeStartOptions}
            onAct={onHomeAct}
            onStart={onHomeStart}
            onPickFolder={onHomePickFolder}
            onOpenSession={(id) => {
              setActiveId(id)
              setView('chat')
            }}
            onOpenRepo={(key) => {
              setProjectFocus({ key, at: Date.now() })
              setView('projects')
            }}
          />
        </Suspense>
      )}
      {view === 'projects' && (
        <Suspense fallback={<ViewLoading />}>
          <ProjectsView onResume={resumeCCSession} target={ccTarget} focus={projectFocus} />
        </Suspense>
      )}
      {view === 'usage' && (
        <Suspense fallback={<ViewLoading />}>
          <UsageView />
        </Suspense>
      )}
      {/* Owns the whole content area, its own nav column standing in for the chat
          Sidebar. The icon rail stays put; its bottom Settings entry lights up. */}
      {view === 'settings' && (
        <Suspense fallback={<ViewLoading />}>
          <SettingsView
            models={models}
            defaultModel={defaultModel}
            onSetDefaultModel={handleSetDefaultModel}
            ui={ui}
            onSetUi={updateUi}
            onManageAccounts={() => setAccountsOpen(true)}
            onBack={() => setView(preSettingsView.current)}
          />
        </Suspense>
      )}

      {/* The group shell owns the content area for a group's *member* views. Excluded for
          'remote-session' (an extra of the Servers group, so activeGroup is set there too)
          because the always-mounted server-sessions layer below is a sibling with its own
          `flex: 1` — rendering both at once would split the content area between them.
          The session layer keeps the whole area to itself exactly as before; the way back
          out is its Back button or the Servers rail entry (see NavRail's onClickGroup). */}
      {/* The Ops workspace takes the whole area the same way, once it has a runbook; a deep
          link to it without one falls back to the Ops list inside the shell. */}
      {activeGroup && view !== 'remote-session' && !(view === 'ops-workspace' && opsWorkspace) && (
        <div className="view-with-subnav">
          <div className="view-subnav">
            <div className="view-subnav-group">
              {activeGroup.members.map((m) => (
                <button
                  key={m}
                  className={`view-subnav-btn ${view === m ? 'active' : ''}`}
                  onClick={() => setView(m)}
                >
                  {MEMBER_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          {/* Open Remote/WSL sessions, surfaced on the Servers screens so they're
              reachable without remembering they exist. Selecting one here has to jump
              into the session view as well as focus its pane. */}
          {activeGroup.key === 'servers' && serverSessions.length > 0 && (
            <ServerTabs
              inline
              sessions={serverSessions}
              /* Always null: this copy of the strip only renders on a Servers screen, and
                 there no tab is "current" — the session is open, but you aren't looking at
                 it. Passing activeServerSessionId made the list read as though you were
                 still inside that session. */
              activeId={null}
              onSelect={(id) => {
                setActiveServerSessionId(id)
                setView('remote-session')
              }}
              onClose={closeServerSession}
              onAddToGroup={addToTabGroup}
            />
          )}
          <Suspense fallback={<ViewLoading />}>
            {view === 'planner' && (
              <PlannerView
                accounts={accounts}
                models={models}
                defaultModel={defaultModel}
                defaultAccountId={defaultAccountId}
                codexAccounts={codexAccounts}
                geminiAccounts={geminiAccounts}
                codexDefaultAccountId={codexDefaultAccountId}
                geminiDefaultAccountId={geminiDefaultAccountId}
                showWeek={ui?.showWeekPlanner ?? false}
                onRunTask={runPlannerTask}
                onStandupChat={startStandupChat}
              />
            )}
            {view === 'mcp' && <McpView />}
            {(view === 'ops' || view === 'ops-workspace') && <OpsView onOpen={openOpsWorkspace} />}
            {view === 'remote' && (
              <RemoteView
                onConnect={connectRemote}
                onOpsChat={connectOps}
                onConnectWsl={connectWsl}
                onOpenSession={openRemoteSession}
                onOpenWslSession={openWslSession}
                openWslSessions={serverSessions.flatMap((s) => (s.target.kind === 'wsl' ? [s.target.distro] : []))}
                openSshSessions={connectedSshHosts}
                failedSshSessions={failedSshHosts}
              />
            )}
          </Suspense>
        </div>
      )}

      {view === 'ops-workspace' && opsWorkspace && (
        <Suspense fallback={<ViewLoading />}>
          <OpsWorkspace
            key={opsWorkspace.runbookPath}
            runbookPath={opsWorkspace.runbookPath}
            onBack={() => setView('ops')}
            openChat={openOpsChat}
            /* The ops chat ran on the SDK composer, which is gone. Rendering the chat pane
               here would now start an ungated CLI with no runbook, so the mode only points
               back at the terminal. TODO(B3b): OpsWorkspace loses its chat mode. */
            renderChat={() => (
              <div className="ops-ws-state">
                The ops chat has been retired. Switch to Terminal to run this runbook.
              </div>
            )}
            onChatVisible={() => {}}
            onTerminalVisible={setOpsTerminalVisibleId}
            pendingPlan={workspacePlan}
            onPlanDecide={respondApproval}
            onPlanStop={stopHeadApproval}
          />
        </Suspense>
      )}

      {/* Always-mounted regardless of `view` (only the CSS display toggles) — this is what
          keeps a session's terminal + SFTP connection alive while the user is elsewhere in
          the app. A session is only ever unmounted (and thus disconnected) by closeServerSession
          removing it from serverSessions; navigating away just hides the layer. */}
      {serverSessions.length > 0 && (
        <div className="server-sessions-layer" style={{ display: view === 'remote-session' ? 'flex' : 'none' }}>
          {/* Topmost strip here, so it keeps the drag region (no `inline`). Selecting a
              tab only swaps the visible pane — we're already in the session view. */}
          <ServerTabs
            sessions={serverSessions}
            activeId={activeServerSessionId}
            onSelect={setActiveServerSessionId}
            onClose={closeServerSession}
            onAddToGroup={addToTabGroup}
          />
          <Suspense fallback={<ViewLoading />}>
            {serverSessions.map((s) => (
              <div
                key={s.id}
                className="server-session-pane"
                style={{ display: s.id === activeServerSessionId ? 'flex' : 'none' }}
              >
                <RemoteSessionView
                  target={s.target}
                  seq={s.seq}
                  active={view === 'remote-session' && s.id === activeServerSessionId}
                  onBack={() => setView('remote')}
                  onStatusChange={(st) =>
                    setServerSessionStatus((prev) => (prev[s.id] === st ? prev : { ...prev, [s.id]: st }))
                  }
                />
              </div>
            ))}
          </Suspense>
        </div>
      )}

      {ui && !ui.onboarded && (
        <OnboardingModal
          onFinish={async () => {
            await updateUi({ onboarded: true })
            await refreshAuth()
          }}
        />
      )}
      {secretQueue.length > 0 && (
        <SecretPrompt
          key={secretQueue[0].requestId}
          request={secretQueue[0]}
          onSubmit={(value) => answerSecret(secretQueue[0].requestId, value)}
        />
      )}
      {/* While a password is being asked, the approval modal waits: its window-level Esc would
          otherwise deny the call behind the prompt. */}
      {secretQueue.length === 0 && headIsPlan && !workspacePlan && (
        <PlanReviewSheet
          key={headApproval.approvalId}
          request={headApproval}
          onDecide={respondApproval}
          onStop={stopHeadApproval}
        />
      )}
      {secretQueue.length === 0 && !headIsPlan && approvalQueue.length > 0 && (
        <ApprovalModal
          request={approvalQueue[0]}
          onDecide={respondApproval}
          onStop={approvalQueue[0]?.ops ? () => respondApprovalStopById(approvalQueue[0].approvalId) : undefined}
        />
      )}
      {openFilePath && (
        <FileEditor
          filePath={openFilePath}
          onClose={() => setOpenFilePath(null)}
          read={readLocalFile}
          write={writeLocalFile}
        />
      )}
      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {/* Right-click for the app's own fields. Mounted once, listens on window, and
          steps aside for anything a closer handler already answered. */}
      <TextContextMenu />
      {accountsOpen && (
        <AccountsModal
          onClose={() => setAccountsOpen(false)}
          onChanged={() => {
            refreshAccounts()
            refreshProviderAccounts()
          }}
        />
      )}
      {changelogOpen && <ChangelogModal onClose={() => setChangelogOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      </div>
    </div>
  )
}
