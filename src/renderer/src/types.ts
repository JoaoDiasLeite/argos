export interface ToolCall {
  id: string
  tool: string
  input: unknown
  result?: string
  isError?: boolean
}

export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  timestamp: number
  /** Set when this assistant turn ended in an error. */
  error?: boolean
  /** Token usage for this assistant turn (shown under the message). */
  usage?: MessageUsage
  /**
   * Choices the owner made in an `AskUserQuestion`. When present this turn is the
   * decision itself — drawn as one, not as the output of a tool.
   */
  decisions?: AskDecision[]
}

export interface Session {
  id: string
  name: string
  messages: Message[]
  projectPath?: string
  /** Claude Code engine session id, used to resume the conversation. */
  claudeSessionId?: string
  /** Model override for this session (falls back to the global default). */
  model?: string
  /** If launched from a CC Agent, the agent's run options. */
  agentId?: string
  agentName?: string
  systemPrompt?: string
  permissionMode?: PermissionMode
  allowedTools?: string[]
  useMcp?: boolean
  /** When true, skip per-tool approval prompts (auto-accept). */
  autoApprove?: boolean
  /** Light chat mode: send no tools (allowedTools:[]) to cut per-turn token cost. */
  lightMode?: boolean
  /** If set, this chat runs on a remote SSH host instead of locally. */
  remoteHostId?: string
  remoteHostName?: string
  /** If set, this chat runs inside this WSL distro. */
  wslDistro?: string
  /** Extra working directories exposed to the engine (Claude Code --add-dir). */
  additionalDirs?: string[]
  /** Run this chat inside a fresh git worktree of projectPath. */
  useWorktree?: boolean
  /** Resolved worktree cwd, created on first send so later turns reuse it. */
  worktreePath?: string
  /** Set once the embedded terminal has actually launched a CLI for this chat. Keeps a
   *  chat driven entirely from the terminal (no `messages`) visible in the sidebar and
   *  persisted to disk — see visibleSessions() in lib/account-scope.ts. */
  hasTerminalActivity?: boolean
  /** Which Claude Code account (login) this chat runs under. Undefined = default account. */
  accountId?: string
  accountName?: string
  /** Which Codex account this chat runs under, when its model is a Codex model. */
  codexAccountId?: string
  codexAccountName?: string
  /** Which Gemini account this chat runs under, when its model is a Gemini model. */
  geminiAccountId?: string
  geminiAccountName?: string
  /**
   * Set when this session was forked from another chat. Drives the "branched from …"
   * divider shown after the copied messages. `atMessageId` is the id of the last
   * copied message (the branch point) in this session's transcript.
   */
  branchedFrom?: { name: string; atMessageId: string }
  /** Accumulated usage across this chat's turns. */
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  createdAt: number
  updatedAt: number
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface TermLine {
  kind: 'user' | 'thinking' | 'tool' | 'result' | 'error' | 'info'
  text: string
}

export type ProviderId = 'claude' | 'codex' | 'gemini'

export interface ModelInfo {
  id: string
  label: string
  inputPrice: number
  outputPrice: number
  context: string
  provider: ProviderId
  /** True when this entry came from live catalog discovery, not our bundled/user data. */
  discovered?: boolean
}

export interface UsageLimits {
  hourUsd: number
  sessionUsd: number
  weekUsd: number
}

export interface UiPrefs {
  theme: 'dark' | 'light'
  /** Color palette id (see global.css [data-palette]). 'warm-rust' is the default. */
  palette: string
  density: 'comfortable' | 'compact'
  fontSize: 'sm' | 'md' | 'lg'
  onboarded: boolean
  /** Which panel new chats open in. */
  defaultChatView: 'chat' | 'terminal'
}

export interface SystemPrefs {
  openAtLogin: boolean
  startMinimized: boolean
  closeToTray: boolean
  /** Preferred quick-launcher accelerator. '' = automatic (Alt+Space with fallback). */
  overlayShortcut: string
  /** Add an "Open with Argos" entry to the Explorer folder right-click menu (HKCU). */
  explorerContextMenu: boolean
}

export interface AppConfig {
  defaultModel: string
  limits: UsageLimits
  ui: UiPrefs
  system: SystemPrefs
  claudeSettings: Record<string, unknown>
}

// ─── Scheduled Runs ─────────────────────────────────────────────────────────

export type ScheduledCadence =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string /* "HH:MM" */ }
  | { kind: 'weekly'; day: number /* 0=Sun..6=Sat */; time: string }

export interface ScheduledRun {
  id: string
  name: string
  prompt: string
  model?: string
  projectPath?: string
  accountId?: string
  cadence: ScheduledCadence
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastResult?: { ok: boolean; summary: string; costUsd: number; at: number }
  nextRunAt?: number
  /**
   * Explicit tool-access level for this routine.
   * 'read-only' → mutating tools (Bash, Write, Edit, etc.) are removed from context via disallowedTools.
   * 'full'      → no tool restriction.
   * Undefined (legacy) → treated as 'full'.
   */
  toolAccess?: 'read-only' | 'full'
  /** @deprecated Use toolAccess. Kept to read legacy saved data. */
  allowedTools?: string[]
}

export interface SourceAccount {
  email?: string
  org?: string
  plan?: string
}

export interface SourceInfo {
  id: string
  label: string
  kind: 'local' | 'wsl'
  distro?: string
  account?: SourceAccount
}

/**
 * A `claude` process running on this machine right now, as its own registry entry
 * reports it.
 *
 * Claude Code writes one `<pid>.json` per live session under `<claude-root>/sessions`,
 * and that file — not a scan of the process table — is where every field here comes
 * from. Argos never guesses which process is a session.
 */
export interface LiveSession {
  pid: number
  /** The conversation this process is holding — the same id its transcript carries. */
  sessionId: string
  cwd: string
  /** The registry's own name for the session, e.g. `claude-gui-26`. */
  name: string
  /** Absent in the registry for a session that has not reported one yet. */
  status: 'busy' | 'idle' | 'unknown'
  kind: string
  version?: string
  startedAt: number
  updatedAt: number
  /** Which Claude root this entry was found under. */
  sourceId: string
  sourceLabel: string
  /**
   * The entry's `pidDomain` does not match this process's own, so its `pid` is a
   * number from another PID space — a distro's, or another user's.
   *
   * It is listed, because knowing the session is live is useful. It can never be
   * signalled: the same number on this side belongs to an unrelated process, and
   * that is the worst mistake this feature could make.
   */
  foreign: boolean
}

/**
 * Why a takeover was refused. Nine reasons rather than one boolean, because they
 * mean genuinely different things to whoever is reading: one needs a refresh, one
 * will never work, and one means the pid was recycled and something else holds it.
 */
export type TakeoverRefusal =
  | 'not-found'
  | 'foreign'
  | 'pid-changed'
  | 'no-proc-start'
  | 'not-running'
  | 'unverifiable'
  | 'pid-reused'
  | 'not-claude'
  | 'failed'

export type TakeoverResult =
  | { ok: true; pid: number }
  | { ok: false; error: TakeoverRefusal; detail?: string }

export interface CCProject {
  encodedDir: string
  realPath: string
  name: string
  /** Transcripts sitting directly in the project directory. */
  sessionCount: number
  /** Transcripts in the project's `archived/` subdirectory. */
  archivedCount: number
  lastActive: number
  sourceId: string
  sourceLabel: string
  kind: 'local' | 'wsl'
  distro?: string
  account?: SourceAccount
  /**
   * Filed away by the user — a preference, not a directory. Orthogonal to archiving
   * a *session*, which moves a file.
   */
  archived: boolean
}

/**
 * What a project-level operation answers with.
 *
 * A conflict is a value, not a thrown error: each one needs a different move in the
 * UI, and a `catch` flattens them into one failure. `not-empty` carries the count so
 * the refusal can say what it is protecting.
 */
/**
 * Why a folder change was refused. Each one is a different sentence in the UI, and a
 * single 'failed' would have flattened nine distinct refusals into one shrug.
 */
export type ProjectMoveRefusal =
  | 'not-found'
  | 'invalid-target'
  | 'same-path'
  | 'target-inside-source'
  | 'target-exists'
  | 'no-parent'
  | 'cross-volume'
  | 'encoded-collision'
  | 'busy'
  | 'failed'

/**
 * The result of changing a project's folder.
 *
 * `warnings` is the honest part: the two renames either both happen or both roll
 * back, but re-keying the source's `.claude.json` and the app's own preferences is
 * best-effort — a failure there leaves a working project with a stale pin, not a
 * broken one, and saying so beats pretending it went perfectly.
 */
export type ProjectMoveResult =
  | { ok: true; encodedDir: string; realPath: string; warnings: string[] }
  | { ok: false; error: ProjectMoveRefusal; detail?: string }

export type ProjectOpResult =
  | { ok: true }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'not-empty'; sessions: number; archived: number }
  | { ok: false; error: 'failed'; message: string }

export interface CCSessionMeta {
  sessionId: string
  encodedDir: string
  realPath: string
  title: string
  preview: string
  messageCount: number
  model?: string
  createdAt: number
  updatedAt: number
  sourceId: string
  kind: 'local' | 'wsl'
  distro?: string
  /** Effective tag set — the last `custom-tags` entry in the transcript wins. */
  tags: string[]
  /**
   * The preview adds nothing over the title, or is an opening shared by enough
   * sessions in this project to be a template rather than a subject. Don't render it.
   */
  previewRedundant: boolean
  /** Sitting in the project's `archived/` subdirectory rather than beside it. */
  archived: boolean
}

/**
 * Just enough of a conversation to decide whether to reopen it. `last` is the one
 * that answers the question — where it stopped, not how it opened.
 */
/** Outcome of an archive / rename / move / delete. Conflicts come back as values. */
export type LifecycleResult =
  | { ok: true }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'exists' }
  | { ok: false; error: 'failed'; message: string }

export interface SessionPeek {
  first: string
  last: string
  lastRole: 'user' | 'assistant'
  costUsd: number
}

/** Label name → colour, plus the palette new labels are drawn from. */
export interface LabelRegistry {
  palette: string[]
  labels: Record<string, string>
}

export type SetTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'invalid'; message: string }

/**
 * Renaming onto an existing label is a merge, and a merge loses a label nobody
 * asked to lose — so it comes back as a conflict the UI turns into an explicit offer.
 * `failed > 0` means the sweep was partial and the registry was left untouched.
 */
export type LabelRenameResult =
  | { ok: true; renamed: number; failed: number }
  | { ok: false; error: 'label-exists'; target: string; count: number }

export interface SearchSnippet {
  kind: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  before: string
  match: string
  after: string
}

export interface SearchHit {
  sessionId: string
  encodedDir: string
  realPath: string
  projectName: string
  title: string
  snippet: string
  updatedAt: number
  model?: string
  sourceId: string
  kind: 'local' | 'wsl'
  distro?: string
  account?: SourceAccount
  /** Every occurrence, not just the ones a snippet was cut for. */
  matchCount: number
  /** The first few hits with their surroundings and the kind of text they sit in. */
  snippets: SearchSnippet[]
}

/**
 * One question the owner answered mid-task, read back out of an `AskUserQuestion`
 * pair. `rejected` is derived from the options, not parsed.
 */
export interface AskDecision {
  question: string
  header: string
  chosen: string[]
  /** Free text the owner typed — the "Other" option. */
  custom: string | null
  rejected: string[]
}

export interface CCTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolCalls: { id: string; tool: string; input: unknown; result?: string; isError?: boolean }[]
  timestamp: number
  /** Choices the owner made, on a turn of his own. */
  decisions?: AskDecision[]
}

export interface UsageEntry {
  day: string
  model: string
  project: string
  source: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  costUsd: number
}

export interface UsageWindows {
  hour: { costUsd: number; tokens: number }
  session: { costUsd: number; tokens: number }
  week: { costUsd: number; tokens: number }
}

export interface UsageReport {
  entries: UsageEntry[]
  windows: UsageWindows
  generatedAt: number
}

// Real plan usage from Anthropic's (undocumented) oauth/usage endpoint — the same
// method community HUDs use. See src/main/plan-usage.ts.
export interface PlanWindow {
  key: string
  label: string
  /** 0–100. */
  utilization: number
  resetsAt?: string
}

export type PlanStatus = 'ok' | 'no-credentials' | 'unauthorized' | 'rate-limited' | 'error'

/** Real plan usage for a single account/login (see src/main/plan-usage.ts). */
export interface AccountPlanUsage {
  /** Environments this login is present in (e.g. ['Local', 'Ubuntu-DevOps']). */
  envs?: string[]
  /** True when this identity includes the machine-default login. */
  isDefault?: boolean
  /** Managed account ids (accounts.ts) sharing this identity — matches `Session.accountId`. */
  accountIds?: string[]
  /** 'default' | account id | 'wsl:<distro>' */
  accountKey: string
  /** Display name: the account name, or the distro name for WSL sources. */
  accountName: string
  email?: string
  status: PlanStatus
  error?: string
  /** True when `windows` is carried over from an older successful fetch. */
  stale?: boolean
  subscriptionType?: string
  rateLimitTier?: string
  fetchedAt: number
  windows: PlanWindow[]
}

/** Codex plan-usage badge data for one account (see src/main/codex-usage.ts) — the
 *  Codex analog of AccountPlanUsage/PlanWindow above, but a single window (Codex's
 *  `account/rateLimits/read` reports one primary window, not several named ones). */
export interface CodexAccountUsage {
  /** 0–100. */
  utilization: number
  resetsAt?: string
  windowMinutes?: number
  planType?: string
}

export interface PlanUsageReport {
  accounts: AccountPlanUsage[]
  /** accountKey of the entry ambient UI should feature. */
  primary?: string
  generatedAt: number
}

// Compatibility alias for the pre-multi-account renderer (UsageView still consumes a
// single account's shape). Batch B migrates the renderer to PlanUsageReport directly.

export interface McpServer {
  name: string
  scope: 'global' | 'project'
  /** Where it's defined: 'local' or a WSL distro name. */
  source: string
  projectPath?: string
  transport: 'stdio' | 'sse' | 'http' | 'unknown'
  command?: string
  args?: string[]
  url?: string
  needsAuth: boolean
  config: Record<string, unknown>
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface AgentDef {
  id: string
  name: string
  icon: string
  systemPrompt: string
  model: string
  permissionMode: PermissionMode
  allowedTools: string[]
  defaultProjectPath?: string
  createdAt: number
  updatedAt: number
}

/** A candidate agent proposed by `agentsSuggest`, from history analysis. Not yet a real AgentDef. */
export interface AgentSuggestion {
  name: string
  icon: string
  systemPrompt: string
  allowedTools: string[]
  reason: string
}

export interface AgentsSuggestResult {
  ok: boolean
  data?: { suggestions: AgentSuggestion[] }
  error?: string
  costUsd: number
}

export interface ClaudeMdFile {
  scope: string
  path: string
  exists: boolean
  content: string
}

// ─── Claude permissions & hooks (from ~/.claude/settings.json) ────────────────

export interface WriteResult {
  ok: boolean
  error?: string
}

export interface ClaudePermissions {
  allow: string[]
  deny: string[]
  ask: string[]
}

export interface ClaudeHookCommand {
  type: 'command'
  command: string
}

export interface ClaudeHookEntry {
  matcher?: string
  hooks: ClaudeHookCommand[]
}

export type ClaudeHooks = Record<string, ClaudeHookEntry[]>

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
  'UserPromptSubmit',
  'SessionStart'
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface CheckpointMeta {
  id: string
  sessionId: string
  label: string
  createdAt: number
  messageCount: number
  fileCount: number
}

export interface RestoreResult {
  restored: number
  safetyCheckpointId: string | null
}

export interface CheckpointFileDiff {
  path: string
  before: string
  after: string
}

export interface CheckpointDiff {
  files: CheckpointFileDiff[]
}

export interface GitFile {
  path: string
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  files: GitFile[]
  ahead: number
  behind: number
}

export interface ImageAttachment {
  kind: 'image'
  mediaType: string
  data: string
  preview: string
}

export interface FileAttachment {
  kind: 'file'
  name: string
  size: number
  /** Full text content, delivered inline with the prompt (not persisted on the Message). */
  content: string
}

export type Attachment = ImageAttachment | FileAttachment

export type SshAuthType = 'password' | 'key' | 'agent'

export interface SshHostPublic {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKeyPath?: string
  remotePath?: string
  claudePath?: string
  hasSecret: boolean
}

export interface SshHostInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  remotePath?: string
  claudePath?: string
}

export interface SshKeyInfo {
  name: string
  privatePath: string
  publicPath?: string
  type?: string
  comment?: string
  publicKey?: string
}

export type GenerateKeyResult = { ok: true; key: SshKeyInfo } | { ok: false; error: string }

/** One entry from an `sftpList` directory listing (see src/main/sftp.ts). */
export interface RemoteEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  mtime: number
}

export interface WslDistro {
  name: string
  isDefault: boolean
  /** The distro's VM is up right now (`wsl -l -v` STATE column). Not the same as
   *  "reachable" — a stopped distro still works, WSL just boots it on connect. */
  running: boolean
}

/** The Remote Session ("Connect") view's target — an SSH host or a WSL distro. */
export type RemoteTarget = { kind: 'ssh'; host: SshHostPublic } | { kind: 'wsl'; distro: string }

export interface RoomsLayout {
  /** Room keys (project path, or '__unassigned__') in the user's preferred order. */
  order: string[]
  /** Room key -> custom display name, overriding the default folder-name label. */
  names: Record<string, string>
}

export type AuthMode = 'claude-code' | 'api-key'

export interface AuthStatus {
  mode: AuthMode
  claudeCodeDetected: boolean
  hasApiKey: boolean
}

export interface CCAccountStatus {
  id: string
  name: string
  configDir: string | null
  isDefault: boolean
  loggedIn: boolean
  email?: string
  org?: string
  plan?: string
}

export interface AccountList {
  accounts: CCAccountStatus[]
  defaultAccountId: string
}

export interface AgentCliStatus {
  id: 'codex' | 'gemini'
  installed: boolean
  loggedIn: boolean
  detail?: string
  email?: string
  plan?: string
}

export type AgentProvider = 'codex' | 'gemini'

export interface ProviderAccountStatus {
  id: string
  name: string
  provider: AgentProvider
  configDir: string | null
  isDefault: boolean
  loggedIn: boolean
  email?: string
  plan?: string
}

export interface ProviderAccountList {
  accounts: ProviderAccountStatus[]
  defaultAccountId: string
}

/** Common shape AccountPicker renders — CCAccountStatus and ProviderAccountStatus
 *  both satisfy it structurally. */
export interface AccountOption {
  id: string
  name: string
  isDefault?: boolean
  loggedIn: boolean
  email?: string
  plan?: string
}

export type AgentEvent =
  | { appSessionId: string; kind: 'system'; claudeSessionId?: string; tools: string[] }
  | { appSessionId: string; kind: 'text'; content: string }
  | { appSessionId: string; kind: 'thinking'; content: string }
  | { appSessionId: string; kind: 'tool-use'; tool: string; input: unknown; toolId: string }
  | { appSessionId: string; kind: 'tool-result'; toolId: string; content: string; isError: boolean }

export interface AgentDone {
  appSessionId: string
  claudeSessionId?: string
  costUsd: number
  isError: boolean
  errorText?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface AgentError {
  appSessionId: string
  error: string
}

export interface ApprovalRequest {
  appSessionId: string
  approvalId: string
  tool: string
  input: Record<string, unknown>
}

// ─── Planner ──────────────────────────────────────────────────────────────────

export type Effort = 'light' | 'medium' | 'deep'

export interface WeeklyPriority {
  id: string
  title: string
  color: string
}

export interface PlannerTask {
  id: string
  title: string
  /** 0 = Monday … 6 = Sunday, or null for the unscheduled backlog. */
  day: number | null
  done: boolean
  priorityId?: string | null
  /** Start time, "HH:MM". */
  timeOfDay?: string | null
  /** End time, "HH:MM". */
  endTime?: string | null
  durationMin?: number | null
  effort?: Effort | null
  notes?: string | null
}

export interface SavedReview {
  id: string
  createdAt: number
  mode: 'review' | 'reflect'
  model?: string
  score?: number | null
  summary?: string
  warnings?: string[]
  suggestions?: { title: string; detail?: string }[]
  wins?: string[]
  misses?: string[]
  adjustments?: string[]
}

export interface WeekPlan {
  weekStart: string
  intention?: string
  priorities: WeeklyPriority[]
  tasks: PlannerTask[]
  reflection?: string
  reviews?: SavedReview[]
  createdAt: number
  updatedAt: number
}

export type PlannerAssistMode = 'review' | 'draft' | 'reflect' | 'rebalance' | 'import'

// ─── Backlog fused with the repo ──────────────────────────────────────────────
// Mirror of src/main/backlog.ts — keep both in sync.
//
// The week planner's tasks exist only in Argos. These are the `- [ ]` boxes already
// written in the project's own record, so they outlive the app and travel with the
// repo. When a project has one, that file is the truth and Argos's own unscheduled
// tasks are legacy.

/** One checkbox line in the primary record. */
export interface BacklogTopic {
  /**
   * 0-based line index in the file as it was last read — the address every edit
   * tries first. Text is only the fallback, because two identical lines make text
   * alone write to whichever came first.
   */
  line: number
  /** The text after the checkbox, trimmed. */
  title: string
  done: boolean
  /** Nearest heading above the line, or null when it sits before any. */
  section: string | null
  /** Leading whitespace, kept so an edit or a duplicate holds its nesting. */
  indent: string
}

export interface BacklogRecord {
  /** Absolute path of the primary record. */
  path: string
  /** Relative to the project root — what the UI names. */
  relPath: string
  topics: BacklogTopic[]
  /**
   * Unticked topics in the whole file. The real count, never the length of a list
   * the UI capped for display — a backlog that says 12 when it holds 40 is worse
   * than no count at all.
   */
  pending: number
  done: number
}

/** No record is a normal state, not an error: most projects do not keep one. */
export type BacklogReadResult =
  | { found: true; record: BacklogRecord }
  | { found: false; looked: string[] }

/**
 * Addressing one topic for a write. Index first, title as the fallback.
 */
export interface BacklogRef {
  line: number
  title: string
}

/**
 * Two conflicts, deliberately distinct. `stale` means the file moved under the view
 * and nothing matches any more — reload. `ambiguous` means more than one line
 * matches, which is exactly the case a text `findIndex` used to silently write to
 * the first of; it needs the user to say which, not a guess.
 */
export type BacklogWriteResult =
  | { ok: true; record: BacklogRecord }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'ambiguous'; matches: number }
  | { ok: false; error: 'no-record' }
  | { ok: false; error: 'failed'; message: string }

// ─── Memory diagnostics ───────────────────────────────────────────────────────
// Mirror of src/main/memory-diagnostic.ts — keep both in sync.
//
// Read-only by construction: there is no write counterpart to any of this, and there
// should not be. It reports what the three memory layers hold and what is missing;
// fixing a gap is the user's edit to make, in the file the report names.

export type MemoryLayerId = 'global' | 'project' | 'memories'

export interface MemoryLayer {
  id: MemoryLayerId
  label: string
  path: string
  exists: boolean
  /** Bytes for the two file layers; total bytes across the directory for `memories`. */
  bytes: number
  /** Files in the memory directory. Undefined for the single-file layers. */
  files?: number
}

export interface MemoryGap {
  layer: MemoryLayerId
  /** `warn` is something actually broken; `info` is something merely absent. */
  severity: 'info' | 'warn'
  message: string
}

export interface MemoryReport {
  projectPath?: string
  layers: MemoryLayer[]
  gaps: MemoryGap[]
  /** 0-100, derived from the layers present and the gaps found. */
  score: number
  checkedAt: number
}

// ─── Sprints (Scrum board / standups / burndown) ────────────────────────────────
// Mirror of src/main/sprints.ts — keep both in sync.

export type SprintStatus = 'planning' | 'active' | 'completed'
export type ItemStatus = 'todo' | 'in-progress' | 'done'

export interface SprintItem {
  id: string
  title: string
  notes?: string | null
  status: ItemStatus
  /** Story points. null/undefined = unestimated (counts as 0 in burndown). */
  points?: number | null
  createdAt: number
  /** Set the moment the item first enters 'done' — the burndown x-axis anchor. */
  completedAt?: number | null
  /** The status this item held before its current one — lets un-checking 'done' restore it. */
  prevStatus?: ItemStatus | null
}

/** Cached GitLab backfill so re-opening the importer doesn't re-hit the MCP each time. */
export interface SprintBackfillCache {
  fetchedAt: number
  project?: string
  projectUrl?: string
  source?: string
  note?: string
  openIssueCount?: number | null
  items: { title: string; points?: number | null; notes?: string }[]
}

export interface DailyStandup {
  /** ISO date "YYYY-MM-DD" — the key; one standup per date per sprint. */
  date: string
  yesterday: string
  today: string
  blockers: string
  updatedAt: number
}

export interface Sprint {
  id: string
  name: string
  goal?: string
  /** ISO date "YYYY-MM-DD". */
  startDate: string
  /** ISO date "YYYY-MM-DD", inclusive. */
  endDate: string
  status: SprintStatus
  items: SprintItem[]
  standups: DailyStandup[]
  /** Project folder standups/metrics default to (for git-log digest). */
  projectPath?: string
  /** Last GitLab backfill result, cached so the importer opens instantly. */
  backfillCache?: SprintBackfillCache
  createdAt: number
  updatedAt: number
}

// ─── Slash commands & skills ──────────────────────────────────────────────────

export interface SlashCommand {
  name: string
  kind: 'command' | 'skill'
  scope: 'user' | 'project'
  description?: string
}

export interface PlannerAssistResult {
  ok: boolean
  data?: unknown
  error?: string
  raw?: string
  costUsd: number
}

// ─── Terminal (embedded PTY) ────────────────────────────────────────────────

export interface TerminalCreateOptions {
  cwd?: string
  /** The account id for the chat's provider (Claude account, CODEX_HOME account, or Gemini account). */
  accountId?: string
  /** Run inside this WSL distro (for WSL-backed chats). */
  wslDistro?: string
  /** Connect over SSH to this remote host id (for remote-backed chats). */
  remoteHostId?: string
  /** Which CLI this terminal is for. Defaults to 'claude'. */
  provider?: ProviderId
  /** The chat's Claude Code session id — resumed when launching claude (local shells only). */
  resumeSessionId?: string
  cols: number
  rows: number
}

export interface TerminalCreateResult {
  ok: boolean
  shell?: string
  /** True when a LOCAL shell already spawned the provider CLI directly (non-interactive
   *  invocation) — the renderer should skip its own auto-start timer/terminalStartCli call
   *  and just arm the reveal-on-settle logic. Omitted/false for wsl/ssh, which still rely
   *  on terminalStartCli typing the launch command into an interactive remote shell. */
  cliLaunched?: boolean
  /** True when an already-live pty was reattached to instead of a new one being spawned —
   *  the terminal survived the renderer unmounting (navigating away and back). */
  reused?: boolean
  /** The reused pty's buffered output, for the fresh xterm instance to replay before any
   *  live chunk arrives. Only present on the reuse path. */
  buffer?: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
}

// ─── Remote shell (Remote Session SSH terminal, over the SFTP connection) ──────

export interface RemoteShellDataEvent {
  id: string
  data: string
}

export interface RemoteShellExitEvent {
  id: string
  code: number
}

// ─── Auto-update ────────────────────────────────────────────────────────────

export type UpdaterStateKind =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloaded'
  | 'error'

export interface UpdaterState {
  state: UpdaterStateKind
  version?: string
  error?: string
  currentVersion: string
}

/** A Claude Code conversation addressed from outside the app — an `argos://session` link. */
export interface CcSessionTarget {
  sourceId?: string
  encodedDir: string
  sessionId: string
}

/**
 * What the Notifications panel shows. Text only: the hook block is pasted by the
 * user, never written by us — `~/.claude/settings.json` is their file.
 */
export interface NotifyHookInfo {
  command: string
  block: string
  /** The same command as a session inside a WSL distro can reach it (Windows only). */
  wslCommand: string | null
  wslBlock: string | null
  installed: boolean
  settingsPath: string
}

declare global {
  interface Window {
    electronAPI: {
      // Notifications
      notify: (title: string, body: string) => Promise<{ shown: boolean }>
      setZoom: (factor: number) => Promise<number>

      // Auto-update
      updaterState: () => Promise<UpdaterState>
      updaterCheck: () => Promise<UpdaterState>
      updaterInstall: () => Promise<void>
      onUpdaterEvent: (cb: (data: UpdaterState) => void) => () => void

      // Tray / quick-launcher overlay — events received by the MAIN window
      onNewChat: (cb: (folderPath?: string) => void) => () => void
      onOverlayPrompt: (cb: (payload: { prompt: string; quick?: boolean }) => void) => () => void
      onOpenSession: (cb: (sessionId: string) => void) => () => void
      onOpenCcSession: (cb: (target: CcSessionTarget) => void) => () => void
      notifyHookInfo: () => Promise<NotifyHookInfo>

      // Quick-launcher overlay — calls made by the OVERLAY window
      overlaySubmit: (payload: { prompt: string; quick?: boolean }) => void
      overlayOpenSession: (sessionId: string) => void
      overlayOpenMain: () => void
      overlayHide: () => void
      overlayShortcut: () => Promise<string>
      onOverlayShown: (cb: () => void) => () => void

      // Window controls (custom frameless title bar)
      windowMinimize: () => Promise<void>
      windowMaximizeToggle: () => Promise<boolean>
      windowClose: () => Promise<void>
      windowIsMaximized: () => Promise<boolean>
      windowGetBounds: () => Promise<{ x: number; y: number; width: number; height: number }>
      windowSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
      onWindowMaximized: (cb: (maximized: boolean) => void) => () => void

      // Auth
      authStatus: () => Promise<AuthStatus>
      setAuthMode: (mode: AuthMode) => Promise<AuthStatus>
      setApiKey: (key: string) => Promise<AuthStatus>
      clearApiKey: () => Promise<AuthStatus>
      hasApiKey: () => Promise<boolean>

      // Accounts (multiple Claude Code logins)
      accountsList: () => Promise<AccountList>
      accountsAdd: (name: string) => Promise<CCAccountStatus>
      accountsRename: (id: string, name: string) => Promise<AccountList>
      accountsRemove: (id: string) => Promise<AccountList>
      accountsSetDefault: (id: string) => Promise<AccountList>
      accountsLogin: (id: string) => Promise<{ launched: boolean; command: string }>

      // Agent CLI login status (Codex / Gemini) — machine-default login only
      agentCliStatus: (id: 'codex' | 'gemini') => Promise<AgentCliStatus>
      agentCliLogin: (id: 'codex' | 'gemini') => Promise<{ launched: boolean; command: string }>

      // Provider accounts (multiple Codex / Gemini logins)
      providerAccountsList: (provider: AgentProvider) => Promise<ProviderAccountList>
      providerAccountsAdd: (provider: AgentProvider, name: string) => Promise<ProviderAccountStatus>
      providerAccountsRename: (provider: AgentProvider, id: string, name: string) => Promise<ProviderAccountList>
      providerAccountsRemove: (provider: AgentProvider, id: string) => Promise<ProviderAccountList>
      providerAccountsSetDefault: (provider: AgentProvider, id: string) => Promise<ProviderAccountList>
      providerAccountsLogin: (
        provider: AgentProvider,
        id: string
      ) => Promise<{ launched: boolean; command: string }>

      // Codex plan-usage badge (the Codex analog of ccPlanUsage below), keyed by account id
      codexUsage: (force?: boolean) => Promise<Record<string, CodexAccountUsage>>

      // Agent
      sendAgent: (payload: {
        appSessionId: string
        claudeSessionId?: string
        prompt: string
        projectPath?: string
        model?: string
        systemPrompt?: string
        permissionMode?: PermissionMode
        allowedTools?: string[]
        useMcp?: boolean
        approvalMode?: 'ask' | 'auto'
        images?: { mediaType: string; data: string }[]
        files?: { name: string; content: string }[]
        remoteHostId?: string
        wslDistro?: string
        additionalDirs?: string[]
        useWorktree?: boolean
        worktreePath?: string
        accountId?: string
        codexAccountId?: string
        geminiAccountId?: string
      }) => void
      stopAgent: (appSessionId: string) => Promise<{ stopped: boolean }>
      onAgentEvent: (cb: (data: AgentEvent) => void) => () => void
      onAgentDone: (cb: (data: AgentDone) => void) => () => void
      onAgentError: (cb: (data: AgentError) => void) => () => void
      onApprovalRequest: (cb: (data: ApprovalRequest) => void) => () => void
      onAgentWorktree: (
        cb: (data: { appSessionId: string; path: string; branch?: string }) => void
      ) => () => void
      respondApproval: (payload: {
        approvalId: string
        allow: boolean
        updatedInput?: Record<string, unknown>
      }) => Promise<{ ok: boolean }>
      onApprovalResolved: (cb: (approvalId: string) => void) => () => void

      // Approval toast window
      onToastApproval: (cb: (data: ApprovalRequest) => void) => () => void
      toastOpenMain: () => void

      // Agent status pill window
      onPillUpdate: (
        cb: (data: {
          state?: 'running' | 'done' | 'error'
          sessionName?: string
          tool?: string | null
        }) => void
      ) => () => void
      pillOpenMain: () => void

      // Config / models
      getConfig: () => Promise<AppConfig>
      getModels: () => Promise<ModelInfo[]>
      setDefaultModel: (modelId: string) => Promise<{ defaultModel: string }>
      setLimits: (limits: Partial<UsageLimits>) => Promise<UsageLimits>
      setUiPrefs: (prefs: Partial<UiPrefs>) => Promise<UiPrefs>
      setSystemPrefs: (
        prefs: Partial<SystemPrefs>
      ) => Promise<{ system: SystemPrefs; registeredShortcut: string }>

      // Claude Code data
      ccSources: () => Promise<SourceInfo[]>
      ccListProjects: () => Promise<CCProject[]>
      ccListSessions: (
        sourceId: string,
        encodedDir: string,
        archived?: boolean
      ) => Promise<CCSessionMeta[]>
      ccReadSession: (
        sourceId: string,
        encodedDir: string,
        sessionId: string
      ) => Promise<CCTranscriptMessage[]>
      ccUsage: (force?: boolean) => Promise<UsageReport>
      ccPlanUsage: (force?: boolean) => Promise<PlanUsageReport>
      onPlanUsage: (cb: (report: PlanUsageReport) => void) => () => void
      onOpenView: (cb: (view: string) => void) => () => void
      ccSearch: (
        query: string,
        scope?: { sourceId: string; encodedDir: string }
      ) => Promise<SearchHit[]>
      ccSessionPeek: (
        sourceId: string,
        encodedDir: string,
        sessionId: string,
        archived?: boolean
      ) => Promise<SessionPeek | null>
      ccSessionArchive: (s: string, d: string, id: string) => Promise<LifecycleResult>
      ccSessionUnarchive: (s: string, d: string, id: string) => Promise<LifecycleResult>
      ccSessionDelete: (s: string, d: string, id: string, archived?: boolean) => Promise<LifecycleResult>
      ccSessionRename: (
        s: string,
        d: string,
        id: string,
        title: string,
        archived?: boolean
      ) => Promise<LifecycleResult>
      ccSessionMove: (
        s: string,
        d: string,
        id: string,
        toSource: string,
        toDir: string,
        archived?: boolean
      ) => Promise<LifecycleResult>
      ccFavorites: () => Promise<string[]>
      ccSetFavorite: (sourceId: string, encodedDir: string, on: boolean) => Promise<string[]>
      /** Filing only — the flag lives in preferences, no file moves. */
      ccProjectArchive: (sourceId: string, encodedDir: string, on: boolean) => Promise<string[]>
      /** Refused with `not-empty` while the project still holds any transcript. */
      ccProjectDelete: (sourceId: string, encodedDir: string) => Promise<ProjectOpResult>
      /** `claude` processes live on this machine right now, read from the registry. */
      ccLiveSessions: () => Promise<LiveSession[]>
      /**
       * Ask a live `claude` to exit so its conversation can be resumed here.
       * `expectedPid` is the pid the UI displayed — it is only ever used to refuse
       * when the registry now says something else, never to choose what to signal.
       */
      ccTakeoverSession: (
        sourceId: string,
        sessionId: string,
        expectedPid: number
      ) => Promise<TakeoverResult>
      /** Move the project's real folder on disk, and re-key everything that named it. */
      ccProjectMove: (
        sourceId: string,
        encodedDir: string,
        toPath: string
      ) => Promise<ProjectMoveResult>
      ccSetSessionTags: (
        sourceId: string,
        encodedDir: string,
        sessionId: string,
        tags: string[]
      ) => Promise<SetTagsResult>
      ccLabels: () => Promise<LabelRegistry>
      ccLabelSetColor: (name: string, color?: string) => Promise<LabelRegistry>
      ccLabelUsage: (name: string) => Promise<{ count: number }>
      ccLabelRename: (from: string, to: string) => Promise<LabelRenameResult>
      ccLabelMerge: (from: string, into: string) => Promise<{ merged: number; failed: number }>
      ccLabelDelete: (name: string) => Promise<{ cleared: number; failed: number }>

      // MCP
      mcpList: () => Promise<McpServer[]>
      mcpUpsert: (name: string, cfg: Record<string, unknown>) => Promise<McpServer[]>
      mcpRemove: (name: string) => Promise<McpServer[]>

      // Agents
      agentsList: () => Promise<AgentDef[]>
      agentsSave: (agent: AgentDef) => Promise<AgentDef>
      agentsDelete: (id: string) => Promise<AgentDef[]>
      agentsSuggest: (accountId?: string) => Promise<AgentsSuggestResult>

      // Chat compaction
      summarizeChat: (payload: {
        transcript: string
        model?: string
        accountId?: string
      }) => Promise<{ ok: boolean; summary?: string; error?: string }>

      // Planner
      plannerList: () => Promise<string[]>
      plannerGet: (weekStart: string) => Promise<WeekPlan>
      plannerSave: (week: WeekPlan) => Promise<WeekPlan>
      plannerDelete: (weekStart: string) => Promise<string[]>

      /**
       * The repo-backed backlog. Every write is addressed by `BacklogRef` and comes
       * back with the whole re-read record, so the renderer never has to guess what
       * the file looks like after its own edit.
       */
      backlogRead: (projectPath: string) => Promise<BacklogReadResult>
      backlogCreate: (
        projectPath: string,
        title: string,
        section?: string | null
      ) => Promise<BacklogWriteResult>
      backlogSetDone: (
        projectPath: string,
        ref: BacklogRef,
        done: boolean
      ) => Promise<BacklogWriteResult>
      backlogEdit: (
        projectPath: string,
        ref: BacklogRef,
        title: string
      ) => Promise<BacklogWriteResult>
      backlogDuplicate: (projectPath: string, ref: BacklogRef) => Promise<BacklogWriteResult>
      backlogDelete: (projectPath: string, ref: BacklogRef) => Promise<BacklogWriteResult>
      /** Read-only — there is no counterpart that writes. */
      memoryDiagnose: (projectPath?: string) => Promise<MemoryReport>
      plannerAssist: (payload: {
        mode: PlannerAssistMode
        week: WeekPlan
        notes?: string
        images?: { mediaType: string; data: string }[]
        model?: string
        accountId?: string
      }) => Promise<PlannerAssistResult>

      // Sprints (Scrum board / standups / burndown)
      sprintList: () => Promise<Sprint[]>
      sprintGet: (id: string) => Promise<Sprint | null>
      sprintSave: (sprint: Sprint) => Promise<Sprint>
      sprintDelete: (id: string) => Promise<Sprint[]>
      standupGenerate: (payload: {
        projectPath?: string
        date: string
        boardSummary?: string
        model?: string
        accountId?: string
      }) => Promise<{
        ok: boolean
        data?: { yesterday?: string; today?: string; blockers?: string }
        error?: string
        raw?: string
        costUsd: number
        commitCount: number
      }>
      sprintBackfill: (payload: {
        projectPath?: string
        instructions?: string
        model?: string
        accountId?: string
        /** When true, only resolve which GitLab project the MCP is attributed to. */
        probe?: boolean
      }) => Promise<{
        ok: boolean
        data?: {
          items?: { title: string; points?: number | null; notes?: string }[]
          project?: string
          projectId?: number | string | null
          url?: string
          openIssueCount?: number | null
          source?: string
          note?: string
        }
        error?: string
        raw?: string
        costUsd: number
      }>

      // Claude permissions & hooks
      getClaudePermissions: () => Promise<ClaudePermissions>
      setClaudePermissions: (perms: ClaudePermissions) => Promise<WriteResult & { permissions?: ClaudePermissions }>
      getClaudeHooks: () => Promise<ClaudeHooks>
      setClaudeHooks: (hooks: ClaudeHooks) => Promise<WriteResult & { hooks?: ClaudeHooks }>

      // CLAUDE.md
      claudeMdRead: (projectPath?: string, provider?: ProviderId) => Promise<ClaudeMdFile[]>
      claudeMdWrite: (filePath: string, content: string) => Promise<{ success: boolean }>

      // Checkpoints
      checkpointCreate: (
        sessionId: string,
        label: string,
        files: string[],
        messageCount: number
      ) => Promise<CheckpointMeta>
      checkpointList: (sessionId: string) => Promise<CheckpointMeta[]>
      checkpointRestore: (sessionId: string, id: string) => Promise<RestoreResult>
      checkpointDelete: (sessionId: string, id: string) => Promise<CheckpointMeta[]>
      checkpointCompare: (sessionId: string, idA: string, idB: string) => Promise<CheckpointDiff>
      checkpointSavePatch: (
        sessionId: string,
        idA: string,
        idB: string
      ) => Promise<{ saved: boolean; filePath?: string; reason?: string }>

      // SSH
      sshList: () => Promise<SshHostPublic[]>
      sshSave: (host: SshHostInput) => Promise<SshHostPublic[]>
      sshDelete: (id: string) => Promise<SshHostPublic[]>
      sshTest: (id: string) => Promise<{ ok: boolean; message: string }>
      sshTestClaude: (id: string) => Promise<{ ok: boolean; message: string }>
      sshKeysList: () => Promise<SshKeyInfo[]>
      sshKeysGenerate: (name: string, comment?: string) => Promise<GenerateKeyResult>
      sshKeysPublic: (privatePath: string) => Promise<string | null>

      // SFTP (Remote Session file browser)
      sftpConnect: (hostId: string) => Promise<{ ok: boolean; home?: string; cwd?: string; error?: string }>
      sftpList: (hostId: string, dir: string) => Promise<{ ok: boolean; entries?: RemoteEntry[]; error?: string }>
      sftpRead: (
        hostId: string,
        p: string
      ) => Promise<{ ok: boolean; content?: string; tooLarge?: boolean; binary?: boolean; error?: string }>
      sftpWrite: (hostId: string, p: string, content: string) => Promise<{ ok: boolean; error?: string }>
      sftpMkdir: (hostId: string, dir: string) => Promise<{ ok: boolean; error?: string }>
      sftpRename: (hostId: string, from: string, to: string) => Promise<{ ok: boolean; error?: string }>
      sftpDelete: (hostId: string, p: string) => Promise<{ ok: boolean; error?: string }>
      sftpDownload: (
        hostId: string,
        p: string
      ) => Promise<{ ok: boolean; savedTo?: string; canceled?: boolean; error?: string }>
      sftpUpload: (hostId: string, dir: string) => Promise<{ ok: boolean; uploaded?: string[]; error?: string }>
      sftpHistory: (hostId: string) => Promise<{ ok: boolean; commands?: string[]; error?: string }>
      sftpDisconnect: (hostId: string) => Promise<{ ok: boolean }>

      // WSL
      wslList: () => Promise<WslDistro[]>
      wslTest: (distro: string) => Promise<{ ok: boolean; message: string }>
      wslTestClaude: (distro: string) => Promise<{ ok: boolean; message: string }>
      wslHidden: () => Promise<string[]>
      wslSetHidden: (distro: string, hidden: boolean) => Promise<string[]>
      wslHistory: (distro: string) => Promise<{ ok: boolean; commands?: string[]; error?: string }>

      // Rooms (persisted board layout: room order + custom names)
      roomsGetLayout: () => Promise<RoomsLayout>
      roomsSetLayout: (layout: RoomsLayout) => Promise<boolean>

      // Git
      gitStatus: (cwd: string) => Promise<GitStatus>
      gitDiff: (cwd: string, filePath: string, staged: boolean) => Promise<string>
      gitStage: (cwd: string, filePath: string) => Promise<GitStatus>
      gitUnstage: (cwd: string, filePath: string) => Promise<GitStatus>
      gitStageAll: (cwd: string) => Promise<GitStatus>
      gitCommit: (cwd: string, message: string) => Promise<{ ok: boolean; message: string }>

      // File system
      readDir: (dirPath: string) => Promise<FileNode[] | { error: string }>
      readFile: (filePath: string) => Promise<{ content?: string; error?: string }>
      openFolder: (defaultPath?: string) => Promise<string | null>
      fsReadText: (
        filePath: string
      ) => Promise<{ ok: boolean; content?: string; tooLarge?: boolean; binary?: boolean; error?: string }>
      fsWriteFile: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>
      fsMkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>
      fsRename: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>
      fsDelete: (targetPath: string) => Promise<{ ok: boolean; error?: string }>

      // Sessions
      listSessions: () => Promise<Session[]>
      saveSession: (session: Session) => Promise<{ success: boolean }>
      deleteSession: (id: string) => Promise<{ success: boolean }>
      exportSession: (session: Session, format: 'md' | 'html') => Promise<{ saved: boolean; filePath?: string }>
      exportMarkdown: (defaultFileName: string, content: string) => Promise<{ saved: boolean; path?: string }>

      // Commands & skills
      commandsList: (projectPath?: string) => Promise<SlashCommand[]>

      // Scheduler / Routines
      schedulerList: () => Promise<ScheduledRun[]>
      schedulerUpsert: (run: ScheduledRun) => Promise<ScheduledRun>
      schedulerDelete: (id: string) => Promise<ScheduledRun[]>
      schedulerSetEnabled: (id: string, enabled: boolean) => Promise<ScheduledRun[]>
      schedulerRunNow: (id: string) => Promise<{ ok: boolean; summary: string; costUsd: number } | null>

      // Terminal (embedded PTY)
      terminalCreate: (id: string, opts: TerminalCreateOptions) => Promise<TerminalCreateResult>
      terminalWrite: (id: string, data: string) => void
      terminalResize: (id: string, cols: number, rows: number) => void
      terminalKill: (id: string) => Promise<{ ok: boolean }>
      terminalKillDeferred: (id: string) => void
      terminalStartCli: (
        id: string,
        provider: ProviderId,
        resumeSessionId?: string
      ) => Promise<{ ok: boolean }>
      onTerminalData: (cb: (data: TerminalDataEvent) => void) => () => void
      onTerminalExit: (cb: (data: TerminalExitEvent) => void) => () => void

      // Remote shell (Remote Session SSH terminal, over the SFTP connection)
      remoteShellCreate: (id: string, hostId: string, cols: number, rows: number) => Promise<{ ok: boolean; error?: string }>
      remoteShellWrite: (id: string, data: string) => void
      remoteShellResize: (id: string, cols: number, rows: number) => void
      remoteShellKill: (id: string) => Promise<{ ok: boolean }>
      onRemoteShellData: (cb: (data: RemoteShellDataEvent) => void) => () => void
      onRemoteShellExit: (cb: (data: RemoteShellExitEvent) => void) => () => void
    }
  }
}
