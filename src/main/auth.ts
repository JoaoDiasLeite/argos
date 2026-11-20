import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readJsonFile, writeJsonFileAtomic } from './json-file'

export type AuthMode = 'claude-code' | 'api-key'

interface AuthState {
  mode: AuthMode
}

const authStatePath = path.join(app.getPath('userData'), 'auth-state.json')
const apiKeyPath = path.join(app.getPath('userData'), 'api-key.bin')

let state: AuthState = { mode: 'claude-code' }

// ─── State persistence ──────────────────────────────────────────────────────

export function loadAuthState(): void {
  try {
    if (fs.existsSync(authStatePath)) {
      state = readJsonFile<AuthState>(authStatePath)
    }
  } catch {
    state = { mode: 'claude-code' }
  }
}

function saveAuthState(): void {
  writeJsonFileAtomic(authStatePath, state)
}

export function setMode(mode: AuthMode): void {
  state.mode = mode
  saveAuthState()
}

// ─── Secure API key storage ───────────────────────────────────────────────────

export function setApiKey(key: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key)
    fs.writeFileSync(apiKeyPath, encrypted)
  } else {
    // Fallback: store plain (encryption unavailable on this OS/session)
    fs.writeFileSync(apiKeyPath, Buffer.from(`plain:${key}`, 'utf-8'))
  }
}

export function getApiKey(): string | null {
  try {
    if (!fs.existsSync(apiKeyPath)) return null
    const buf = fs.readFileSync(apiKeyPath)
    if (buf.subarray(0, 6).toString('utf-8') === 'plain:') {
      return buf.subarray(6).toString('utf-8')
    }
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
    return null
  } catch {
    return null
  }
}

export function hasApiKey(): boolean {
  return getApiKey() !== null
}

// ─── Claude Code login detection ───────────────────────────────────────────────

/**
 * Heuristic: does a Claude Code credential store exist for this user?
 * Claude Code persists auth under ~/.claude. We can't read the encrypted
 * credentials, but their presence is a strong signal the user is logged in.
 */
export function detectClaudeCodeLogin(): boolean {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json')
  ]
  if (candidates.some((p) => fs.existsSync(p))) return true

  // .claude dir with a config file is a weaker but useful signal
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    try {
      const entries = fs.readdirSync(claudeDir)
      if (entries.some((e) => e.includes('config') || e.includes('credential'))) {
        return true
      }
    } catch {
      // ignore
    }
  }
  return false
}

/**
 * Build the env passed to the Agent SDK subprocess based on the active mode.
 * - claude-code: strip any API key so the engine uses the user's stored login
 * - api-key: inject the stored key
 */
export function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }

  // Strip Claude Code's own runtime/session markers so a `claude` we spawn never thinks
  // it's nested inside a parent session (which would make it adopt/continue that session
  // instead of the chat's own). This matters when the app itself was launched from within
  // a Claude Code session — otherwise the GUI's runs tangle with the launcher's session.
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE')) delete env[k]
  }

  if (state.mode === 'api-key') {
    const key = getApiKey()
    if (key) env.ANTHROPIC_API_KEY = key
  } else {
    // claude-code mode: don't let a stray env key override the account login
    delete env.ANTHROPIC_API_KEY
  }
  return env
}

export interface AuthStatus {
  mode: AuthMode
  claudeCodeDetected: boolean
  hasApiKey: boolean
}

export function getAuthStatus(): AuthStatus {
  return {
    mode: state.mode,
    claudeCodeDetected: detectClaudeCodeLogin(),
    hasApiKey: hasApiKey()
  }
}
