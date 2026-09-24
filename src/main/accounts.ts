import { app } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readJsonFile } from './json-file'
import { openLinuxTerminal } from './linux-desktop'

/**
 * Multi-account support for Claude Code subscription logins.
 *
 * Each account is an isolated Claude Code config directory selected via the
 * CLAUDE_CONFIG_DIR environment variable. The "default" account uses the machine's
 * standard config (~/.claude + ~/.claude.json, CLAUDE_CONFIG_DIR unset); additional
 * accounts each get their own dir under <userData>/cc-accounts/<id>, with their own
 * .credentials.json (login token) and .claude.json (oauthAccount identity).
 */

export interface CCAccount {
  id: string
  name: string
  /** Absolute config dir for this account, or null to use the machine default (~/.claude). */
  configDir: string | null
  isDefault: boolean
}

export interface CCAccountStatus extends CCAccount {
  /** True when this account has credentials and is usable for runs. */
  loggedIn: boolean
  email?: string
  org?: string
  plan?: string
}

interface AccountsState {
  accounts: CCAccount[]
  defaultAccountId: string
}

const DEFAULT_ID = 'default'

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json')
}

function accountsRoot(): string {
  return path.join(app.getPath('userData'), 'cc-accounts')
}

function freshState(): AccountsState {
  return {
    accounts: [{ id: DEFAULT_ID, name: 'Default', configDir: null, isDefault: true }],
    defaultAccountId: DEFAULT_ID
  }
}

let state: AccountsState = freshState()

export function loadAccounts(): void {
  try {
    if (fs.existsSync(accountsFile())) {
      const loaded = readJsonFile<Partial<AccountsState>>(accountsFile())
      const accounts = Array.isArray(loaded.accounts) ? loaded.accounts : []
      // Always guarantee a default account exists.
      if (!accounts.some((a) => a.id === DEFAULT_ID)) {
        accounts.unshift({ id: DEFAULT_ID, name: 'Default', configDir: null, isDefault: true })
      }
      state = {
        accounts: accounts.map((a) => ({ ...a, isDefault: a.id === DEFAULT_ID })),
        defaultAccountId:
          loaded.defaultAccountId && accounts.some((a) => a.id === loaded.defaultAccountId)
            ? loaded.defaultAccountId
            : DEFAULT_ID
      }
    } else {
      state = freshState()
    }
  } catch {
    state = freshState()
  }
}

function persist(): void {
  try {
    fs.writeFileSync(accountsFile(), JSON.stringify(state, null, 2))
  } catch {
    // best-effort
  }
}

// ─── File locations per account ─────────────────────────────────────────────

interface AccountPaths {
  claudeJson: string
  credentials: string
}

function pathsFor(account: CCAccount): AccountPaths {
  if (account.configDir) {
    return {
      claudeJson: path.join(account.configDir, '.claude.json'),
      credentials: path.join(account.configDir, '.credentials.json')
    }
  }
  // Default machine login.
  return {
    claudeJson: path.join(os.homedir(), '.claude.json'),
    credentials: path.join(os.homedir(), '.claude', '.credentials.json')
  }
}

function readOAuthAccount(claudeJsonPath: string): { email?: string; org?: string; plan?: string } {
  try {
    const raw = readJsonFile<any>(claudeJsonPath)
    const a = raw.oauthAccount
    if (!a || typeof a !== 'object') return {}
    const plan =
      a.organizationType === 'claude_team'
        ? 'Team'
        : a.billingType === 'stripe_subscription'
          ? 'Pro'
          : a.billingType
            ? 'Paid'
            : 'Free'
    return { email: a.emailAddress, org: a.organizationName, plan }
  } catch {
    return {}
  }
}

function statusFor(account: CCAccount): CCAccountStatus {
  const { claudeJson, credentials } = pathsFor(account)
  const ident = readOAuthAccount(claudeJson)
  // On macOS credentials live in the Keychain, so fall back to the oauthAccount identity.
  const loggedIn = fs.existsSync(credentials) || !!ident.email
  return { ...account, loggedIn, ...ident }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getAccounts(): CCAccount[] {
  return state.accounts
}

export function listAccountStatus(): { accounts: CCAccountStatus[]; defaultAccountId: string } {
  return {
    accounts: state.accounts.map(statusFor),
    defaultAccountId: state.defaultAccountId
  }
}

/** All known Claude config dirs: the machine default (null) plus each managed
 *  account's own dir. Used to hunt for a valid OAuth token (see plan-usage.ts). */
export function listConfigDirs(): (string | null)[] {
  return [null, ...state.accounts.map((a) => a.configDir).filter((d): d is string => !!d)]
}

/** Config dir to inject as CLAUDE_CONFIG_DIR for a run, or null for the machine default. */
export function accountConfigDir(accountId?: string): string | null {
  if (!accountId) return null
  const account = state.accounts.find((a) => a.id === accountId)
  return account?.configDir ?? null
}

function genId(): string {
  // Deterministic-ish unique id without Math.random / Date in scripts is not a concern here
  // (main process), but keep it filesystem-safe.
  return 'acc_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

export function addAccount(name: string): CCAccountStatus {
  const id = genId()
  const configDir = path.join(accountsRoot(), id)
  fs.mkdirSync(configDir, { recursive: true })
  const account: CCAccount = { id, name: name.trim() || 'Account', configDir, isDefault: false }
  state.accounts.push(account)
  persist()
  return statusFor(account)
}

export function renameAccount(id: string, name: string): void {
  const account = state.accounts.find((a) => a.id === id)
  if (account) {
    account.name = name.trim() || account.name
    persist()
  }
}

export function removeAccount(id: string): { accounts: CCAccountStatus[]; defaultAccountId: string } {
  if (id === DEFAULT_ID) return listAccountStatus() // never remove the default
  const account = state.accounts.find((a) => a.id === id)
  if (account?.configDir) {
    try {
      fs.rmSync(account.configDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
  state.accounts = state.accounts.filter((a) => a.id !== id)
  if (state.defaultAccountId === id) state.defaultAccountId = DEFAULT_ID
  persist()
  return listAccountStatus()
}

export function setDefaultAccount(id: string): { accounts: CCAccountStatus[]; defaultAccountId: string } {
  if (state.accounts.some((a) => a.id === id)) {
    state.defaultAccountId = id
    persist()
  }
  return listAccountStatus()
}

/**
 * Resolve the `claude` CLI to an absolute path so login works even when the npm global
 * bin dir isn't on PATH (a common situation on Windows). Falls back to the bare command
 * name, which relies on PATH, if no known install location is found.
 */
export function resolveClaudeBin(): string {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) candidates.push(path.join(appData, 'npm', 'claude.cmd'))
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'claude.cmd'))
    }
  } else {
    candidates.push(
      // The native installer's location, then npm's documented global prefix.
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude'
    )
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return 'claude'
}

/**
 * Launch an interactive Claude Code login for an account, in its own terminal window with
 * CLAUDE_CONFIG_DIR pointed at the account's config dir. The user completes the browser
 * OAuth flow; afterwards the dir holds .credentials.json + .claude.json and the account
 * shows as logged in. Returns the command so the UI can show a manual fallback.
 */
export function loginAccount(id: string): { launched: boolean; command: string } {
  const account = state.accounts.find((a) => a.id === id)
  const dir = account?.configDir
  if (!account || !dir) {
    // The default account logs in through the normal `claude` CLI, not a custom dir.
    return { launched: false, command: 'claude' }
  }
  fs.mkdirSync(dir, { recursive: true })

  const claudeBin = resolveClaudeBin()
  let command: string
  let child: ReturnType<typeof spawn> | null = null
  try {
    if (process.platform === 'win32') {
      command = `set "CLAUDE_CONFIG_DIR=${dir}" && "${claudeBin}"`
      // cmd reads .bat files in the legacy OEM codepage, which corrupts non-ASCII paths
      // (e.g. an accented user name like "João") — the path then can't be found. Keep the
      // batch body pure ASCII and pass both the claude binary and config dir through the
      // environment instead: Windows passes the env block to child processes as Unicode,
      // so the paths survive intact regardless of codepage. `cmd /k` keeps the window open
      // so the user can see the login prompt/URL.
      const bat = path.join(os.tmpdir(), `claude-login-${id}.bat`)
      fs.writeFileSync(bat, `@echo off\r\ncall "%CLAUDE_BIN%"\r\n`)
      child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', bat], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_BIN: claudeBin }
      })
    } else if (process.platform === 'darwin') {
      command = `CLAUDE_CONFIG_DIR='${dir}' '${claudeBin}'`
      child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`], {
        detached: true,
        stdio: 'ignore'
      })
    } else {
      command = `CLAUDE_CONFIG_DIR='${dir}' '${claudeBin}'`
      if (!openLinuxTerminal(command)) return { launched: false, command }
    }
    child?.on('error', () => {
      /* swallow — caller falls back to showing the command */
    })
    child?.unref()
    return { launched: true, command }
  } catch {
    const fallback =
      process.platform === 'win32'
        ? `set "CLAUDE_CONFIG_DIR=${dir}" && "${claudeBin}"`
        : `CLAUDE_CONFIG_DIR='${dir}' '${claudeBin}'`
    return { launched: false, command: fallback }
  }
}
