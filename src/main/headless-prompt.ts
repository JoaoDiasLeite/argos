/**
 * The prompt of a headless engine run (planner assist, standup, sprint backfill): the
 * text with any attached files appended as delimited blocks, and with images the
 * structured streaming-input form the SDK takes (one user message, text + image blocks).
 */

/** Append attached text files to the prompt as clearly delimited blocks, after the text. */
export function appendFiles(text: string, files: { name: string; content: string }[] | undefined): string {
  if (!files || files.length === 0) return text
  const blocks = files
    .map((f) => `--- Attached file: ${f.name} ---\n${f.content}\n--- End of ${f.name} ---`)
    .join('\n\n')
  return text ? `${text}\n\n${blocks}` : blocks
}

/**
 * A plain string is the fast path; with images the prompt is a one-message generator,
 * whose completion signals end of input so the run finishes.
 */
export function buildPrompt(
  text: string,
  images: { mediaType: string; data: string }[] | undefined,
  files: { name: string; content: string }[] | undefined,
  sessionId: string
): string | AsyncIterable<unknown> {
  const fullText = appendFiles(text, files)
  if (!images || images.length === 0) return fullText
  const content: unknown[] = [{ type: 'text', text: fullText }]
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
  }
  async function* gen(): AsyncIterable<unknown> {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: sessionId
    }
  }
  return gen()
}
