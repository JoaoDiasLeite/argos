import { iterJsonl, tailJsonlEntries } from './jsonl'
import { isInjectedUserEntry, meaningfulUserText } from './transcript-text'

/**
 * The name of a conversation, read from its transcript without reading its
 * transcript.
 *
 * The `Notification` hook fires on every notification on the machine, and some of
 * these files pass 100 MB. So the title comes out of two bounded reads and never a
 * full one: the names are appended (`custom-title`, `ai-title`, always near the
 * end), and the opening message is near the top.
 *
 * Precedence is the CLI's own — the owner's name beats the model's, last one wins —
 * so a `/rename` in a console shows up in the notification for that conversation.
 */

/**
 * How many entries from the top to look at for an opening message.
 *
 * Not "the first user entry": the CLI records into the user's channel everything it
 * injects — a slash command's body, a loaded skill, the reminders — so the first few
 * can all be plumbing. `meaningfulUserText` is what decides; this only bounds how
 * far we are willing to look before giving up.
 */
export const HEAD_ENTRIES = 200

/** The last `custom-title`, or failing that the last `ai-title`, in the file's tail. */
async function titleFromTail(file: string): Promise<string> {
  const entries = await tailJsonlEntries(file)
  let custom = ''
  let ai = ''
  for (const obj of entries) {
    if (obj?.type === 'custom-title' && typeof obj.customTitle === 'string') custom = obj.customTitle
    if (obj?.type === 'ai-title' && typeof obj.aiTitle === 'string') ai = obj.aiTitle
  }
  return custom || ai
}

/** The first user entry near the top that carries prose of the owner's. */
async function titleFromOpening(file: string): Promise<string> {
  let seen = 0
  for await (const obj of iterJsonl(file)) {
    if (++seen > HEAD_ENTRIES) break
    if (obj?.type !== 'user' || !obj.message) continue
    if (isInjectedUserEntry(obj)) continue
    const text = meaningfulUserText(obj.message.content)
    if (text) return text
  }
  return ''
}

/**
 * The conversation's name, or '' when the transcript can't be read.
 *
 * Unreadable is a normal outcome here, not an error: a hook firing inside a WSL
 * distro hands us a path that means nothing on this side of the boundary. The
 * caller falls back to the project name, which is still worth a notification.
 */
export async function titleFromTranscript(file: string): Promise<string> {
  if (!file) return ''
  try {
    const named = await titleFromTail(file)
    if (named) return named
  } catch {
    return ''
  }
  try {
    return await titleFromOpening(file)
  } catch {
    return ''
  }
}
