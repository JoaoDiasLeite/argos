import { spawn } from 'child_process'
import { resolveCodex } from './providers/cli-resolve'

/**
 * Reading Codex's own list of conversations, through the app-server's `thread/list`.
 *
 * This exists because a Codex chat driven from the embedded terminal has no identity
 * link to the conversation it starts. A Claude chat pins its session id before its CLI
 * even launches (`--session-id`), so Argos can find the transcript it will write; the
 * Codex CLI has no such flag, so the only way back to the conversation is to ask Codex
 * what it has. `codex-thread-link-pure.ts` turns the answer into a link.
 *
 * Deliberately the app-server rather than the files underneath it. Codex has moved its
 * history from the `sessions/**\/rollout-*.jsonl` tree that `codex-data.ts` reads into a
 * state database (the CLI still ships a `migrate-rollouts` command for the changeover),
 * and which of the two a given install uses is not ours to keep track of. `thread/list`
 * answers the same either way — it is the CLI's own supported interface, generated
 * bindings and all (`codex app-server generate-json-schema`).
 *
 * Every failure degrades to an empty list. Not finding a thread is the normal state for
 * the first seconds of a chat's life, so no caller can treat it as an error anyway.
 */

export interface CodexThread {
  id: string
  /** The working directory Codex captured for the thread. */
  cwd: string
  /** The user-facing title, once Codex has given the thread one. */
  name?: string
  /** Usually the first user message — what to fall back to before a title exists. */
  preview: string
  /** Unix SECONDS, as the protocol reports them (not milliseconds). */
  createdAt: number
  updatedAt: number
}

// One spawn has to get through a handshake and a database read. Generous, because the
// cost of giving up early is a chat that stays unnamed for another round.
const RPC_TIMEOUT_MS = 15_000

// The rpc ids this module uses. `initialize` is 1 by convention with the rest of the
// codebase (see codex-usage.ts), and the read we actually want is 2.
const INIT_ID = 1
const LIST_ID = 2

interface RawThread {
  id?: unknown
  cwd?: unknown
  name?: unknown
  preview?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

/** Keep only the rows that carry everything a link needs, in our own shape. A thread
 *  with no cwd or no creation time cannot be matched to a chat, so it is not a thread
 *  this module has any use for. */
function parseThreads(data: unknown): CodexThread[] {
  if (!Array.isArray(data)) return []
  const out: CodexThread[] = []
  for (const row of data as RawThread[]) {
    if (typeof row?.id !== 'string' || typeof row.cwd !== 'string') continue
    if (typeof row.createdAt !== 'number') continue
    out.push({
      id: row.id,
      cwd: row.cwd,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : undefined,
      preview: typeof row.preview === 'string' ? row.preview : '',
      createdAt: row.createdAt,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : row.createdAt
    })
  }
  return out
}

/**
 * The Codex threads recorded against any of these working directories.
 *
 * Every cwd goes in one call — `thread/list` takes a list and matches any of them — so a
 * round of linking costs ONE app-server spawn however many chats are waiting on it. That
 * matters: the spawn is the expensive part, and the caller runs on a timer.
 *
 * `configDir` is a CODEX_HOME, for a chat running under a non-default Codex account.
 */
export async function listCodexThreads(
  cwds: string[],
  configDir: string | null
): Promise<CodexThread[]> {
  const wanted = [...new Set(cwds.filter((c) => !!c))]
  if (!wanted.length) return []

  try {
    const { command, prefixArgs } = resolveCodex()
    const child = spawn(command, [...prefixArgs, 'app-server'], {
      env: { ...process.env, ...(configDir ? { CODEX_HOME: configDir } : {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    // A spawn that fails (no codex on PATH) must never reach the caller as a throw — the
    // timeout below resolves it to "no threads", which is the same answer as a machine
    // that has none.
    child.on('error', () => {})

    return await new Promise<CodexThread[]>((resolve) => {
      let settled = false
      let buf = ''

      const finish = (result: CodexThread[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // The app-server runs until it is stopped. Leaving one behind per round would
        // pile up a process every few seconds.
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        resolve(result)
      }

      const timer = setTimeout(() => finish([]), RPC_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line)
          } catch {
            // Newline-delimited JSON-RPC, but the stream also carries whatever the
            // server chooses to say; a line that isn't JSON is simply not for us.
            continue
          }
          if (msg.id !== LIST_ID) continue
          if (msg.error) {
            finish([])
            return
          }
          const result = msg.result as { data?: unknown } | undefined
          finish(parseThreads(result?.data))
          return
        }
      })

      child.on('exit', () => finish([]))

      try {
        child.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: INIT_ID,
            method: 'initialize',
            params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.6.0' } }
          }) + '\n'
        )
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
        child.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: LIST_ID,
            method: 'thread/list',
            params: {
              cwd: wanted,
              // Oldest first, so a folder with several chats hands them out in the order
              // they were started — see pickThreadsForChats, which relies on it.
              sortKey: 'created_at',
              sortDirection: 'asc',
              limit: 100
            }
          }) + '\n'
        )
      } catch {
        finish([])
      }
    })
  } catch {
    return []
  }
}
