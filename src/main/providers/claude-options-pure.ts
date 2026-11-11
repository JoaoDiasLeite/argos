import type { query as QueryFn } from '@anthropic-ai/claude-agent-sdk'
import type { EngineRequest } from './types'

export type ClaudeSdkOptions = NonNullable<Parameters<typeof QueryFn>[0]['options']>

/**
 * Map the provider-neutral request onto Claude Agent SDK options. Optional fields
 * are only set when present so the SDK's own defaults apply otherwise (e.g. an
 * omitted maxTurns stays uncapped).
 *
 * `tools` is forwarded whenever it is defined, including `[]`: an empty array is
 * how a request disables every built-in tool, so a truthiness/length check here
 * would silently hand a bypassPermissions run the full default tool set.
 *
 * Pure (no electron, no SDK runtime import) so it can be unit-tested; `base`
 * carries the machine-specific bits such as the executable path.
 */
export function buildClaudeSdkOptions(req: EngineRequest, base: Partial<ClaudeSdkOptions> = {}): ClaudeSdkOptions {
  return {
    ...base,
    model: req.model,
    cwd: req.cwd,
    env: req.env,
    abortController: req.abortController,
    settingSources: req.settingSources,
    permissionMode: req.permissionMode,
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
    ...(req.additionalDirectories && req.additionalDirectories.length
      ? { additionalDirectories: req.additionalDirectories }
      : {}),
    ...(req.disallowedTools ? { disallowedTools: req.disallowedTools } : {}),
    ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
    ...(req.mcpServers ? { mcpServers: req.mcpServers as Record<string, never> } : {}),
    ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
    ...(req.resume ? { resume: req.resume } : {})
  }
}
