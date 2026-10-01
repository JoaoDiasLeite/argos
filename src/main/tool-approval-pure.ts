/**
 * Which tool calls may run without asking, in a chat whose approval mode is 'ask'.
 *
 * This is an allowlist, deliberately. It used to be a denylist of five names
 * (Edit, Write, MultiEdit, NotebookEdit, Bash), which meant every tool it had not
 * heard of ran unprompted: `mcp__*` servers, WebFetch, the Agent tool spawning
 * subagents, KillShell. A denylist is only as complete as the day it was written,
 * and the SDK adds tools without asking. An allowlist fails closed: a new tool
 * asks until someone decides it is harmless and adds it here.
 *
 * What qualifies: reading the local filesystem, reading an MCP resource, and the
 * SDK's own bookkeeping tools (todos, plan mode, questions back to the user). Not
 * qualifying, and so asking: anything that writes, runs a command, reaches the
 * network, spawns another agent, or kills a process.
 */
export const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'BashOutput',
  'TodoRead',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool'
])

/** True when the user must be asked before this tool runs. Unknown names ask. */
export function needsApproval(toolName: string): boolean {
  return !AUTO_ALLOWED_TOOLS.has(toolName)
}
