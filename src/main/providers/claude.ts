import type { query as QueryFn } from '@anthropic-ai/claude-agent-sdk'
import { sdkExecutable } from '../sdk-exe'
import type { AiEngine, EngineMessage, EngineRequest } from './types'

/**
 * Claude engine — wraps the Agent SDK `query()`.
 *
 * The SDK ships as ESM, so it must be reached via a runtime dynamic import that
 * survives CommonJS transpilation (a bare `import()` would be rewritten to
 * `require()` and throw). This mirrors the loader that previously lived inline in
 * index.ts / scheduler.ts — now centralized here as the single SDK entry point.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  s: string
) => Promise<unknown>

let queryFn: typeof QueryFn | null = null

async function getQuery(): Promise<typeof QueryFn> {
  if (!queryFn) {
    const mod = (await dynamicImport('@anthropic-ai/claude-agent-sdk')) as {
      query: typeof QueryFn
    }
    queryFn = mod.query
  }
  return queryFn
}

/**
 * This is the one place that knows the Claude Agent SDK's message shape — content
 * blocks split across `assistant`/`user` message types, `stream_event` deltas,
 * `result` usage fields. Everything else in the app consumes the neutral
 * `EngineMessage` union instead.
 */
function* mapSdkMessage(message: any, sawPartial: { value: boolean }): Iterable<EngineMessage> {
  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        yield { type: 'init', sessionId: message.session_id, tools: message.tools ?? [] }
      }
      break
    }

    case 'stream_event': {
      const ev = message.event
      if (!ev) break
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          sawPartial.value = true
          yield { type: 'text-delta', text: ev.delta.text }
        } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          sawPartial.value = true
          yield { type: 'thinking-delta', text: ev.delta.thinking }
        }
      }
      break
    }

    case 'assistant': {
      const content = message.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use') {
          yield { type: 'tool-use', id: block.id, name: block.name, input: block.input }
        } else if (!sawPartial.value && block.type === 'text' && block.text) {
          // No partials available for this run — emit the full text once.
          yield { type: 'text-delta', text: block.text }
        } else if (!sawPartial.value && block.type === 'thinking' && block.thinking) {
          yield { type: 'thinking-delta', text: block.thinking }
        }
      }
      break
    }

    case 'user': {
      const content = message.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text ?? '').join('')
                : ''
          yield {
            type: 'tool-result',
            toolUseId: block.tool_use_id,
            content: text.slice(0, 50000),
            isError: !!block.is_error
          }
        }
      }
      break
    }

    case 'result': {
      yield {
        type: 'result',
        sessionId: message.session_id,
        isError: message.subtype !== 'success',
        errorText: message.subtype !== 'success' ? (message.result ?? message.subtype) : undefined,
        costUsd: message.total_cost_usd ?? 0,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0
        }
      }
      break
    }
  }
}

export const claudeEngine: AiEngine = {
  id: 'claude',
  async *run(req: EngineRequest) {
    const query = await getQuery()

    // Map the provider-neutral request onto SDK options. Optional fields are only
    // set when present so the SDK's own defaults apply otherwise (e.g. an omitted
    // maxTurns stays uncapped).
    const options: NonNullable<Parameters<typeof query>[0]['options']> = {
      ...sdkExecutable(),
      model: req.model,
      cwd: req.cwd,
      env: req.env,
      abortController: req.abortController,
      settingSources: req.settingSources,
      permissionMode: req.permissionMode,
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

    const stream = query({ prompt: req.prompt, options })
    const sawPartial = { value: false }
    for await (const message of stream) {
      yield* mapSdkMessage(message, sawPartial)
    }
  }
}
