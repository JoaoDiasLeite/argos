import { describe, expect, it, vi } from 'vitest'

// config.ts imports electron; the policy only needs the default model and the
// provider of a model id.
vi.mock('./config', () => ({
  getConfig: () => ({ defaultModel: 'claude-sonnet-5-5' }),
  providerFor: () => 'claude'
}))

import { resolvePolicy } from './ai-policy'
import { buildClaudeSdkOptions } from './providers/claude-options-pure'
import type { EngineRequest } from './providers/types'

const MUTATING = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch']

function engineReq(policy: ReturnType<typeof resolvePolicy>): EngineRequest {
  return {
    prompt: 'x',
    ...policy,
    cwd: '/tmp',
    env: {},
    abortController: new AbortController(),
    permissionMode: 'bypassPermissions'
  }
}

describe('resolvePolicy', () => {
  it('headless-reasoning loads no built-in tools at all', () => {
    const p = resolvePolicy({ profile: 'headless-reasoning' })
    expect(p.tools).toEqual([])
    expect(p.settingSources).toEqual([])
  })

  it('mcp-ask loads only the read-only built-ins and approves the MCP servers', () => {
    const p = resolvePolicy({ profile: 'mcp-ask', mcpServerNames: ['gitlab'] })
    expect(p.tools).toEqual(['Read', 'Grep', 'Glob'])
    for (const t of MUTATING) expect(p.tools).not.toContain(t)
    expect(p.allowedTools).toContain('mcp__gitlab')
  })

  it('the tools restriction reaches the SDK options for both profiles', () => {
    expect(buildClaudeSdkOptions(engineReq(resolvePolicy({ profile: 'headless-reasoning' }))).tools).toEqual([])
    expect(buildClaudeSdkOptions(engineReq(resolvePolicy({ profile: 'mcp-ask' }))).tools).toEqual([
      'Read',
      'Grep',
      'Glob'
    ])
  })

  it('clamps headless-reasoning to the cheap tier', () => {
    expect(resolvePolicy({ profile: 'headless-reasoning', requestedModel: 'claude-opus-5-5' }).model).toBe(
      'claude-sonnet-5-5'
    )
  })
})
