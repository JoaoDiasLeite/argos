import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import {
  Attribution,
  SessionPaths,
  attribute,
  authoredPath,
  toRepoRelative
} from './authorship-pure'
import { checkpointPaths } from './checkpoints'
import { getStatus, getRepoRoot } from './git'
import { readChatTranscript } from './claude-data'

/**
 * Which chat wrote which file — kept here, in the main process, and on disk.
 *
 * The renderer has tracked this all along (`modifiedFilesRef` in `App.tsx`) and still
 * does, for checkpoints. That record cannot carry a commit gate: it is fed only by the
 * SDK's `tool-use` events, so it is empty for a chat driven from the terminal, it is
 * empty for a chat whose run went out over WSL or SSH, and it is gone the next time the
 * app starts. All three are the normal way of working here.
 *
 * So the ledger lives beside the other one-JSON-record stores (`agents.ts`,
 * `planner.ts`), is written from every path a run can take, and is read back by the Git
 * panel to say, of the files dirty in a repo, which came from the chat you are standing
 * in and which did not.
 */

export interface LedgerEntry {
  /** Absolute paths, in whatever spelling the CLI that wrote them used. */
  paths: string[]
  updatedAt: number
}

type Ledger = Record<string, LedgerEntry>

const ledgerPath = (): string => path.join(app.getPath('userData'), 'authorship.json')
const sessionsDir = (): string => path.join(app.getPath('userData'), 'sessions')

/**
 * A chat that edits for an hour produces thousands of tool calls over a few dozen files,
 * and the set collapses them. The cap is only there so a runaway loop writing generated
 * files cannot grow one JSON file without bound; the oldest entries go first.
 */
const MAX_PATHS_PER_SESSION = 2000

let cache: Ledger | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function load(): Ledger {
  if (cache) return cache
  try {
    cache = readJsonFile<Ledger>(ledgerPath())
  } catch {
    // Absent on first run, and unreadable is the same thing as far as anyone here is
    // concerned — an empty ledger attributes nothing, which is the honest answer.
    cache = {}
  }
  return cache
}

/**
 * Written debounced: a single turn can touch one file forty times, and the ledger is
 * read by a person opening a panel, not by anything that races the writes.
 */
function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      writeJsonFileAtomic(ledgerPath(), load())
    } catch {
      // Losing the ledger costs attribution, never work — the files are on disk either
      // way. Retried on the next edit.
    }
  }, 1000)
}

/** Record the files a chat wrote. Absolute paths, exactly as the CLI reported them. */
export function recordAuthored(appSessionId: string, paths: string[]): void {
  if (!appSessionId || !paths.length) return
  const ledger = load()
  const existing = ledger[appSessionId]?.paths ?? []
  const merged = [...new Set([...existing, ...paths.filter(Boolean)])]
  ledger[appSessionId] = {
    paths: merged.length > MAX_PATHS_PER_SESSION ? merged.slice(-MAX_PATHS_PER_SESSION) : merged,
    updatedAt: Date.now()
  }
  scheduleWrite()
}

/**
 * The feed every live run goes through: one tool call in, nothing or one path out.
 *
 * Called from the SDK loop in `index.ts` and from `claude-stream.ts`, which is the same
 * pair of places the renderer's `tool-use` events come from — so a chat run locally, in
 * a distro or over SSH all land here alike.
 */
export function recordToolUse(appSessionId: string, tool: string, input: unknown): void {
  const p = authoredPath(tool, input)
  if (p) recordAuthored(appSessionId, [p])
}

/** Drop a chat's claim entirely — for a chat being deleted, or one being disowned. */
export function forgetSession(appSessionId: string): void {
  const ledger = load()
  if (!(appSessionId in ledger)) return
  delete ledger[appSessionId]
  scheduleWrite()
}

interface SessionRecord {
  id: string
  name?: string
  projectPath?: string
  worktreePath?: string
  claudeSessionId?: string
  terminalSessionId?: string
}

function readSessionRecord(id: string): SessionRecord | null {
  try {
    return readJsonFile<SessionRecord>(path.join(sessionsDir(), `${id}.json`))
  } catch {
    return null
  }
}

function listSessionRecords(): SessionRecord[] {
  try {
    return fs
      .readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [readJsonFile<SessionRecord>(path.join(sessionsDir(), f))]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * Give a chat that predates the ledger something to say for itself.
 *
 * Two sources, both read once and then folded into the ledger like any other entry, so
 * the cost is paid on the first Git panel a chat sees and never again:
 *
 * - **Its checkpoints.** `Checkpoint.files` is already a list of the paths a chat
 *   touched, for every chat that reached a checkpoint.
 * - **Its transcript.** A chat driven from the terminal wrote its own record through the
 *   CLI, and `readChatTranscript` already parses the tool calls out of it. This covers
 *   Claude Code only: the Codex reader deliberately does not parse tool calls
 *   (`codex-data.ts`), and Gemini has no transcript of this shape at all, so a terminal
 *   chat on those two is attributed from its checkpoints or not at all — which the Git
 *   panel shows as "unattributed" rather than as somebody else's work.
 */
async function backfill(sessionId: string): Promise<void> {
  const rec = readSessionRecord(sessionId)
  const found = new Set<string>(checkpointPaths(sessionId))

  const ccId = rec?.claudeSessionId || rec?.terminalSessionId
  const cwd = rec?.worktreePath || rec?.projectPath
  if (ccId && cwd) {
    const transcript = await readChatTranscript(cwd, ccId)
    for (const m of transcript?.messages ?? []) {
      for (const c of m.toolCalls ?? []) {
        const p = authoredPath(c.tool, c.input)
        if (p) found.add(p)
      }
    }
  }
  // Recorded even when nothing was found, so the scan is not repeated on every open.
  const ledger = load()
  if (!ledger[sessionId]) ledger[sessionId] = { paths: [], updatedAt: 0 }
  recordAuthored(sessionId, [...found])
  scheduleWrite()
}

export interface RepoAttribution extends Attribution {
  /** False when `cwd` is not a git repo — the panel keeps its plain list in that case. */
  isRepo: boolean
}

/**
 * Attribute a repo's dirty files to the chats that wrote them.
 *
 * The repo *root* is resolved first, not reused from `cwd`: `git status --porcelain`
 * reports paths from the root, while a chat's folder can be any directory inside it, and
 * joining the two without asking produces paths that match nothing.
 */
export async function attributionFor(
  cwd: string,
  activeSessionId?: string
): Promise<RepoAttribution> {
  const status = await getStatus(cwd)
  if (!status.isRepo) return { isRepo: false, mine: [], others: [], unattributed: [] }
  const root = (await getRepoRoot(cwd)) || cwd

  if (activeSessionId && !load()[activeSessionId]) await backfill(activeSessionId)

  const ledger = load()
  const names = new Map(listSessionRecords().map((s) => [s.id, s.name || 'Untitled chat']))
  const worktrees = new Map(
    listSessionRecords()
      .filter((s) => s.worktreePath)
      .map((s) => [s.id, s.worktreePath as string])
  )

  const ledgers: SessionPaths[] = Object.entries(ledger).map(([sessionId, entry]) => ({
    sessionId,
    name: names.get(sessionId) ?? 'A chat Argos no longer has',
    updatedAt: entry.updatedAt,
    paths: entry.paths
      .map((p) => toRepoRelative(p, root, worktrees.get(sessionId)))
      .filter((p): p is string => !!p)
  }))

  return {
    isRepo: true,
    ...attribute(
      status.files.map((f) => f.path),
      ledgers,
      activeSessionId
    )
  }
}
