/**
 * The `ops` MCP server a terminal CLI starts (docs/OPS_AGENT_PLAN.md §9 Phase 5): a thin
 * stdio process that speaks MCP to the CLI and relays every tool call over the local
 * socket to the running Argos. It holds no policy, no ledger and no SSH; main gates,
 * logs, asks and executes, and this only carries the call there and the answer back.
 *
 * Started as `Argos.exe <app>/out/main/ops-relay.js` with ELECTRON_RUN_AS_NODE=1 (see
 * ops-mcp-config.ts), or as `argos --ops-mcp` (index.ts). Reads ARGOS_OPS_PIPE (the
 * bridge's endpoint) and ARGOS_OPS_TOKEN (this terminal's token) from the environment.
 *
 * stdout IS the MCP channel: nothing else may write to it, so console output is moved
 * to stderr before anything loads. The bridge going away ends this process with 0, so
 * the CLI sees the server leave rather than hang.
 *
 * No Electron import: under ELECTRON_RUN_AS_NODE there is no `electron` module.
 */
import * as fs from 'fs'
import * as net from 'net'
import type { Readable, Writable } from 'stream'
import type { McpServer as McpServerClass } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StdioServerTransport as StdioTransportClass } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { z as ZodNs } from 'zod'
import { createLineSplitter, encodeFrame, isOpsToken, parseReply, type OpsBridgeHello, type OpsBridgeReply } from './ops-bridge-pure'
import { opsServerInstructions, opsToolDefs } from './ops-tool-defs-pure'

export const OPS_MCP_FLAG = '--ops-mcp'

export interface OpsRelayIo {
  stdin: Readable
  stdout: Writable
  log: (line: string) => void
  env: NodeJS.ProcessEnv
  exit: (code: number) => void
  /** Tests load the SDK through their own import(); the runtime dynamic import is the default. */
  loadMcp: () => Promise<McpParts>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>

export interface McpParts {
  McpServer: typeof McpServerClass
  StdioServerTransport: typeof StdioTransportClass
  z: typeof ZodNs
}

async function loadMcpParts(): Promise<McpParts> {
  const mcp = (await dynamicImport('@modelcontextprotocol/sdk/server/mcp.js')) as { McpServer: typeof McpServerClass }
  const stdio = (await dynamicImport('@modelcontextprotocol/sdk/server/stdio.js')) as {
    StdioServerTransport: typeof StdioTransportClass
  }
  const zod = (await dynamicImport('zod')) as { z: typeof ZodNs }
  return { McpServer: mcp.McpServer, StdioServerTransport: stdio.StdioServerTransport, z: zod.z }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * In Electron's own main process (not ELECTRON_RUN_AS_NODE) `process.stdin` as a stream
 * delivers nothing on Windows (measured, see notify-hook.ts), while a direct read of the
 * descriptor works; a ReadStream on fd 0 reads it that way.
 */
function defaultIo(): OpsRelayIo {
  const electronMain = !!process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1'
  return {
    stdin: electronMain ? fs.createReadStream('', { fd: 0, autoClose: false }) : process.stdin,
    stdout: electronMain ? fs.createWriteStream('', { fd: 1, autoClose: false }) : process.stdout,
    log: (line) => {
      try {
        process.stderr.write(`[argos ops-mcp] ${line}\n`)
      } catch {
        // nowhere left to say it
      }
    },
    env: process.env,
    exit: (code) => process.exit(code),
    loadMcp: loadMcpParts
  }
}

/** Keep stdout for MCP: anything that logs through console goes to stderr instead. */
function divertConsole(log: (line: string) => void): void {
  const toErr = (...a: unknown[]): void => log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  console.log = toErr
  console.info = toErr
  console.debug = toErr
}

/** The bridge connection: one outstanding request per id, replies matched back. */
interface BridgeClient {
  request(kind: 'hello' | 'call', tool?: string, args?: Record<string, unknown>): Promise<OpsBridgeReply>
}

function connectBridge(endpoint: string, token: string, onClose: () => void): Promise<BridgeClient> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, (r: OpsBridgeReply) => void>()
    let seq = 0
    let connected = false
    const socket = net.createConnection(endpoint)
    const splitter = createLineSplitter()
    socket.on('connect', () => {
      connected = true
      resolve({
        request(kind, tool, args) {
          seq += 1
          const id = `r${seq}`
          return new Promise<OpsBridgeReply>((res) => {
            pending.set(id, res)
            socket.write(encodeFrame({ id, token, kind, ...(tool ? { tool } : {}), ...(args ? { args } : {}) }))
          })
        }
      })
    })
    socket.on('data', (chunk: Buffer) => {
      const { lines, error } = splitter.push(chunk)
      for (const line of lines) {
        const r = parseReply(line)
        if (!r.ok) continue
        const res = pending.get(r.msg.id)
        if (res) {
          pending.delete(r.msg.id)
          res(r.msg)
        }
      }
      if (error) socket.destroy()
    })
    socket.on('error', (e) => {
      if (!connected) reject(e)
    })
    socket.on('close', () => {
      if (connected) onClose()
    })
  })
}

export async function runOpsRelay(override: Partial<OpsRelayIo> = {}): Promise<void> {
  const io: OpsRelayIo = { ...defaultIo(), ...override }
  if (!override.stdout) divertConsole(io.log)

  const endpoint = io.env.ARGOS_OPS_PIPE
  const token = io.env.ARGOS_OPS_TOKEN
  if (!endpoint || !token) {
    io.log('ARGOS_OPS_PIPE and ARGOS_OPS_TOKEN must be set; this server is started by an Argos ops terminal.')
    io.exit(2)
    return
  }
  if (!isOpsToken(token)) {
    io.log('ARGOS_OPS_TOKEN is not a valid ops token.')
    io.exit(2)
    return
  }

  let done = false
  const finish = (code: number): void => {
    if (done) return
    done = true
    io.exit(code)
  }

  let bridge: BridgeClient
  try {
    bridge = await connectBridge(endpoint, token, () => finish(0))
  } catch (e) {
    io.log(`Argos is not reachable at ${endpoint}: ${message(e)}`)
    finish(1)
    return
  }

  const hello = await bridge.request('hello')
  if (!hello.ok || hello.result.isError) {
    io.log(`Argos refused this ops session: ${hello.ok ? hello.result.text : hello.error}`)
    finish(1)
    return
  }
  let info: OpsBridgeHello
  try {
    info = JSON.parse(hello.result.text) as OpsBridgeHello
  } catch {
    io.log('Argos answered hello with something that is not JSON.')
    finish(1)
    return
  }

  let parts: McpParts
  try {
    parts = await io.loadMcp()
  } catch (e) {
    io.log(`Could not load the MCP SDK: ${message(e)}`)
    finish(1)
    return
  }
  const { McpServer, StdioServerTransport, z } = parts
  const hosts = Array.isArray(info.hosts) ? info.hosts : []
  const server = new McpServer({ name: 'ops', version: '1.0.0' }, { instructions: opsServerInstructions(info.runbook, hosts) })
  const offered = new Set(Array.isArray(info.tools) ? info.tools : [])

  for (const def of opsToolDefs(z, hosts)) {
    if (!offered.has(def.name)) continue
    // The SDK's generic over the shape is not worth spelling here: the shape is a zod raw
    // shape from the same zod the SDK resolves, and the handler takes plain JSON.
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: { description: string; inputSchema: Record<string, unknown> },
      cb: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>
    ) => void
    register(def.name, { description: def.description, inputSchema: def.shape }, async (args) => {
      const r = await bridge.request('call', def.name, args)
      return r.ok
        ? { content: [{ type: 'text', text: r.result.text }], isError: r.result.isError }
        : { content: [{ type: 'text', text: `Argos could not run the call: ${r.error}` }], isError: true }
    })
  }

  const transport = new StdioServerTransport(io.stdin, io.stdout)
  transport.onclose = () => finish(0)
  io.stdin.once('end', () => finish(0))
  try {
    await server.connect(transport)
  } catch (e) {
    io.log(`Could not start the MCP transport: ${message(e)}`)
    finish(1)
  }
}
