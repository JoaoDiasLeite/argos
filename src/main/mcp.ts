import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getWslClaudeRoots } from './wsl'
import { readJsonFile, writeJsonFileAtomic } from './json-file'

const claudeJsonPath = path.join(os.homedir(), '.claude.json')
const authCachePath = path.join(os.homedir(), '.claude', 'mcp-needs-auth-cache.json')

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

function readJson(p: string): any {
  try {
    return readJsonFile<any>(p)
  } catch {
    return {}
  }
}

function readClaudeJson(): any {
  return readJson(claudeJsonPath)
}

function authNeeded(cachePath: string): Set<string> {
  const set = new Set<string>()
  try {
    const cache = readJsonFile<any>(cachePath)
    // Cache shape varies; collect any server names present.
    const collect = (o: unknown) => {
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (v === true) set.add(k)
          else if (typeof v === 'object') collect(v)
        }
      }
    }
    collect(cache)
  } catch {
    // ignore
  }
  return set
}

function transportOf(cfg: any): McpServer['transport'] {
  if (cfg.command) return 'stdio'
  if (cfg.type === 'sse' || (cfg.url && cfg.type === 'sse')) return 'sse'
  if (cfg.type === 'http' || cfg.url) return 'http'
  return 'unknown'
}

function toServer(
  name: string,
  cfg: any,
  scope: McpServer['scope'],
  source: string,
  needsAuthSet: Set<string>,
  projectPath?: string
): McpServer {
  return {
    name,
    scope,
    source,
    projectPath,
    transport: transportOf(cfg),
    command: cfg.command,
    args: cfg.args,
    url: cfg.url,
    needsAuth: needsAuthSet.has(name),
    config: cfg
  }
}

/** Collect global + per-project MCP servers from one parsed .claude.json. */
function collectFrom(raw: any, source: string, needs: Set<string>, out: McpServer[]): void {
  if (raw?.mcpServers && typeof raw.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(raw.mcpServers)) {
      out.push(toServer(name, cfg, 'global', source, needs))
    }
  }
  if (raw?.projects && typeof raw.projects === 'object') {
    for (const [projectPath, pdata] of Object.entries<any>(raw.projects)) {
      if (pdata?.mcpServers && typeof pdata.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(pdata.mcpServers)) {
          out.push(toServer(name, cfg, 'project', source, needs, projectPath))
        }
      }
    }
  }
}

/**
 * List MCP servers from the local ~/.claude.json AND every reachable WSL distro's
 * ~/.claude.json (read directly over the \\wsl.localhost share — no shelling in).
 */
export async function listMcpServers(): Promise<McpServer[]> {
  const servers: McpServer[] = []

  // Local
  collectFrom(readClaudeJson(), 'local', authNeeded(authCachePath), servers)

  // WSL distros
  try {
    const roots = await getWslClaudeRoots()
    for (const r of roots) {
      const wslAuthCache = r.claudeJsonPath.replace(
        /\.claude\.json$/i,
        '.claude\\mcp-needs-auth-cache.json'
      )
      collectFrom(readJson(r.claudeJsonPath), r.distro, authNeeded(wslAuthCache), servers)
    }
  } catch {
    // WSL not available — local-only is fine.
  }

  return servers.sort((a, b) =>
    a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source)
  )
}

function backupAndWrite(data: unknown): void {
  if (fs.existsSync(claudeJsonPath)) {
    fs.copyFileSync(claudeJsonPath, `${claudeJsonPath}.bak`)
  }
  writeJsonFileAtomic(claudeJsonPath, data)
}

/** Add or update a global MCP server (local ~/.claude.json). cfg is the raw server config. */
export function upsertGlobalMcpServer(name: string, cfg: Record<string, unknown>): Promise<McpServer[]> {
  const raw = readClaudeJson()
  if (!raw.mcpServers || typeof raw.mcpServers !== 'object') raw.mcpServers = {}
  raw.mcpServers[name] = cfg
  backupAndWrite(raw)
  return listMcpServers()
}

export function removeGlobalMcpServer(name: string): Promise<McpServer[]> {
  const raw = readClaudeJson()
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    delete raw.mcpServers[name]
    backupAndWrite(raw)
  }
  return listMcpServers()
}

/** Build the mcpServers object to pass to the Agent SDK for a given project. */
export function mcpServersForProject(projectPath?: string): Record<string, unknown> {
  const raw = readClaudeJson()
  const out: Record<string, unknown> = {}
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    Object.assign(out, raw.mcpServers)
  }
  if (
    projectPath &&
    raw.projects?.[projectPath]?.mcpServers &&
    typeof raw.projects[projectPath].mcpServers === 'object'
  ) {
    Object.assign(out, raw.projects[projectPath].mcpServers)
  }
  return out
}
