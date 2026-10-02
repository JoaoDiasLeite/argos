import type { ApprovalOpsContext } from '../types'

/** Words joined by spaces; any word with whitespace or a quote is single-quoted. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((w) => (w === '' || /[\s'"]/.test(w) ? `'${w.replace(/'/g, `'\''`)}'` : w))
    .join(' ')
}

/** Header verb and the "what exactly will run" lines for an ops approval. */
export function describeOpsRequest(ops: ApprovalOpsContext): { verb: string; lines: string[] } {
  const host = ops.hostName
  const path = ops.path ?? ''
  const argvLine = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ''
  const lines: string[] = []
  switch (ops.tool) {
    case 'plan':
      return { verb: `approve the plan for ${host}`, lines: ops.planSteps ?? [] }
    case 'script':
      if (argvLine) lines.push(argvLine)
      if (ops.scriptSha256) lines.push(`sha256 ${ops.scriptSha256.slice(0, 12)}…`)
      return { verb: `run script ${ops.argv?.[0] ?? ''} on ${host}`.replace('  ', ' '), lines }
    case 'read':
      return { verb: `read ${path} on ${host}`, lines: [path] }
    case 'list':
      return { verb: `list ${path} on ${host}`, lines: [path] }
    case 'write':
      return { verb: `write ${path} on ${host}`, lines: [path] }
    default:
      if (argvLine) lines.push(argvLine)
      return { verb: `run a command on ${host}`, lines }
  }
}

/** One-line toast summary, capped at ~80 chars. */
export function summarizeOps(ops: ApprovalOpsContext): string {
  if (ops.tool === 'plan') {
    const n = ops.planSteps?.length ?? 0
    return `Plan: ${n} step${n === 1 ? '' : 's'} for ${ops.hostName}`
  }
  const what = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ops.path || ops.tool
  const full = `${ops.hostName}: ${what}`
  return full.length > 80 ? full.slice(0, 79) + '…' : full
}
