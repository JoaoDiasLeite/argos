import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { costFromUsage, splitCacheWrite } from './providers/cost'
import { iterJsonl, iterJsonlEntries, sniffCwd } from './jsonl'
import {
  boilerplateKeys,
  isInjectedUserEntry,
  meaningfulUserText,
  previewKey,
  previewRestatesTitle,
  stripCommandBlocks,
  stripReminders
} from './transcript-text'
import {
  Matches,
  Segment,
  SearchSnippet,
  collectMatches,
  proseSegments,
  rawPrefilterable,
  searchableSegments,
  snippetText
} from './search-pure'
import {
  ASK_RESULT_PREFIX,
  AskDecision,
  stripPreviewBlocks,
  withDecisions
} from './ask-answers-pure'
import { getWslClaudeRoots } from './wsl'
import { storeGet, storeSet } from './store'
import { readJsonFile } from './json-file'
import { getAccounts } from './accounts'

// ─── Sources (local + WSL distros) ──────────────────────────────────────────

export interface SourceAccount {
  email?: string
  org?: string
  plan?: string
}

export interface ClaudeSource {
  id: string // 'local' | 'wsl:<distro>'
  label: string // 'Local' | distro name
  kind: 'local' | 'wsl'
  distro?: string
  projectsDir: string
  claudeJsonPath: string
  account?: SourceAccount
}

function readAccount(claudeJsonPath: string): SourceAccount | undefined {
  try {
    const raw = readJsonFile<any>(claudeJsonPath)
    const a = raw.oauthAccount
    if (!a || typeof a !== 'object') return undefined
    const plan =
      a.organizationType === 'claude_team'
        ? 'Team'
        : a.billingType === 'stripe_subscription'
          ? 'Pro'
          : a.billingType
            ? 'Paid'
            : 'Free'
    return { email: a.emailAddress, org: a.organizationName, plan }
  } catch {
    return undefined
  }
}

export function localSource(): ClaudeSource {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json')
  return {
    id: 'local',
    label: 'Local',
    kind: 'local',
    projectsDir: path.join(os.homedir(), '.claude', 'projects'),
    claudeJsonPath,
    account: readAccount(claudeJsonPath)
  }
}

// Cache discovered sources briefly so navigating Usage/Projects doesn't re-probe WSL.
let sourceCache: { at: number; sources: ClaudeSource[] } | null = null

export async function getSources(force = false): Promise<ClaudeSource[]> {
  const now = Date.now()
  if (!force && sourceCache && now - sourceCache.at < 30000) return sourceCache.sources
  const sources: ClaudeSource[] = [localSource()]
  // Each non-default account runs with CLAUDE_CONFIG_DIR pointed at its own configDir
  // (see accounts.ts), so its transcripts land under <configDir>/projects rather than
  // ~/.claude/projects — without this, chats run under those accounts are invisible to
  // Projects/Resume even though they're on disk.
  for (const account of getAccounts()) {
    if (!account.configDir) continue
    const claudeJsonPath = path.join(account.configDir, '.claude.json')
    sources.push({
      id: `account:${account.id}`,
      label: account.name,
      kind: 'local',
      projectsDir: path.join(account.configDir, 'projects'),
      claudeJsonPath,
      account: readAccount(claudeJsonPath)
    })
  }
  try {
    for (const root of await getWslClaudeRoots()) {
      sources.push({
        id: `wsl:${root.distro}`,
        label: root.distro,
        kind: 'wsl',
        distro: root.distro,
        projectsDir: root.projectsDir,
        claudeJsonPath: root.claudeJsonPath,
        account: readAccount(root.claudeJsonPath)
      })
    }
  } catch {
    // WSL probing failed — local only
  }
  sourceCache = { at: now, sources }
  return sources
}

export async function resolveSource(id: string): Promise<ClaudeSource | null> {
  if (id === 'local') return localSource()
  return (await getSources()).find((s) => s.id === id) ?? null
}

export interface SourceInfo {
  id: string
  label: string
  kind: 'local' | 'wsl'
  distro?: string
  account?: SourceAccount
}
export async function listSources(): Promise<SourceInfo[]> {
  return (await getSources(true)).map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    distro: s.distro,
    account: s.account
  }))
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CCProject {
  encodedDir: string
  realPath: string
  name: string
  sessionCount: number
  lastActive: number
  sourceId: string
  sourceLabel: string
  kind: 'local' | 'wsl'
  distro?: string
  account?: SourceAccount
}

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
   * sessions in this project to be a template rather than a subject. The UI hides
   * it; the text is kept so the decision stays inspectable.
   */
  previewRedundant: boolean
  /** Sitting in the project's `archived/` subdirectory rather than beside it. */
  archived: boolean
}

/**
 * Just enough of a conversation to decide whether to reopen it.
 *
 * `last` matters more than `first` and is the reason this exists: what a session
 * opened with is often a slash command shared by thirty others, while where it
 * stopped is what answers "do I need to go back in".
 */
export interface SessionPeek {
  first: string
  last: string
  lastRole: 'user' | 'assistant'
  costUsd: number
}

export async function readSessionPeek(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  archived = false
): Promise<SessionPeek | null> {
  const full = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  if (!full) return null

  let first = ''
  let last = ''
  let lastRole: 'user' | 'assistant' = 'assistant'
  let costUsd = 0
  const seen = new Set<string>()

  try {
    for await (const obj of iterJsonl(full)) {
      if (obj.type === 'assistant' && obj.message?.usage) {
        // Same dedupe as the usage sweep: resume re-logs an assistant message two or
        // three times, and without this a resumed conversation reads 2-3x its cost.
        const key = obj.message?.id ?? obj.requestId ?? obj.uuid
        if (!key || !seen.has(key)) {
          if (key) seen.add(key)
          costUsd += costFromUsage(obj.message.model ?? 'unknown', obj.message.usage)
        }
      }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      if (!obj.message) continue

      // A skill's body or a task notification is not what this conversation was
      // about, and it is not where it left off either.
      if (obj.type === 'user' && isInjectedUserEntry(obj)) continue
      const text =
        obj.type === 'user'
          ? meaningfulUserText(obj.message.content)
          : stripCommandBlocks(stripReminders(plainText(obj.message.content))).replace(/\s+/g, ' ').trim()
      if (!text) continue

      if (!first) first = text.slice(0, 400)
      last = text.slice(0, 700)
      lastRole = obj.type
    }
  } catch {
    // A partial peek is still worth showing.
  }

  return { first, last, lastRole, costUsd }
}

export interface CCTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolCalls: { id: string; tool: string; input: unknown; result?: string; isError?: boolean }[]
  timestamp: number
  /**
   * The choices the owner made in an `AskUserQuestion`, when the pair could be
   * read. Present only on the message that carries them, and that message is the
   * owner's turn — a decision is his, not the tool's.
   */
  decisions?: AskDecision[]
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function realPathMap(claudeJsonPath: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const raw = readJsonFile<any>(claudeJsonPath)
    if (raw.projects && typeof raw.projects === 'object') {
      for (const realPath of Object.keys(raw.projects)) {
        map.set(encodePath(realPath), realPath)
      }
    }
  } catch {
    // ignore
  }
  return map
}

function encodePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

function decodeFallback(encoded: string): string {
  let s = encoded.replace(/-/g, '/').replace(/\/{2,}/g, '/')
  s = s.replace(/^([A-Za-z])\//, '$1:/')
  return s
}

async function cwdFromSessions(dir: string): Promise<string | null> {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  for (const file of files) {
    try {
      const cwd = await sniffCwd(path.join(dir, file))
      if (cwd) return cwd
    } catch {
      /* next file */
    }
  }
  return null
}

async function resolveRealPath(
  src: ClaudeSource,
  encodedDir: string,
  pathMap: Map<string, string>
): Promise<string> {
  return (
    pathMap.get(encodedDir) ??
    (await cwdFromSessions(path.join(src.projectsDir, encodedDir))) ??
    decodeFallback(encodedDir)
  )
}

/**
 * Resolve a transcript path, or null if the ids don't address one inside their own
 * source. Every write to a transcript must go through this.
 *
 * The renderer supplies `encodedDir` and `sessionId` and they reach the filesystem,
 * so they are checked rather than trusted: no separators, no `..`, and the resolved
 * path must still sit under the source's own projects dir. The last check is the one
 * that matters — the charset tests are a fast reject, but a source's dir is itself
 * built from a discovered path, so containment is verified against the real thing.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/**
 * Archived sessions live in a subdirectory of their project, not in a database.
 * "Archived" is therefore not a stored flag anywhere — it is where the file is, and
 * unarchiving is the same move back.
 */
export const ARCHIVED_DIR = 'archived'

export async function safeSessionPath(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  archived = false
): Promise<string | null> {
  if (!SAFE_ID.test(encodedDir) || !SAFE_ID.test(sessionId)) return null
  if (encodedDir === '.' || encodedDir === '..' || sessionId === '.' || sessionId === '..') return null
  const src = await resolveSource(sourceId)
  if (!src) return null
  const base = path.resolve(src.projectsDir)
  const rel = archived
    ? path.join(base, encodedDir, ARCHIVED_DIR, `${sessionId}.jsonl`)
    : path.join(base, encodedDir, `${sessionId}.jsonl`)
  const full = path.resolve(rel)
  if (full !== rel) return null
  if (!full.startsWith(base + path.sep)) return null
  return full
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function parseTimestamp(v: unknown): number {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

// ─── Projects / sessions ────────────────────────────────────────────────────

async function projectsForSource(src: ClaudeSource): Promise<CCProject[]> {
  if (!fs.existsSync(src.projectsDir)) return []
  const pathMap = realPathMap(src.claudeJsonPath)
  const result: CCProject[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src.projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(src.projectsDir, entry.name)
    let jsonlFiles: string[]
    try {
      jsonlFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    if (jsonlFiles.length === 0) continue
    let lastActive = 0
    for (const f of jsonlFiles) {
      const st = safeStat(path.join(dir, f))
      if (st && st.mtimeMs > lastActive) lastActive = st.mtimeMs
    }
    const realPath = await resolveRealPath(src, entry.name, pathMap)
    result.push({
      encodedDir: entry.name,
      realPath,
      name: realPath.split(/[\\/]/).filter(Boolean).pop() ?? entry.name,
      sessionCount: jsonlFiles.length,
      lastActive,
      sourceId: src.id,
      sourceLabel: src.label,
      kind: src.kind,
      distro: src.distro,
      account: src.account
    })
  }
  return result
}

export async function getAllProjects(): Promise<CCProject[]> {
  const sources = await getSources()
  const all: CCProject[] = []
  for (const src of sources) all.push(...(await projectsForSource(src)))
  return all.sort((a, b) => b.lastActive - a.lastActive)
}

export async function listSessions(
  sourceId: string,
  encodedDir: string,
  archived = false
): Promise<CCSessionMeta[]> {
  const src = await resolveSource(sourceId)
  if (!src) return []
  const dir = archived
    ? path.join(src.projectsDir, encodedDir, ARCHIVED_DIR)
    : path.join(src.projectsDir, encodedDir)
  if (!fs.existsSync(dir)) return []
  const realPath = await resolveRealPath(src, encodedDir, realPathMap(src.claudeJsonPath))

  const sessions: CCSessionMeta[] = []
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, '')
    const full = path.join(dir, file)
    const st = safeStat(full)
    let title = ''
    let customTitle = ''
    let preview = ''
    let model: string | undefined
    let messageCount = 0
    let createdAt = 0
    // The time of the last real message — NOT the file's mtime. Renaming or tagging a
    // session appends a line, which bumps mtime, which would float a conversation
    // nothing happened in to the top of a date-sorted list. mtime is the fallback for
    // a transcript whose entries carry no usable timestamp.
    let lastMessageAt = 0
    // Read in the pass that is already happening rather than via readEffectiveTags:
    // a second walk of the transcript to fetch one line would double the cost of
    // opening a project.
    let tags: string[] = []
    try {
      for await (const obj of iterJsonl(full)) {
        if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
        // A name the owner chose beats one the model generated, and the last one
        // wins — the same precedence the CLI uses, so a `/rename` there shows here
        // and a rename here shows there.
        if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle
        // Last one wins, same rule as the title.
        if (obj.type === 'custom-tags' && Array.isArray(obj.tags)) {
          tags = obj.tags.filter((t: unknown) => typeof t === 'string')
        }
        if (obj.type === 'assistant' && obj.message) {
          messageCount++
          if (obj.message.model) model = obj.message.model
          const ts = parseTimestamp(obj.timestamp)
          if (ts && !createdAt) createdAt = ts
          if (ts) lastMessageAt = Math.max(lastMessageAt, ts)
        }
        if (obj.type === 'user' && obj.message) {
          messageCount++
          if (!preview && !isInjectedUserEntry(obj)) {
            // Empty means this entry carried no prose of the owner's — a slash
            // command's own body, a loaded skill, a reminder. Falling through to the
            // next entry is what makes the preview the conversation rather than the
            // plumbing that opened it.
            preview = meaningfulUserText(obj.message.content).slice(0, 160)
          }
        }
      }
    } catch {
      /* skip */
    }
    sessions.push({
      sessionId,
      encodedDir,
      realPath,
      title: customTitle || title || preview || sessionId.slice(0, 8),
      preview,
      messageCount,
      model,
      createdAt: createdAt || (st?.birthtimeMs ?? 0),
      updatedAt: lastMessageAt || (st?.mtimeMs ?? 0),
      sourceId: src.id,
      kind: src.kind,
      distro: src.distro,
      tags,
      previewRedundant: false,
      archived
    })
  }

  // Whether a preview is worth showing can only be decided against the rest of the
  // project: the same opening on three sessions is a command being re-run, and a line
  // that appears on a third of the list has stopped telling any of them apart.
  const boilerplate = boilerplateKeys(sessions.map((s) => s.preview))
  for (const s of sessions) {
    s.previewRedundant =
      !s.preview ||
      boilerplate.has(previewKey(s.preview)) ||
      previewRestatesTitle(s.preview, s.title)
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * An entry's text for the peek. Unlike `contentToText` this keeps thinking blocks:
 * where a conversation left off is sometimes the assistant still reasoning.
 */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => (b.type === 'text' ? b.text ?? '' : b.type === 'thinking' ? b.thinking ?? '' : ''))
      .join(' ')
  }
  return ''
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
 * Where a search looks, and — because of that — how deep it reads.
 *
 * Naming a project narrows the sweep to it *and* narrows what counts as a hit to
 * prose. The two go together on purpose: inside one project you are looking for a
 * conversation you had, and matching tool inputs there buries it under every file
 * path the assistant ever touched. Across everything you are looking for anywhere a
 * thing was mentioned at all, and a command or a result is a fair place to find it.
 */
export interface SearchScope {
  sourceId: string
  encodedDir: string
}

/** One transcript, searched. Null when nothing in it matched. */
async function searchOneSession(
  full: string,
  query: string,
  segmentsOf: (obj: any) => Segment[]
): Promise<{ matches: Matches; title: string; model?: string; updatedAt: number } | null> {
  const prefilter = rawPrefilterable(query)
  const lower = query.toLowerCase()
  const segments: Segment[] = []
  let title = ''
  let model: string | undefined
  let updatedAt = 0
  for await (const { raw, obj } of iterJsonlEntries(full)) {
    if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
    if (obj.type === 'custom-title' && obj.customTitle) title = obj.customTitle
    if (obj.type === 'assistant' && obj.message?.model) model = obj.message.model
    const ts = parseTimestamp(obj.timestamp)
    if (ts) updatedAt = Math.max(updatedAt, ts)
    // Building segments for a line that cannot match is most of what a sweep over
    // every transcript would spend its time on. The test is a superset one — see
    // rawPrefilterable for the queries it is not allowed to be used for.
    if (prefilter && !raw.toLowerCase().includes(lower)) continue
    segments.push(...segmentsOf(obj))
  }
  const matches = collectMatches(segments, query)
  if (!matches.matchCount) return null
  return { matches, title, model, updatedAt }
}

/**
 * Search transcripts. Global by default; scoped to one project, and to prose, when
 * a scope is given.
 */
export async function searchSessions(
  query: string,
  limit = 100,
  scope?: SearchScope
): Promise<SearchHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const segmentsOf = scope ? proseSegments : searchableSegments
  const sources = scope ? [await resolveSource(scope.sourceId)] : await getSources()
  const hits: SearchHit[] = []

  for (const src of sources) {
    if (!src || !fs.existsSync(src.projectsDir)) continue
    const pathMap = realPathMap(src.claudeJsonPath)
    let dirNames: string[]
    if (scope) {
      dirNames = [scope.encodedDir]
    } else {
      try {
        dirNames = fs
          .readdirSync(src.projectsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        continue
      }
    }
    for (const encodedDir of dirNames) {
      const realPath = await resolveRealPath(src, encodedDir, pathMap)
      const projectName = realPath.split(/[\/]/).filter(Boolean).pop() ?? encodedDir
      const dir = path.join(src.projectsDir, encodedDir)
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      // The project's own name is a match worth returning — but only when searching
      // across projects, where naming one is how you find it. Inside a project it
      // would match every session in it and tell you nothing.
      const projectMatch = !scope && projectName.toLowerCase().includes(q.toLowerCase())
      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '')
        const fullPath = path.join(dir, file)
        const st = safeStat(fullPath)
        let found: Awaited<ReturnType<typeof searchOneSession>> = null
        try {
          found = await searchOneSession(fullPath, q, segmentsOf)
        } catch {
          continue
        }
        if (!found && !projectMatch) continue

        const snippets = found?.matches.snippets ?? []
        hits.push({
          sessionId,
          encodedDir,
          realPath,
          projectName,
          title: found?.title || (snippets[0] ? snippetText(snippets[0]) : '') || sessionId.slice(0, 8),
          snippet: snippets[0] ? snippetText(snippets[0]) : `(matches project ${projectName})`,
          updatedAt: found?.updatedAt || st?.mtimeMs || 0,
          model: found?.model,
          sourceId: src.id,
          kind: src.kind,
          distro: src.distro,
          account: src.account,
          matchCount: found?.matches.matchCount ?? 0,
          snippets
        })
      }
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

function blockText(content: unknown): { text: string; thinking: string; tools: any[] } {
  let text = ''
  let thinking = ''
  const tools: any[] = []
  if (typeof content === 'string') return { text: content, thinking, tools }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text') text += b.text ?? ''
      else if (b.type === 'thinking') thinking += b.thinking ?? ''
      else if (b.type === 'tool_use') tools.push({ id: b.id, tool: b.name, input: b.input })
    }
  }
  return { text, thinking, tools }
}

export async function readSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string,
  archived = false
): Promise<CCTranscriptMessage[]> {
  const full = await safeSessionPath(sourceId, encodedDir, sessionId, archived)
  if (!full || !fs.existsSync(full)) return []
  const messages: CCTranscriptMessage[] = []
  const toolResults = new Map<string, { result: string; isError: boolean }>()

  // A tool_result always appears after the tool_use it answers, so results are
  // stitched onto the messages after the read rather than during it. That is what
  // lets this be a single pass — the buffered version walked the whole transcript
  // twice, once for the results and once for the messages.
  try {
    for await (const obj of iterJsonl(full)) {
      if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const b of obj.message.content) {
          if (b.type === 'tool_result') {
            const txt =
              typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => c.text ?? '').join('')
                  : ''
            // An AskUserQuestion answer has the chosen mockups appended to it, and
            // those are most of its length. Cutting them first is what keeps the
            // last question's answer inside the cap — truncated, the parser finds
            // no anchor for it and the decision silently loses a question.
            const body = txt.startsWith(ASK_RESULT_PREFIX) ? stripPreviewBlocks(txt) : txt
            toolResults.set(b.tool_use_id, { result: body.slice(0, 4000), isError: !!b.is_error })
          }
        }
      }
      if ((obj.type === 'assistant' || obj.type === 'user') && obj.message) {
        const { text, thinking, tools } = blockText(obj.message.content)
        const isToolResultOnly =
          obj.type === 'user' &&
          Array.isArray(obj.message.content) &&
          obj.message.content.every((b: any) => b.type === 'tool_result')
        if (isToolResultOnly) continue
        if (!text && !thinking && tools.length === 0) continue
        messages.push({
          role: obj.type === 'assistant' ? 'assistant' : 'user',
          text,
          thinking: thinking || undefined,
          toolCalls: tools,
          timestamp: parseTimestamp(obj.timestamp)
        })
      }
    }
  } catch {
    // Unreadable transcript. Return whatever was parsed before the failure rather
    // than nothing: a truncated conversation still reads, an empty pane doesn't.
  }

  for (const m of messages) {
    m.toolCalls = m.toolCalls.map((t) => ({ ...t, ...(toolResults.get(t.id) ?? {}) }))
  }
  return withDecisions(messages)
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface UsageEntry {
  day: string // YYYY-MM-DD
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
  session: { costUsd: number; tokens: number } // rolling 5h
  week: { costUsd: number; tokens: number }
}

export interface UsageReport {
  entries: UsageEntry[]
  windows: UsageWindows
  generatedAt: number
}

const HOUR = 3600_000
const SESSION = 5 * HOUR
const WEEK = 7 * 24 * HOUR

async function collectUsage(
  src: ClaudeSource,
  agg: Map<string, UsageEntry>,
  win: UsageWindows,
  now: number,
  seen: Set<string>
): Promise<void> {
  if (!fs.existsSync(src.projectsDir)) return
  const pathMap = realPathMap(src.claudeJsonPath)
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(src.projectsDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const realPath = await resolveRealPath(src, entry.name, pathMap)
    const projectName = realPath.split(/[\\/]/).filter(Boolean).pop() ?? entry.name
    const dir = path.join(src.projectsDir, entry.name)
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        // Only assistant messages carry usage; the raw prefilter keeps the parse off
        // the ~95% of lines that can't contribute, which matters because this sweeps
        // every transcript in every project.
        const usageOnly = { match: (raw: string) => raw.includes('"usage"') }
        for await (const obj of iterJsonl(path.join(dir, file), usageOnly)) {
          if (obj.type !== 'assistant' || !obj.message?.usage) continue
          // Resume re-logs the same assistant message 2–3× (same message.id / requestId,
          // different uuid). Count each real API response once or usage inflates ~2.3×.
          const dedupKey = obj.message?.id ?? obj.requestId ?? obj.uuid
          if (dedupKey) {
            if (seen.has(dedupKey)) continue
            seen.add(dedupKey)
          }
          const u = obj.message.usage
          const inTok = u.input_tokens ?? 0
          const outTok = u.output_tokens ?? 0
          const { write5m, write1h } = splitCacheWrite(u)
          const cacheRead = u.cache_read_input_tokens ?? 0
          const cacheTok = write5m + write1h + cacheRead
          const model = obj.message.model ?? 'unknown'
          const cost = costFromUsage(model, u)
          const tokens = inTok + outTok
          const ts = parseTimestamp(obj.timestamp)
          const day = ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown'

          const key = `${src.id}|${day}|${model}|${projectName}`
          const e = agg.get(key)
          if (e) {
            e.inputTokens += inTok
            e.outputTokens += outTok
            e.cacheTokens += cacheTok
            e.costUsd += cost
          } else {
            agg.set(key, {
              day,
              model,
              project: projectName,
              source: src.id,
              inputTokens: inTok,
              outputTokens: outTok,
              cacheTokens: cacheTok,
              costUsd: cost
            })
          }

          // Rolling windows (need message-level timestamps).
          if (ts) {
            const age = now - ts
            if (age <= HOUR) {
              win.hour.costUsd += cost
              win.hour.tokens += tokens
            }
            if (age <= SESSION) {
              win.session.costUsd += cost
              win.session.tokens += tokens
            }
            if (age <= WEEK) {
              win.week.costUsd += cost
              win.week.tokens += tokens
            }
          }
        }
      } catch {
        // Unreadable transcript — it contributes nothing and must not stop the rest.
        continue
      }
    }
  }
}

const USAGE_CACHE_TTL = 12 * HOUR
// Bump when the usage computation changes so stale cached reports are discarded.
// v2: dedupe re-logged assistant messages (was inflating cost/tokens ~2.3×).
// v3: price cache writes by their TTL — Claude Code writes 1h entries, which cost
//     2× input, not the flat 1.25× every write was charged at.
const USAGE_CACHE_VERSION = 3

export async function getUsage(force = false): Promise<UsageReport> {
  const now = Date.now()
  if (!force) {
    const cached = storeGet<{ report: UsageReport; at: number; v?: number } | null>('usageCache', null)
    if (cached && cached.v === USAGE_CACHE_VERSION && now - cached.at < USAGE_CACHE_TTL) return cached.report
  }
  const agg = new Map<string, UsageEntry>()
  const win: UsageWindows = {
    hour: { costUsd: 0, tokens: 0 },
    session: { costUsd: 0, tokens: 0 },
    week: { costUsd: 0, tokens: 0 }
  }
  const seen = new Set<string>()
  for (const src of await getSources()) {
    try {
      await collectUsage(src, agg, win, now, seen)
    } catch {
      // skip unreadable source
    }
  }
  const report: UsageReport = { entries: [...agg.values()], windows: win, generatedAt: now }
  storeSet('usageCache', { report, at: now, v: USAGE_CACHE_VERSION })
  return report
}
