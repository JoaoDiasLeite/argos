/**
 * The wire format between the `--ops-mcp` relay and the running Argos
 * (docs/OPS_AGENT_PLAN.md §9 Phase 5): newline-delimited JSON over a local socket.
 *
 *   relay → main: { id, token, kind: 'hello' | 'call', tool?, args? }
 *   main → relay: { id, ok: true, result: { text, isError } } | { id, ok: false, error }
 *
 * One message is at most OPS_BRIDGE_MAX_FRAME bytes. A line that is too long or does
 * not parse closes the connection: the relay is a program Argos wrote, so a malformed
 * line is a tampered relay or a stranger, and neither gets a conversation.
 *
 * Pure: no sockets here, so framing, size cap and shape checks are tested apart.
 */

/** 4 MB, in both directions. */
export const OPS_BRIDGE_MAX_FRAME = 4 * 1024 * 1024

/** The per-terminal token: 32 lowercase hex characters (16 random bytes). */
export const OPS_TOKEN_RE = /^[0-9a-f]{32}$/

export function isOpsToken(v: unknown): v is string {
  return typeof v === 'string' && OPS_TOKEN_RE.test(v)
}

export interface OpsBridgeRequest {
  id: string
  token: string
  kind: 'hello' | 'call'
  tool?: string
  args?: Record<string, unknown>
}

export type OpsBridgeReply =
  | { id: string; ok: true; result: { text: string; isError: boolean } }
  | { id: string; ok: false; error: string }

/** What `hello` answers, as JSON in `result.text`: enough for the relay to describe the tools. */
export interface OpsBridgeHello {
  runbook: string
  hosts: { id: string; name: string; groups: string[] }[]
  tools: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One line from the relay → a request, or why it is not one. */
export function parseRequest(line: string): { ok: true; msg: OpsBridgeRequest } | { ok: false; error: string } {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (!isObject(v)) return { ok: false, error: 'not an object' }
  if (typeof v.id !== 'string' || v.id === '' || v.id.length > 128) return { ok: false, error: 'bad id' }
  if (!isOpsToken(v.token)) return { ok: false, error: 'bad token' }
  if (v.kind !== 'hello' && v.kind !== 'call') return { ok: false, error: 'bad kind' }
  if (v.kind === 'call') {
    if (typeof v.tool !== 'string' || !/^[a-z_]{1,32}$/.test(v.tool)) return { ok: false, error: 'bad tool' }
    if (v.args !== undefined && !isObject(v.args)) return { ok: false, error: 'bad args' }
  }
  return {
    ok: true,
    msg: {
      id: v.id,
      token: v.token,
      kind: v.kind,
      ...(typeof v.tool === 'string' ? { tool: v.tool } : {}),
      ...(isObject(v.args) ? { args: v.args } : {})
    }
  }
}

/** One line from main → a reply, or why it is not one. */
export function parseReply(line: string): { ok: true; msg: OpsBridgeReply } | { ok: false; error: string } {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (!isObject(v) || typeof v.id !== 'string') return { ok: false, error: 'not a reply' }
  if (v.ok === true && isObject(v.result) && typeof v.result.text === 'string') {
    return { ok: true, msg: { id: v.id, ok: true, result: { text: v.result.text, isError: v.result.isError === true } } }
  }
  if (v.ok === false && typeof v.error === 'string') return { ok: true, msg: { id: v.id, ok: false, error: v.error } }
  return { ok: false, error: 'not a reply' }
}

/** One message as a line. */
export function encodeFrame(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

const TRUNCATED = '\n[truncated by the ops bridge: the result was larger than one message may be]'

/**
 * A reply that fits one frame. A tool result is capped by the policy (2 MB per stream at
 * most), but stdout and stderr together, JSON-escaped, can still pass 4 MB; the tail is
 * cut, and says so, rather than the frame being refused on the other side.
 */
export function encodeReply(reply: OpsBridgeReply, max = OPS_BRIDGE_MAX_FRAME): string {
  let line = encodeFrame(reply)
  if (Buffer.byteLength(line, 'utf-8') <= max || !reply.ok) return line
  let text = reply.result.text
  while (Buffer.byteLength(line, 'utf-8') > max && text.length > 0) {
    const over = Buffer.byteLength(line, 'utf-8') - max
    // Escaping can make one char cost up to 6 bytes; cut generously, then re-measure.
    text = text.slice(0, Math.max(0, text.length - over - TRUNCATED.length - 1024))
    line = encodeFrame({ ...reply, result: { ...reply.result, text: text + TRUNCATED } })
  }
  return line
}

/**
 * Splits a byte stream into lines. `push` returns the complete lines so far, or an
 * error once a line (complete or still open) passes `max` bytes; after an error the
 * splitter is spent and the connection should close.
 */
export interface LineSplitter {
  push(chunk: Buffer | string): { lines: string[]; error?: string }
}

export function createLineSplitter(max = OPS_BRIDGE_MAX_FRAME): LineSplitter {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let failed = false
  return {
    push(chunk) {
      if (failed) return { lines: [], error: 'closed' }
      let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk
      const lines: string[] = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl === -1) break
        const bytes = pendingBytes + nl
        if (bytes > max) {
          failed = true
          return { lines, error: `a message is larger than ${max} bytes` }
        }
        const line = Buffer.concat([...pending, buf.subarray(0, nl)]).toString('utf-8').replace(/\r$/, '')
        pending = []
        pendingBytes = 0
        if (line.trim() !== '') lines.push(line)
        buf = buf.subarray(nl + 1)
      }
      if (buf.length > 0) {
        pending.push(buf)
        pendingBytes += buf.length
        if (pendingBytes > max) {
          failed = true
          return { lines, error: `a message is larger than ${max} bytes` }
        }
      }
      return { lines }
    }
  }
}

/** The endpoint name: a named pipe on Windows, a socket file elsewhere. */
export function bridgeEndpoint(platform: NodeJS.Platform, id: string, socketDir: string, join: (...p: string[]) => string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\argos-ops-${id}` : join(socketDir, `argos-ops-${id}.sock`)
}
