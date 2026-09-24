import { app } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readJsonFile } from './json-file'
import { checkCodexStatus } from './agent-clis'
import { openLinuxTerminal } from './linux-desktop'

/**
 * Multi-account support for Codex and Gemini logins — the Codex/Gemini analog of
 * `accounts.ts`'s Claude Code account model, but adapted to each CLI's own
 * isolation mechanism:
 *
 *   - Codex has a first-class `CODEX_HOME` env var (already used for the per-call
 *     MCP-server isolation in providers/codex.ts), so an account is just its own
 *     CODEX_HOME dir holding its own auth.json.
 *   - Gemini has no equivalent config-dir override — every path it touches is
 *     derived from `os.homedir()` + `.gemini`. The only lever is overriding the
 *     *process* home directory itself: on POSIX Node's os.homedir() reads `HOME`
 *     first, on Windows it reads `USERPROFILE` first. Pointing a spawned gemini
 *     process at a fake home makes it create/read its own `.gemini/` there,
 *     including the OAuth login — no credential copying required, the login flow
 *     just writes into the isolated home directly.
 *
 * The "default" account (id 'default') always means "use the machine's real
 * home/login" — configDir null, no env override — matching accounts.ts.
 */

export type AgentProvider = 'codex' | 'gemini'

export interface ProviderAccount {
  id: string
  name: string
  provider: AgentProvider
  /** Isolated CODEX_HOME (codex) / fake HOME (gemini), or null for the machine default. */
  configDir: string | null
  isDefault: boolean
}

export interface ProviderAccountStatus extends ProviderAccount {
  loggedIn: boolean
  email?: string
  plan?: string
}

interface AccountGroup {
  accounts: ProviderAccount[]
  defaultAccountId: string
}

interface ProviderAccountsState {
  codex: AccountGroup
  gemini: AccountGroup
}

const DEFAULT_ID = 'default'

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'provider-accounts.json')
}

function accountsRoot(provider: AgentProvider): string {
  return path.join(app.getPath('userData'), 'provider-accounts', provider)
}

function freshGroup(provider: AgentProvider): AccountGroup {
  return {
    accounts: [{ id: DEFAULT_ID, name: 'Default', provider, configDir: null, isDefault: true }],
    defaultAccountId: DEFAULT_ID
  }
}

function freshState(): ProviderAccountsState {
  return { codex: freshGroup('codex'), gemini: freshGroup('gemini') }
}

let state: ProviderAccountsState = freshState()

function loadGroup(provider: AgentProvider, loaded: unknown): AccountGroup {
  const raw = (loaded as Partial<AccountGroup>) ?? {}
  let accounts = Array.isArray(raw.accounts) ? raw.accounts : []
  if (!accounts.some((a) => a.id === DEFAULT_ID)) {
    accounts.unshift({ id: DEFAULT_ID, name: 'Default', provider, configDir: null, isDefault: true })
  }
  if (provider === 'gemini') {
    // Antigravity's single machine-wide keyring login can't be isolated per account, so
    // any non-default gemini account on disk is a leftover from a previous build that
    // still let addProviderAccount() create inert entries — drop them on load instead of
    // carrying them forward forever.
    accounts = accounts.filter((a) => a.id === DEFAULT_ID)
  }
  return {
    accounts: accounts.map((a) => ({ ...a, provider, isDefault: a.id === DEFAULT_ID })),
    defaultAccountId:
      raw.defaultAccountId && accounts.some((a) => a.id === raw.defaultAccountId) ? raw.defaultAccountId : DEFAULT_ID
  }
}

export function loadProviderAccounts(): void {
  try {
    if (fs.existsSync(accountsFile())) {
      const loaded = readJsonFile<Partial<ProviderAccountsState>>(accountsFile())
      state = {
        codex: loadGroup('codex', loaded.codex),
        gemini: loadGroup('gemini', loaded.gemini)
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

function group(provider: AgentProvider): AccountGroup {
  return state[provider]
}

// ─── Public API ────────────────────────────────────────────────────────────

export function getProviderAccounts(provider: AgentProvider): ProviderAccount[] {
  return group(provider).accounts
}

/** Config dir to inject (CODEX_HOME for codex; fake HOME for gemini), or null for the
 *  machine default. */
export function providerAccountConfigDir(provider: AgentProvider, accountId?: string): string | null {
  if (!accountId) return null
  return group(provider).accounts.find((a) => a.id === accountId)?.configDir ?? null
}

/** Env vars to merge into a spawned CLI's environment for the given account. Empty
 *  object for the default account (no override). */
export function providerAccountEnv(provider: AgentProvider, accountId?: string): Record<string, string> {
  // Antigravity (Gemini) uses the real home + OS keyring for its single machine-wide
  // login — a stale per-account fake-HOME must never relocate its config.
  if (provider === 'gemini') return {}
  const dir = providerAccountConfigDir(provider, accountId)
  if (!dir) return {}
  return { CODEX_HOME: dir }
}

function genId(): string {
  return 'pacc_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

/** Only meaningful for Codex. Gemini's single Antigravity login can't be isolated per
 *  account, so `listProviderAccountStatus` never surfaces extra Gemini accounts and any
 *  created here would be inert — refuse outright rather than silently doing nothing. */
export function addProviderAccount(provider: AgentProvider, name: string): ProviderAccount {
  if (provider === 'gemini') {
    throw new Error('Gemini accounts cannot be created — Antigravity uses a single machine-wide login')
  }
  const id = genId()
  const configDir = path.join(accountsRoot(provider), id)
  fs.mkdirSync(configDir, { recursive: true })
  const account: ProviderAccount = { id, name: name.trim() || 'Account', provider, configDir, isDefault: false }
  group(provider).accounts.push(account)
  persist()
  return account
}

export function renameProviderAccount(provider: AgentProvider, id: string, name: string): void {
  // Gemini has no per-account identity to rename — its one account is always
  // 'default'/'Antigravity'; renaming would only relabel an entry nothing reads.
  if (provider === 'gemini') return
  const account = group(provider).accounts.find((a) => a.id === id)
  if (account) {
    account.name = name.trim() || account.name
    persist()
  }
}

export function removeProviderAccount(provider: AgentProvider, id: string): void {
  // Gemini only ever has the default account (see loadGroup); there is nothing
  // isolated to remove and no other account can exist to pass in as `id`.
  if (provider === 'gemini') return
  if (id === DEFAULT_ID) return
  const g = group(provider)
  const account = g.accounts.find((a) => a.id === id)
  if (account?.configDir) {
    try {
      fs.rmSync(account.configDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
  g.accounts = g.accounts.filter((a) => a.id !== id)
  if (g.defaultAccountId === id) g.defaultAccountId = DEFAULT_ID
  persist()
}

export function setDefaultProviderAccount(provider: AgentProvider, id: string): void {
  // Gemini has exactly one account and it is always the default — nothing to switch.
  if (provider === 'gemini') return
  const g = group(provider)
  if (g.accounts.some((a) => a.id === id)) {
    g.defaultAccountId = id
    persist()
  }
}

/**
 * Launch an interactive login for one account, in its own terminal window, with
 * the account's env override set — mirrors accounts.ts's `loginAccount()`. The
 * user completes the CLI's own login flow (browser OAuth for both); afterwards
 * the account's isolated dir holds its own credentials.
 */
export function loginProviderAccount(provider: AgentProvider, id: string): { launched: boolean; command: string } {
  const account = group(provider).accounts.find((a) => a.id === id)
  const dir = account?.configDir
  // Gemini logs in through Antigravity (Google's latest agentic CLI), launched via its
  // `agy` command, rather than the older `gemini` CLI.
  const bareCommand = provider === 'codex' ? 'codex login' : 'agy'
  // Gemini/Antigravity has exactly one machine-wide login (OS keyring, not a config
  // dir), so it always uses the bare command — never a per-account env override, which
  // would only relocate config while the credentials stayed in the keyring anyway.
  if (!account || !dir || provider === 'gemini') {
    return launchLoginTerminal(`${provider}-default`, bareCommand, {})
  }
  fs.mkdirSync(dir, { recursive: true })
  return launchLoginTerminal(`${provider}-${id}`, bareCommand, { CODEX_HOME: dir })
}

/**
 * Open a terminal window running `command` with extra env vars set. Windows batch
 * files are written pure-ASCII and read paths back out of the environment block
 * (which Windows passes as Unicode) rather than interpolating them into the script
 * body — cmd reads .bat files in the legacy OEM codepage, which corrupts
 * non-ASCII paths (e.g. an accented user directory). Same trick as
 * accounts.ts's loginAccount().
 */
function launchLoginTerminal(
  idForTempFile: string,
  command: string,
  envOverride: Record<string, string>
): { launched: boolean; command: string } {
  try {
    let child: ReturnType<typeof spawn> | null = null
    if (process.platform === 'win32') {
      // The env override is injected via `env:` below, so cmd.exe (and the batch
      // file it runs) inherits it automatically — no need to `set` it in the
      // script body, which also sidesteps the OEM-codepage path-corruption issue
      // accounts.ts's loginAccount() documents for non-ASCII paths.
      const bat = path.join(os.tmpdir(), `${idForTempFile}-login-${Date.now()}.bat`)
      fs.writeFileSync(bat, `@echo off\r\ncall ${command}\r\n`)
      child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', bat], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...envOverride }
      })
    } else if (process.platform === 'darwin') {
      const prefix = Object.entries(envOverride)
        .map(([k, v]) => `${k}='${v}' `)
        .join('')
      const full = `${prefix}${command}`
      child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${full}"`], {
        detached: true,
        stdio: 'ignore'
      })
    } else {
      const prefix = Object.entries(envOverride)
        .map(([k, v]) => `${k}='${v}' `)
        .join('')
      if (!openLinuxTerminal(`${prefix}${command}`)) {
        return { launched: false, command: `${prefix}${command}` }
      }
    }
    child?.on('error', () => {
      /* swallow — caller falls back to showing the command */
    })
    child?.unref()
    const shown = Object.entries(envOverride)
      .map(([k, v]) => `${k}='${v}' `)
      .join('')
    return { launched: true, command: `${shown}${command}` }
  } catch {
    const shown = Object.entries(envOverride)
      .map(([k, v]) => `${k}='${v}' `)
      .join('')
    return { launched: false, command: `${shown}${command}` }
  }
}

/**
 * Status (loggedIn/email/plan) for every account of a provider — one status
 * lookup per account, run in sequence. Best-effort: a lookup failure just
 * leaves that account showing as not logged in, same as the single-account
 * checks in agent-clis.ts.
 */
export async function listProviderAccountStatus(
  provider: AgentProvider
): Promise<{ accounts: ProviderAccountStatus[]; defaultAccountId: string }> {
  if (provider === 'gemini') {
    // Antigravity is a single machine-wide keyring login — present it as one fixed
    // "Antigravity" account regardless of any legacy stored gemini accounts.
    return {
      accounts: [
        { id: 'default', name: 'Antigravity', provider: 'gemini', configDir: null, isDefault: true, loggedIn: true }
      ],
      defaultAccountId: 'default'
    }
  }
  const g = group(provider)
  // Each account's login status is a live CLI spawn (`codex login status`), ~1s
  // apiece — run them concurrently so N accounts don't load in N seconds.
  const accounts = await Promise.all(
    g.accounts.map(async (account) => {
      const status = await checkCodexStatus(account.configDir ?? undefined)
      return { ...account, loggedIn: status.loggedIn, email: status.email, plan: status.plan }
    })
  )
  return { accounts, defaultAccountId: g.defaultAccountId }
}
