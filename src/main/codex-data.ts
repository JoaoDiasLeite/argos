import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { StringDecoder } from 'string_decoder'
import { iterJsonlEntries } from './jsonl'
import { boilerplateKeys, previewKey, previewRestatesTitle } from './transcript-text'
import {
  CodexRolloutFacts,
  codexContentText,
  codexUserText,
  encodeProjectPath,
  groupRolloutsByCwd,
  parseRolloutFileName,
  reduceThreadNames,
  rolloutDateSegments
} from './codex-data-pure'
import {
  deleteTranscript,
  FileOpResult,
  moveTranscript,
  normalizeTitle
} from './session-files'
// Type-only, so this does NOT create a runtime import cycle with claude-data.ts —
// which imports this module for real. The shapes are the ones Projects already
// consumes; a Codex project must be indistinguishable from a Claude Code one at the
// IPC boundary or the view would need a second code path for it.
import type { CCProject, CCSessionMeta, CCTranscriptMessage } from './claude-data'

/**
 * Reading Codex's own transcripts, in the shapes `ccListProjects` / `ccListSessions`
 * already return.
 *
 * Codex stores conversations nothing like Claude Code does. There is no directory
 * per project: every transcript lands in a date tree under `~/.codex/sessions`, and
 * the only thing saying which folder it belongs to is the `cwd` on its first line.
 * So a "project" here is derived, not listed — see `groupRolloutsByCwd`.
 *
 * The cost model is the point of this file. There are hundreds of these files and
 * Projects has to open immediately, so listing projects reads exactly ONE line per
 * transcript (`iterJsonlEntries` with a raw prefilter, stopped at the first hit) and
 * the result is cached for as long as `getSources` caches its own probing. Only
 * opening a single project pays for a full read, and only of that project's files.
 */

// ─── Sources ────────────────────────────────────────────────────────────────

/**
 * One Codex installation Argos can read.
 *
 * `home` is a CODEX_HOME: the machine default, or a per-account isolated one from
 * provider-accounts.ts. Those accounts already exist and each keeps its OWN
 * `sessions/` tree, so a conversation run under a second account is invisible unless
 * its home is listed here — the same reason `getSources` walks Claude's accounts.
 */
export interface CodexSource {
  id: string
  label: string
  home: string
  sessionsDir: string
  indexPath: string
}

export const CODEX_SOURCE_PREFIX = 'codex'

function makeSource(id: string, label: string, home: string): CodexSource {
  return {
    id,
    label,
    home,
    sessionsDir: path.join(home, 'sessions'),
    indexPath: path.join(home, 'session_index.jsonl')
  }
}

/** The machine's own Codex home, honouring an externally set CODEX_HOME. */
export function defaultCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv
  return path.join(os.homedir(), '.codex')
}

/** A non-default Codex account's isolated CODEX_HOME, as the caller knows it. */
export interface CodexAccountHome {
  id: string
  name: string
  home: string
}

/**
 * Every Codex home worth listing. Never throws and never probes anything expensive —
 * this runs inside `getSources`, which the Usage and Projects views both hit.
 *
 * A home that does not exist is simply not a source: a machine without Codex must
 * produce no Codex row at all, not an empty one.
 *
 * The accounts are passed in rather than read from provider-accounts.ts, so this
 * module never touches Electron and stays runnable outside a main process.
 */
export function codexSources(accounts: CodexAccountHome[] = []): CodexSource[] {
  const sources: CodexSource[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, home: string): void => {
    const key = path.resolve(home).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    if (!fs.existsSync(path.join(home, 'sessions'))) return
    sources.push(makeSource(id, label, home))
  }
  add(CODEX_SOURCE_PREFIX, 'Codex', defaultCodexHome())
  for (const account of accounts) {
    if (!account.home) continue
    add(`${CODEX_SOURCE_PREFIX}:${account.id}`, `Codex · ${account.name}`, account.home)
  }
  return sources
}

// ─── Header scan ────────────────────────────────────────────────────────────

function parseTimestamp(v: unknown): number {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

/** True for the errors that mean "this file is simply not there any more". */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The `cwd` and start time from a transcript's `session_meta` header.
 *
 * One line. The prefilter keeps `JSON.parse` off every other line in the file, and
 * the `return` inside the loop closes the stream at the first hit — a rollout can be
 * tens of megabytes and this reads the first chunk of it.
 *
 * A read error is NOT caught here. Per the streaming rule in PLAN.md ("Lot 0"),
 * treating unreadable as empty is what makes a real session vanish without a word;
 * the caller decides, and the only failure it forgives is the file being gone.
 */
async function readRolloutHeader(file: string): Promise<{ cwd: string; createdAt: number } | null> {
  for await (const { obj } of iterJsonlEntries(file, { match: (raw) => raw.includes('"session_meta"') })) {
    if (obj?.type !== 'session_meta') continue
    const cwd = obj?.payload?.cwd
    // The header is the first line by construction. Whatever it said is the answer,
    // even if it carried no cwd — there is no second header to go looking for.
    if (typeof cwd !== 'string' || !cwd) return null
    return { cwd, createdAt: parseTimestamp(obj?.payload?.timestamp ?? obj?.timestamp) }
  }
  // No header at all: a truncated or not-yet-written file. Normal, not an error.
  return null
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Every `rollout-*.jsonl` under a `sessions/<YYYY>/<MM>/<DD>` tree. */
function rolloutFiles(sessionsDir: string): { file: string; sessionId: string; startedAt: number }[] {
  const out: { file: string; sessionId: string; startedAt: number }[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // A missing or unreadable date bucket contributes nothing; the tree is
      // rebuilt by Codex on demand and half of it existing is the normal state.
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Depth-limited rather than unbounded: the layout is year/month/day and
      // nothing else down there is a transcript.
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
        continue
      }
      const parsed = parseRolloutFileName(entry.name)
      if (!parsed) continue
      out.push({ file: full, sessionId: parsed.sessionId, startedAt: parsed.startedAt })
    }
  }
  walk(sessionsDir, 0)
  return out
}

// Same discipline as claude-data.ts's `sourceCache`: a 30s window, so moving between
// Projects and a project's session list does not re-scan hundreds of headers.
const SCAN_TTL = 30000
const scanCache = new Map<string, { at: number; rollouts: CodexRolloutFacts[] }>()

/**
 * Where an archived Codex transcript lives: `<CODEX_HOME>/archived_sessions`, flat.
 *
 * Codex's own directory, not one Argos invents — the CLI created it and leaves files
 * there alone. Flat is what makes unarchiving reconstructable: the rollout keeps its
 * name, and the name says which date bucket it came out of (`rolloutDateSegments`).
 */
export function codexArchivedDir(src: CodexSource): string {
  return path.join(src.home, 'archived_sessions')
}

/**
 * Every transcript in a Codex home, with just enough read to place it in a project.
 *
 * Read errors propagate. A caller that cannot afford one (the combined project list,
 * which must survive a broken Codex install) catches it at the source boundary and
 * loses only the Codex rows — losing one session quietly is the outcome that rule
 * exists to prevent.
 */
export async function scanCodexRollouts(src: CodexSource, force = false): Promise<CodexRolloutFacts[]> {
  return scanDir(src.id, src.sessionsDir, force)
}

/**
 * The same scan over the archive. Kept separate rather than merged with a flag on the
 * facts, because every caller already knows which of the two it is asking about and a
 * mixed list would have to be split again by all of them.
 */
export async function scanCodexArchived(src: CodexSource, force = false): Promise<CodexRolloutFacts[]> {
  return scanDir(`${src.id}::archived`, codexArchivedDir(src), force)
}

async function scanDir(cacheKey: string, dir: string, force: boolean): Promise<CodexRolloutFacts[]> {
  const now = Date.now()
  const cached = scanCache.get(cacheKey)
  if (!force && cached && now - cached.at < SCAN_TTL) return cached.rollouts

  const rollouts: CodexRolloutFacts[] = []
  for (const { file, sessionId, startedAt } of rolloutFiles(dir)) {
    let header: { cwd: string; createdAt: number } | null
    try {
      header = await readRolloutHeader(file)
    } catch (err) {
      // Deleted or rotated out from under the scan — genuinely nothing to list.
      if (isMissing(err)) continue
      throw err
    }
    if (!header) continue
    rollouts.push({
      sessionId,
      file,
      cwd: header.cwd,
      createdAt: header.createdAt || startedAt,
      mtime: statMtime(file)
    })
  }
  scanCache.set(cacheKey, { at: now, rollouts })
  return rollouts
}

/** Drop a home's cached scan, so the next listing re-reads the headers. */
export function invalidateCodexScan(): void {
  scanCache.clear()
}

// ─── Projects ───────────────────────────────────────────────────────────────

/**
 * Codex's projects for one home, in the shape Projects already renders.
 *
 * Built from both trees. A project whose every conversation has been archived still
 * has to appear — it is the one an unarchive has to be reachable from — so the
 * archive contributes rows of its own, with no active sessions in them.
 */
export async function codexProjects(src: CodexSource): Promise<CCProject[]> {
  const active = groupRolloutsByCwd(await scanCodexRollouts(src))
  const archived = new Map(
    groupRolloutsByCwd(await scanCodexArchived(src)).map((g) => [g.encodedDir, g])
  )
  const groups = [...active]
  for (const [encodedDir, g] of archived) {
    if (!active.some((a) => a.encodedDir === encodedDir)) groups.push({ ...g, sessionCount: 0 })
  }
  return groups.map((g) => ({
    encodedDir: g.encodedDir,
    realPath: g.realPath,
    name: g.name,
    sessionCount: g.sessionCount,
    archivedCount: archived.get(g.encodedDir)?.sessionCount ?? 0,
    lastActive: g.lastActive,
    sourceId: src.id,
    sourceLabel: src.label,
    kind: 'local' as const,
    provider: 'codex' as const,
    // Filing a project away is a per-source-and-directory preference in store.ts and
    // the caller applies it uniformly; leaving it false here would silently unfile
    // every Codex project, so the caller overlays the real value.
    archived: false
  }))
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/**
 * The thread names Codex keeps outside the transcripts, read once per listing.
 *
 * Streamed like every other `.jsonl` in this process, not slurped — the file grows by
 * a line on every rename and nothing bounds it. A missing file is a home where
 * nothing has been named yet, which is not an error.
 */
async function threadNames(src: CodexSource): Promise<Map<string, string>> {
  const entries: unknown[] = []
  try {
    for await (const { obj } of iterJsonlEntries(src.indexPath)) entries.push(obj)
  } catch (err) {
    if (isMissing(err)) return new Map()
    throw err
  }
  return reduceThreadNames(entries)
}

interface SessionBody {
  preview: string
  messageCount: number
  model?: string
  lastMessageAt: number
}

/**
 * The parts of a session only a full read can give: how many turns it had, what it
 * opened with, and when it last moved.
 *
 * Prefiltered to the two payload kinds that carry any of it. A rollout interleaves
 * reasoning, tool calls and world-state snapshots with the conversation, and parsing
 * those to throw them away is most of what an unfiltered read would spend its time
 * on — the same reasoning as the usage sweep's `"usage"` prefilter.
 */
async function readSessionBody(file: string): Promise<SessionBody> {
  let preview = ''
  let messageCount = 0
  let model: string | undefined
  let lastMessageAt = 0
  const match = (raw: string): boolean =>
    raw.includes('"type":"message"') || raw.includes('"type": "message"') || raw.includes('turn_context')
  for await (const { obj } of iterJsonlEntries(file, { match })) {
    const payload = obj?.payload
    if (!payload || typeof payload !== 'object') continue
    if (obj?.type === 'turn_context') {
      // The model can change mid-conversation; the last one is the one to resume with.
      if (typeof payload.model === 'string' && payload.model) model = payload.model
      continue
    }
    if (obj?.type !== 'response_item' || payload.type !== 'message') continue
    const role = payload.role
    // `developer` is the harness talking to itself — sandbox policy, skill listings.
    // It is neither side of the conversation and must not be counted as a turn.
    if (role !== 'user' && role !== 'assistant') continue
    messageCount++
    const ts = parseTimestamp(obj?.timestamp)
    if (ts) lastMessageAt = Math.max(lastMessageAt, ts)
    if (!preview && role === 'user') {
      // Empty means this entry was entirely Codex's own injected context, so the
      // loop falls through to the next one — the preview should be the conversation,
      // not the environment block that opened it.
      preview = codexUserText(payload.content).slice(0, 160)
    }
  }
  return { preview, messageCount, model, lastMessageAt }
}

/**
 * The sessions of one Codex project, active or archived.
 *
 * Archived means the file sits in `archived_sessions/` — the same "it is where it is"
 * rule the Claude Code side follows, rather than a flag stored beside the transcript.
 */
export async function codexSessions(
  src: CodexSource,
  encodedDir: string,
  archived = false
): Promise<CCSessionMeta[]> {
  const scan = archived ? await scanCodexArchived(src) : await scanCodexRollouts(src)
  const rollouts = scan.filter((r) => encodeProjectPath(r.cwd) === encodedDir)
  if (!rollouts.length) return []
  const realPath = rollouts[0].cwd
  const names = await threadNames(src)

  const sessions: CCSessionMeta[] = []
  for (const r of rollouts) {
    let body: SessionBody
    try {
      body = await readSessionBody(r.file)
    } catch (err) {
      // Gone since the scan — there is no session left to list.
      if (isMissing(err)) continue
      throw err
    }
    sessions.push({
      sessionId: r.sessionId,
      encodedDir,
      realPath,
      // A name the user gave the thread beats one inferred from its opening line,
      // the same precedence `custom-title` gets on the Claude Code side.
      title: names.get(r.sessionId) || body.preview || r.sessionId.slice(0, 8),
      preview: body.preview,
      messageCount: body.messageCount,
      model: body.model,
      createdAt: r.createdAt,
      updatedAt: body.lastMessageAt || r.mtime,
      sourceId: src.id,
      kind: 'local',
      provider: 'codex',
      // Codex has no tag concept. An empty array, not undefined: the view maps over it.
      tags: [],
      previewRedundant: false,
      archived
    })
  }

  // Same judgement the Claude Code listing makes, and reusing the same code: whether
  // an opening line tells one session apart from another can only be decided against
  // the rest of the project.
  const boilerplate = boilerplateKeys(sessions.map((s) => s.preview))
  for (const s of sessions) {
    s.previewRedundant =
      !s.preview || boilerplate.has(previewKey(s.preview)) || previewRestatesTitle(s.preview, s.title)
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── Transcript ─────────────────────────────────────────────────────────────

/**
 * Where a Codex session's transcript is, or null.
 *
 * The id comes from the renderer and is used to pick a file out of a scan Argos
 * built, never to construct a path — so there is nothing here for a crafted id to
 * escape from, and no need for the charset guards `safeSessionPath` applies.
 */
export async function rolloutFileFor(
  src: CodexSource,
  sessionId: string,
  archived = false
): Promise<string | null> {
  // Both trees are consulted whichever way the caller asked. The renderer's `archived`
  // is what its last listing said, and a conversation archived from another window is
  // still the same conversation — failing with "not found" because it moved since is
  // an answer about Argos's bookkeeping, not about the user's transcript.
  const first = archived ? await scanCodexArchived(src) : await scanCodexRollouts(src)
  const hit = first.find((r) => r.sessionId === sessionId)
  if (hit) return hit.file
  const second = archived ? await scanCodexRollouts(src) : await scanCodexArchived(src)
  return second.find((r) => r.sessionId === sessionId)?.file ?? null
}

/**
 * A Codex conversation as the transcript pane's own message shape.
 *
 * Messages only. Codex logs its reasoning and its tool calls as separate payload
 * kinds with their own vocabulary, and mapping those onto Claude Code's `tool_use` /
 * `tool_result` pairs would be a guess — an empty `toolCalls` says "not read yet",
 * an invented one says something false about what the agent did.
 */
export async function codexTranscript(src: CodexSource, sessionId: string): Promise<CCTranscriptMessage[]> {
  const file = await rolloutFileFor(src, sessionId)
  if (!file) return []
  const messages: CCTranscriptMessage[] = []
  for await (const { obj } of iterJsonlEntries(file, {
    match: (raw) => raw.includes('"type":"message"') || raw.includes('"type": "message"')
  })) {
    if (obj?.type !== 'response_item') continue
    const payload = obj?.payload
    if (!payload || payload.type !== 'message') continue
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') continue
    // The same stripping the preview uses: Codex's injected context blocks arrive in
    // the user's channel and are not part of the conversation.
    const text = role === 'user' ? codexUserText(payload.content) : codexContentText(payload.content).trim()
    if (!text) continue
    messages.push({ role, text, toolCalls: [], timestamp: parseTimestamp(obj?.timestamp) })
  }
  return messages
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Renaming, archiving, moving and deleting a Codex conversation.
 *
 * Every one of these goes through Codex's own mechanisms rather than a preference
 * Argos keeps on the side: a name is a line in `session_index.jsonl`, archiving is
 * the file being in `archived_sessions/`, and the project a conversation belongs to
 * is the `cwd` in its header. The CLI sees each of them, which is the point — a
 * conversation renamed here is renamed in `codex resume` too.
 *
 * Ids never build a path here. They pick a file out of a scan Argos did, the same way
 * the readers do, so there is nothing for a crafted id to escape from.
 */

/** Drop every cached scan, active and archived — any write invalidates both. */
function invalidateAfterWrite(): void {
  invalidateCodexScan()
}

export async function codexDeleteSession(
  src: CodexSource,
  sessionId: string,
  archived = false
): Promise<FileOpResult> {
  const file = await rolloutFileFor(src, sessionId, archived)
  if (!file) return { ok: false, error: 'not-found' }
  const res = await deleteTranscript(file)
  if (res.ok) invalidateAfterWrite()
  return res
}

/**
 * Rename by appending to `session_index.jsonl`.
 *
 * Append-only and last-one-wins (`reduceThreadNames`), which is exactly how Codex
 * itself records a rename — so this is the same write the CLI would have made, not a
 * shadow copy of the name that only Argos would read back.
 */
export async function codexRenameSession(
  src: CodexSource,
  sessionId: string,
  raw: unknown
): Promise<FileOpResult> {
  let title: string
  try {
    title = normalizeTitle(raw)
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
  const file = await rolloutFileFor(src, sessionId, false)
  if (!file) return { ok: false, error: 'not-found' }
  try {
    await fs.promises.appendFile(
      src.indexPath,
      JSON.stringify({ id: sessionId, thread_name: title, updated_at: new Date().toISOString() }) +
        '\n'
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}

export async function codexArchiveSession(
  src: CodexSource,
  sessionId: string
): Promise<FileOpResult> {
  const file = await rolloutFileFor(src, sessionId, false)
  if (!file) return { ok: false, error: 'not-found' }
  const res = await moveTranscript(file, path.join(codexArchivedDir(src), path.basename(file)))
  if (res.ok) invalidateAfterWrite()
  return res
}

/**
 * Back out of the archive, into the date bucket the rollout's own name names.
 *
 * Not "wherever it came from" remembered somewhere — the name carries the date, so
 * the bucket is derivable, and an archive Argos did not create still unarchives to
 * the right place.
 */
export async function codexUnarchiveSession(
  src: CodexSource,
  sessionId: string
): Promise<FileOpResult> {
  const file = await rolloutFileFor(src, sessionId, true)
  if (!file) return { ok: false, error: 'not-found' }
  const name = path.basename(file)
  const segments = rolloutDateSegments(name)
  if (!segments) {
    return { ok: false, error: 'failed', message: 'This transcript has an unrecognised name.' }
  }
  const res = await moveTranscript(file, path.join(src.sessionsDir, ...segments, name))
  if (res.ok) invalidateAfterWrite()
  return res
}

/**
 * Move a conversation to another project, by rewriting the `cwd` in its header.
 *
 * This is where Codex and Claude Code genuinely differ. A Claude Code transcript is
 * filed by the directory it sits in, so moving it is cosmetic and the recorded cwd is
 * left alone. A Codex rollout sits in a date bucket that says nothing about the
 * project — the cwd IS the filing — so moving one means changing it, and a later
 * `codex resume` will start in the new folder. The caller says so in as many words
 * before asking for this.
 *
 * Only the header line is rewritten, through a temp file: the conversation's own
 * lines are copied byte for byte, and an interrupted write leaves the original in
 * place rather than a half-rewritten transcript.
 */
export async function codexMoveSession(
  src: CodexSource,
  sessionId: string,
  toCwd: string,
  archived = false
): Promise<FileOpResult> {
  const file = await rolloutFileFor(src, sessionId, archived)
  if (!file) return { ok: false, error: 'not-found' }
  try {
    const rewritten = await rewriteFirstLine(file, (line) => {
      const obj = JSON.parse(line)
      if (obj?.type !== 'session_meta' || !obj?.payload) return null
      obj.payload.cwd = toCwd
      return JSON.stringify(obj)
    })
    if (!rewritten) {
      return {
        ok: false,
        error: 'failed',
        message: 'This transcript has no header saying where it ran, so it cannot be refiled.'
      }
    }
    invalidateAfterWrite()
    return { ok: true }
  } catch (e) {
    if (isMissing(e)) return { ok: false, error: 'not-found' }
    return { ok: false, error: 'failed', message: (e as Error).message }
  }
}

/**
 * Replace a file's first line, streaming the rest through untouched.
 *
 * Streamed rather than read whole: a rollout runs to tens of megabytes and only its
 * first line is of any interest here. `transform` returning null means the line was
 * not what the caller expected — nothing is written and the original stands.
 */
async function rewriteFirstLine(
  file: string,
  transform: (line: string) => string | null
): Promise<boolean> {
  const first = await readFirstLine(file)
  if (first === null) return false
  const replacement = transform(first)
  if (replacement === null) return false

  const tmp = `${file}.argos-tmp`
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp)
    out.on('error', reject)
    out.on('finish', () => resolve())
    // `start` skips the original header exactly, so the remaining bytes — including
    // whatever encoding or trailing state they carry — are never parsed, only copied.
    const rest = fs.createReadStream(file, { start: Buffer.byteLength(first, 'utf8') })
    rest.on('error', reject)
    out.write(replacement)
    rest.pipe(out)
  })
  await fs.promises.rename(tmp, file)
  return true
}

/** A file's first line, without its newline, or null for an empty file. */
async function readFirstLine(file: string): Promise<string | null> {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      buffered += decoder.write(chunk as Buffer)
      const nl = buffered.indexOf('\n')
      if (nl !== -1) return buffered.slice(0, nl)
    }
  } finally {
    stream.destroy()
  }
  buffered += decoder.end()
  return buffered || null
}
