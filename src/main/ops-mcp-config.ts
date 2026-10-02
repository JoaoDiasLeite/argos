/**
 * Writes and removes the per-terminal MCP config of an ops terminal (shapes in
 * ops-mcp-config-pure.ts). The folder is `userData/ops-mcp/<terminalId>/`, created 0700
 * and the file 0600 where the platform honours modes: it holds the session token.
 *
 * No Electron here; index.ts passes the folder.
 */
import * as fs from 'fs'
import * as path from 'path'
import { opsMcpConfigFile, type OpsCli, type OpsRelayCommand } from './ops-mcp-config-pure'

export function writeOpsMcpConfig(
  dir: string,
  provider: OpsCli,
  relayCommand: OpsRelayCommand,
  env: Record<string, string>,
  opts: { runbookPath?: string } = {}
): { path: string } {
  const file = opsMcpConfigFile(provider, relayCommand, env, opts)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = path.join(dir, file.fileName)
  fs.writeFileSync(p, file.content, { encoding: 'utf-8', mode: 0o600 })
  return { path: p }
}

export function removeOpsMcpConfig(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort: a leftover holds a revoked token, which the bridge no longer accepts
  }
}
