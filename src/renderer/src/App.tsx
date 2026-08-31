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
  CcSessionTarget
} from './types'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import ResizeHandles from './components/ResizeHandles'
import Chat from './components/Chat'
import TerminalPanel from './components/TerminalPanel'
import SettingsModal from './components/SettingsModal'
import NavRail, { ALL_VIEWS, View, VIEW_GROUPS, groupOwnsView } from './components/NavRail'
import ServerTabs from './components/ServerTabs'
import ClaudeMdModal from './components/ClaudeMdModal'
import ApprovalModal from './components/ApprovalModal'
import PendingRuns, { PendingRun } from './components/PendingRuns'
import FileEditor from './components/FileEditor'
import { readLocalFile, writeLocalFile } from './lib/local-file-io'
import { installEditingKeys } from './lib/clipboard-paste'
import TextContextMenu from './components/TextContextMenu'
import { applyPalette } from './lib/palettes'
import CheckpointsModal from './components/CheckpointsModal'
import GitModal from './components/GitModal'
import CommandPalette, { CommandItem } from './components/CommandPalette'
import OnboardingModal from './components/OnboardingModal'
import AccountsModal from './components/AccountsModal'
import ChangelogModal from './components/ChangelogModal'
import { UiPrefs } from './types'
import { sessionToReplaySeed } from './lib/markdown-export'
import { provOf, acctOf, AccountDefaults } from './lib/account-scope'
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

function applyUi(ui: UiPrefs) {
  const root = document.documentElement
  applyPalette(root, ui.theme, ui.palette)
  root.dataset.density = ui.density
  const zoom = ui.fontSize === 'sm' ? 0.9 : ui.fontSize === 'lg' ? 1.12 : 1
  window.electronAPI.setZoom(zoom)
}

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
  const [activeId, setActiveId] = useState<string>('')
  const [compacting, setCompacting] = useState(false)
  // Per-session run state: each id in the set has an agent run in flight. The main
  // process already routes concurrent runs by appSessionId, so the renderer only
  // needs to track which sessions are busy (no global mutex). Always update
  // immutably via `new Set(prev)`.
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [terminalLines, setTerminalLines] = useState<TermLine[]>([])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [claudeMdOpen, setClaudeMdOpen] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'sessions'>('sessions')
  // File opened from the sidebar's Files tab, shown in the FileEditor modal.
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  // Chats the user hid from the pending-requests bar; cleared per id when that run ends.
  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(new Set())
  // Bumped every time we deliberately land on a new chat, so Chat can bring the composer
  // forward even when the "open new chats in" pref is Terminal (see Chat's effect).
  const [newChatNonce, setNewChatNonce] = useState(0)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [view, setView] = useState<View>('chat')
  // A conversation named by a notification click (`argos://session`). Held here
  // rather than passed straight through so a second click on the same conversation
  // still re-opens it: the object identity is what ProjectsView reacts to.
  const [ccTarget, setCcTarget] = useState<CcSessionTarget | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [defaultModel, setDefaultModel] = useState('claude-opus-4-8')
  const [ui, setUi] = useState<UiPrefs | null>(null)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
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
    setRunningIds((prev) => {
      const next = new Set(prev)
      next.add(sid)
      return next
    })
  }, [])
  const endRun = useCallback((sid: string) => {
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

  const activeSession = sessions.find((s) => s.id === activeId)
  // The open file belongs to the chat's project tree, so it goes stale the moment we point at
  // a different folder or leave the chat view (where the Files tab lives) entirely.
  const activeProjectPath = activeSession?.projectPath
  useEffect(() => {
    setOpenFilePath(null)
  }, [activeProjectPath, view])
  // "Is the currently-focused session streaming?" — replaces the old global `streaming`
  // boolean wherever it gated the active chat's UI.
  const activeStreaming = activeSession ? runningIds.has(activeSession.id) : false
  // Sessions with a pending approval — drives the amber sidebar dot.
  const attentionIds = useMemo(
    () => new Set(approvalQueue.map((r) => r.appSessionId)),
    [approvalQueue]
  )
  // Chats still working, for the window-wide pending bar. The chat you're already looking at
  // is left out — its own header already shows it streaming, so listing it is just noise.
  const pendingRuns = useMemo<PendingRun[]>(
    () =>
      sessions
        .filter(
          (s) =>
            runningIds.has(s.id) &&
            !dismissedRunIds.has(s.id) &&
            !(view === 'chat' && s.id === activeId)
        )
        .map((s) => ({ id: s.id, name: s.name, attention: attentionIds.has(s.id) })),
    [sessions, runningIds, dismissedRunIds, attentionIds, view, activeId]
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
      if (saved.length > 0) {
        setSessions(saved)
        setActiveId(saved[0].id)
      }
    }
    init()
  }, [refreshAuth, refreshAccounts])

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
            cacheCreationTokens: (s.cacheCreationTokens ?? 0) + (data.cacheCreationTokens ?? 0)
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
      text: string,
      images?: { mediaType: string; data: string }[],
      files?: { name: string; content: string }[],
      imageThumbnails?: string[]
    ) => {
      const session = sessions.find((s) => s.id === activeIdRef.current)
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
  const retryTurnRef = useRef<() => void>(() => {})
  const retryTurn = useCallback(() => {
    const sid = activeIdRef.current
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
    (messageId: string, newText: string) => {
      if (!newText.trim()) return
      const sid = activeIdRef.current
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
    (payload: { prompt: string; quick?: boolean }) => {
      const prompt = payload.prompt.trim()
      if (!prompt) return
      const base = sessionsRef.current.find((s) => s.id === activeIdRef.current)
      const s = newSession(
        base?.projectPath,
        payload.quick ? 'claude-haiku-4-5' : defaultModel,
        base?.accountId ?? defaultAccountId
      )
      s.name = prompt.slice(0, 40)

      const userMsg: Message = { id: generateId(), role: 'user', content: prompt, timestamp: Date.now() }
      const assistantMsg: Message = { id: generateId(), role: 'assistant', content: '', toolCalls: [], timestamp: Date.now() }

      // Each overlay prompt starts a FRESH session, so other in-flight runs no longer
      // block it — concurrent runs are supported. Only missing auth blocks.
      const blocked = !ready
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
    [defaultModel, defaultAccountId, ready, startRun, addTermFor, buildAgentPayload]
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
  const stopMessage = useCallback(async () => {
    const sid = activeIdRef.current
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
      setNewChatNonce((n) => n + 1)
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
    // the same way it does when goToNewChat lands you here.
    setNewChatNonce((n) => n + 1)
  }
  createSessionRef.current = createSession

  // Coming back to the chat view from elsewhere should land on a new chat rather than dropping
  // you back into whatever happened to be open last. An existing empty draft is reused so
  // bouncing between views doesn't pile up blank chats in the sidebar.
  const goToNewChat = () => {
    // createSession now does the draft reuse itself, for every entry point.
    createSession()
  }

  // Navigation from the nav rail / command palette, as opposed to the setView calls that
  // already pick a specific chat to land on (createSession, pickAccount, deployAgent, …).
  const goToView = (v: View) => {
    if (v === 'chat' && view !== 'chat') {
      goToNewChat()
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
      setNewChatNonce((n) => n + 1)
      return
    }
    const s = newSession(activeSession?.projectPath, model, activeSession?.accountId ?? defaultAccountId)
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setView('chat')
    setNewChatNonce((n) => n + 1)
  }

  const deleteSession = async (id: string) => {
    // Chat terminals outlive their pane (see ChatTerminal's effect cleanup), so deleting the
    // chat is what finally tears its pty down — otherwise it would linger until app quit.
    await window.electronAPI.terminalKill(`chatterm_${id}`)
    await window.electronAPI.deleteSession(id)
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      // Deleting the last chat lands back on the welcome pane — no auto-draft.
      if (activeId === id) setActiveId(next.length > 0 ? next[0].id : '')
      return next
    })
  }

  const setSessionProject = (path: string) => {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, projectPath: path } : s)))
  }

  // Patch the active draft session from the new-chat config bar (folder, environment,
  // extra dirs, worktree toggle). Only meaningful before the first message is sent.
  const patchActiveSession = (patch: Partial<Session>) => {
    let patched: Session | undefined
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeIdRef.current) return s
        patched = { ...s, ...patch }
        return patched
      })
    )
    // A chat driven purely from the embedded terminal never goes through the normal
    // agent:send → saveSession path, so without this it'd vanish on restart even after
    // hasTerminalActivity makes it visible in the sidebar for the rest of this run.
    if (patch.hasTerminalActivity && patched) window.electronAPI.saveSession(patched)
  }

  const setSessionModel = (modelId: string) => {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, model: modelId } : s)))
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
  const activeChatProvider: ProviderId =
    models.find((m) => (activeSession?.model || defaultModel).startsWith(m.id))?.provider ?? 'claude'
  const activeChatAccountId =
    activeChatProvider === 'codex'
      ? (activeSession?.codexAccountId ?? codexDefaultAccountId)
      : activeChatProvider === 'gemini'
        ? (activeSession?.geminiAccountId ?? geminiDefaultAccountId)
        : (activeSession?.accountId ?? defaultAccountId)
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
    setNewChatNonce((n) => n + 1)
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
    // Otherwise land on a new chat on the picked account rather than reopening an old one:
    // repurpose the active empty draft onto this account, else start a fresh chat.
    if (active && active.messages.length === 0) {
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, model: providerModel, ...acctFields } : s)))
    } else {
      const s = newSession(activeSession?.projectPath, providerModel, provider === 'claude' ? accountId : defaultAccountId)
      Object.assign(s, acctFields)
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
    }
    setView('chat')
  }

  const toggleAutoApprove = () => {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, autoApprove: !s.autoApprove } : s)))
  }

  const toggleLightMode = () => {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, lightMode: !s.lightMode } : s)))
  }

  // Summarize the current (long) session and start a FRESH one seeded with the summary as
  // system context — so each turn re-sends a compact brief instead of the whole transcript.
  const compactSession = async () => {
    if (!activeSession || compacting) return
    setCompacting(true)
    const transcript = activeSession.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    const res = await window.electronAPI.summarizeChat({
      transcript,
      model: activeSession.model || defaultModel,
      accountId: activeSession.accountId ?? defaultAccountId
    })
    setCompacting(false)
    if (!res.ok || !res.summary) {
      addTerm({ kind: 'error', text: res.error || 'Compaction failed.' })
      return
    }
    const s = newSession(
      activeSession.projectPath,
      activeSession.model || defaultModel,
      activeSession.accountId ?? defaultAccountId
    )
    s.name = activeSession.name
    s.lightMode = activeSession.lightMode
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
  const branchSession = (messageId: string) => {
    const parent = sessionsRef.current.find((s) => s.id === activeIdRef.current)
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

  const createCheckpoint = async (label: string) => {
    if (!activeSession) return
    await window.electronAPI.checkpointCreate(
      activeSession.id,
      label,
      trackedFiles(activeSession.id),
      activeSession.messages.length
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
    s.autoApprove = true // remote runs are headless; no interactive approval channel
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
    s.autoApprove = true
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

  const updateUi = async (patch: Partial<UiPrefs>) => {
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
    items.push({ id: 'new-quick', title: 'Quick chat (cheapest model)', group: 'Actions', run: createQuickChat })
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
    items.push({ id: 'settings', title: 'Open Settings', group: 'Views', run: () => setSettingsOpen(true) })
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
        run: () => setSessionModel(m.id)
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
  }, [sessions, models, accounts])

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
          onSettings={() => setSettingsOpen(true)}
          onChangelog={() => setChangelogOpen(true)}
          serverSessionCount={serverSessions.length}
        />

      {view === 'chat' && (
        <>
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            runningIds={runningIds}
            attentionIds={attentionIds}
            tab={sidebarTab}
            onTabChange={setSidebarTab}
            onSelectSession={setActiveId}
            onNewSession={createSession}
            onNewQuickChat={createQuickChat}
            onDeleteSession={deleteSession}
            projectPath={activeSession?.projectPath}
            onSetProject={setSessionProject}
            onOpenFile={setOpenFilePath}
            openFilePath={openFilePath ?? undefined}
            onOpenSettings={() => setSettingsOpen(true)}
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
                <p>Start a new chat, or pick one from the sidebar.</p>
                <div className="welcome-actions">
                  <button className="btn-primary" onClick={createSession}>New chat</button>
                  <button className="welcome-quick" onClick={createQuickChat}>Quick chat</button>
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
            <Chat
              session={activeSession}
              streaming={activeStreaming}
              onSendMessage={sendMessage}
              onStop={stopMessage}
              onOpenSettings={() => setSettingsOpen(true)}
              ready={ready}
              models={models}
              currentModel={activeSession?.model || defaultModel}
              onModelChange={setSessionModel}
              terminalProvider={activeChatProvider}
              terminalAccountId={activeChatAccountId}
              defaultChatView={ui?.defaultChatView ?? 'chat'}
              newChatNonce={newChatNonce}
              onOpenClaudeMd={() => setClaudeMdOpen(true)}
              autoApprove={activeSession?.autoApprove ?? false}
              onToggleAutoApprove={toggleAutoApprove}
              lightMode={activeSession?.lightMode ?? false}
              onToggleLightMode={toggleLightMode}
              onStartFresh={createSession}
              onCompact={compactSession}
              compacting={compacting}
              onOpenCheckpoints={() => setCheckpointsOpen(true)}
              onOpenGit={() => setGitOpen(true)}
              onRetry={retryTurn}
              onEditResend={editAndResend}
              onBranch={branchSession}
              onExportSession={(format) => {
                if (activeSession) window.electronAPI.exportSession(activeSession, format)
              }}
              onPatchSession={patchActiveSession}
            />
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

      {view === 'projects' && (
        <Suspense fallback={<ViewLoading />}>
          <ProjectsView onResume={resumeCCSession} target={ccTarget} />
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

      {settingsOpen && (
        <SettingsModal
          auth={auth}
          models={models}
          defaultModel={defaultModel}
          onSetDefaultModel={handleSetDefaultModel}
          ui={ui}
          onSetUi={updateUi}
          onClose={() => setSettingsOpen(false)}
          onChanged={refreshAuth}
          onManageAccounts={() => {
            setSettingsOpen(false)
            setAccountsOpen(true)
          }}
        />
      )}
      {ui && !ui.onboarded && (
        <OnboardingModal
          onFinish={async () => {
            await updateUi({ onboarded: true })
            await refreshAuth()
          }}
        />
      )}
      {claudeMdOpen && (
        <ClaudeMdModal
          projectPath={activeSession?.projectPath}
          provider={activeChatProvider}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
      {view !== 'rooms' && approvalQueue.length > 0 && (
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
      {checkpointsOpen && activeSession && (
        <CheckpointsModal
          sessionId={activeSession.id}
          trackedFileCount={trackedFiles(activeSession.id).length}
          onClose={() => setCheckpointsOpen(false)}
          onCreate={createCheckpoint}
          onRestored={() => addTerm({ kind: 'info', text: 'files restored from checkpoint' })}
        />
      )}
      {gitOpen && (
        <GitModal cwd={activeSession?.projectPath ?? ''} onClose={() => setGitOpen(false)} />
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
