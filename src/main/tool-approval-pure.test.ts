import { describe, it, expect } from 'vitest'
import { AUTO_ALLOWED_TOOLS, needsApproval } from './tool-approval-pure'

describe('needsApproval', () => {
  it('lets read-only file tools through', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) expect(needsApproval(t)).toBe(false)
  })

  it('asks for every tool that writes, runs or kills', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillShell', 'KillBash']) {
      expect(needsApproval(t)).toBe(true)
    }
  })

  it('asks for tools that reach the network or spawn agents', () => {
    for (const t of ['WebFetch', 'WebSearch', 'Agent', 'Task']) expect(needsApproval(t)).toBe(true)
  })

  it('asks for every MCP tool, whatever the server', () => {
    expect(needsApproval('mcp__gitlab__create_issue')).toBe(true)
    expect(needsApproval('mcp__ops__run')).toBe(true)
    expect(needsApproval('mcp__anything')).toBe(true)
  })

  it('asks for a name it has never seen — the list fails closed', () => {
    expect(needsApproval('SomeFutureTool')).toBe(true)
    expect(needsApproval('')).toBe(true)
  })

  it('never auto-allows anything that could mutate, by name', () => {
    const suspicious = /write|edit|kill|bash|exec|run|fetch|search|agent|task|delete|remove/i
    for (const t of AUTO_ALLOWED_TOOLS) {
      // Three names trip the regex and are read-only anyway: TodoWrite edits the
      // model's own task list, BashOutput reads a background shell's output, and
      // ToolSearch loads tool schemas. Each is exempted by name so a fourth one asks.
      if (t === 'TodoWrite' || t === 'BashOutput' || t === 'ToolSearch') continue
      expect(t, `${t} is on the auto-allow list`).not.toMatch(suspicious)
    }
  })
})
