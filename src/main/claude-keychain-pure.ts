import { createHash } from 'crypto'

/**
 * Where Claude Code keeps its OAuth login on macOS: a generic password in the login
 * Keychain instead of <configDir>/.credentials.json. The value is the same JSON.
 *
 * Derivation, as Claude Code itself does it (read from the CLI bundled with
 * @anthropic-ai/claude-agent-sdk 0.3.x): the service is `Claude Code-credentials`, and
 * when CLAUDE_CONFIG_DIR is set, `-` plus the first 8 hex digits of the SHA-256 of that
 * dir (NFC-normalised, exactly as passed in the variable) is appended. The account name
 * is `claude-code-user`; a value over 2400 bytes is split into base64 chunks under
 * `claude-code-user#0..n-1`, with a `{"n","l"}` manifest under `claude-code-user#m`.
 */

export const KEYCHAIN_ACCOUNT = 'claude-code-user'

/** The Keychain service for a config dir; null means the default (~/.claude, variable unset). */
export function claudeKeychainService(configDir: string | null): string {
  const base = 'Claude Code-credentials'
  if (!configDir) return base
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8)
  return `${base}-${hash}`
}

/**
 * The secret as `security find-generic-password -w` prints it. A value that is not plain
 * text comes out hex-encoded; JSON never needs that, but decode it if it happens.
 */
export function decodeKeychainOutput(stdout: string): string {
  const v = stdout.trim()
  if (v.length > 0 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v)) {
    const decoded = Buffer.from(v, 'hex').toString('utf8')
    if (decoded.trimStart().startsWith('{')) return decoded
  }
  return v
}

/** The chunk manifest, when valid (same bounds Claude Code checks). */
export function parseChunkManifest(raw: string): { n: number; l: number } | null {
  try {
    const o = JSON.parse(raw) as { n?: unknown; l?: unknown }
    const { n, l } = o
    if (
      typeof n === 'number' &&
      typeof l === 'number' &&
      Number.isInteger(n) &&
      Number.isInteger(l) &&
      n > 0 &&
      n <= 256 &&
      l > 0 &&
      l <= n * 2400
    ) {
      return { n, l }
    }
  } catch {
    /* not a manifest */
  }
  return null
}

/** Reassemble chunked base64 parts, or null when they don't add up to the manifest. */
export function joinChunks(parts: string[], manifest: { n: number; l: number }): string | null {
  const joined = parts.join('')
  if (parts.length !== manifest.n || joined.length !== manifest.l) return null
  return Buffer.from(joined, 'base64').toString('utf8')
}

/** True when `raw` is a credentials JSON with an access token (never logs or returns it). */
export function looksLikeCredentials(raw: string): boolean {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const inner = (o.claudeAiOauth ?? o) as Record<string, unknown>
    return typeof inner?.accessToken === 'string' && inner.accessToken.length > 0
  } catch {
    return false
  }
}
