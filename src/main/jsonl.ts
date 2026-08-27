import * as fs from 'fs'
import * as readline from 'readline'

/**
 * Streaming reader for Claude Code transcripts (`~/.claude/projects/**\/*.jsonl`).
 *
 * Every transcript read in this process must come through here. Reading a whole
 * transcript into a string is not a style preference: these files are appended to
 * for the life of a conversation and routinely reach tens of megabytes, and this
 * code runs in the Electron main process — a synchronous read of one of them
 * freezes the window, the tray and every other chat along with it.
 */

/** One successfully-parsed entry, with the raw line it came from. */
export interface JsonlEntry {
  /** The original line. Callers that match against the serialized form (search)
   *  need it; parsing and re-serializing would not round-trip. */
  raw: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any
}

export interface IterOptions {
  /**
   * Cheap test against the raw line, applied BEFORE parsing. A caller that wants
   * only the entries carrying a given field should use this rather than filtering
   * the parsed object: `JSON.parse` is by far the expensive part, and a sweep over
   * every project's transcripts parses hundreds of thousands of lines to keep a
   * few hundred. Must be a superset test — it can let through lines the caller
   * then rejects, but never exclude one it needs.
   */
  match?: (raw: string) => boolean
}

/**
 * Yield every parseable entry in `file`, one at a time.
 *
 * A line that fails to parse is skipped: a transcript is appended to by a live
 * process, so the last line can be a partial write, and a stray unparseable line
 * must not cost the caller the rest of the conversation.
 *
 * A read error is NOT swallowed here — it propagates to the caller. Callers that
 * genuinely tolerate an unreadable file catch it themselves and say so; swallowing
 * it centrally would make a permissions error read as "this session is empty".
 */
export async function* iterJsonlEntries(
  file: string,
  opts: IterOptions = {}
): AsyncGenerator<JsonlEntry> {
  const stream = fs.createReadStream(file, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      if (opts.match && !opts.match(line)) continue
      try {
        yield { raw: line, obj: JSON.parse(line) }
      } catch {
        // Partial write or corrupt line — keep scanning.
      }
    }
  } finally {
    // Reached on early `break`/`return` in the consumer too, which is the whole
    // point of the sniff helpers below: stop reading a 100 MB file at line 3.
    rl.close()
    stream.destroy()
  }
}

/** `iterJsonlEntries` for callers that don't need the raw line. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function* iterJsonl(file: string, opts: IterOptions = {}): AsyncGenerator<any> {
  for await (const entry of iterJsonlEntries(file, opts)) yield entry.obj
}

/** How much of a transcript's tail a bounded read looks at. */
export const TAIL_BYTES = 256 * 1024

/**
 * The parseable entries in the last `maxBytes` of a transcript, oldest first.
 *
 * For the appended-at-the-end lines — `custom-title`, `ai-title`, `custom-tags` —
 * where streaming from the top to find the last one would read the whole file. Some
 * transcripts pass 100 MB, and the notification hook runs on every notification.
 *
 * The first line of the window is dropped whenever the window did not start at byte
 * zero: it is a fragment of a line that began before it, and a fragment either fails
 * to parse or, worse, parses into something that is not what was written.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tailJsonlEntries(file: string, maxBytes = TAIL_BYTES): Promise<any[]> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return []
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    const lines = buf.toString('utf-8').split('\n')
    if (start > 0) lines.shift()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // Partial write or corrupt line — keep going, same rule as the streaming read.
      }
    }
    return out
  } finally {
    await handle.close()
  }
}

/**
 * The first `cwd` recorded in a transcript, or null.
 *
 * Stops at the first hit. The encoded directory name is lossy (every non-alphanumeric
 * character becomes a dash), so the real project path is sniffed from the transcript
 * instead — and it is written on essentially every entry, so this reads a handful of
 * lines rather than the file.
 */
export async function sniffCwd(file: string): Promise<string | null> {
  for await (const obj of iterJsonl(file, { match: (raw) => raw.includes('"cwd"') })) {
    const cwd = obj?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  }
  return null
}
