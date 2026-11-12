import { describe, expect, it } from 'vitest'
import { buildClaudeSdkOptions } from './claude-options-pure'
import type { EngineRequest } from './types'

function req(extra: Partial<EngineRequest> = {}): EngineRequest {
  return {
    prompt: 'hi',
    model: 'claude-sonnet-5-5',
    cwd: '/tmp',
    env: {},
    abortController: new AbortController(),
    settingSources: [],
    permissionMode: 'bypassPermissions',
    ...extra
  }
}

describe('buildClaudeSdkOptions', () => {
  it('forwards an empty tools list, which disables every built-in tool', () => {
    const o = buildClaudeSdkOptions(req({ tools: [], allowedTools: [] }))
    expect(o).toHaveProperty('tools')
    expect(o.tools).toEqual([])
  })

  it('forwards a non-empty tools list unchanged', () => {
    const o = buildClaudeSdkOptions(req({ tools: ['Read', 'Grep', 'Glob'], allowedTools: ['mcp__gl', 'Read'] }))
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(o.allowedTools).toEqual(['mcp__gl', 'Read'])
  })

  it('leaves tools unset when the request does not specify it', () => {
    const o = buildClaudeSdkOptions(req())
    expect(o).not.toHaveProperty('tools')
  })

  it('keeps the base options and the remaining mapping', () => {
    const o = buildClaudeSdkOptions(req({ maxTurns: 0, disallowedTools: ['Bash'] }), {
      pathToClaudeCodeExecutable: '/x/claude'
    })
    expect(o.pathToClaudeCodeExecutable).toBe('/x/claude')
    expect(o.maxTurns).toBe(0)
    expect(o.disallowedTools).toEqual(['Bash'])
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o).not.toHaveProperty('additionalDirectories')
  })
})
