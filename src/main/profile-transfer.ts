import { app, dialog, type BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type {
  ExportCandidate,
  ExportCandidates,
  ExportRequest,
  ExportResult,
  ImportPreviewResult,
  ImportProjectPreview,
  ImportRequest,
  ImportResult,
  ImportSkip
} from '../shared/profile-transfer'
import { PROFILE_FILE_EXTENSION } from '../shared/profile-transfer'
import { t } from './i18n'
import { getAllProjects, getSources, type ClaudeSource } from './claude-data'
import { scanCodexArchived, scanCodexRollouts, defaultCodexHome, invalidateCodexScan } from './codex-data'
import { encodeProjectPath } from './codex-data-pure'
import { readHostsWithSecrets, updateHostsWith, type SshHost } from './ssh'
import { getApiKey, setApiKey, loadAuthState } from './auth'
import { loadAccounts } from './accounts'
import { loadProviderAccounts } from './provider-accounts'
import { loadConfig } from './config'
import { reloadStore } from './store'
import { listDistros, wslHome, wslShareRoot } from './wsl'
import {
  BACKUP_FILES,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  BundleWriter,
  CHAT_ID,
  DEFAULT_ACCOUNT_ID,
  MAX_NAME_LENGTH,
  PROFILE_DIRS,
  PROFILE_JSON_FILES,
  candidateKey,
  decryptSecrets,
  defaultExportName,
  encryptSecrets,
  fileEntry,
  isRemoteChat,
  isTranscriptRel,
  makePathRemapper,
  mergeAccountGroup,
  mergeHosts,
  mergeStore,
  mergeTrust,
  openBundle,
  remapStore,
  safeMdName,
  safeRel,
  selectChats,
  sourceAccountId,
  splitHostSecrets,
  stripLocalStoreKeys,
  type AccountGroupLike,
  type BundleHeader,
  type BundleLine,
  type ChatLine,
  type FileLine,
  type OpenedBundle,
  type PathRemapper,
  type ProfileLine,
  type ProjectLine,
  type SecretsPayload
} from './profile-transfer-pure'

/**
 * Moving Argos to another machine: one `.argos` file with the profile and the chats of the
 * projects the user picks (see shared/profile-transfer.ts for the contract, and
 * profile-transfer-pure.ts for the format and merge rules). Logins never travel; secrets
 * travel only under a passphrase.
 */

const userData = (): string => app.getPath('userData')
const sessionsDir = (): string => path.join(userData(), 'sessions')
const chatExportsDir = (): string => path.join(userData(), 'exports', 'chats')
const isWindows = process.platform === 'win32'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The one file the import may read: whatever the open dialog last returned. The renderer
// hands the path back, so it is checked rather than trusted.
let previewedFile: string | null = null

// ─── Small fs helpers ─────────────────────────────────────────────────────────

interface WalkedFile {
  abs: string
  /** Relative to the walk root, forward slashes. */
  rel: string
  size: number
}

async function walkFiles(root: string, depth = 8): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth) await walk(abs, level + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await fs.promises.stat(abs)
        out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), size: st.size })
      } catch {
        // gone between readdir and stat
      }
    }
  }
  await walk(root, 0)
  return out
}

async function readJson(file: string): Promise<unknown> {
  try {
    const text = await fs.promises.readFile(file, 'utf8')
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

/** Write only when nothing is there yet. False when the file already existed. */
async function writeIfAbsent(file: string, data: string | Buffer): Promise<boolean> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.promises.writeFile(file, data, { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    throw e
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.promises.rename(tmp, file)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function readChatRecords(): Promise<Record<string, unknown>[]> {
  let names: string[]
  try {
    names = (await fs.promises.readdir(sessionsDir())).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const name of names) {
    const rec = await readJson(path.join(sessionsDir(), name))
    if (isPlainObject(rec) && typeof rec.id === 'string') out.push(rec)
  }
  return out
}

// ─── Export: candidates ───────────────────────────────────────────────────────

interface ProjectFiles {
  /** Where `files[].rel` is relative to. */
  root: string
  files: WalkedFile[]
  transcripts: number
}

/** The files one project's transcripts occupy, Claude Code or Codex. */
async function projectFiles(src: ClaudeSource, encodedDir: string): Promise<ProjectFiles> {
  if (src.provider === 'codex' && src.codex) {
    const home = src.codex.home
    const facts = [...(await scanCodexRollouts(src.codex)), ...(await scanCodexArchived(src.codex))].filter(
      (f) => encodeProjectPath(f.cwd) === encodedDir
    )
    const files: WalkedFile[] = []
    for (const f of facts) {
      try {
        const st = await fs.promises.stat(f.file)
        files.push({ abs: f.file, rel: path.relative(home, f.file).split(path.sep).join('/'), size: st.size })
      } catch {
        // rotated out from under the scan
      }
    }
    return { root: home, files, transcripts: files.length }
  }
  const root = path.join(src.projectsDir, encodedDir)
  const files = await walkFiles(root)
  // Top-level and archived transcripts; subagent logs in per-session folders travel too
  // but are not conversations of their own.
  const transcripts = files.filter((f) => isTranscriptRel(f.rel, 'claude')).length
  return { root, files, transcripts }
}

interface CandidateWithSource {
  candidate: ExportCandidate
  source: ClaudeSource
  encodedDir: string
}

async function collectCandidates(withSizes = true): Promise<CandidateWithSource[]> {
  const sources = await getSources(true)
  const projects = await getAllProjects()
  const out: CandidateWithSource[] = []
  for (const p of projects) {
    const source = sources.find((s) => s.id === p.sourceId)
    if (!source) continue
    let bytes = 0
    if (withSizes) {
      try {
        const pf = await projectFiles(source, p.encodedDir)
        bytes = pf.files.reduce((n, f) => n + f.size, 0)
      } catch {
        // a source that fails to read still lists, with no size
      }
    }
    out.push({
      source,
      encodedDir: p.encodedDir,
      candidate: {
        key: candidateKey(p.sourceId, p.encodedDir),
        sourceId: p.sourceId,
        sourceLabel: p.sourceLabel,
        provider: p.provider ?? 'claude',
        kind: p.kind,
        realPath: p.realPath,
        name: p.name,
        sessionCount: p.sessionCount + p.archivedCount,
        bytes,
        lastActive: p.lastActive
      }
    })
  }
  return out
}

export async function listExportCandidates(): Promise<ExportCandidates> {
  const [candidates, records] = await Promise.all([collectCandidates(), readChatRecords()])
  return {
    projects: candidates.map((c) => c.candidate),
    remoteChatCount: records.filter(isRemoteChat).length
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function readProfileDirs(): Promise<Record<string, Record<string, string>>> {
  const dirs: Record<string, Record<string, string>> = {}
  for (const name of PROFILE_DIRS) {
    const root = path.join(userData(), name)
    const files: Record<string, string> = {}
    for (const f of await walkFiles(root, 3)) {
      try {
        files[f.rel] = await fs.promises.readFile(f.abs, 'utf8')
      } catch {
        // unreadable: left behind
      }
    }
    dirs[name] = files
  }
  return dirs
}

function defaultAccountIdOf(json: unknown): string {
  return isPlainObject(json) && typeof json.defaultAccountId === 'string' ? json.defaultAccountId : DEFAULT_ACCOUNT_ID
}

export async function exportProfile(win: BrowserWindow | null, req: ExportRequest): Promise<ExportResult> {
  const options = {
    title: t('main.profile.exportTitle'),
    defaultPath: path.join(app.getPath('documents'), defaultExportName(new Date())),
    filters: [{ name: t('main.profile.fileFilter'), extensions: [PROFILE_FILE_EXTENSION] }]
  }
  const pick = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (pick.canceled || !pick.filePath) return { ok: false, canceled: true }
  const target = pick.filePath
  // Written aside and renamed at the end, so a failed export never leaves a half file
  // under the name the user picked.
  const partial = `${target}.partial`
  let writer: BundleWriter | null = null

  try {
    // Profile JSON, parsed.
    const json: Record<string, unknown> = {}
    for (const name of PROFILE_JSON_FILES) {
      const value = await readJson(path.join(userData(), name))
      if (value === undefined) continue
      json[name] = name === 'store.json' && isPlainObject(value) ? stripLocalStoreKeys(value) : value
    }
    const dirs = await readProfileDirs()

    // Servers travel without their secrets; those go in the envelope, if any.
    const hostsRead = readHostsWithSecrets()
    if (!hostsRead.ok) console.warn(`[profile] ssh hosts unreadable, exported without them: ${hostsRead.error}`)
    const { hosts, secrets: sshSecrets } = splitHostSecrets(hostsRead.ok ? hostsRead.hosts : [])
    const passphrase = req.passphrase ?? ''
    let secrets: ProfileLine['secrets']
    if (passphrase) {
      const payload: SecretsPayload = { ssh: sshSecrets }
      const apiKey = getApiKey()
      if (apiKey) payload.apiKey = apiKey
      secrets = await encryptSecrets(payload, passphrase)
    }

    const wanted = new Set(req.projects)
    const candidates = (await collectCandidates(false)).filter((c) => wanted.has(c.candidate.key))
    const records = selectChats(
      await readChatRecords(),
      candidates.map((c) => ({ sourceId: c.candidate.sourceId, kind: c.candidate.kind, realPath: c.candidate.realPath })),
      {
        includeRemote: req.includeRemoteChats,
        windows: isWindows,
        claudeAccountId: defaultAccountIdOf(json['accounts.json']),
        codexAccountId: defaultAccountIdOf(isPlainObject(json['provider-accounts.json']) ? json['provider-accounts.json'].codex : undefined)
      }
    )

    writer = new BundleWriter(fs.createWriteStream(partial))
    const header: BundleHeader = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: Date.now(),
      appVersion: app.getVersion(),
      platform: process.platform,
      home: os.homedir(),
      userData: userData()
    }
    await writer.write(header)
    await writer.write({ type: 'profile', json, dirs, sshHosts: hosts as Record<string, unknown>[], ...(secrets ? { secrets } : {}) })

    // Chat records of those projects (plus remote ones if asked), with archived transcripts.
    for (const record of records) {
      const chat: ChatLine = { type: 'chat', record }
      const md = typeof record.archivedTranscript === 'string' ? path.resolve(record.archivedTranscript) : ''
      const rel = md ? path.relative(chatExportsDir(), md) : ''
      if (md && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        try {
          chat.archivedMd = { name: path.basename(md), text: await fs.promises.readFile(md, 'utf8') }
        } catch {
          // the export file is gone; the record still travels
        }
      }
      await writer.write(chat)
    }

    // Each project, then its files, read one at a time as they are written.
    let transcripts = 0
    for (const [index, c] of candidates.entries()) {
      const pf = await projectFiles(c.source, c.encodedDir)
      const projectTranscripts = pf.files.filter((f) => isTranscriptRel(f.rel, c.candidate.provider)).length
      transcripts += projectTranscripts
      await writer.write({
        type: 'project',
        index,
        sourceId: c.candidate.sourceId,
        sourceLabel: c.candidate.sourceLabel,
        provider: c.candidate.provider,
        kind: c.candidate.kind,
        distro: c.source.distro,
        accountId: sourceAccountId(c.candidate.sourceId),
        realPath: c.candidate.realPath,
        encodedDir: c.encodedDir,
        files: pf.files.length,
        transcripts: projectTranscripts
      })
      for (const f of pf.files) {
        let buf: Buffer
        try {
          buf = await fs.promises.readFile(f.abs)
        } catch {
          continue // unreadable transcript: left behind rather than failing the export
        }
        await writer.write({ type: 'file', project: index, ...fileEntry(f.rel, buf) })
      }
    }

    await writer.end()
    writer = null
    await fs.promises.rename(partial, target)
    const bytes = (await fs.promises.stat(target)).size
    return {
      ok: true,
      path: target,
      bytes,
      counts: {
        projects: candidates.length,
        transcripts,
        chats: records.length,
        sprints: Object.keys(dirs.sprints ?? {}).length,
        servers: hosts.length,
        secrets: !!secrets
      }
    }
  } catch (e) {
    writer?.abort()
    await fs.promises.rm(partial, { force: true }).catch(() => undefined)
    return { ok: false, error: t('main.profile.error.write', { error: errMsg(e) }) }
  }
}

// ─── Import: reading and planning ─────────────────────────────────────────────

function bundleErrorText(e: unknown, file: string): string {
  if (e instanceof BundleError) {
    if (e.code === 'unsupported-version') return t('main.profile.error.version', { version: String(e.version ?? '?') })
    return t(e.code === 'not-argos' ? 'main.profile.error.notArgos' : 'main.profile.error.corrupt')
  }
  return t('main.profile.error.read', { path: file, error: errMsg(e) })
}

/** Open a bundle and read through its profile line, which always comes first. */
async function openForImport(
  file: string,
  skipFiles: boolean
): Promise<{ ok: true; opened: OpenedBundle; profile: ProfileLine } | { ok: false; error: string }> {
  try {
    await fs.promises.access(file, fs.constants.R_OK)
  } catch (e) {
    return { ok: false, error: t('main.profile.error.read', { path: file, error: errMsg(e) }) }
  }
  let opened: OpenedBundle | null = null
  try {
    opened = await openBundle(fs.createReadStream(file), { skipFiles })
    const first = await opened.lines.next()
    if (first.done || !first.value || first.value.type !== 'profile') throw new BundleError('corrupt')
    return { ok: true, opened, profile: first.value }
  } catch (e) {
    await opened?.lines.return(undefined).catch(() => undefined)
    return { ok: false, error: bundleErrorText(e, file) }
  }
}

type Dest = { kind: 'claude'; dir: string } | { kind: 'codex'; home: string }

interface PlannedProject {
  line: ProjectLine
  preview: ImportProjectPreview
  /** Null when the transcripts have nowhere to go here (unresolved or too long). */
  dest: Dest | null
  /** Rewrite transcript text to this machine's paths (local projects only). */
  remapText: boolean
}

interface ImportContext {
  header: BundleHeader
  profile: ProfileLine
  remap: PathRemapper
  crossPlatform: boolean
  claudeAccounts: { group: AccountGroupLike; created: string[] }
  providerAccounts: Record<string, unknown>
  providerCreated: string[]
  codexGroup: AccountGroupLike | undefined
  wslDirs: Map<string, Promise<string | null>>
  distros: Promise<Set<string>> | null
}

const safeAccountGroup = (raw: unknown): AccountGroupLike | undefined => {
  if (!isPlainObject(raw) || !Array.isArray(raw.accounts)) return undefined
  return {
    accounts: raw.accounts.filter(
      (a): a is AccountGroupLike['accounts'][number] => isPlainObject(a) && typeof a.id === 'string' && CHAT_ID.test(a.id)
    ),
    defaultAccountId: typeof raw.defaultAccountId === 'string' ? raw.defaultAccountId : DEFAULT_ACCOUNT_ID
  }
}

/** A WSL distro's Claude projects dir on this machine, or null when it is not installed. */
function wslProjectsDir(ctx: ImportContext, distro: string): Promise<string | null> {
  if (!isWindows) return Promise.resolve(null)
  let hit = ctx.wslDirs.get(distro)
  if (!hit) {
    ctx.distros ??= listDistros().then((ds) => new Set(ds.map((d) => d.name)))
    hit = ctx.distros.then(async (installed) => {
      if (!installed.has(distro)) return null
      const home = await wslHome(distro)
      return home ? `${wslShareRoot(distro)}${home.replace(/\//g, '\\')}\\.claude\\projects` : null
    })
    ctx.wslDirs.set(distro, hit)
  }
  return hit
}

async function planProfile(header: BundleHeader, profile: ProfileLine): Promise<ImportContext> {
  const crossPlatform = header.platform !== process.platform
  const remap = makePathRemapper(
    crossPlatform
      ? []
      : [
          { from: header.userData, to: userData() },
          { from: header.home, to: os.homedir() }
        ],
    isWindows
  )

  const claudeAccounts = mergeAccountGroup(
    safeAccountGroup(await readJson(path.join(userData(), 'accounts.json'))),
    safeAccountGroup(profile.json['accounts.json']),
    (id) => path.join(userData(), 'cc-accounts', id)
  )

  const localProviders = await readJson(path.join(userData(), 'provider-accounts.json'))
  const importedProviders = profile.json['provider-accounts.json']
  const providerAccounts: Record<string, unknown> = isPlainObject(localProviders) ? { ...localProviders } : {}
  const providerCreated: string[] = []
  for (const provider of ['codex', 'gemini']) {
    const imported = isPlainObject(importedProviders) ? safeAccountGroup(importedProviders[provider]) : undefined
    if (!imported) continue
    const merged = mergeAccountGroup(
      safeAccountGroup(isPlainObject(localProviders) ? localProviders[provider] : undefined),
      imported,
      (id) => path.join(userData(), 'provider-accounts', provider, id)
    )
    providerAccounts[provider] = { ...merged.group, accounts: merged.group.accounts.map((a) => ({ ...a, provider })) }
    providerCreated.push(...merged.created)
  }

  return {
    header,
    profile,
    remap,
    crossPlatform,
    claudeAccounts,
    providerAccounts,
    providerCreated,
    codexGroup: safeAccountGroup(providerAccounts.codex),
    wslDirs: new Map(),
    distros: null
  }
}

async function planProject(ctx: ImportContext, project: ProjectLine): Promise<PlannedProject> {
  const { remap } = ctx
  const wsl = project.kind === 'wsl'
  const toPath = wsl ? project.realPath : remap.value(project.realPath)
  const destName = wsl ? project.encodedDir : remap.encoded(project.encodedDir)
  const tooLong = project.provider !== 'codex' && destName.length > MAX_NAME_LENGTH
  const wslRoot = wsl && project.distro ? await wslProjectsDir(ctx, project.distro) : null

  let dest: Dest | null = null
  if (project.provider === 'codex') {
    if (!wsl) {
      if (project.sourceId === 'codex') dest = { kind: 'codex', home: defaultCodexHome() }
      else {
        const acc = ctx.codexGroup?.accounts.find((a) => a.id === project.accountId)
        if (acc) dest = { kind: 'codex', home: acc.configDir ?? defaultCodexHome() }
      }
    }
  } else if (wsl) {
    if (wslRoot) dest = { kind: 'claude', dir: path.join(wslRoot, destName) }
  } else {
    let root: string | null = null
    if (project.sourceId === 'local') root = path.join(os.homedir(), '.claude', 'projects')
    else {
      const acc = ctx.claudeAccounts.group.accounts.find((a) => a.id === project.accountId)
      if (acc) root = acc.configDir ? path.join(acc.configDir, 'projects') : path.join(os.homedir(), '.claude', 'projects')
    }
    if (root) dest = { kind: 'claude', dir: path.join(root, destName) }
  }

  let exists = false
  try {
    exists = wsl
      ? !!wslRoot && !!project.distro && fs.existsSync(`${wslShareRoot(project.distro)}${toPath.replace(/\//g, '\\')}`)
      : fs.existsSync(toPath)
  } catch {
    exists = false
  }
  return {
    line: project,
    dest: tooLong ? null : dest,
    remapText: !wsl,
    preview: {
      name: toPath.split(/[\\/]/).filter(Boolean).pop() ?? toPath,
      provider: project.provider,
      sourceLabel: project.sourceLabel,
      fromPath: project.realPath,
      toPath,
      exists,
      unresolved: !dest,
      tooLong,
      transcripts: typeof project.transcripts === 'number' ? project.transcripts : 0
    }
  }
}

export async function previewImport(win: BrowserWindow | null): Promise<ImportPreviewResult> {
  const options = {
    title: t('main.profile.importTitle'),
    properties: ['openFile' as const],
    filters: [{ name: t('main.profile.fileFilter'), extensions: [PROFILE_FILE_EXTENSION] }]
  }
  const pick = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true }
  const file = pick.filePaths[0]
  previewedFile = file

  const open = await openForImport(file, true)
  if (!open.ok) return { ok: false, error: open.error }
  const { opened, profile } = open
  try {
    const ctx = await planProfile(opened.header, profile)
    let chats = 0
    const projects: ImportProjectPreview[] = []
    // Read to the end: counts the chats and proves the file is whole. File lines are
    // skipped unparsed, so this keeps metadata only.
    for await (const line of opened.lines) {
      if (!line) continue
      if (line.type === 'chat') chats++
      else if (line.type === 'project') projects.push((await planProject(ctx, line)).preview)
    }
    const accountNames: string[] = []
    for (const a of safeAccountGroup(profile.json['accounts.json'])?.accounts ?? []) accountNames.push(a.name)
    const providers = profile.json['provider-accounts.json']
    const codex = isPlainObject(providers) ? safeAccountGroup(providers.codex) : undefined
    for (const a of codex?.accounts ?? []) if (a.id !== DEFAULT_ACCOUNT_ID) accountNames.push(a.name)
    return {
      ok: true,
      preview: {
        path: file,
        createdAt: opened.header.createdAt,
        appVersion: opened.header.appVersion,
        platform: opened.header.platform,
        crossPlatform: ctx.crossPlatform,
        fromHome: opened.header.home,
        toHome: os.homedir(),
        projects,
        chats,
        sprints: Object.keys(profile.dirs.sprints ?? {}).length,
        servers: profile.sshHosts.length,
        accounts: accountNames,
        hasSecrets: !!profile.secrets
      }
    }
  } catch (e) {
    await opened.lines.return(undefined).catch(() => undefined)
    return { ok: false, error: e instanceof BundleError ? bundleErrorText(e, file) : t('main.profile.error.import', { error: errMsg(e) }) }
  }
}

// ─── Import: applying ─────────────────────────────────────────────────────────

function timestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function backupProfile(): Promise<string> {
  const dir = path.join(userData(), 'backups', `pre-import-${timestamp(new Date())}`)
  await fs.promises.mkdir(dir, { recursive: true })
  for (const name of BACKUP_FILES) {
    const src = path.join(userData(), name)
    try {
      await fs.promises.copyFile(src, path.join(dir, name))
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
    }
  }
  return dir
}

function fileData(f: FileLine, remapText: PathRemapper['text'] | null): string | Buffer {
  if (f.encoding === 'base64') return Buffer.from(f.text, 'base64')
  return remapText ? remapText(f.text) : f.text
}

/** Profile-level steps: any failure here stops the import. */
async function applyProfile(ctx: ImportContext, secrets: SecretsPayload | null, importedHosts: (Record<string, unknown> & { id: string })[]): Promise<void> {
  const { remap } = ctx
  const pj = ctx.profile.json
  const ud = userData()

  // config.json: replaced.
  if (isPlainObject(pj['config.json'])) await writeJsonAtomic(path.join(ud, 'config.json'), remap.deep(pj['config.json']))

  // store.json: key-wise merge.
  if (isPlainObject(pj['store.json'])) {
    const local = await readJson(path.join(ud, 'store.json'))
    const merged = mergeStore(isPlainObject(local) ? local : {}, remapStore(pj['store.json'], remap))
    await fs.promises.writeFile(path.join(ud, 'store.json'), JSON.stringify(merged), 'utf8')
  }

  // Accounts: metadata only, each new one with an empty config dir of its own.
  if (pj['accounts.json'] !== undefined) {
    for (const dir of ctx.claudeAccounts.created) await fs.promises.mkdir(dir, { recursive: true })
    await writeJsonAtomic(path.join(ud, 'accounts.json'), ctx.claudeAccounts.group)
  }
  if (pj['provider-accounts.json'] !== undefined) {
    for (const dir of ctx.providerCreated) await fs.promises.mkdir(dir, { recursive: true })
    await writeJsonAtomic(path.join(ud, 'provider-accounts.json'), ctx.providerAccounts)
  }

  if (isPlainObject(pj['auth-state.json'])) await writeJsonAtomic(path.join(ud, 'auth-state.json'), pj['auth-state.json'])
  if (isPlainObject(pj['ssh-trust.json'])) {
    const local = await readJson(path.join(ud, 'ssh-trust.json'))
    await writeJsonAtomic(path.join(ud, 'ssh-trust.json'), mergeTrust(isPlainObject(local) ? local : {}, pj['ssh-trust.json']))
  }

  // Servers: through ssh.ts, so they are encrypted for this machine.
  if (importedHosts.length) {
    const incoming = importedHosts.map((h) => {
      const host = remap.deep(h) as unknown as SshHost
      const s = secrets?.ssh[host.id]
      return { ...host, ...(s?.password ? { password: s.password } : {}), ...(s?.passphrase ? { passphrase: s.passphrase } : {}) }
    })
    const res = updateHostsWith((local) => mergeHosts(local, incoming))
    if (!res.ok) throw new Error(res.error)
  }
  if (secrets?.apiKey) setApiKey(secrets.apiKey)
}

/** Sprints, planner, ops ledger: add-only, file by file. The ledger is hash-chained, so
 *  it is written exactly as exported. */
async function applyProfileDirs(ctx: ImportContext, skipped: ImportSkip[]): Promise<void> {
  for (const name of PROFILE_DIRS) {
    const files = ctx.profile.dirs[name]
    if (!isPlainObject(files)) continue
    for (const [rel, text] of Object.entries(files)) {
      const safe = safeRel(rel)
      if (!safe || typeof text !== 'string') continue
      let data = text
      if (name !== 'ops-audit' && safe.endsWith('.json')) {
        try {
          data = JSON.stringify(ctx.remap.deep(JSON.parse(text)), null, 2)
        } catch {
          // not JSON after all: as exported
        }
      }
      try {
        await writeIfAbsent(path.join(userData(), name, ...safe.split('/')), data)
      } catch (e) {
        skipped.push({ name: `${name}/${safe}`, reason: errMsg(e) })
      }
    }
  }
}

/** One chat record (and its archived transcript): add-only by id. */
async function applyChat(ctx: ImportContext, chat: ChatLine): Promise<void> {
  const record = chat.record
  if (typeof record.id !== 'string' || !CHAT_ID.test(record.id)) return
  const next = ctx.remap.deep(record)
  const mdName = chat.archivedMd ? safeMdName(chat.archivedMd.name) : null
  if (mdName && chat.archivedMd && typeof chat.archivedMd.text === 'string') {
    const mdPath = path.join(chatExportsDir(), mdName)
    await writeIfAbsent(mdPath, chat.archivedMd.text)
    next.archivedTranscript = mdPath
  }
  await writeIfAbsent(path.join(sessionsDir(), `${record.id}.json`), JSON.stringify(next, null, 2))
}

interface ProjectState {
  plan: PlannedProject
  /** This project's entry in `skipped`, once a file of it has failed. */
  failure: ImportSkip | null
  firstError: string
  failed: number
}

/**
 * Merge the bundle into this machine's profile, streaming it. Nothing is written until the
 * passphrase (when one is given) has opened the secrets and this machine's server list has
 * been read; everything replaced is copied aside first. Past the profile itself, a chat,
 * sprint or transcript that cannot be written is skipped and reported, and the rest goes on.
 * The caller relaunches the app.
 */
export async function applyImport(req: ImportRequest): Promise<ImportResult> {
  if (!previewedFile || req.path !== previewedFile) return { ok: false, error: t('main.profile.error.notPreviewed') }
  const open = await openForImport(req.path, false)
  if (!open.ok) return { ok: false, error: open.error }
  const { opened, profile } = open
  const close = (): Promise<unknown> => opened.lines.return(undefined).catch(() => undefined)

  let secrets: SecretsPayload | null = null
  if (profile.secrets && req.passphrase) {
    secrets = await decryptSecrets(profile.secrets, req.passphrase)
    if (!secrets) {
      await close()
      return { ok: false, error: 'bad-passphrase' }
    }
  }
  const importedHosts = profile.sshHosts.filter(
    (h): h is Record<string, unknown> & { id: string } => isPlainObject(h) && typeof h.id === 'string'
  )
  if (importedHosts.length) {
    const hostsNow = readHostsWithSecrets()
    if (!hostsNow.ok) {
      await close()
      return { ok: false, error: t('main.profile.error.hostsUnreadable', { error: hostsNow.error }) }
    }
  }

  let backupDir: string
  try {
    backupDir = await backupProfile()
  } catch (e) {
    await close()
    return { ok: false, error: t('main.profile.error.import', { error: errMsg(e) }) }
  }

  const skipped: ImportSkip[] = []
  try {
    const ctx = await planProfile(opened.header, profile)
    await applyProfile(ctx, secrets, importedHosts)
    await applyProfileDirs(ctx, skipped)

    const projects = new Map<number, ProjectState>()
    for await (const line of opened.lines) {
      if (!line) continue
      await applyLine(ctx, line, projects, skipped)
    }
    reloadAfterImport()
    return { ok: true, backupDir, skipped }
  } catch (e) {
    // A profile-level step failed, or the file turned out damaged partway. Whatever was
    // written stays; the backup holds the profile as it was.
    await close()
    reloadAfterImport()
    const error = e instanceof BundleError ? bundleErrorText(e, req.path) : errMsg(e)
    return { ok: false, error: t('main.profile.error.importPartial', { error, backup: backupDir }) }
  }
}

async function applyLine(ctx: ImportContext, line: BundleLine, projects: Map<number, ProjectState>, skipped: ImportSkip[]): Promise<void> {
  if (line.type === 'chat') {
    try {
      await applyChat(ctx, line)
    } catch (e) {
      const name = typeof line.record.name === 'string' && line.record.name ? line.record.name : String(line.record.id)
      skipped.push({ name, reason: errMsg(e) })
    }
    return
  }
  if (line.type === 'project') {
    const plan = await planProject(ctx, line)
    const state: ProjectState = { plan, failure: null, firstError: '', failed: 0 }
    if (plan.preview.tooLong) {
      state.failure = { name: plan.preview.toPath, reason: t('main.profile.skip.tooLong', { max: MAX_NAME_LENGTH }) }
      skipped.push(state.failure)
    }
    projects.set(line.index, state)
    return
  }
  if (line.type !== 'file') return
  const state = projects.get(line.project)
  const dest = state?.plan.dest
  if (!state || !dest) return
  const safe = safeRel(line.rel)
  if (!safe) return
  const root = dest.kind === 'claude' ? dest.dir : dest.home
  try {
    await writeIfAbsent(path.join(root, ...safe.split('/')), fileData(line, state.plan.remapText ? ctx.remap.text : null))
  } catch (e) {
    // One entry per project however many of its files fail: a folder that cannot be
    // created fails every file in it the same way.
    state.failed++
    if (!state.failure) {
      state.firstError = errMsg(e)
      state.failure = { name: state.plan.preview.toPath, reason: state.firstError }
      skipped.push(state.failure)
    } else {
      state.failure.reason = t('main.profile.skip.files', { count: state.failed, error: state.firstError })
    }
  }
}

/** Point the modules that keep the profile in memory at what is now on disk, so nothing
 *  writes the old state back before the relaunch. */
function reloadAfterImport(): void {
  loadAuthState()
  loadAccounts()
  loadProviderAccounts()
  loadConfig()
  reloadStore()
  invalidateCodexScan()
  void getSources(true).catch(() => undefined)
}
