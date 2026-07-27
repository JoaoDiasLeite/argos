import * as fsp from 'fs/promises'
import { classifyFileBuffer, isRootPath } from './local-fs-pure'

export { isRootPath }

const DEFAULT_MAX_READ_BYTES = 1_000_000

/**
 * Guarded local-filesystem read/mutation helpers backing the WSL "Connect" file browser
 * (LocalBrowser), which browses a distro over its Windows-side share
 * (\\wsl.localhost\<distro>\…) — plain `fs` from the Windows side, no WSL invocation
 * needed. Every function is defensive: empty paths are rejected, deleting a filesystem/
 * share root is refused, and nothing ever throws across the IPC boundary.
 */

function isSafePath(p: unknown): p is string {
  return typeof p === 'string' && p.trim().length > 0
}

/**
 * Read a local file as text for the file editor, with the same size/binary guards sftpRead
 * applies (see sftp.ts) so both results render through the same component. Separate from the
 * older unguarded 'fs:read-file' IPC, whose consumers expect its plain shape.
 */
export async function readTextFile(
  filePath: string,
  maxBytes = DEFAULT_MAX_READ_BYTES
): Promise<{ ok: boolean; content?: string; tooLarge?: boolean; binary?: boolean; error?: string }> {
  if (!isSafePath(filePath)) return { ok: false, error: 'Invalid path' }
  try {
    // Stat first so an oversized file is never pulled into memory; classifyFileBuffer
    // re-checks the size, which also covers a file that grew between the stat and the read.
    const st = await fsp.stat(filePath)
    if (st.size > maxBytes) return { ok: true, tooLarge: true }
    return { ok: true, ...classifyFileBuffer(await fsp.readFile(filePath), maxBytes) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fsWriteFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafePath(filePath)) return { ok: false, error: 'Invalid path' }
  if (typeof content !== 'string') return { ok: false, error: 'Invalid content' }
  try {
    await fsp.writeFile(filePath, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fsMkdir(dirPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafePath(dirPath)) return { ok: false, error: 'Invalid path' }
  try {
    await fsp.mkdir(dirPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fsRename(from: string, to: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafePath(from) || !isSafePath(to)) return { ok: false, error: 'Invalid path' }
  try {
    await fsp.rename(from, to)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fsDelete(targetPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafePath(targetPath)) return { ok: false, error: 'Invalid path' }
  if (isRootPath(targetPath)) return { ok: false, error: 'Refusing to delete a filesystem root' }
  try {
    const st = await fsp.stat(targetPath)
    if (st.isDirectory()) {
      // v1: surface "directory not empty" rather than silently recursing — matches
      // sftpDelete's stance (see sftp.ts).
      await fsp.rmdir(targetPath)
    } else {
      await fsp.unlink(targetPath)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
