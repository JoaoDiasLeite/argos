import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'crypto'
import { createGunzip, createGzip } from 'zlib'
import { once } from 'events'
import { pipeline } from 'stream/promises'
import { StringDecoder } from 'string_decoder'
import type { Readable, Writable } from 'stream'
import { promisify } from 'util'
import { encodeProjectPath } from './codex-data-pure'
import { projectNameKey } from './project-move-pure'

/**
 * The parts of profile export/import that need no Electron and no disk: the bundle format,
 * its secrets envelope, rewriting paths from the exporting machine's home to this one's,
 * and the merge rules that fold an imported profile into the one already here.
 */

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export const BUNDLE_FORMAT = 'argos-profile'
/** 2: gzip-compressed NDJSON, streamed. (1, one JSON document, never shipped.) */
export const BUNDLE_VERSION = 2

/** Top-level profile JSON files that travel in the bundle. */
export const PROFILE_JSON_FILES = [
  'config.json',
  'store.json',
  'accounts.json',
  'provider-accounts.json',
  'auth-state.json',
  'ssh-trust.json'
] as const

/** Profile folders that travel file by file. */
export const PROFILE_DIRS = ['sprints', 'planner', 'ops-audit'] as const

/** Everything an import may replace or merge, copied aside before it starts. */
export const BACKUP_FILES = [...PROFILE_JSON_FILES, 'ssh-hosts.bin', 'api-key.bin']

/** store.json keys that describe this machine rather than the user: never exported. */
export const STORE_LOCAL_KEYS = ['usageCache', 'sessionMigration']

/** The longest file or folder name NTFS (and ext4, in bytes) accepts. */
export const MAX_NAME_LENGTH = 255

export interface BundleFile {
  /** Relative, forward slashes. */
  rel: string
  text: string
  /** Set when the file was not valid UTF-8 and `text` holds base64. */
  encoding?: 'base64'
}

export interface EncryptedSecrets {
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  data: string
}

export interface SecretsPayload {
  ssh: Record<string, { password?: string; passphrase?: string }>
  apiKey?: string
}

// ─── Bundle format ────────────────────────────────────────────────────────────
//
// A `.argos` file is gzip over NDJSON: a header line, one 'profile' line, then any
// number of 'chat' lines, then each project as a 'project' line followed by its 'file'
// lines. Every line is one JSON object whose first key is `type`, so a reader that only
// wants counts can skip the file lines without parsing them. Streamed both ways: a
// profile can hold hundreds of MB of transcripts, past V8's longest string.

export interface BundleHeader {
  format: typeof BUNDLE_FORMAT
  version: number
  createdAt: number
  appVersion: string
  platform: string
  home: string
  userData: string
}

export interface ProfileLine {
  type: 'profile'
  json: Record<string, unknown>
  dirs: Record<string, Record<string, string>>
  sshHosts: Record<string, unknown>[]
  secrets?: EncryptedSecrets
}

export interface ChatLine {
  type: 'chat'
  record: Record<string, unknown>
  archivedMd?: { name: string; text: string }
}

export interface ProjectLine {
  type: 'project'
  /** Referenced by this project's 'file' lines, which follow it. */
  index: number
  sourceId: string
  sourceLabel: string
  provider: 'claude' | 'codex'
  kind: 'local' | 'wsl'
  distro?: string
  /** The Argos account id the source belongs to ('default' for the machine login). */
  accountId: string
  realPath: string
  encodedDir: string
  files: number
  transcripts: number
}

export interface FileLine extends BundleFile {
  type: 'file'
  /** The `index` of its project line. */
  project: number
}

export type BundleLine = ProfileLine | ChatLine | ProjectLine | FileLine

export type DecodeError = 'not-argos' | 'unsupported-version' | 'corrupt'

export class BundleError extends Error {
  constructor(
    readonly code: DecodeError,
    readonly version?: number
  ) {
    super(code)
  }
}

/** One NDJSON line, `type` first. */
export function encodeLine(line: BundleHeader | BundleLine): string {
  return JSON.stringify(line) + '\n'
}

export function validateHeader(parsed: unknown): BundleHeader {
  const h = parsed as Partial<BundleHeader> | null
  if (!h || typeof h !== 'object' || h.format !== BUNDLE_FORMAT) throw new BundleError('not-argos')
  if (h.version !== BUNDLE_VERSION) {
    throw new BundleError('unsupported-version', typeof h.version === 'number' ? h.version : undefined)
  }
  if (typeof h.home !== 'string' || typeof h.userData !== 'string' || typeof h.platform !== 'string') {
    throw new BundleError('corrupt')
  }
  return {
    format: BUNDLE_FORMAT,
    version: h.version,
    createdAt: typeof h.createdAt === 'number' ? h.createdAt : 0,
    appVersion: typeof h.appVersion === 'string' ? h.appVersion : '',
    platform: h.platform,
    home: h.home,
    userData: h.userData
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A body line, checked for the fields its type needs. Throws 'corrupt'. */
export function parseLine(raw: string): BundleLine {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new BundleError('corrupt')
  }
  if (!isObj(v)) throw new BundleError('corrupt')
  switch (v.type) {
    case 'profile':
      return {
        type: 'profile',
        json: isObj(v.json) ? v.json : {},
        dirs: isObj(v.dirs) ? (v.dirs as ProfileLine['dirs']) : {},
        sshHosts: Array.isArray(v.sshHosts) ? v.sshHosts.filter(isObj) : [],
        ...(isObj(v.secrets) ? { secrets: v.secrets as unknown as EncryptedSecrets } : {})
      }
    case 'chat':
      if (!isObj(v.record)) throw new BundleError('corrupt')
      return v as unknown as ChatLine
    case 'project':
      if (typeof v.index !== 'number' || typeof v.sourceId !== 'string' || typeof v.realPath !== 'string' || typeof v.encodedDir !== 'string') {
        throw new BundleError('corrupt')
      }
      return v as unknown as ProjectLine
    case 'file':
      if (typeof v.project !== 'number' || typeof v.rel !== 'string' || typeof v.text !== 'string') throw new BundleError('corrupt')
      return v as unknown as FileLine
    default:
      throw new BundleError('corrupt')
  }
}

/** A file line's raw text, recognised without parsing it (see encodeLine: `type` is first). */
export function isFileLine(raw: string): boolean {
  return raw.startsWith('{"type":"file"')
}

/**
 * Writes a bundle to `out` through gzip, one line at a time, waiting whenever the
 * compressor's buffer is full. `end()` resolves once the file is flushed.
 */
export class BundleWriter {
  private readonly gzip = createGzip()
  private readonly done: Promise<void>
  private failure: unknown = null

  constructor(out: Writable) {
    this.done = pipeline(this.gzip, out)
    this.done.catch((e) => {
      this.failure = e ?? new Error('write failed')
    })
  }

  async write(line: BundleHeader | BundleLine): Promise<void> {
    if (this.failure) throw this.failure
    if (!this.gzip.write(encodeLine(line))) {
      await Promise.race([once(this.gzip, 'drain'), this.done])
      if (this.failure) throw this.failure
    }
  }

  async end(): Promise<void> {
    this.gzip.end()
    await this.done
  }

  /** Stop and discard; `out` is destroyed with it. */
  abort(): void {
    this.gzip.destroy()
  }
}

/** The raw lines of a gzip stream, as they decompress. Throws 'not-argos'/'corrupt'. */
async function* gunzipLines(input: Readable): AsyncGenerator<string> {
  const gunzip = createGunzip()
  const piped = pipeline(input, gunzip)
  piped.catch(() => undefined)
  const decoder = new StringDecoder('utf8')
  // A line can be tens of MB (one transcript), so its pieces are collected and joined
  // once, and each chunk is searched only for its own newlines.
  let parts: string[] = []
  let first = true
  try {
    for await (const chunk of gunzip) {
      first = false
      const text = decoder.write(chunk as Buffer)
      let start = 0
      let nl: number
      while ((nl = text.indexOf('\n', start)) >= 0) {
        parts.push(text.slice(start, nl))
        const line = parts.join('')
        parts = []
        start = nl + 1
        if (line) yield line
      }
      if (start < text.length) parts.push(text.slice(start))
    }
  } catch (e) {
    if (e instanceof BundleError) throw e
    // Failing before any byte came out: not gzip at all. After: truncated or damaged.
    throw new BundleError(first ? 'not-argos' : 'corrupt')
  } finally {
    gunzip.destroy()
  }
  parts.push(decoder.end())
  const last = parts.join('')
  if (last) yield last
}

export interface OpenedBundle {
  header: BundleHeader
  /** The body lines, parsed; `skipFiles` yields file lines as null without parsing them. */
  lines: AsyncGenerator<BundleLine | null>
}

/**
 * Read the header (validating format and version) and hand back the rest as a stream.
 * The header is read before this resolves, so a wrong file fails here.
 */
export async function openBundle(input: Readable, opts: { skipFiles?: boolean } = {}): Promise<OpenedBundle> {
  const raw = gunzipLines(input)
  const first = await raw.next()
  if (first.done) throw new BundleError('not-argos')
  let parsed: unknown
  try {
    parsed = JSON.parse(first.value)
  } catch {
    await raw.return(undefined)
    throw new BundleError('not-argos')
  }
  let header: BundleHeader
  try {
    header = validateHeader(parsed)
  } catch (e) {
    await raw.return(undefined)
    throw e
  }
  async function* body(): AsyncGenerator<BundleLine | null> {
    for await (const line of raw) {
      if (opts.skipFiles && isFileLine(line)) {
        yield null
        continue
      }
      yield parseLine(line)
    }
  }
  return { header, lines: body() }
}

// ─── File name ────────────────────────────────────────────────────────────────

export function defaultExportName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `argos-profile-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.argos`
}

export function candidateKey(sourceId: string, encodedDir: string): string {
  return `${sourceId}::${encodedDir}`
}

/** Transcripts among a project's files: Codex rollouts, or a Claude project's top-level and archived `.jsonl`. */
export function isTranscriptRel(rel: string, provider: 'claude' | 'codex'): boolean {
  return rel.endsWith('.jsonl') && (provider === 'codex' || !rel.includes('/') || rel.startsWith('archived/'))
}

/** Text of a file for the bundle; base64 when it does not survive a UTF-8 round trip. */
export function fileEntry(rel: string, buf: Buffer): BundleFile {
  const text = buf.toString('utf8')
  if (Buffer.byteLength(text, 'utf8') === buf.length && Buffer.from(text, 'utf8').equals(buf)) return { rel, text }
  return { rel, text: buf.toString('base64'), encoding: 'base64' }
}

/** A bundle-relative path that cannot climb out of the directory it is written under. */
export function safeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null
  const parts = rel.split(/[\\/]+/)
  if (parts.some((p) => p === '..' || p === '')) return null
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null
  return parts.join('/')
}

// ─── Secrets ──────────────────────────────────────────────────────────────────

export async function encryptSecrets(payload: SecretsPayload, passphrase: string): Promise<EncryptedSecrets> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await scrypt(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

/** The secrets, or null when the passphrase is wrong (or the envelope was tampered with). */
export async function decryptSecrets(enc: EncryptedSecrets, passphrase: string): Promise<SecretsPayload | null> {
  try {
    const key = await scrypt(passphrase, Buffer.from(enc.salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(text) as Partial<SecretsPayload>
    return { ssh: parsed.ssh && typeof parsed.ssh === 'object' ? parsed.ssh : {}, apiKey: parsed.apiKey }
  } catch {
    return null
  }
}

// ─── Path remap ───────────────────────────────────────────────────────────────

export interface RemapPair {
  from: string
  to: string
}

export interface PathRemapper {
  /** A whole string value: rewritten only when it starts with a mapped root. */
  value: (s: string) => string
  /** Raw JSON/JSONL text: rewrites string literals that start with a mapped root. */
  text: (s: string) => string
  /** Any parsed JSON value, recursively. */
  deep: <T>(v: T) => T
  /** A Claude Code encoded project dir (`C--Users-X-proj`). */
  encoded: (s: string) => string
  identity: boolean
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrite paths from the exporting machine's roots to this machine's.
 *
 * Prefix-only, and only at a path boundary: `C:\Users\Jo` never matches
 * `C:\Users\Joana`. Each root is tried in the spellings Argos and the CLIs store:
 * backslashes, forward slashes (session records) and, in raw JSONL text, the
 * JSON-escaped backslashes (`C:\\Users\\X`). The replacement keeps the spelling it
 * replaced. `pairs` are tried in order, so the more specific root goes first.
 */
export function makePathRemapper(pairs: RemapPair[], caseInsensitive: boolean): PathRemapper {
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s)
  const active = pairs.filter((p) => p.from && p.to && fold(norm(p.from)) !== fold(norm(p.to)))
  const prepared = active.map((p) => {
    const from = trimSep(p.from)
    const to = trimSep(p.to)
    return {
      back: from.replace(/\//g, '\\'),
      fwd: from.replace(/\\/g, '/'),
      toBack: to.replace(/\//g, '\\'),
      toFwd: to.replace(/\\/g, '/'),
      encFrom: encodeProjectPath(from),
      encTo: encodeProjectPath(to)
    }
  })

  const value = (s: string): string => {
    for (const p of prepared) {
      for (const [spelling, repl] of [
        [p.back, p.toBack],
        [p.fwd, p.toFwd]
      ] as const) {
        if (s.length < spelling.length) continue
        if (fold(s.slice(0, spelling.length)) !== fold(spelling)) continue
        const rest = s.slice(spelling.length)
        if (rest && rest[0] !== '\\' && rest[0] !== '/') continue
        return repl + rest
      }
    }
    return s
  }

  const flags = caseInsensitive ? 'gi' : 'g'
  const textRules = prepared.flatMap((p) => {
    const escBack = p.back.replace(/\\/g, '\\\\')
    const escToBack = p.toBack.replace(/\\/g, '\\\\')
    const rules = [
      { re: new RegExp(`"${escapeRegex(escBack)}(?=\\\\\\\\|/|")`, flags), to: `"${escToBack}` },
      { re: new RegExp(`"${escapeRegex(p.fwd)}(?=\\\\\\\\|/|")`, flags), to: `"${p.toFwd}` }
    ]
    // Some writers escape non-ASCII (`João`): match that spelling of the root too.
    const asciiBack = asciiEscape(escBack)
    if (asciiBack !== escBack) {
      rules.push(
        { re: new RegExp(`"${escapeRegex(asciiBack)}(?=\\\\\\\\|/|")`, flags), to: `"${escToBack}` },
        { re: new RegExp(`"${escapeRegex(asciiEscape(p.fwd))}(?=\\\\\\\\|/|")`, flags), to: `"${p.toFwd}` }
      )
    }
    return rules
  })
  const text = (s: string): string => {
    let out = s
    // `replace` with a function so `$` in a path is never read as a substitution.
    for (const r of textRules) out = out.replace(r.re, () => r.to)
    return out
  }

  const deep = <T>(v: T): T => {
    if (typeof v === 'string') return value(v) as T
    if (Array.isArray(v)) return v.map((x) => deep(x)) as T
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deep(x)
      return out as T
    }
    return v
  }

  const encoded = (s: string): string => {
    for (const p of prepared) {
      if (s.length < p.encFrom.length) continue
      if (fold(s.slice(0, p.encFrom.length)) !== fold(p.encFrom)) continue
      const rest = s.slice(p.encFrom.length)
      if (rest && rest[0] !== '-') continue
      return p.encTo + rest
    }
    return s
  }

  return { value, text, deep, encoded, identity: prepared.length === 0 }
}

/** A string's JSON spelling with every non-ASCII character as `\uXXXX`. */
function asciiEscape(s: string): string {
  return s.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function norm(p: string): string {
  return trimSep(p).replace(/\\/g, '/')
}

function trimSep(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

/** Favourite/archived project keys are `<sourceId>:<encodedDir>`; remap the dir part. */
export function remapProjectPrefKey(key: string, remap: PathRemapper): string {
  const i = key.lastIndexOf(':')
  if (i < 0) return key
  return key.slice(0, i + 1) + remap.encoded(key.slice(i + 1))
}

/** store.json with this machine's paths: project-name keys, project pref keys, values. */
export function remapStore(store: Record<string, unknown>, remap: PathRemapper): Record<string, unknown> {
  if (remap.identity) return store
  const out = remap.deep(store)
  for (const k of ['favoriteProjects', 'archivedProjects']) {
    const v = out[k]
    if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? remapProjectPrefKey(x, remap) : x))
  }
  const names = out['project-names']
  if (names && typeof names === 'object' && !Array.isArray(names)) {
    const next: Record<string, unknown> = {}
    for (const [key, name] of Object.entries(names as Record<string, unknown>)) {
      next[projectNameKey(remap.value(key))] = name
    }
    out['project-names'] = next
  }
  return out
}

// ─── Merges ───────────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function unionArrays(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map((x) => JSON.stringify(x)))
  const out = [...a]
  for (const x of b) {
    const key = JSON.stringify(x)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
  }
  return out
}

/** Key-wise: objects merged (imported wins per key), arrays unioned, scalars imported wins. */
export function mergeStore(local: Record<string, unknown>, imported: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...local }
  for (const [k, v] of Object.entries(imported)) {
    if (STORE_LOCAL_KEYS.includes(k)) continue
    const mine = out[k]
    if (isPlainObject(mine) && isPlainObject(v)) out[k] = { ...mine, ...v }
    else if (Array.isArray(mine) && Array.isArray(v)) out[k] = unionArrays(mine, v)
    else out[k] = v
  }
  return out
}

export function stripLocalStoreKeys(store: Record<string, unknown>): Record<string, unknown> {
  const out = { ...store }
  for (const k of STORE_LOCAL_KEYS) delete out[k]
  return out
}

export interface AccountLike {
  id: string
  name: string
  configDir: string | null
  isDefault: boolean
  [extra: string]: unknown
}

export interface AccountGroupLike {
  accounts: AccountLike[]
  defaultAccountId: string
}

export const DEFAULT_ACCOUNT_ID = 'default'

/**
 * Merge account metadata by id. Logins never travel, so a new non-default account gets an
 * empty config dir of its own here (`newConfigDir`) and the user signs in again; an account
 * this machine already has keeps its own dir. The imported name wins. This machine keeps
 * its default account choice unless it only had the built-in one.
 */
export function mergeAccountGroup(
  local: AccountGroupLike | undefined,
  imported: AccountGroupLike | undefined,
  newConfigDir: (id: string) => string
): { group: AccountGroupLike; created: string[] } {
  const base: AccountGroupLike = local && Array.isArray(local.accounts)
    ? { accounts: local.accounts.map((a) => ({ ...a })), defaultAccountId: local.defaultAccountId || DEFAULT_ACCOUNT_ID }
    : { accounts: [], defaultAccountId: DEFAULT_ACCOUNT_ID }
  const onlyDefault = base.accounts.every((a) => a.id === DEFAULT_ACCOUNT_ID)
  const created: string[] = []
  for (const acc of imported && Array.isArray(imported.accounts) ? imported.accounts : []) {
    if (!acc || typeof acc.id !== 'string') continue
    const existing = base.accounts.find((a) => a.id === acc.id)
    if (existing) {
      if (typeof acc.name === 'string' && acc.name) existing.name = acc.name
      continue
    }
    if (acc.id === DEFAULT_ACCOUNT_ID) {
      base.accounts.unshift({ ...acc, configDir: null, isDefault: true })
      continue
    }
    const configDir = newConfigDir(acc.id)
    base.accounts.push({ ...acc, configDir, isDefault: false })
    created.push(configDir)
  }
  if (onlyDefault && imported?.defaultAccountId && base.accounts.some((a) => a.id === imported.defaultAccountId)) {
    base.defaultAccountId = imported.defaultAccountId
  }
  return { group: base, created }
}

export interface HostLike {
  id: string
  password?: string
  passphrase?: string
}

/** Merge SSH hosts by id: imported fields win, and a secret the import lacks is kept from here. */
export function mergeHosts<T extends HostLike>(local: T[], imported: T[]): T[] {
  const out = local.map((h) => ({ ...h }))
  for (const h of imported) {
    if (!h || typeof h.id !== 'string') continue
    const idx = out.findIndex((x) => x.id === h.id)
    if (idx < 0) {
      out.push({ ...h })
      continue
    }
    const prev = out[idx]
    out[idx] = { ...h, password: h.password || prev.password, passphrase: h.passphrase || prev.passphrase }
    if (!out[idx].password) delete out[idx].password
    if (!out[idx].passphrase) delete out[idx].passphrase
  }
  return out
}

/** The hosts as they travel: no secrets in the clear. */
export function splitHostSecrets<T extends HostLike>(hosts: T[]): { hosts: Omit<T, 'password' | 'passphrase'>[]; secrets: SecretsPayload['ssh'] } {
  const secrets: SecretsPayload['ssh'] = {}
  const out = hosts.map((h) => {
    const { password, passphrase, ...rest } = h
    if (password || passphrase) {
      secrets[h.id] = {}
      if (password) secrets[h.id].password = password
      if (passphrase) secrets[h.id].passphrase = passphrase
    }
    return rest
  })
  return { hosts: out, secrets }
}

/** Host-key trust: entries this machine has not seen are added; one it has verified stays. */
export function mergeTrust(local: Record<string, unknown>, imported: Record<string, unknown>): Record<string, unknown> {
  return { ...imported, ...local }
}

// ─── Chats ↔ projects ─────────────────────────────────────────────────────────

/** A comparable spelling of a project folder: forward slashes, no trailing one, case-folded on Windows. */
export function projectPathKey(p: string, opts: { wsl: boolean; windows: boolean }): string {
  let s = p
  if (opts.wsl) {
    // `\\wsl.localhost\Distro\home\x` and `/home/x` are the same folder.
    s = s.replace(/^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+/i, '')
    s = s.replace(/\\/g, '/')
    if (!s.startsWith('/')) s = '/' + s
    return s.replace(/\/+$/, '') || '/'
  }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '')
  return opts.windows ? s.toLowerCase() : s
}

/** True for a chat that runs on an SSH host: its folder is not on this machine. */
export function isRemoteChat(record: Record<string, unknown>): boolean {
  return typeof record.remoteHostId === 'string' && !!record.remoteHostId
}

/**
 * The source a chat's transcripts live in, as `getSources` names it, or null for one that
 * has none here (remote, Gemini).
 */
export function chatSourceId(
  record: Record<string, unknown>,
  defaults: { claudeAccountId: string; codexAccountId: string }
): string | null {
  if (isRemoteChat(record)) return null
  if (typeof record.wslDistro === 'string' && record.wslDistro) return `wsl:${record.wslDistro}`
  const provider = typeof record.provider === 'string' ? record.provider : 'claude'
  if (provider === 'codex') {
    const id = typeof record.codexAccountId === 'string' && record.codexAccountId ? record.codexAccountId : defaults.codexAccountId
    return id === DEFAULT_ACCOUNT_ID ? 'codex' : `codex:${id}`
  }
  if (provider === 'claude') {
    const id = typeof record.accountId === 'string' && record.accountId ? record.accountId : defaults.claudeAccountId
    return id === DEFAULT_ACCOUNT_ID ? 'local' : `account:${id}`
  }
  return null
}

export interface SelectedProject {
  sourceId: string
  kind: 'local' | 'wsl'
  realPath: string
}

/**
 * Which chat records travel with the selected projects: those whose folder and source
 * match one of them (a chat on another provider with no source of its own, Gemini, goes
 * when its folder matches any selected local project), plus remote chats when asked.
 */
export function selectChats(
  records: Record<string, unknown>[],
  selected: SelectedProject[],
  opts: { includeRemote: boolean; windows: boolean; claudeAccountId: string; codexAccountId: string }
): Record<string, unknown>[] {
  const bySource = new Set(
    selected.map((p) => `${p.sourceId}|${projectPathKey(p.realPath, { wsl: p.kind === 'wsl', windows: opts.windows })}`)
  )
  const localPaths = new Set(
    selected.filter((p) => p.kind === 'local').map((p) => projectPathKey(p.realPath, { wsl: false, windows: opts.windows }))
  )
  return records.filter((r) => {
    if (isRemoteChat(r)) return opts.includeRemote
    const projectPath = typeof r.projectPath === 'string' ? r.projectPath : ''
    if (!projectPath) return false
    const wsl = typeof r.wslDistro === 'string' && !!r.wslDistro
    const key = projectPathKey(projectPath, { wsl, windows: opts.windows })
    const sourceId = chatSourceId(r, opts)
    if (sourceId) return bySource.has(`${sourceId}|${key}`)
    return !wsl && localPaths.has(key)
  })
}

/** The account id a source id belongs to, for the bundle. */
export function sourceAccountId(sourceId: string): string {
  if (sourceId.startsWith('account:')) return sourceId.slice('account:'.length)
  if (sourceId.startsWith('codex:')) return sourceId.slice('codex:'.length)
  return DEFAULT_ACCOUNT_ID
}

export const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A file name for an archived chat transcript, or null if it is anything else. */
export function safeMdName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  if (!/^[^\\/:*?"<>|]+\.md$/.test(name) || name.startsWith('.')) return null
  return name
}
