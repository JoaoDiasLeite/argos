/**
 * The `ops` tools as the model sees them: names, descriptions and argument schemas. One
 * definition for both servers that expose them, the SDK chat's in-process server
 * (ops-tools.ts) and the stdio relay a terminal CLI starts (ops-relay.ts), so the two
 * front ends describe the same tools in the same words.
 *
 * Pure: zod is handed in, because both callers load it at runtime from the ESM graph
 * their MCP library uses, and the schemas must be that instance's.
 */
import type { z as ZodNs } from 'zod'

/** A host as the tool descriptions list it. */
export interface OpsToolHost {
  id: string
  name: string
  groups: string[]
}

/** The six tool names, bare (the model sees them as `mcp__ops__<name>`). */
export const OPS_BRIDGE_TOOLS = ['propose_plan', 'run', 'script', 'read', 'list', 'write'] as const
export type OpsBridgeTool = (typeof OPS_BRIDGE_TOOLS)[number]

export const OPS_TOOL_RULES =
  'One simple command only: no chaining (;, &&, ||), no pipes, redirections, subshells or variable assignments. ' +
  'Use the scripts the runbook provides for anything that needs more than one command. ' +
  "Every call is checked against the runbook policy and may be refused or need the operator's approval."

/** The hosts the model may name, in every tool description: the id is what it must send. */
export function opsHostListText(hosts: OpsToolHost[]): string {
  const rows = hosts.map((h) => `- ${h.name} (hostId: ${h.id}; groups: ${h.groups.join(', ')})`)
  return `Hosts in this runbook:\n${rows.length ? rows.join('\n') : '- (no hosts)'}`
}

export function opsServerInstructions(runbookName: string, hosts: OpsToolHost[]): string {
  return `Remote operations for runbook ${runbookName}. ${OPS_TOOL_RULES}\n${opsHostListText(hosts)}`
}

export interface OpsToolDef {
  name: OpsBridgeTool
  description: string
  /** A zod raw shape, as both `tool()` and `registerTool` take it. */
  shape: Record<string, ZodNs.ZodType>
}

export function opsToolDefs(z: typeof ZodNs, hosts: OpsToolHost[]): OpsToolDef[] {
  const h = opsHostListText(hosts)
  return [
    {
      name: 'propose_plan',
      description:
        'Call this once, before any other ops tool: list the steps you intend to run, one per entry, naming the host and the command or script. Nothing runs until the operator approves the plan.',
      shape: { steps: z.array(z.string().min(1)).min(1).max(40) }
    },
    {
      name: 'run',
      description: `Run one command on a runbook host over SSH and return its exit code, stdout and stderr. ${OPS_TOOL_RULES}\n${h}`,
      shape: { hostId: z.string(), cmd: z.string() }
    },
    {
      name: 'script',
      description: `Run one of the runbook's scripts (by file name, from its scripts/ folder) on a host, with arguments as separate strings. ${OPS_TOOL_RULES}\n${h}`,
      shape: { hostId: z.string(), name: z.string(), args: z.array(z.string()).default([]) }
    },
    {
      name: 'read',
      description: `Read a text file on a host. The path must be absolute and inside the runbook's read paths. ${OPS_TOOL_RULES}\n${h}`,
      shape: { hostId: z.string(), path: z.string() }
    },
    {
      name: 'list',
      description: `List a directory on a host. The path must be absolute and inside the runbook's read paths. ${OPS_TOOL_RULES}\n${h}`,
      shape: { hostId: z.string(), path: z.string() }
    },
    {
      name: 'write',
      description: `Write a text file on a host. The path must be absolute and inside the runbook's write paths; the previous file may be backed up first. ${OPS_TOOL_RULES}\n${h}`,
      shape: { hostId: z.string(), path: z.string(), content: z.string() }
    }
  ]
}
