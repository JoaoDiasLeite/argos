import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readJsonFile } from './json-file'

export type ProviderId = 'claude' | 'codex' | 'gemini'

export interface ModelInfo {
  id: string
  label: string
  /** USD per 1M tokens */
  inputPrice: number
  outputPrice: number
  context: string
  provider: ProviderId
  /** True when this entry came from live catalog discovery, not our bundled/user data. */
  discovered?: boolean
}

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', inputPrice: 5, outputPrice: 25, context: '1M', provider: 'claude' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', inputPrice: 5, outputPrice: 25, context: '1M', provider: 'claude' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', inputPrice: 5, outputPrice: 25, context: '1M', provider: 'claude' },
  // Standard pricing; $2/$10 intro pricing applies through 2026-08-31.
  { id: 'claude-sonnet-5', label: 'Sonnet 5', inputPrice: 3, outputPrice: 15, context: '1M', provider: 'claude' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', inputPrice: 3, outputPrice: 15, context: '1M', provider: 'claude' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', inputPrice: 1, outputPrice: 5, context: '200K', provider: 'claude' },
  { id: 'claude-fable-5', label: 'Fable 5', inputPrice: 10, outputPrice: 50, context: '1M', provider: 'claude' },
  // Codex ids + context size confirmed locally via `codex debug models` (the
  // installed CLI's own catalog). Pricing is not in that catalog — sourced from
  // several converging third-party trackers (OpenAI's own pricing page 403'd a
  // direct fetch); worth a spot-check against platform.openai.com/pricing later.
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', inputPrice: 5, outputPrice: 30, context: '272K', provider: 'codex' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', inputPrice: 2.5, outputPrice: 15, context: '272K', provider: 'codex' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', inputPrice: 1, outputPrice: 6, context: '272K', provider: 'codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4', inputPrice: 2.5, outputPrice: 15, context: '272K', provider: 'codex' },
  // Gemini ids/pricing from ai.google.dev's own model + pricing docs (not
  // locally confirmed — Gemini CLI has no offline catalog command like codex's,
  // and this machine isn't logged into Gemini yet to verify against a live call).
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', inputPrice: 2, outputPrice: 12, context: '1M', provider: 'gemini' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', inputPrice: 0.5, outputPrice: 3, context: '1M', provider: 'gemini' }
]

export function priceFor(modelId: string): ModelInfo {
  return MODELS.find((m) => modelId.startsWith(m.id)) ?? MODELS[0]
}

export function providerFor(modelId: string | undefined): ProviderId {
  if (!modelId) return 'claude'
  return priceFor(modelId).provider
}

export interface UsageLimits {
  hourUsd: number
  sessionUsd: number
  weekUsd: number
}

export interface UiPrefs {
  theme: 'dark' | 'light'
  /** Color palette id (see global.css [data-palette]). 'warm-rust' is the default. */
  palette: string
  density: 'comfortable' | 'compact'
  fontSize: 'sm' | 'md' | 'lg'
  onboarded: boolean
  /** Which panel new chats open in. */
  defaultChatView: 'chat' | 'terminal'
}

export interface SystemPrefs {
  openAtLogin: boolean
  startMinimized: boolean
  closeToTray: boolean
  /** Preferred quick-launcher accelerator. '' = automatic (Alt+Space with fallback). */
  overlayShortcut: string
  /** Add an "Open with Argos" entry to the Explorer folder right-click menu (HKCU). */
  explorerContextMenu: boolean
}

interface AppConfig {
  defaultModel: string
  limits: UsageLimits
  ui: UiPrefs
  system: SystemPrefs
}

const configPath = path.join(app.getPath('userData'), 'config.json')
let config: AppConfig = {
  // Sonnet is the default: ~40% cheaper per token than Opus and ample for most
  // chat/coding turns. Opus/Fable remain one click away in the per-chat model picker.
  defaultModel: 'claude-sonnet-4-6',
  // 0 = no personal budget set (no % bar shown). These are user budgets, NOT Anthropic
  // plan limits, which are metered server-side and not readable locally.
  limits: { hourUsd: 0, sessionUsd: 0, weekUsd: 0 },
  ui: { theme: 'dark', palette: 'warm-rust', density: 'comfortable', fontSize: 'md', onboarded: false, defaultChatView: 'chat' },
  system: { openAtLogin: false, startMinimized: false, closeToTray: true, overlayShortcut: '', explorerContextMenu: false }
}

export function loadConfig(): void {
  try {
    if (fs.existsSync(configPath)) {
      const loaded = readJsonFile<Partial<AppConfig>>(configPath)
      config = {
        ...config,
        ...loaded,
        limits: { ...config.limits, ...(loaded.limits ?? {}) },
        ui: { ...config.ui, ...(loaded.ui ?? {}) },
        // Backfill for configs saved by older versions that predate `system`.
        system: { ...config.system, ...(loaded.system ?? {}) }
      }
    }
  } catch {
    // keep defaults
  }
}

function saveConfig(): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

export function getConfig(): AppConfig {
  return config
}

export function setDefaultModel(modelId: string): void {
  config.defaultModel = modelId
  saveConfig()
}

export function setLimits(limits: Partial<UsageLimits>): UsageLimits {
  config.limits = { ...config.limits, ...limits }
  saveConfig()
  return config.limits
}

export function setUiPrefs(prefs: Partial<UiPrefs>): UiPrefs {
  config.ui = { ...config.ui, ...prefs }
  saveConfig()
  return config.ui
}

export function setSystemPrefs(prefs: Partial<SystemPrefs>): SystemPrefs {
  config.system = { ...config.system, ...prefs }
  saveConfig()
  return config.system
}

// ─── Claude Code's own settings.json (effort, model) ──────────────────────────

const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json')

export function getClaudeSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(claudeSettingsPath)) {
      return readJsonFile<Record<string, unknown>>(claudeSettingsPath)
    }
  } catch {
    // ignore
  }
  return {}
}

export interface WriteResult {
  ok: boolean
  error?: string
}

/**
 * Atomically merge `patch` into ~/.claude/settings.json.
 *
 * Three cases:
 *   (a) File does not exist → create with the patch object.
 *   (b) File exists and parses successfully → deep-merge then write.
 *   (c) File exists but FAILS to parse → refuse to write; return an error so
 *       callers can surface it to the user instead of silently clobbering the file.
 *
 * The write is atomic: we write to a sibling temp file and rename over the
 * target, so a crash mid-write cannot corrupt settings.json.
 */
function writeClaudeSettings(patch: Record<string, unknown>): WriteResult {
  const dir = path.dirname(claudeSettingsPath)
  fs.mkdirSync(dir, { recursive: true })

  let existing: Record<string, unknown> = {}

  if (fs.existsSync(claudeSettingsPath)) {
    let raw: string
    try {
      raw = fs.readFileSync(claudeSettingsPath, 'utf-8')
      // Tolerate a UTF-8 BOM (external tools like PowerShell 5.1 write one).
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    } catch (e) {
      return { ok: false, error: `Could not read settings.json: ${String(e)}` }
    }
    try {
      existing = JSON.parse(raw)
    } catch {
      // File exists but is not valid JSON (e.g. has JSONC comments or is corrupt).
      // Refuse to overwrite — the user must fix it manually.
      return {
        ok: false,
        error:
          '~/.claude/settings.json exists but could not be parsed (it may contain comments or be malformed). ' +
          'Please fix it manually before saving from this UI.'
      }
    }
  }

  const merged = { ...existing, ...patch }
  const tmp = claudeSettingsPath + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
    fs.renameSync(tmp, claudeSettingsPath)
  } catch (e) {
    // Clean up temp file on failure if it exists
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, error: `Could not write settings.json: ${String(e)}` }
  }

  return { ok: true }
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export interface ClaudePermissions {
  allow: string[]
  deny: string[]
  ask: string[]
}

export function getClaudePermissions(): ClaudePermissions {
  const settings = getClaudeSettings()
  const raw = (settings.permissions ?? {}) as Record<string, unknown>
  return {
    allow: Array.isArray(raw.allow) ? (raw.allow as string[]) : [],
    deny: Array.isArray(raw.deny) ? (raw.deny as string[]) : [],
    ask: Array.isArray(raw.ask) ? (raw.ask as string[]) : []
  }
}

/**
 * Validate and coerce an incoming permissions object.
 * Returns a clean object or throws with a descriptive message.
 */
function coercePermissions(raw: unknown): ClaudePermissions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Permissions must be an object')
  }
  const r = raw as Record<string, unknown>
  const toStringArray = (v: unknown, key: string): string[] => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) throw new Error(`permissions.${key} must be an array`)
    return v.map((item, i) => {
      if (typeof item !== 'string') throw new Error(`permissions.${key}[${i}] must be a string`)
      return item.trim()
    }).filter(Boolean)
  }
  return {
    allow: toStringArray(r.allow, 'allow'),
    deny: toStringArray(r.deny, 'deny'),
    ask: toStringArray(r.ask, 'ask')
  }
}

export function setClaudePermissions(raw: unknown): WriteResult & { permissions?: ClaudePermissions } {
  let perms: ClaudePermissions
  try {
    perms = coercePermissions(raw)
  } catch (e) {
    return { ok: false, error: String(e) }
  }

  // Merge only allow/deny/ask; preserve all other sub-keys (additionalDirectories, defaultMode, …)
  const settings = getClaudeSettings()
  const existingPerms = (settings.permissions ?? {}) as Record<string, unknown>
  const mergedPerms = { ...existingPerms, allow: perms.allow, deny: perms.deny, ask: perms.ask }

  const result = writeClaudeSettings({ permissions: mergedPerms })
  if (!result.ok) return result
  return { ok: true, permissions: perms }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export interface ClaudeHookCommand {
  type: 'command'
  command: string
}

export interface ClaudeHookEntry {
  matcher?: string
  hooks: ClaudeHookCommand[]
}

export type ClaudeHooks = Record<string, ClaudeHookEntry[]>

export function getClaudeHooks(): ClaudeHooks {
  const settings = getClaudeSettings()
  const raw = settings.hooks
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as ClaudeHooks
}

/**
 * Validate and coerce an incoming hooks object.
 * Returns a clean object or throws with a descriptive message.
 */
function coerceHooks(raw: unknown): ClaudeHooks {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Hooks must be an object')
  }
  const r = raw as Record<string, unknown>
  const result: ClaudeHooks = {}
  for (const [event, entries] of Object.entries(r)) {
    if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`)
    result[event] = entries.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`hooks.${event}[${i}] must be an object`)
      }
      const e = entry as Record<string, unknown>
      if (!Array.isArray(e.hooks)) throw new Error(`hooks.${event}[${i}].hooks must be an array`)
      const cmds: ClaudeHookCommand[] = e.hooks.map((cmd, j) => {
        if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
          throw new Error(`hooks.${event}[${i}].hooks[${j}] must be an object`)
        }
        const c = cmd as Record<string, unknown>
        if (typeof c.command !== 'string' || !c.command.trim()) {
          throw new Error(`hooks.${event}[${i}].hooks[${j}].command must be a non-empty string`)
        }
        return { type: 'command' as const, command: c.command.trim() }
      })
      const hookEntry: ClaudeHookEntry = { hooks: cmds }
      if (typeof e.matcher === 'string' && e.matcher.trim()) {
        hookEntry.matcher = e.matcher.trim()
      }
      return hookEntry
    })
  }
  return result
}

export function setClaudeHooks(raw: unknown): WriteResult & { hooks?: ClaudeHooks } {
  let incomingHooks: ClaudeHooks
  try {
    incomingHooks = coerceHooks(raw)
  } catch (e) {
    return { ok: false, error: String(e) }
  }

  // Merge incoming hooks with existing ones, preserving any event keys the UI
  // doesn't know about (unknown events stay untouched in the file).
  const existingHooks = getClaudeHooks()
  const mergedHooks: ClaudeHooks = { ...existingHooks, ...incomingHooks }

  // Remove event keys that were explicitly cleared (empty array → delete key)
  for (const [event, entries] of Object.entries(incomingHooks)) {
    if (entries.length === 0) {
      delete mergedHooks[event]
    }
  }

  const result = writeClaudeSettings({ hooks: mergedHooks })
  if (!result.ok) return result
  return { ok: true, hooks: mergedHooks }
}
