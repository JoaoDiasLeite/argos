import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import {
  Session,
  Message,
  ToolCall,
  AgentEvent,
  AgentDone,
  AgentError,
  AuthStatus,
  TermLine,
  ModelInfo,
  CCSessionMeta,
  AgentDef,
  ApprovalRequest,
  CCAccountStatus,
  ProviderAccountStatus,
  ProviderId,
  PlannerTask,
  UsageLimits,
  PlanUsageReport,
  ScheduledRun,
  CcSessionTarget,
  LiveSession
} from './types'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import ResizeHandles from './components/ResizeHandles'
import ChatPane from './components/ChatPane'
import { SessionPaneApi } from './hooks/useSessionPane'
import TerminalPanel from './components/TerminalPanel'
import NavRail, { ALL_VIEWS, View, VIEW_GROUPS, groupOwnsView } from './components/NavRail'
import ServerTabs from './components/ServerTabs'
import ClaudeMdModal from './components/ClaudeMdModal'
import ApprovalModal from './components/ApprovalModal'
import PendingRuns, { PendingRun } from './components/PendingRuns'
import FileEditor from './components/FileEditor'
import { readLocalFile, writeLocalFile } from './lib/local-file-io'
import { installEditingKeys } from './lib/clipboard-paste'
import TextContextMenu from './components/TextContextMenu'
import { applyTheme, zoomFor } from './lib/theme'
import CheckpointsModal from './components/CheckpointsModal'
import GitModal from './components/GitModal'
import CommandPalette, { CommandItem } from './components/CommandPalette'
import OnboardingModal from './components/OnboardingModal'
import AccountsModal from './components/AccountsModal'
import ChangelogModal from './components/ChangelogModal'
import { UiPrefs, UiPrefsPatch } from './types'
import { sessionToReplaySeed } from './lib/markdown-export'
import { provOf, acctOf, originOf, nextChatAfterClose, AccountDefaults } from './lib/account-scope'
import type {
  HomeAttention,
  HomeRunning,
  HomeRepo,
  HomeProject,
  HomePlan,
  HomeSpend,
  HomeRoutine,
  HomeRecent,
  HomeStart,
  HomeStartChoice,
  HomeStartOptions
} from './views/HomeView'
import { projectKey, canonicalProjectPath, buildPosixDistroMap, ProjectKeyContext } from './lib/project-key'
import { projectDisplayName, projectDisplayNames, RepoName } from './lib/project-name'
import { cadenceSummary } from './lib/cadence'
import { chatTerminalId } from './lib/terminal-id'
import { usePanes } from './hooks/usePanes'
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
const LiveView = lazy(() => import('./views/LiveView'))
const AgentsView = lazy(() => import('./views/AgentsView'))
const RoomsView = lazy(() => import('./views/RoomsView'))
const UsageView = lazy(() => import('./views/UsageView'))
const McpView = lazy(() => import('./views/McpView'))
const PlannerView = lazy(() => import('./views/PlannerView'))
const RemoteView = lazy(() => import('./views/RemoteView'))
const RemoteSessionView = lazy(() => import('./views/RemoteSessionView'))
const ScheduledView = lazy(() => import('./views/ScheduledView'))
const SettingsView = lazy(() => import('./views/SettingsView'))
const HomeView = lazy(() => import('./views/HomeView'))

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
  return {
    id: generateId(),
    name: 'New chat',
    messages: [],
    projectPath,
    model,
    accountId,
    // MCP off by default: loading every configured MCP server injects all their tool
    // schemas into every turn's context. Toggle it on per-chat when a chat needs them.
    useMcp: false,
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
  agents: 'Agents',
  rooms: 'Rooms',
  planner: 'Planner',
  scheduled: 'Routines',
  mcp: 'MCP',
  remote: 'Remote & WSL'
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
  const { panes, focused, openInFocused, closePane, restore } = usePanes()
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
  const [compacting, setCompacting] = useState(false)
  // Per-session run state: each id in the set has an agent run in flight. The main
  // process already routes concurrent runs by appSessionId, so the renderer only
  // needs to track which sessions are busy (no global mutex). Always update
  // immutably via `new Set(prev)`.
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [terminalLines, setTerminalLines] = useState<TermLine[]>([])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [claudeMdFor, setClaudeMdFor] = useState<string | null>(null)
  const [checkpointsFor, setCheckpointsFor] = useState<string | null>(null)
  const [gitFor, setGitFor] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'sessions'>('sessions')
  // File opened from the sidebar's Files tab, shown in the FileEditor modal.
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  // Chats the user hid from the pending-requests bar; cleared per id when that run ends.
  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(new Set())
  // Bumped every time we deliberately land on a new chat, so Chat can bring the composer
  // forward even when the "open new chats in" pref is Terminal (see Chat's effect).
  // Per session, not one global counter: with several panes on screen a global bump would
  // reach every pane at once and they would fight over the caret. The values come from a
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
  // Chat or terminal, for the whole app. Read in one place so every surface that has to
  // change shape (the chat pane, the sidebar's actions, Home's start box, approvals)
  // agrees on it — see ui-prefs-pure.ts for what the two modes mean.
  const workMode = ui?.workMode ?? 'chat'
  // Prompts waiting to be typed into a chat's terminal, by session id. In terminal mode
  // "start this" cannot post a message into a transcript that does not exist, so the text
  // is parked here and ChatTerminal types it into the CLI once that CLI is up. Cleared as
  // soon as it is sent: a restart must not re-run the task.
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
  const [limits, setLimits] = useState<UsageLimits>({ hourUsd: 0, sessionUsd: 0, weekUsd: 0 })
  // Tracks which budget windows are currently over-limit, to avoid re-notifying on each turn.
  const overLimitRef = useRef<{ hour: boolean; session: boolean; week: boolean }>({ hour: false, session: false, week: false })
  // Inline banner: null = no banner, or a message string.
  const [budgetBanners, setBudgetBanners] = useState<string[]>([])
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
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const limitsRef = useRef(limits)
  limitsRef.current = limits
  // Mirror of runningIds for listener callbacks registered once (same pattern as
  // sessionsRef/activeIdRef). Kept in sync on every render.
  const runningIdsRef = useRef(runningIds)
  runningIdsRef.current = runningIds

  // Add/remove a session id from the running set (immutable Set updates).
  const startRun = useCallback((sid: string) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, runState: 'running' } : s))
    setRunningIds((prev) => {
      const next = new Set(prev)
      next.add(sid)
      return next
    })
  }, [])
  const endRun = useCallback((sid: string) => {
    setSessions((prev) => prev.map((s) => s.id === sid ? { ...s, runState: 'idle' } : s))
    setRunningIds((prev) => {
      if (!prev.has(sid)) return prev
      const next = new Set(prev)
      next.delete(sid)
      return next
    })
    // Dismissing a chat from the pending bar only hides that run. Forgetting it here means
    // the chat's NEXT request shows up again rather than being silently suppressed forever.
    setDismissedRunIds((prev) => {
      if (!prev.has(sid)) return prev
      const next = new Set(prev)
      next.delete(sid)
      return next
    })
  }, [])
  // Latest createSession, so the global ⌘N handler never calls a stale closure.
  // An optional projectPath overrides the inherited folder (used by --folder launches).
  const createSessionRef = useRef<(projectPath?: string) => void>(() => {})

  // Files Claude has edited/written per session — used for checkpoint snapshots.
  const modifiedFilesRef = useRef<Map<string, Set<string>>>(new Map())
  const trackFile = (sessionId: string, filePath: string) => {
    if (!filePath) return
    let set = modifiedFilesRef.current.get(sessionId)
    if (!set) {
      set = new Set()
      modifiedFilesRef.current.set(sessionId, set)
    }
    set.add(filePath)
  }
  const trackedFiles = (sessionId: string) => [...(modifiedFilesRef.current.get(sessionId) ?? [])]

  // Clear a chat's unread flag the moment it comes on screen, regardless of which of the
  // many setActiveId call sites got it there (sidebar click, opening from Projects, a
  // fork, …) — a single effect covers all of them instead of threading a "mark read" call
  // through every entry point. Visibility, not focus: a chat sitting in a pane you can see
  // has been read even while you type in the one beside it. Persists on its own: the
  // save-on-change effect below picks up the new object references.
  // Keyed on `visibleKey`, since the Set itself is a fresh object on every render.
  useEffect(() => {
    const visible = visibleIdsRef.current
    setSessions((prev) => {
      if (!prev.some((s) => s.unread && visible.has(s.id))) return prev
      return prev.map((s) => (s.unread && visible.has(s.id) ? { ...s, unread: false } : s))
    })
  }, [visibleKey])

  const activeSession = sessions.find((s) => s.id === activeId)
  // Which CLI a session's model belongs to. A plain lookup, but it has three callers now
  // that must agree — the sidebar's scope, the embedded terminal, and the CLAUDE.md modal,
  // which is opened FOR a session and so cannot read the active one.
  const providerOf = (s?: Session): ProviderId => provOf(models, s?.model || defaultModel)
  // The three modals are opened for a session, not for "the active one" — with two panes
  // on screen those differ, and resolving them here keeps the JSX from doing the lookup
  // once per prop.
  const claudeMdSession = claudeMdFor ? sessions.find((s) => s.id === claudeMdFor) : undefined
  const checkpointsSession = checkpointsFor ? sessions.find((s) => s.id === checkpointsFor) : undefined
  const gitSession = gitFor ? sessions.find((s) => s.id === gitFor) : undefined
  // The open file belongs to the chat's project tree, so it goes stale the moment we point at
  // a different folder or leave the chat view (where the Files tab lives) entirely.
  const activeProjectPath = activeSession?.projectPath
  useEffect(() => {
    setOpenFilePath(null)
  }, [activeProjectPath, view])
  // Sessions with a pending approval — drives the amber sidebar dot.
  const attentionIds = useMemo(
    () => new Set(approvalQueue.map((r) => r.appSessionId)),
    [approvalQueue]
  )

  const dismissRun = useCallback((sid: string) => {
    setDismissedRunIds((prev) => new Set(prev).add(sid))
  }, [])

  const ready = auth ? (auth.mode === 'api-key' ? auth.hasApiKey : auth.claudeCodeDetected || auth.hasApiKey) : false

  const addTerm = useCallback((line: TermLine) => {
    setTerminalLines((prev) => [...prev.slice(-499), line])
  }, [])

  // With concurrent runs, terminal lines from different sessions interleave. When
  // more than one run is active, prefix each entry with the producing session's short
  // name so lines are attributable. Cheap: just prepends to the text at the call site.
  const addTermFor = useCallback((sid: string, line: TermLine) => {
    if (runningIdsRef.current.size > 1) {
      const name = sessionsRef.current.find((s) => s.id === sid)?.name || 'chat'
      line = { ...line, text: `[${name.slice(0, 14)}] ${line.text}` }
    }
    setTerminalLines((prev) => [...prev.slice(-499), line])
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
      setLimits(config.limits)
      applyUi(config.ui)
      // No auto-created blank draft: with no saved chats the main area shows the
      // welcome pane until the user explicitly starts one.
      // Restore whatever pane layout was persisted, filtered to sessions that still
      // exist. Unconditionally, even with nothing saved: restoring is also what arms
      // persistence, so skipping it on a first run would leave the layout unsaved for
      // the whole session.
      const restored = restore(saved.map((s) => s.id))
      if (saved.length > 0) {
        setSessions(saved.map((s) => s.runState === 'running' ? { ...s, runState: 'interrupted' as const } : s))
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

  // Persist partial output periodically, including continuous streams. A recovered
  // running marker becomes "interrupted" on startup; no command is replayed.
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

  const appendToLastAssistant = (sid: string, update: (m: Message) => Message) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s
        const msgs = [...s.messages]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') msgs[msgs.length - 1] = update(last)
        return { ...s, messages: msgs }
      })
    )
  }

  // Agent event listeners
  useEffect(() => {
    const offEvent = window.electronAPI.onAgentEvent((data: AgentEvent) => {
      const sid = data.appSessionId
      if (data.kind === 'system') {
        if (data.claudeSessionId) {
          setSessions((prev) =>
            prev.map((s) => (s.id === sid ? { ...s, claudeSessionId: data.claudeSessionId } : s))
          )
        }
        addTermFor(sid, { kind: 'info', text: `session started · ${data.tools.length} tools available` })
        return
      }
      if (data.kind === 'text') {
        appendToLastAssistant(sid, (m) => ({ ...m, content: m.content + data.content }))
        return
      }
      if (data.kind === 'thinking') {
        addTermFor(sid, { kind: 'thinking', text: data.content })
        appendToLastAssistant(sid, (m) => ({ ...m, thinking: (m.thinking ?? '') + data.content }))
        return
      }
      if (data.kind === 'tool-use') {
        const inputStr = typeof data.input === 'object' ? JSON.stringify(data.input) : String(data.input)
        addTermFor(sid, { kind: 'tool', text: `${data.tool}(${inputStr.slice(0, 200)})` })
        const call: ToolCall = { id: data.toolId, tool: data.tool, input: data.input }
        appendToLastAssistant(sid, (m) => ({ ...m, toolCalls: [...(m.toolCalls ?? []), call] }))
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(data.tool)) {
          const fp = (data.input as { file_path?: string; path?: string })?.file_path ??
            (data.input as { path?: string })?.path
          if (fp) trackFile(sid, fp)
        }
        return
      }
      if (data.kind === 'tool-result') {
        addTermFor(sid, { kind: data.isError ? 'error' : 'result', text: data.content.slice(0, 300) || '(no output)' })
        appendToLastAssistant(sid, (m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((c) =>
            c.id === data.toolId ? { ...c, result: data.content, isError: data.isError } : c
          )
        }))
        return
      }
    })

    const offDone = window.electronAPI.onAgentDone((data: AgentDone) => {
      endRun(data.appSessionId)
      if (data.isError && data.errorText) addTermFor(data.appSessionId, { kind: 'error', text: data.errorText })
      addTermFor(data.appSessionId, { kind: 'info', text: `done · $${data.costUsd.toFixed(4)}` })

      // Budget alerting — fetch fresh config + usage windows and check against limits.
      // Fire-and-forget; non-blocking on the run flow. Any failure is swallowed so
      // the post-run state updates (cost accounting, session save) always complete.
      Promise.all([
        window.electronAPI.ccUsage(false),
        window.electronAPI.getConfig()
      ]).then(([report, config]) => {
        // Always sync limits state so the UI and future checks are fresh.
        const freshLimits = config.limits
        setLimits(freshLimits)
        limitsRef.current = freshLimits

        const win = report.windows
        const over = overLimitRef.current
        const newBanners: string[] = []

        const check = (key: 'hour' | 'session' | 'week', costUsd: number, limit: number, label: string) => {
          // Treat 0 / unset as "no limit for this window" — reset latch and skip.
          if (!limit || limit <= 0) {
            if (over[key]) over[key] = false
            return
          }
          const exceeded = costUsd >= limit
          if (exceeded && !over[key]) {
            // Crossing from under → over: fire notification once and latch.
            over[key] = true
            window.electronAPI.notify(
              `Budget limit reached: ${label}`,
              `You've spent $${costUsd.toFixed(2)} this ${label.toLowerCase()} (limit $${limit.toFixed(2)}).`
            )
          } else if (!exceeded && over[key]) {
            // Usage dropped back under (new period rolled over) — re-arm the latch.
            over[key] = false
          }
          if (exceeded) newBanners.push(`${label} budget exceeded: $${costUsd.toFixed(2)} / $${limit.toFixed(2)}`)
        }

        check('hour', win.hour.costUsd, freshLimits.hourUsd, 'Hour')
        check('session', win.session.costUsd, freshLimits.sessionUsd, 'Session')
        check('week', win.week.costUsd, freshLimits.weekUsd, 'Week')
        // Replace (not accumulate) banners — prevents stacking duplicates across turns.
        setBudgetBanners(newBanners)
      }).catch(() => { /* usage fetch failure is non-fatal — silently swallow */ })
      if (!document.hasFocus()) {
        const sess = sessionsRef.current.find((s) => s.id === data.appSessionId)
        const where = sess?.name ? `“${sess.name}”` : 'chat'
        window.electronAPI.notify(
          data.isError ? 'Claude run failed' : 'Claude finished',
          data.isError ? data.errorText || 'The run ended with an error.' : `${where} is ready.`
        )
      }
      const turnUsage = {
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        cacheReadTokens: data.cacheReadTokens ?? 0,
        cacheCreationTokens: data.cacheCreationTokens ?? 0,
        costUsd: data.costUsd ?? 0
      }
      setSessions((prev) => {
        const updated = prev.map((s) => {
          if (s.id !== data.appSessionId) return s
          // Attach this turn's usage to the last assistant message.
          let lastAssistant = -1
          for (let i = s.messages.length - 1; i >= 0; i--) {
            if (s.messages[i].role === 'assistant') {
              lastAssistant = i
              break
            }
          }
          const messages =
            lastAssistant >= 0
              ? s.messages.map((m, i) => (i === lastAssistant ? { ...m, usage: turnUsage } : m))
              : s.messages
          return {
            ...s,
            messages,
            claudeSessionId: data.claudeSessionId ?? s.claudeSessionId,
            updatedAt: Date.now(),
            costUsd: (s.costUsd ?? 0) + (data.costUsd ?? 0),
            inputTokens: (s.inputTokens ?? 0) + (data.inputTokens ?? 0),
            outputTokens: (s.outputTokens ?? 0) + (data.outputTokens ?? 0),
            cacheReadTokens: (s.cacheReadTokens ?? 0) + (data.cacheReadTokens ?? 0),
            cacheCreationTokens: (s.cacheCreationTokens ?? 0) + (data.cacheCreationTokens ?? 0),
            // The turn finished while this chat wasn't on screen — same signal as a
            // terminal chat's transcript catching up in the background. Visibility, not
            // focus: a run that finished in a pane you were watching is not news.
            ...(!visibleIdsRef.current.has(s.id) ? { unread: true } : {})
          }
        })
        const session = updated.find((s) => s.id === data.appSessionId)
        if (session) window.electronAPI.saveSession(session)
        return updated
      })
    })

    const offErr = window.electronAPI.onAgentError((data: AgentError) => {
      endRun(data.appSessionId)
      addTermFor(data.appSessionId, { kind: 'error', text: data.error })
      appendToLastAssistant(data.appSessionId, (m) => ({
        ...m,
        content: m.content || `Error: ${data.error}`,
        error: true
      }))
      if (!document.hasFocus()) window.electronAPI.notify('Claude run failed', data.error.slice(0, 120))
    })

    const offApproval = window.electronAPI.onApprovalRequest((data: ApprovalRequest) => {
      approvalSinceRef.current.set(data.approvalId, Date.now())
      setApprovalQueue((prev) => [...prev, data])
    })

    // A git worktree was created for a `useWorktree` chat — persist its path so later
    // turns (and the embedded terminal) reuse it instead of re-creating one each send.
    const offWorktree = window.electronAPI.onAgentWorktree((data) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === data.appSessionId ? { ...s, worktreePath: data.path } : s))
      )
    })

    // An approval answered elsewhere (e.g. the always-on-top toast while this
    // window was hidden) — drop it here so the modal doesn't linger unanswered.
    const offResolved = window.electronAPI.onApprovalResolved((approvalId: string) => {
      approvalSinceRef.current.delete(approvalId)
      setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
    })

    return () => {
      offEvent()
      offDone()
      offErr()
      offApproval()
      offWorktree()
      offResolved()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Answer a specific queued approval by id: send the response, prune it from the
  // queue, and log against its own session. Used both by the inline Rooms flow and
  // (via respondApproval) the head-of-queue global modal.
  const respondApprovalById = (approvalId: string, allow: boolean) => {
    const req = approvalQueue.find((r) => r.approvalId === approvalId)
    if (!req) return
    window.electronAPI.respondApproval({ approvalId, allow })
    addTermFor(req.appSessionId, { kind: allow ? 'info' : 'error', text: `${allow ? 'allowed' : 'denied'} ${req.tool}` })
    approvalSinceRef.current.delete(approvalId)
    setApprovalQueue((prev) => prev.filter((r) => r.approvalId !== approvalId))
  }

  // Global modal answers the HEAD of the queue — delegates to respondApprovalById.
  const respondApproval = (allow: boolean) => {
    const head = approvalQueue[0]
    if (head) respondApprovalById(head.approvalId, allow)
  }

  // Shared helper — builds the sendAgent payload from a session + prompt.
  // Both sendMessage, retryTurn, and editAndResend call this so params stay identical.
  const buildAgentPayload = useCallback(
    (
      session: Session,
      text: string,
      images?: { mediaType: string; data: string }[],
      files?: { name: string; content: string }[]
    ) => ({
      appSessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      prompt: text,
      projectPath: session.projectPath,
      model: session.model || defaultModel,
      systemPrompt: session.systemPrompt,
      permissionMode: session.permissionMode,
      // Light mode = no tools at all (drops tool schemas from every turn) and full
      // settings isolation in the main process (drops global plugins/skills too).
      allowedTools: session.lightMode ? [] : session.allowedTools,
      useMcp: session.lightMode ? false : session.useMcp ?? false,
      lightMode: session.lightMode ?? false,
      approvalMode: (session.autoApprove ? 'auto' : 'ask') as 'auto' | 'ask',
      images,
      files,
      remoteHostId: session.remoteHostId,
      wslDistro: session.wslDistro,
      additionalDirs: session.additionalDirs,
      useWorktree: session.useWorktree,
      worktreePath: session.worktreePath,
      accountId: session.accountId ?? defaultAccountId,
      // Falls back to the current Codex default account, mirroring the sidebar's
      // acctOf (src/renderer/src/lib/account-scope.ts) — an unbound Codex chat must
      // run on the same account it's filed/scoped under, not the literal 'default'.
      codexAccountId: session.codexAccountId ?? codexDefaultAccountId,
      geminiAccountId: session.geminiAccountId
    }),
    [defaultModel, defaultAccountId, codexDefaultAccountId]
  )

  const sendMessage = useCallback(
    (
      sid: string,
      text: string,
      images?: { mediaType: string; data: string }[],
      files?: { name: string; content: string }[],
      imageThumbnails?: string[]
    ) => {
      const session = sessions.find((s) => s.id === sid)
      if (!session || runningIds.has(session.id)) return

      // Auto-checkpoint the pre-turn state of files Claude has already touched, so this
      // turn's changes can be rolled back.
      const tracked = trackedFiles(session.id)
      if (tracked.length > 0) {
        window.electronAPI.checkpointCreate(
          session.id,
          `Before: ${text.slice(0, 50)}`,
          tracked,
          session.messages.length
        )
      }

      // The transcript shows only the filenames of attached files; the full content
      // rides along in the prompt (see main/index.ts buildPrompt), never in
      // message.content — keeps stored sessions and future re-sends light.
      // NOTE: edited-resend re-sends text only and will NOT re-attach these files.
      const displayContent = files && files.length
        ? `${text}\n\n📎 attached: ${files.map((f) => f.name).join(', ')}`
        : text

      // The thumbnails ride on the message, the full-size images only on the payload:
      // the transcript shows what was sent without the session file carrying it.
      const userMsg: Message = {
        id: generateId(),
        role: 'user',
        content: displayContent,
        timestamp: Date.now(),
        ...(imageThumbnails?.length ? { imageThumbnails } : {})
      }
      const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }

      const updated: Session = {
        ...session,
        name: session.messages.length === 0 && session.name === 'New chat' ? text.slice(0, 40) : session.name,
        messages: [...session.messages, userMsg, assistantMsg],
        // Argos's own record takes over from here — the terminal sync must not
        // re-import over it and lose this turn's streaming state.
        ccSynced: false,
        updatedAt: Date.now()
      }

      setSessions((prev) => prev.map((s) => (s.id === session.id ? updated : s)))
      startRun(session.id)
      setTerminalOpen(true)
      addTermFor(session.id, { kind: 'user', text: text.slice(0, 120) })

      window.electronAPI.sendAgent(buildAgentPayload(session, text, images, files))
    },
    [sessions, runningIds, startRun, addTermFor, buildAgentPayload]
  )

  // Retry the last failed turn: reset the trailing assistant message and re-send
  // the last user message's content. Uses a ref so the listener-registered callback
  // always sees current state (same pattern as createSessionRef).
  const retryTurnRef = useRef<(sid: string) => void>(() => {})
  const retryTurn = useCallback((sid: string) => {
    const session = sessionsRef.current.find((s) => s.id === sid)
    if (!session || runningIdsRef.current.has(sid)) return

    // Find the last user message that precedes the failed assistant message.
    const msgs = session.messages
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user')
    if (lastUserIdx === -1) return
    const lastUserMsg = msgs[lastUserIdx]

    // Reset the trailing assistant message in-place (clear error state).
    const freshAssistant: Message = {
      ...msgs[msgs.length - 1],
      content: '',
      toolCalls: [],
      thinking: undefined,
      error: false
    }
    const nextMsgs = [...msgs.slice(0, msgs.length - 1), freshAssistant]
    setSessions((prev) =>
      prev.map((s) => (s.id === sid ? { ...s, messages: nextMsgs } : s))
    )

    startRun(sid)
    setTerminalOpen(true)
    addTermFor(sid, { kind: 'info', text: 'retrying…' })

    // Re-run sends text only — original images are not persisted on Message.
    window.electronAPI.sendAgent(buildAgentPayload(session, lastUserMsg.content))
  }, [startRun, addTermFor, buildAgentPayload])
  retryTurnRef.current = retryTurn

  // Edit a user message and resend: truncates history to before that message,
  // then appends a fresh user + assistant pair with the new text.
  const editAndResend = useCallback(
    (sid: string, messageId: string, newText: string) => {
      if (!newText.trim()) return
      const session = sessionsRef.current.find((s) => s.id === sid)
      if (!session || runningIdsRef.current.has(sid)) return

      const idx = session.messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return

      const userMsg: Message = { id: generateId(), role: 'user', content: newText.trim(), timestamp: Date.now() }
      const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }

      const nextMsgs = [...session.messages.slice(0, idx), userMsg, assistantMsg]
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, messages: nextMsgs, updatedAt: Date.now() } : s))
      )

      startRun(sid)
      setTerminalOpen(true)
      addTermFor(sid, { kind: 'user', text: newText.trim().slice(0, 120) })

      // Re-run sends text only — original images are not persisted on Message.
      window.electronAPI.sendAgent(buildAgentPayload(session, newText.trim()))
    },
    [startRun, addTermFor, buildAgentPayload]
  )

  // Launch a new chat from the quick-launcher overlay (global shortcut) or tray.
  // If a run is already in progress or auth is missing, the prompt is preserved as a
  // failed turn (error + Retry) instead of being silently dropped.
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
    }) => {
      const prompt = payload.prompt.trim()
      if (!prompt) return
      const base = sessionsRef.current.find((s) => s.id === activeIdRef.current)
      const s = newSession(
        payload.projectPath ?? base?.projectPath,
        payload.modelId ?? (payload.quick ? 'claude-haiku-4-5' : defaultModel),
        payload.accountId ?? base?.accountId ?? defaultAccountId
      )
      s.name = prompt.slice(0, 40)

      // Terminal mode: no transcript to post into and no run for Argos to drive. The chat
      // is created the same way — folder, model and account all still decided here, and
      // they are what the CLI launches under — and the prompt is handed to the terminal to
      // type. `ready` is not consulted: signing in is the CLI's business in this mode.
      if (workMode === 'terminal') {
        setSessions((prev) => [s, ...prev])
        setActiveId(s.id)
        setView('chat')
        setTerminalPrompts((prev) => ({ ...prev, [s.id]: prompt }))
        window.electronAPI.saveSession(s)
        return
      }

      const userMsg: Message = { id: generateId(), role: 'user', content: prompt, timestamp: Date.now() }
      const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }

      // Each overlay prompt starts a FRESH session, so other in-flight runs no longer
      // block it — concurrent runs are supported. Only missing auth blocks, and only
      // Anthropic auth: a Codex or Antigravity run has nothing to do with `ready`, and
      // used to be refused on a signed-out Claude.
      const runModelId = s.model ?? defaultModel
      const runProvider = models.find((m) => runModelId.startsWith(m.id))?.provider ?? 'claude'
      const blocked =
        runProvider === 'claude' && !ready
          ? 'Not signed in — connect Claude Code or an API key in Settings, then press Retry.'
          : null

      s.messages = blocked
        ? [userMsg, { ...assistantMsg, content: blocked, error: true }]
        : [userMsg, assistantMsg]
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      setView('chat')
      if (blocked) {
        window.electronAPI.saveSession(s)
        return
      }
      startRun(s.id)
      setTerminalOpen(true)
      addTermFor(s.id, { kind: 'user', text: prompt.slice(0, 120) })
      window.electronAPI.sendAgent(buildAgentPayload(s, prompt))
    },
    [defaultModel, defaultAccountId, ready, workMode, startRun, addTermFor, buildAgentPayload]
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
      setCcTarget(target)
      setView('projects')
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

  // Stop only the ACTIVE session's run. agent:stop takes the appSessionId and aborts
  // just that run's AbortController in the main process, leaving other runs untouched.
  const stopRun = useCallback(async (sid: string) => {
    await window.electronAPI.stopAgent(sid)
    endRun(sid)
    addTermFor(sid, { kind: 'info', text: 'stopped' })
  }, [endRun, addTermFor])

  // projectPath, when a string, overrides the folder normally inherited from the
  // active session (e.g. an Explorer "Open with Argos" or Jump List launch).
  // The `typeof` guard lets this double as a plain onClick handler — a click event
  // arg is ignored rather than mistaken for a folder path.
  // An unused chat: no messages, and never driven through the embedded terminal either.
  // Preferring the active one keeps you where you are when it already qualifies.
  const blankDraft = (): Session | undefined => {
    const unused = (s: Session) => s.messages.length === 0 && !s.hasTerminalActivity
    if (activeSession && unused(activeSession)) return activeSession
    return sessions.find(unused)
  }

  const createSession = (projectPath?: unknown) => {
    const folder = typeof projectPath === 'string' ? projectPath : undefined
    // An untouched draft IS the new chat — a chat only earns its own row once it has been
    // used. So reuse a blank one rather than stacking another, repointing it at whichever
    // folder was asked for so a project group's "+" still lands you inside that project.
    const draft = blankDraft()
    if (draft) {
      if (folder && draft.projectPath !== folder) {
        setSessions((prev) => prev.map((s) => (s.id === draft.id ? { ...s, projectPath: folder } : s)))
      }
      setActiveId(draft.id)
      setView('chat')
      bumpNewChatNonce(draft.id)
      return
    }
    const s = newSession(
      folder ?? activeSession?.projectPath,
      defaultModel,
      activeSession?.accountId ?? defaultAccountId
    )
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    // Bump the nonce so the chat pane greets the new draft (composer highlight + focus)
    // the same way it does for every other New chat entry point.
    bumpNewChatNonce(s.id)
  }
  createSessionRef.current = createSession

  // Navigation from the nav rail / command palette, as opposed to the setView calls that
  // already pick a specific chat to land on (createSession, pickAccount, deployAgent, …).
  //
  // Arriving at the chat view creates nothing. It used to land you on a new chat, which
  // read as convenience while a chat was just a blank composer — but a chat is a real
  // thing (in terminal mode, a CLI process starting in some folder), and spawning one
  // every time you passed through the view is not something anyone asked for. A chat is
  // created when you press New chat, and only then.
  //
  // What you get instead: the chat you were in if it has anything in it, and otherwise
  // the welcome pane — start one, or pick one from the sidebar. An untouched draft is
  // let go of rather than deleted: it stays available for the next New chat to reuse
  // (see blankDraft), it just stops being what the view opens on.
  //
  // Terminal mode goes further: the view always opens on the welcome pane, whatever was
  // last active. A terminal is a live CLI process, and dropping back into one you left
  // running — at whatever prompt or half-typed command it sits on — is not what pressing
  // Chat in the rail asks for. The terminal keeps running and stays one click away in the
  // sidebar; the rail entry means "New terminal, or pick one".
  const goToView = (v: View) => {
    if (v === 'chat' && view !== 'chat') {
      const active = sessions.find((s) => s.id === activeIdRef.current)
      const unused = active && active.messages.length === 0 && !active.hasTerminalActivity
      if (workMode === 'terminal' || unused) setActiveId('')
      setView('chat')
      return
    }
    setView(v)
  }

  // Quick chat: forces the current provider's cheapest model for throwaway / trivial questions.
  const createQuickChat = () => {
    const model = cheapestModelForProvider(defaultProvider) ?? defaultModel
    // Same draft reuse as createSession, but the point of a quick chat is the model, so a
    // reused draft gets switched onto it.
    const draft = blankDraft()
    if (draft) {
      setSessions((prev) => prev.map((s) => (s.id === draft.id ? { ...s, model } : s)))
      setActiveId(draft.id)
      setView('chat')
      bumpNewChatNonce(draft.id)
      return
    }
    const s = newSession(activeSession?.projectPath, model, activeSession?.accountId ?? defaultAccountId)
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    bumpNewChatNonce(s.id)
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

  // Leave the terminal that IS the chat (terminal mode). Unlike unmounting the pane,
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

  // Patch the active draft session from the new-chat config bar (folder, environment,
  // extra dirs, worktree toggle). Only meaningful before the first message is sent.
  const patchSession = (sid: string, patch: Partial<Session>) => {
    let patched: Session | undefined
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s
        patched = { ...s, ...patch }
        return patched
      })
    )
    // A chat driven purely from the embedded terminal never goes through the normal
    // agent:send → saveSession path, so without this it'd vanish on restart even after
    // hasTerminalActivity makes it visible in the sidebar for the rest of this run. The
    // terminal's session id has to survive the same way and for a sharper reason: it is
    // the only record of which Claude Code conversation that terminal started, and losing
    // it means the chat can never be matched back to its own transcript.
    if ((patch.hasTerminalActivity || patch.terminalSessionId) && patched) {
      window.electronAPI.saveSession(patched)
    }
  }

  const setSessionModel = (sid: string, modelId: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model: modelId } : s)))
  }

  const exportSession = (sid: string, format: Parameters<typeof window.electronAPI.exportSession>[1]) => {
    const session = sessions.find((s) => s.id === sid)
    if (session) window.electronAPI.exportSession(session, format)
  }

  // Account selection is app-level: it sets the DEFAULT account used for new chats.
  // Existing sessions keep their own accountId forever (a chat is permanently bound to
  // the account that created it — its Claude Code resume id only exists there). The one
  // exception: an unstarted draft (zero messages) follows the switch, so an empty chat
  // inherits the account you just picked.
  const switchDefaultAccount = async (accountId: string) => {
    const { accounts: next, defaultAccountId: nextDefault } =
      await window.electronAPI.accountsSetDefault(accountId)
    setAccounts(next)
    setDefaultAccountId(nextDefault)
    const name = next.find((a) => a.id === accountId)?.name
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeIdRef.current && s.messages.length === 0
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
  // Which account the SIDEBAR is scoped to while this chat is open. Normally the chat's
  // own, so opening one bound to another account moves the whole sidebar onto it. But a
  // chat that runs inside a distro or on a remote host isn't on that account at all — it
  // only carries the id it was created with — and letting it drag the scope there hid
  // every local chat of the account you were actually using, on nothing more than which
  // chat you had clicked. Undefined means "whatever this provider's default is".
  const scopeAccountId = activeSession && originOf(activeSession) ? undefined : activeChatAccountId
  const firstModelForProvider = (provider: ProviderId): string | undefined =>
    models.find((m) => m.provider === provider)?.id
  // Cheapest released model of a provider (by input+output price), for Quick chat.
  const cheapestModelForProvider = (provider: ProviderId): string | undefined => {
    const inProvider = models.filter((m) => m.provider === provider)
    const priced = inProvider.filter((m) => m.inputPrice > 0 || m.outputPrice > 0)
    const pool = priced.length ? priced : inProvider
    if (pool.length === 0) return undefined
    return pool.reduce((a, b) => (a.inputPrice + a.outputPrice <= b.inputPrice + b.outputPrice ? a : b)).id
  }

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
          if (s.id !== activeIdRef.current || s.messages.length !== 0) return s
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
    // the remaining branch goes to the welcome pane, where there is no composer to greet.
    bumpNewChatNonce(activeIdRef.current)
    await switchDefaultProviderAccount(provider, accountId)

    // Resolve chats with the just-picked account as this provider's default — state from
    // switchDefaultProviderAccount hasn't flushed yet, and an unbound legacy chat must
    // resolve the same way its run will (see account-scope.ts / buildAgentPayload).
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

    // Already on this account with nothing typed yet (the switch may have rebound an empty
    // draft) — that IS the new-chat page, so stay put.
    const active = sessions.find((s) => s.id === activeIdRef.current)
    if (
      active &&
      active.messages.length === 0 &&
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
    if (active && active.messages.length === 0) {
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, model: providerModel, ...acctFields } : s)))
    } else {
      setActiveId('')
    }
    setView('chat')
  }

  const toggleAutoApprove = (sid: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, autoApprove: !s.autoApprove } : s)))
  }

  const toggleLightMode = (sid: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, lightMode: !s.lightMode } : s)))
  }

  // Summarize the current (long) session and start a FRESH one seeded with the summary as
  // system context — so each turn re-sends a compact brief instead of the whole transcript.
  const compactSession = async (sid: string) => {
    const session = sessions.find((s) => s.id === sid)
    if (!session || compacting) return
    setCompacting(true)
    const transcript = session.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    const res = await window.electronAPI.summarizeChat({
      transcript,
      model: session.model || defaultModel,
      accountId: session.accountId ?? defaultAccountId
    })
    setCompacting(false)
    if (!res.ok || !res.summary) {
      addTerm({ kind: 'error', text: res.error || 'Compaction failed.' })
      return
    }
    const s = newSession(
      session.projectPath,
      session.model || defaultModel,
      session.accountId ?? defaultAccountId
    )
    s.name = session.name
    s.lightMode = session.lightMode
    s.systemPrompt = `Context carried over from a previous (compacted) session:\n\n${res.summary}`
    s.messages = [
      {
        id: generateId(),
        role: 'assistant',
        content: `**Session compacted to save tokens.** History is fresh; the summary below is carried forward as context.\n\n${res.summary}`,
        timestamp: Date.now()
      }
    ]
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    window.electronAPI.saveSession(s)
  }

  // Fork a chat from any message point into a new session. Unlike Compact (which
  // summarizes via an LLM call), this is instant and client-side: it deep-copies the
  // messages up to and including the branch point for visual continuity, and seeds the
  // new session's context through the SAME channel Compact uses — the `systemPrompt`
  // field, re-sent on every turn by buildAgentPayload. The branched session gets NO
  // claudeSessionId: the Claude Code engine can only resume from a session's latest
  // point, so a truncated fork must rebuild context client-side (via the seed).
  const branchSession = (sid: string, messageId: string) => {
    const parent = sessionsRef.current.find((s) => s.id === sid)
    if (!parent) return
    const idx = parent.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return

    // Deep copy messages[0..idx] inclusive — display history for the new transcript.
    // structuredClone keeps message ids, so branchedFrom.atMessageId lines up.
    const sliced = parent.messages.slice(0, idx + 1).map((m) => structuredClone(m))

    // Name: "<parent> (branch)", deduping with "(branch 2)", "(branch 3)"… on collision.
    const existing = new Set(sessionsRef.current.map((s) => s.name))
    let name = `${parent.name} (branch)`
    for (let n = 2; existing.has(name); n++) name = `${parent.name} (branch ${n})`

    // Compact serialization of the slice → the context carrier. Combine with the
    // parent's own systemPrompt (e.g. an agent's instructions) so both survive.
    const seed = sessionToReplaySeed({ ...parent, messages: sliced })
    const carryOver = `Context carried over from a previous (branched) session:\n\n${seed}`
    const systemPrompt = parent.systemPrompt ? `${parent.systemPrompt}\n\n${carryOver}` : carryOver

    const now = Date.now()
    const s: Session = {
      id: generateId(),
      name,
      messages: sliced,
      projectPath: parent.projectPath,
      model: parent.model,
      accountId: parent.accountId,
      accountName: parent.accountName,
      systemPrompt,
      permissionMode: parent.permissionMode,
      allowedTools: parent.allowedTools,
      useMcp: parent.useMcp,
      autoApprove: parent.autoApprove,
      lightMode: parent.lightMode,
      // Intentionally NO claudeSessionId — the fork rebuilds context via the seed.
      branchedFrom: { name: parent.name, atMessageId: sliced[sliced.length - 1].id },
      createdAt: now,
      updatedAt: now
    }
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    window.electronAPI.saveSession(s)
  }

  // Wrappers around the three modal-open setters, taking the session they open for —
  // each modal now tracks which session it belongs to, so two panes can have their own
  // CLAUDE.md/checkpoints/git modal open on different sessions at once.
  const openClaudeMd = (sid: string) => setClaudeMdFor(sid)
  const openCheckpoints = (sid: string) => setCheckpointsFor(sid)
  const openGit = (sid: string) => setGitFor(sid)

  // Creates a checkpoint for the given session — the checkpoints modal passes its own
  // session here rather than this closing over `activeSession`, so a checkpoint taken from
  // a background pane's modal doesn't land on whatever session happens to be active.
  const createCheckpoint = async (session: Session, label: string) => {
    await window.electronAPI.checkpointCreate(
      session.id,
      label,
      trackedFiles(session.id),
      session.messages.length
    )
  }

  // Resume a real Claude Code session from the Projects view (local or WSL).
  const resumeCCSession = async (cc: CCSessionMeta) => {
    const transcript = await window.electronAPI.ccReadSession(cc.sourceId, cc.encodedDir, cc.sessionId)
    const messages: Message[] = transcript.map((m) => ({
      id: generateId(),
      role: m.role,
      content: m.text,
      thinking: m.thinking,
      toolCalls: m.toolCalls,
      timestamp: m.timestamp,
      decisions: m.decisions
    }))
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
    const s: Session = {
      id: generateId(),
      name: cc.title,
      messages,
      projectPath,
      claudeSessionId: cc.sessionId,
      model: cc.model || defaultModel,
      accountId,
      useMcp: false,
      wslDistro: isWsl ? cc.distro : undefined,
      remoteHostName: isWsl ? `WSL · ${cc.distro}` : undefined,
      autoApprove: isWsl ? true : undefined,
      createdAt: cc.createdAt || Date.now(),
      updatedAt: Date.now()
    }
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    setTerminalLines([])
    addTerm({ kind: 'info', text: `resuming ${isWsl ? cc.distro + ' ' : ''}session ${cc.sessionId.slice(0, 8)}` })
  }

  // Pull each terminal-driven chat's transcript in from disk once the CLI it launched
  // has actually written one. A chat qualifies while it's still showing nothing of its
  // own (`ccSynced`, or never had any messages to begin with) — the moment a turn goes
  // through Argos's composer this stops touching that chat, so a re-import can never
  // clobber streaming state the transcript file doesn't carry.
  const syncTerminalChats = useCallback(async () => {
    const candidates = sessionsRef.current.filter(
      (s) =>
        s.projectPath &&
        (s.claudeSessionId || s.terminalSessionId) &&
        s.hasTerminalActivity &&
        (s.messages.length === 0 || s.ccSynced)
    )
    for (const s of candidates) {
      const sessionId = (s.claudeSessionId || s.terminalSessionId) as string
      const prefer = s.wslDistro ? `wsl:${s.wslDistro}` : undefined
      const transcript = await window.electronAPI.ccChatTranscript(s.projectPath as string, sessionId, prefer)
      if (!transcript) continue

      const nameFromTitle = transcript.title && s.name === 'New chat' ? transcript.title : undefined
      const messagesChanged = transcript.messages.length !== s.messages.length
      const sessionIdChanged = s.claudeSessionId !== sessionId
      const syncedChanged = s.ccSynced !== true
      // A tick where the transcript hasn't grown, the id was already promoted, no
      // title landed and the flag is already set would still produce a *new* session
      // object every time this runs — and this runs on a timer, which would re-save
      // every terminal chat forever for no reason.
      if (!messagesChanged && !sessionIdChanged && !nameFromTitle && !syncedChanged) continue

      setSessions((prev) =>
        prev.map((cur) => {
          if (cur.id !== s.id) return cur
          return {
            ...cur,
            ...(messagesChanged
              ? {
                  messages: transcript.messages.map((m) => ({
                    id: generateId(),
                    role: m.role,
                    content: m.text,
                    thinking: m.thinking,
                    toolCalls: m.toolCalls,
                    timestamp: m.timestamp,
                    decisions: m.decisions
                  })),
                  // Sorted on in the sidebar, so a terminal chat that has been talking
                  // for an hour must not still sort as of the moment it was created.
                  updatedAt:
                    transcript.messages[transcript.messages.length - 1]?.timestamp || Date.now()
                }
              : {}),
            claudeSessionId: sessionId,
            ...(nameFromTitle ? { name: nameFromTitle } : {}),
            ccSynced: true,
            // The terminal wrote new turns while this chat wasn't on screen — reads
            // visibleIdsRef (not visibleIds) because syncTerminalChats has no deps and
            // would otherwise close over whichever panes were open when it was first
            // created.
            ...(messagesChanged &&
            transcript.messages.length > s.messages.length &&
            !visibleIdsRef.current.has(s.id)
              ? { unread: true }
              : {})
          }
        })
      )
    }
  }, [])

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
   * A chat driven from the embedded terminal never goes through `startRun`, so nothing
   * in Argos knew whether it was working or sitting idle — the list looked the same
   * either way. The registry does know, and now that each terminal chat pins its own
   * session id, its rows can be matched back to chats.
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
   * What the sidebar shows as running: Argos's own in-flight runs, plus any chat whose
   * Claude Code session the registry reports busy.
   *
   * Deliberately NOT fed back into `runningIds` itself. That set also gates whether a
   * turn can be sent, and a terminal chat being busy is not a reason to refuse the
   * composer — this is a display, not a lock.
   */
  const displayRunningIds = useMemo(() => {
    if (!liveBusyIds.size) return runningIds
    const out = new Set(runningIds)
    for (const s of sessions) {
      const ccId = s.claudeSessionId || s.terminalSessionId
      if (ccId && liveBusyIds.has(ccId)) out.add(s.id)
    }
    return out
  }, [runningIds, liveBusyIds, sessions])

  // Chats still working, for the window-wide pending bar. Reads displayRunningIds, not
  // runningIds: a chat driven from the embedded terminal never goes through startRun, so
  // keying off Argos's own runs alone left the strip empty for exactly the chats you most
  // need to find your way back to. The chat you're already looking at is left out — its own
  // header already shows it streaming, so listing it is just noise.
  const pendingRuns = useMemo<PendingRun[]>(() => {
    const defaults: AccountDefaults = {
      defaultAccountId,
      codexDefaultAccountId,
      geminiDefaultAccountId
    }
    const running = sessions.filter(
      (s) =>
        displayRunningIds.has(s.id) &&
        !dismissedRunIds.has(s.id) &&
        !(view === 'chat' && visibleIds.has(s.id))
    )
    // Which account each run is actually billed to, resolved exactly the way the run
    // itself resolves it (acctOf mirrors buildAgentPayload's fallbacks), so an unbound
    // chat is never labelled with an account it isn't running on.
    // Keyed by provider too: 'default' means a different login on Codex than it does on
    // Claude, so two runs sharing the bare id are still two accounts.
    //
    // …except where the chat does not run under a managed account at all. A chat inside a
    // WSL distro, or on a box over SSH, runs against the CLI login that lives THERE, and
    // labelling it with the account it happens to carry states something false. originOf
    // answers first, and its key joins the same set, so a distro counts as its own origin
    // when deciding whether the bar spans more than one.
    const origins = running.map((s) => originOf(s))
    const acctIds = running.map((s) => acctOf(s, models, defaults))
    const acctKeys = running.map(
      (s, i) => origins[i]?.key ?? `${provOf(models, s.model)}:${acctIds[i]}`
    )
    // The sidebar is scoped to ONE provider+account, so a run on another account is
    // invisible there — this bar is the only place it shows up at all. Name the account
    // when that matters: the runs span more than one, or a single run is on an account
    // other than the current default. Naming it when every run is on the one account
    // you're already using would just be noise on every pill.
    const spansAccounts = new Set(acctKeys).size > 1
    return running.map((s, i) => {
      // A run somewhere other than this machine is always named, span or no span: "it is
      // working" and "it is working inside Ubuntu-DevOps" are different facts, and the
      // second is the one you need to go and look in the right place.
      const origin = origins[i]
      if (origin) {
        return { id: s.id, name: s.name, attention: attentionIds.has(s.id), account: origin.label }
      }
      const acctId = acctIds[i]
      const provider = provOf(models, s.model)
      const list =
        provider === 'codex' ? codexAccounts : provider === 'gemini' ? geminiAccounts : accounts
      const isDefault =
        acctId ===
        (provider === 'codex'
          ? codexDefaultAccountId
          : provider === 'gemini'
            ? geminiDefaultAccountId
            : defaultAccountId)
      const name = list.find((a) => a.id === acctId)?.name ?? s.accountName
      return {
        id: s.id,
        name: s.name,
        attention: attentionIds.has(s.id),
        account: spansAccounts || (!isDefault && list.length > 1) ? name : undefined
      }
    })
  }, [
    sessions,
    displayRunningIds,
    dismissedRunIds,
    attentionIds,
    view,
    activeId,
    models,
    accounts,
    defaultAccountId,
    codexAccounts,
    codexDefaultAccountId,
    geminiAccounts,
    geminiDefaultAccountId
  ])

  // endRun forgets a dismissal once Argos's own run finishes, but a terminal chat never
  // reaches endRun. Clear dismissals for anything that stopped running, so the chat's next
  // burst of work surfaces again instead of staying hidden for the rest of the session.
  useEffect(() => {
    setDismissedRunIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => displayRunningIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [displayRunningIds])

  // ─── Home view data ────────────────────────────────────────────────────────
  // Everything below is either derived from state Argos already keeps (approvals,
  // running, plans, recent) or fetched only while Home is the visible view (repos'
  // git status) — Home is reachable from anywhere, so nothing here should poll when
  // nobody is looking at it.

  // Fed by schedulerList() only while Home is visible (see the effect below) — kept as
  // state rather than a memo because it comes from a fetch, not from state Argos already
  // holds.
  const [homeScheduledRuns, setHomeScheduledRuns] = useState<ScheduledRun[]>([])
  useEffect(() => {
    if (view !== 'home') return
    let cancelled = false
    window.electronAPI
      .schedulerList()
      .then((runs) => {
        if (!cancelled) setHomeScheduledRuns(runs)
      })
      .catch(() => {
        if (!cancelled) setHomeScheduledRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [view])

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

  // The one name resolver Home uses everywhere a session's or routine's project shows
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
    const failedRoutines: HomeAttention[] = homeScheduledRuns
      .filter((run) => run.lastResult && !run.lastResult.ok)
      .map((run) => {
        const summary = run.lastResult!.summary
        const detail = summary.length > 90 ? `${summary.slice(0, 90)}…` : summary
        return {
          id: `routine:${run.id}`,
          kind: 'routine',
          title: `${run.name} failed`,
          detail,
          context: run.projectPath ? `routine · ${resolveHomeProjectName(run.projectPath)}` : 'routine',
          since: run.lastResult!.at,
          actionLabel: 'Open'
        }
      })
    return [...approvals, ...failedRoutines]
  }, [approvalQueue, sessions, homeScheduledRuns, resolveHomeProjectName])

  const homeRoutines = useMemo<HomeRoutine[]>(
    () =>
      homeScheduledRuns
        .filter((run) => run.enabled && run.nextRunAt !== undefined)
        .sort((a, b) => (a.nextRunAt as number) - (b.nextRunAt as number))
        .slice(0, 3)
        .map((run) => ({
          id: run.id,
          name: run.name,
          nextRunAt: run.nextRunAt,
          cadence: cadenceSummary(run.cadence)
        })),
    [homeScheduledRuns]
  )

  const homeRunning = useMemo<HomeRunning[]>(() => {
    // displayRunningIds, not runningIds: a chat driven from the embedded terminal never
    // goes through startRun, and the CLI row that would have covered it is filtered out
    // just below as a duplicate — so keying off Argos's own runs dropped exactly those
    // chats off this list entirely.
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

  // Same window key (`five_hour`) the sidebar's own plan badge reads (see accountUsage
  // above) — one interpretation of AccountPlanUsage.windows, not a second one for Home.
  const homePlans = useMemo<HomePlan[]>(() => {
    if (!planReport) return []
    return planReport.accounts.map((acc) => {
      const w = acc.windows.find((win) => win.key === 'five_hour')
      return {
        accountKey: acc.accountKey,
        accountName: acc.accountName,
        percent: w ? w.utilization : null,
        resetsAt: w?.resetsAt,
        stale: acc.stale
      }
    })
  }, [planReport])

  const homeRecent = useMemo<HomeRecent[]>(
    () =>
      sessions
        .filter((s) => s.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)
        .map((s) => {
          const last = s.messages[s.messages.length - 1]
          // The transcript is markdown; a one-line preview that keeps the fences and
          // hashes reads as noise, so the marks come out before the truncation.
          const flat = last.content
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

  const [homeSpend, setHomeSpend] = useState<HomeSpend | null>(null)
  useEffect(() => {
    if (view !== 'home') return
    let cancelled = false
    // `false`: same cache-first read UsageView does for its instant paint — Home has no
    // more reason than that view does to force ccUsage's (heavy) refetch on every visit.
    window.electronAPI
      .ccUsage(false)
      .then((report) => {
        if (cancelled) return
        if (report.entries.length === 0) {
          setHomeSpend(null)
          return
        }
        const byDay = new Map<string, number>()
        for (const e of report.entries) {
          if (e.day === 'unknown') continue
          byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.costUsd)
        }
        // `day` is a plain YYYY-MM-DD string, and UsageView builds its own keys from the
        // LOCAL date (its `ymd`), not from toISOString — which is UTC, and would call the
        // hour between local and UTC midnight yesterday.
        const pad = (v: number) => String(v).padStart(2, '0')
        const dayKey = (ts: number) => {
          const d = new Date(ts)
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        }
        const todayKey = dayKey(Date.now())
        const days: { day: string; costUsd: number }[] = []
        for (let i = 13; i >= 0; i--) {
          const d = dayKey(Date.now() - i * 86400_000)
          days.push({ day: d, costUsd: byDay.get(d) ?? 0 })
        }
        setHomeSpend({ today: byDay.get(todayKey) ?? 0, days })
      })
      .catch(() => {
        if (!cancelled) setHomeSpend(null)
      })
    return () => {
      cancelled = true
    }
  }, [view])

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

  // Review an approval, or jump to the routine that failed — the two kinds of row Home's
  // attention list can hold (see homeAttention above; the `routine:` prefix is what
  // that id was namespaced with, to keep it out of the approvalId space).
  const onHomeAct = (id: string) => {
    if (id.startsWith('routine:')) {
      setView('scheduled')
      return
    }
    const req = approvalQueue.find((r) => r.approvalId === id)
    if (req) {
      setActiveId(req.appSessionId)
      setView('chat')
    }
  }

  // Run a custom agent
  const runAgent = (agent: AgentDef) => {
    const s: Session = {
      id: generateId(),
      name: agent.name,
      messages: [],
      projectPath: agent.defaultProjectPath,
      model: agent.model,
      agentId: agent.id,
      agentName: agent.name,
      accountId: defaultAccountId,
      systemPrompt: agent.systemPrompt,
      permissionMode: agent.permissionMode,
      allowedTools: agent.allowedTools,
      useMcp: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
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


  const connectRemote = (host: SshHostPublic) => {
    const s = newSession(host.remotePath, defaultModel, defaultAccountId)
    s.name = `${host.name} (remote)`
    s.remoteHostId = host.id
    s.remoteHostName = host.name
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    addTerm({ kind: 'info', text: `remote session on ${host.name}` })
  }

  const connectWsl = (distro: string, cwd?: string) => {
    const s = newSession(cwd, defaultModel, defaultAccountId)
    s.name = `${distro} (WSL)`
    s.wslDistro = distro
    s.remoteHostName = `WSL · ${distro}`
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    addTerm({ kind: 'info', text: `WSL session on ${distro}` })
  }

  const runPlannerTask = (task: PlannerTask) => {
    // Guard: no auth → nothing can run. A planner task spawns a FRESH session, so
    // concurrent runs are fine — no global streaming refusal.
    if (!ready) {
      addTerm({ kind: 'error', text: 'Not authenticated — cannot run planner task.' })
      return
    }

    const s = newSession(activeSession?.projectPath, activeSession?.model || defaultModel, activeSession?.accountId ?? defaultAccountId)
    s.name = task.title.slice(0, 40)

    const parts: string[] = [`Help me with this planned task: "${task.title}".`]
    if (task.notes) parts.push(`\nNotes: ${task.notes}`)
    if (task.effort) parts.push(`\nEffort level: ${task.effort}`)
    if (typeof task.day === 'number') {
      const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      parts.push(`\nScheduled for: ${dayNames[task.day]}`)
    }
    parts.push('\nPlease start working on it.')
    const prompt = parts.join('')

    const userMsg: Message = { id: generateId(), role: 'user', content: prompt, timestamp: Date.now() }
    const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }
    s.messages = [userMsg, assistantMsg]

    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    startRun(s.id)
    setTerminalOpen(true)
    addTermFor(s.id, { kind: 'user', text: prompt.slice(0, 120) })

    window.electronAPI.sendAgent(buildAgentPayload(s, prompt))
  }

  // Sprint standup → "Discuss" opens a light (tools-off) chat seeded with the day's
  // standup + board as system context, so it's a cheap talk-it-through session that
  // can't touch the repo. Mirrors runPlannerTask's spawn-and-fire flow.
  const startStandupChat = useCallback(
    (context: string, opener: string, name: string) => {
      if (!ready) {
        addTerm({ kind: 'error', text: 'Not authenticated — cannot start chat.' })
        return
      }
      const s = newSession(undefined, defaultModel, defaultAccountId)
      s.name = name
      s.lightMode = true
      s.systemPrompt = context
      const userMsg: Message = { id: generateId(), role: 'user', content: opener, timestamp: Date.now() }
      const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }
      s.messages = [userMsg, assistantMsg]
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      setView('chat')
      startRun(s.id)
      setTerminalOpen(true)
      addTermFor(s.id, { kind: 'user', text: opener.slice(0, 120) })
      window.electronAPI.sendAgent(buildAgentPayload(s, opener))
    },
    [ready, defaultModel, defaultAccountId, startRun, addTerm, addTermFor, buildAgentPayload]
  )

  // Sprint standup → "Schedule" one-click creates a daily standup routine (read-only,
  // starts disabled) and jumps to Routines so the user can review and enable it.
  const createStandupRoutine = useCallback(
    async (name: string, prompt: string, projectPath?: string) => {
      const run: ScheduledRun = {
        id: generateId(),
        name,
        prompt,
        model: defaultModel,
        projectPath,
        accountId: defaultAccountId,
        cadence: { kind: 'daily', time: '09:00' },
        enabled: false,
        createdAt: Date.now(),
        toolAccess: 'read-only'
      }
      await window.electronAPI.schedulerUpsert(run)
      setView('scheduled')
    },
    [defaultModel, defaultAccountId]
  )

  // Rooms view: deploy an agent into a room (project folder) with a first prompt.
  // Builds the session exactly like runAgent does (agent's run options carried onto the
  // session) but — unlike runAgent — immediately fires the prompt, and stays on the Rooms
  // view instead of switching to chat, so the user watches the chip appear and pulse.
  const deployAgent = (agent: AgentDef, projectPath: string | undefined, prompt: string) => {
    const text = prompt.trim()
    if (!text) return

    const s: Session = {
      id: generateId(),
      name: text.slice(0, 40),
      messages: [],
      projectPath,
      model: agent.model,
      agentId: agent.id,
      agentName: agent.name,
      accountId: defaultAccountId,
      systemPrompt: agent.systemPrompt,
      permissionMode: agent.permissionMode,
      allowedTools: agent.allowedTools,
      useMcp: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const userMsg: Message = { id: generateId(), role: 'user', content: text, timestamp: Date.now() }
    const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }

    // Guard: no auth → same treatment as startOverlayPrompt's blocked path — keep the
    // prompt visible as a failed turn (error + Retry from chat) instead of dropping it.
    if (!ready) {
      s.messages = [userMsg, { ...assistantMsg, content: 'Not signed in — connect Claude Code or an API key in Settings, then press Retry.', error: true }]
      setSessions((prev) => [s, ...prev])
      window.electronAPI.saveSession(s)
      return
    }

    s.messages = [userMsg, assistantMsg]
    setSessions((prev) => [s, ...prev])
    // Deliberately no setActiveId/setView('chat') here — stay in Rooms so the new
    // occupant chip appears and starts pulsing in place.
    startRun(s.id)
    setTerminalOpen(true)
    addTermFor(s.id, { kind: 'user', text: text.slice(0, 120) })

    window.electronAPI.sendAgent(buildAgentPayload(s, text))
  }

  const handleSetDefaultModel = async (modelId: string) => {
    setDefaultModel(modelId)
    await window.electronAPI.setDefaultModel(modelId)
  }

  const updateUi = async (patch: UiPrefsPatch) => {
    const next = await window.electronAPI.setUiPrefs(patch)
    setUi(next)
    applyUi(next)
  }

  // Global Ctrl/Cmd-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createSessionRef.current()
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
    items.push({ id: 'new', title: 'New chat', group: 'Actions', subtitle: '⌘N', run: createSession })
    // Quick chat is Argos's own engine on the cheapest model — meaningless in terminal
    // mode, where the CLI chooses its own.
    if (workMode === 'chat') {
      items.push({ id: 'new-quick', title: 'Quick chat (cheapest model)', group: 'Actions', run: createQuickChat })
    }
    const views: { v: View; label: string }[] = [
      { v: 'chat', label: 'Chat' },
      { v: 'projects', label: 'Projects' },
      { v: 'agents', label: 'Agents' },
      { v: 'rooms', label: 'Rooms' },
      { v: 'planner', label: 'Planner' },
      { v: 'scheduled', label: 'Routines' },
      { v: 'usage', label: 'Usage' },
      { v: 'mcp', label: 'MCP' },
      { v: 'remote', label: 'Remote & WSL' }
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
    for (const m of models) {
      items.push({
        id: `model:${m.id}`,
        title: `Use ${m.label}`,
        subtitle: 'this chat',
        group: 'Switch model',
        run: () => setSessionModel(activeId, m.id)
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
  }, [sessions, models, accounts, workMode, activeId])

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

  // Everything a chat pane needs from the App, shared by every pane. A plain object,
  // not a useMemo: most of the actions below are plain consts rebuilt on every render,
  // so memoizing would compare thirty-odd references to never once skip the rebuild.
  // Omitting deps to buy a stable identity would be worse than useless — a stale api
  // binds a pane's actions to a session it no longer shows. If Chat is ever wrapped in
  // React.memo, make the actions stable first; only then does memoizing this pay.
  const paneApi: SessionPaneApi = {
    sessions,
    runningIds,
    approvalQueue,
    models,
    defaultModel,
    ready,
    workMode,
    terminalPrompts,
    newChatNonces,
    compacting,
    saveError,
    defaultAccountId,
    codexDefaultAccountId,
    geminiDefaultAccountId,
    sendMessage,
    stopRun,
    retryTurn,
    editAndResend,
    branchSession,
    patchSession,
    setSessionModel,
    toggleAutoApprove,
    toggleLightMode,
    compactSession,
    closeChatTerminal,
    openClaudeMd,
    openCheckpoints,
    openGit,
    exportSession,
    clearTerminalPrompt,
    onApproval: respondApprovalById,
    createSession,
    openSettings: () => setView('settings')
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
        onDismiss={dismissRun}
      />
      <div className="app">
        <NavRail
          view={view}
          onChange={goToView}
          onSettings={() => setView('settings')}
          onChangelog={() => setChangelogOpen(true)}
          serverSessionCount={serverSessions.length}
          chatRunningCount={displayRunningIds.size}
          attentionCount={approvalQueue.length}
        />

      {view === 'chat' && (
        <>
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            runningIds={displayRunningIds}
            attentionIds={attentionIds}
            tab={sidebarTab}
            onTabChange={setSidebarTab}
            mode={workMode}
            onSelectSession={setActiveId}
            onNewSession={createSession}
            onNewQuickChat={createQuickChat}
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
            selectedAccountId={scopeAccountId}
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
          <div className="main-area">
            {!activeSession ? (
              /* No chat open yet: the composer/chat header only appear once the user
                 explicitly starts or picks a chat. */
              <div className="welcome-pane">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.5" />
                  <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <h2>How can I help?</h2>
                <p>
                  {workMode === 'terminal'
                    ? 'Start a new terminal, or pick a chat from the sidebar.'
                    : 'Start a new chat, or pick one from the sidebar.'}
                </p>
                <div className="welcome-actions">
                  <button className="btn-primary" onClick={createSession}>
                    {workMode === 'terminal' ? 'New terminal' : 'New chat'}
                  </button>
                  {workMode === 'chat' && (
                    <button className="welcome-quick" onClick={createQuickChat}>Quick chat</button>
                  )}
                </div>
              </div>
            ) : (
            <>
            {budgetBanners.length > 0 && (
              <div className="budget-banner">
                {budgetBanners.map((msg, i) => (
                  <div key={i} className="budget-banner-item">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    {msg}
                  </div>
                ))}
                <button className="budget-banner-close" onClick={() => setBudgetBanners([])} aria-label="Dismiss">✕</button>
              </div>
            )}
            <ChatPane sessionId={activeId} api={paneApi} />
            <TerminalPanel
              lines={terminalLines}
              open={terminalOpen}
              onToggle={() => setTerminalOpen((v) => !v)}
              onClear={() => setTerminalLines([])}
            />
            </>
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
            plans={homePlans}
            spend={homeSpend}
            routines={homeRoutines}
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
            onOpenUsage={() => setView('usage')}
            onOpenScheduled={() => setView('scheduled')}
          />
        </Suspense>
      )}
      {view === 'projects' && (
        <Suspense fallback={<ViewLoading />}>
          <ProjectsView onResume={resumeCCSession} target={ccTarget} focus={projectFocus} />
        </Suspense>
      )}
      {view === 'live' && (
        <Suspense fallback={<ViewLoading />}>
          <LiveView />
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
      {activeGroup && view !== 'remote-session' && (
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
            {view === 'agents' && <AgentsView models={models} defaultModel={defaultModel} onRun={runAgent} />}
            {view === 'rooms' && (
              <RoomsView
                sessions={sessions}
                runningIds={runningIds}
                attentionIds={attentionIds}
                approvals={approvalQueue}
                onRespondApproval={respondApprovalById}
                onOpenSession={(id) => {
                  setActiveId(id)
                  setView('chat')
                }}
                onOpenAgentsView={() => setView('agents')}
                onDeploy={deployAgent}
              />
            )}
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
                onRunTask={runPlannerTask}
                onStandupChat={startStandupChat}
                onScheduleStandup={createStandupRoutine}
              />
            )}
            {view === 'scheduled' && (
              <ScheduledView
                models={models}
                defaultModel={defaultModel}
                accounts={accounts}
                defaultAccountId={defaultAccountId}
              />
            )}
            {view === 'mcp' && <McpView />}
            {view === 'remote' && (
              <RemoteView
                onConnect={connectRemote}
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
      {claudeMdSession && (
        <ClaudeMdModal
          projectPath={claudeMdSession.projectPath}
          provider={providerOf(claudeMdSession)}
          onClose={() => setClaudeMdFor(null)}
        />
      )}
      {/* Suppressed only where Chat renders the same request inline — which it does in
          chat mode alone. In terminal mode the chat pane is a terminal, so a run Argos
          itself is driving (Planner, Rooms, a routine) has nowhere else to ask. */}
      {view !== 'rooms' && approvalQueue.length > 0 && !(view === 'chat' && workMode === 'chat' && visibleIds.has(approvalQueue[0].appSessionId)) && (
        <ApprovalModal request={approvalQueue[0]} onDecide={respondApproval} />
      )}
      {openFilePath && (
        <FileEditor
          filePath={openFilePath}
          onClose={() => setOpenFilePath(null)}
          read={readLocalFile}
          write={writeLocalFile}
        />
      )}
      {checkpointsSession && (
        <CheckpointsModal
          sessionId={checkpointsSession.id}
          trackedFileCount={trackedFiles(checkpointsSession.id).length}
          onClose={() => setCheckpointsFor(null)}
          onCreate={(label) => createCheckpoint(checkpointsSession, label)}
          onRestored={() => addTerm({ kind: 'info', text: 'files restored from checkpoint' })}
        />
      )}
      {gitSession && (
        <GitModal cwd={gitSession.projectPath ?? ''} onClose={() => setGitFor(null)} />
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
      </div>
    </div>
  )
}
