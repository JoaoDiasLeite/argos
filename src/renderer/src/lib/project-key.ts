/**
 * Normalise a project path into a key that identifies the same folder regardless of
 * how it was spelled when a particular session recorded it.
 *
 * On Windows the same folder reaches sessions as both `...\claude-gui` and
 * `...\Claude-GUI` (case-preserving but case-insensitive filesystem, plus whichever
 * tool wrote the path choosing its own casing), and separators vary between `\` and
 * `/` depending on which shell launched the session. Grouping sessions by the raw
 * path string then shows the same project twice — this key makes the two collapse
 * into one.
 */
export function projectKey(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}
