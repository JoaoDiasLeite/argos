// Pre-2.0 chat sessions -> terminal-only sessions (docs/TERMINAL_ONLY_PLAN.md §2, §3).
// Pure: no fs, no electron. The I/O loop lives in session-migrate.ts.

export type MigratedProvider = 'claude' | 'codex' | 'gemini'

export interface LegacyToolCall {
  id?: string
  tool: string
  input?: unknown
  result?: string
  isError?: boolean
}

export interface LegacyMessage {
  role: 'user' | 'assistant' | string
  content: string
  timestamp: number
  toolCalls?: LegacyToolCall[]
  usage?: unknown
  error?: unknown
  [key: string]: unknown
}

/** A session JSON as written by Argos <= 1.x. Unknown keys pass through migration. */
export interface LegacySession extends Record<string, unknown> {
  id: string
  name?: string
  createdAt?: number
  updatedAt?: number
  projectPath?: string
  model?: string
  messages?: LegacyMessage[]
  claudeSessionId?: string
  codexThreadId?: string
  remoteHostId?: string
  remoteHostName?: string
  wslDistro?: string
  accountId?: string
  accountName?: string
  codexAccountId?: string
  codexAccountName?: string
  geminiAccountId?: string
  geminiAccountName?: string
  hasTerminalActivity?: boolean
  terminalStartedAt?: number
  terminalSessionId?: string
  unread?: boolean
  runbookPath?: string
}

export interface MigratedSession extends Record<string, unknown> {
  id: string
  provider: MigratedProvider
  archivedTranscript: string
  hasTerminalActivity: false
}

/** SDK-chat-only fields removed by the migration (plan §2 "Delete", plus `model`). */
export const STRIPPED_FIELDS = [
  'messages',
  'model',
  'runState',
  'ccSynced',
  'systemPrompt',
  'permissionMode',
  'allowedTools',
  'useMcp',
  'autoApprove',
  'lightMode',
  'runbookPath',
  'branchedFrom',
  'costUsd',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'additionalDirs',
  'useWorktree',
  'worktreePath'
] as const

/**
 * Mirrors `providerFor` in config.ts (which imports electron, so it can't be used
 * here). That one matches against the model catalog with a Claude fallback; the
 * catalog's Codex ids are `gpt-*` and its Gemini ids `gemini-*`.
 */
export function providerOf(model: string | undefined): MigratedProvider {
  if (!model) return 'claude'
  const m = model.toLowerCase()
  if (m.startsWith('gemini')) return 'gemini'
  if (m.startsWith('gpt') || m.startsWith('codex') || /^o\d/.test(m)) return 'codex'
  return 'claude'
}

// --- Markdown export (ported from renderer lib/markdown-export.ts) ---------------

function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dateRange(messages: LegacyMessage[]): string {
  if (messages.length === 0) return ''
  const first = new Date(messages[0].timestamp)
  const last = new Date(messages[messages.length - 1].timestamp)
  const fmt = (d: Date): string => d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  return first.toDateString() === last.toDateString() ? fmt(first) : `${fmt(first)} – ${fmt(last)}`
}

function primaryToolArg(tool: LegacyToolCall): string | undefined {
  const input = tool.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return undefined
  const candidate = input.file_path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.path
  return typeof candidate === 'string' ? candidate : undefined
}

function toolCallLine(tool: LegacyToolCall): string {
  const arg = primaryToolArg(tool)
  return arg ? `- \u{1F527} ${tool.tool} ${arg}` : `- \u{1F527} ${tool.tool}`
}

/** Renders a chat session as a standalone Markdown document (skips thinking blocks). */
export function sessionToMarkdown(session: LegacySession): string {
  const messages = Array.isArray(session.messages) ? session.messages : []
  const lines: string[] = []
  lines.push(`# ${session.name || 'Chat'}`)

  const meta: string[] = []
  if (session.projectPath) meta.push(session.projectPath)
  const range = dateRange(messages)
  if (range) meta.push(range)
  if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`)
  lines.push('')

  for (const msg of messages) {
    const who = msg.role === 'user' ? 'You' : 'Claude'
    lines.push(`## ${who} — ${shortTime(msg.timestamp)}`)
    lines.push('')
    if (msg.content) {
      lines.push(msg.content)
      lines.push('')
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) lines.push(toolCallLine(tc))
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

// --- Migration ------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function slugify(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'chat'
}

/** `<yyyy-mm-dd of createdAt>-<slug of name>-<id>.md`; `now` stands in for a missing createdAt. */
export function exportFileName(legacy: LegacySession, now: number = Date.now()): string {
  const ts = typeof legacy.createdAt === 'number' && Number.isFinite(legacy.createdAt) ? legacy.createdAt : now
  const d = new Date(ts)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const id = String(legacy.id).replace(/[^A-Za-z0-9_-]/g, '_')
  return `${date}-${slugify(legacy.name)}-${id}.md`
}

/**
 * Turns a pre-2.0 session into a terminal-only one. No `messages` (or an empty array)
 * means nothing to export: skip, which also makes a second run a no-op.
 */
export function migrateSession(
  legacy: LegacySession,
  exportPath: string
): { session: MigratedSession; markdown: string } | { skip: true } {
  if (!Array.isArray(legacy.messages) || legacy.messages.length === 0) return { skip: true }

  const markdown = sessionToMarkdown(legacy)
  const provider = providerOf(legacy.model)
  const next: Record<string, unknown> = { ...legacy }
  for (const key of STRIPPED_FIELDS) delete next[key]
  if (provider !== 'claude') delete next.claudeSessionId
  next.provider = provider
  next.archivedTranscript = exportPath
  next.hasTerminalActivity = false

  return { session: next as MigratedSession, markdown }
}
