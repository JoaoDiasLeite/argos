import type { OpsIntervention } from '../types'

/** Shapes shared by the Ops workspace and ChatTerminal for an ops terminal launch. The IPC
 *  itself is typed on window.electronAPI (types.ts); these name its pieces. */

/** The CLI an ops terminal launches. */
export type OpsTerminalProvider = 'claude' | 'codex' | 'gemini'

/** What the CLI's pty needs to reach the ops relay: its token env and the MCP config. */
export interface OpsTerminalLaunch {
  env: Record<string, string>
  mcpConfigPath: string
}

export type OpsTerminalSessionResult = Awaited<ReturnType<typeof window.electronAPI.opsTerminalSession>>

/** A short, stable, alphanumeric id for a string (cyrb53, base 36). Terminal ids must match
 *  `^[A-Za-z0-9_-]+$`, which a path never does. */
export function hashId(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Every ops terminal's id starts with this, which is how a terminal event is told apart
 *  from a chat's or a server session's. */
export const OPS_TERMINAL_PREFIX = 'opsterm_'

/** The terminal of one intervention: the same runbook, scope, task, ticket and client give
 *  the same terminal (and so its earlier runs); anything else is another one. */
export function opsTerminalIdFor(iv: OpsIntervention): string {
  const scope = iv.scope.kind === 'host' ? `host:${iv.scope.hostId}` : 'open'
  return `${OPS_TERMINAL_PREFIX}${hashId([iv.runbookPath, scope, iv.task, iv.ticket ?? '', iv.client ?? ''].join('\n'))}`
}
