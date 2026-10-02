import type { EngineMessage } from './types'

/**
 * Drains an engine stream for the common "headless" shape every one-shot reasoning
 * call needs: accumulated assistant text, plus the final
 * cost/error outcome. Tool activity (tool-use/tool-result) isn't surfaced here —
 * callers that need to render it (interactive chat) consume the stream directly.
 */
export async function collectText(
  stream: AsyncIterable<EngineMessage>
): Promise<{ text: string; costUsd: number; isError: boolean; errorText?: string }> {
  let text = ''
  let costUsd = 0
  let isError = false
  let errorText: string | undefined

  for await (const message of stream) {
    if (message.type === 'text-delta') {
      text += message.text
    } else if (message.type === 'result') {
      costUsd = message.costUsd
      isError = message.isError
      errorText = message.errorText
    } else if (message.type === 'error') {
      isError = true
      errorText = message.message
    }
  }

  return { text, costUsd, isError, errorText }
}
