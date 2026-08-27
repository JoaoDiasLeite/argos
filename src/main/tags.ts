import * as fs from 'fs'
import { iterJsonl } from './jsonl'
import { normalizeTags } from './tags-pure'

/**
 * Session tags, at the level of a single transcript file.
 *
 * A tag set lives inside the transcript, as an appended
 * `{"type":"custom-tags","tags":[…],"sessionId":…}` line. The last one wins, the
 * same rule the CLI's `/rename` uses for `custom-title`. Nothing is ever edited or
 * removed — the app only appends — so a tag survives the app, is visible to any
 * other tool reading the transcript, and cannot corrupt a conversation.
 *
 * The colour a tag is drawn in is NOT here: that is a user preference and lives in
 * labels.ts. Losing it costs colours, not tags.
 *
 * Deliberately free of source resolution (and therefore of electron) so the read
 * and write halves can be tested against a real file. The sweep across every
 * source lives in tags-sweep.ts.
 */

/** The effective tag set: the last `custom-tags` entry wins. */
export async function readEffectiveTags(file: string): Promise<string[]> {
  let tags: string[] = []
  for await (const obj of iterJsonl(file, { match: (raw) => raw.includes('"custom-tags"') })) {
    if (obj.type === 'custom-tags' && Array.isArray(obj.tags)) {
      tags = obj.tags.filter((t: unknown) => typeof t === 'string')
    }
  }
  return tags
}

/**
 * The ONLY way a `custom-tags` line is written.
 *
 * Normalisation happens here rather than in the IPC handler on purpose. FRIDAY
 * learned this the hard way: with validation living in the handler, the label-rename
 * path built its line by hand and happily wrote `["ui","ui"]` whenever a conversation
 * already carried both. Any new write path — rename, merge, cascade — goes through
 * this function; assembling the line yourself is the defect to avoid repeating.
 */
export async function writeSessionTags(
  file: string,
  sessionId: string,
  tags: unknown
): Promise<string[]> {
  const clean = normalizeTags(tags)
  await fs.promises.appendFile(
    file,
    JSON.stringify({ type: 'custom-tags', tags: clean, sessionId }) + '\n'
  )
  return clean
}
