import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import Anthropic from '@anthropic-ai/sdk'
import { MODELS, ModelInfo, setCatalog } from './config'
import { resolveCodex } from './providers/cli-resolve'
import { readJsonFile } from './json-file'
import { DiscoveredModel, mergeCatalog } from './models-catalog-pure'

const execFileAsync = promisify(execFile)

/** How long a built catalog is reused before the next call re-probes. The
 *  picker asks for the catalog every time it mounts; without this, each open
 *  would spawn the Codex CLI and hit the network again. */
const CATALOG_TTL_MS = 30 * 60 * 1000

function overridesPath(): string {
  return path.join(app.getPath('userData'), 'models.json')
}

function cachePath(): string {
  return path.join(app.getPath('userData'), 'models-cache.json')
}

// User-writable override/extension file — `{ "models": [...] }`, same shape as
// the bundled MODELS array. Entries here win over bundled defaults by id, and
// unknown ids are added as new catalog entries.
function loadOverrides(): ModelInfo[] {
  try {
    const p = overridesPath()
    if (!fs.existsSync(p)) return []
    const raw = readJsonFile<{ models?: ModelInfo[] }>(p)
    return Array.isArray(raw.models) ? raw.models : []
  } catch {
    return []
  }
}

// Last successful discovery, so a launch with no network (or no credentials
// this session) still lists the models we've already seen instead of quietly
// shrinking the picker back to the bundled set.
function loadDiscoveryCache(): DiscoveredModel[] {
  try {
    const p = cachePath()
    if (!fs.existsSync(p)) return []
    const raw = readJsonFile<{ models?: DiscoveredModel[] }>(p)
    return Array.isArray(raw.models) ? raw.models : []
  } catch {
    return []
  }
}

function saveDiscoveryCache(models: DiscoveredModel[]): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), models }, null, 2))
  } catch {
    // best-effort — a cache we can't write just means we re-probe next launch
  }
}

// Best-effort: ask the installed Codex CLI for its own model catalog so a
// model it already knows about but we haven't added yet still shows up
// (flagged `discovered: true`) instead of silently missing. Never throws —
// a missing CLI, a parse failure, or a timeout all just skip discovery.
async function discoverCodexModels(): Promise<DiscoveredModel[]> {
  try {
    const { command, prefixArgs } = resolveCodex()
    const { stdout } = await execFileAsync(command, [...prefixArgs, 'debug', 'models', '--json'], {
      timeout: 4000
    })
    if (!stdout) return []
    const parsed = JSON.parse(stdout)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : []
    return list
      .map((m: unknown) => {
        const id = typeof m === 'string' ? m : (m as { id?: string })?.id
        if (typeof id !== 'string' || !id) return null
        const ctx = typeof m === 'object' ? (m as { context_window?: number })?.context_window : undefined
        return { id, provider: 'codex' as const, maxInputTokens: ctx }
      })
      .filter((m): m is DiscoveredModel => m !== null)
  } catch {
    return []
  }
}

// Best-effort: ask the Anthropic Models API (GET /v1/models, via the SDK's
// `client.models.list()`) for the live catalog, so a Claude model released
// after this build still shows up (flagged `discovered: true`) instead of
// silently missing. The endpoint returns ids, display names and context
// windows — it does NOT return pricing, which is why a discovered entry has
// none and the picker says so rather than guessing.
//
// Credentials: we construct the client with no explicit key so the SDK runs
// its own resolution order — ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
// then an `ant auth login` OAuth profile on disk. Requiring an API key here
// used to skip discovery entirely for anyone signed in the normal way.
//
// Never throws — no credentials, a network failure, or a timeout all just
// skip discovery, and the on-disk cache covers the gap.
async function discoverClaudeModels(): Promise<DiscoveredModel[]> {
  try {
    const client = new Anthropic({ timeout: 4000, maxRetries: 0 })
    const out: DiscoveredModel[] = []
    for await (const model of client.models.list()) {
      if (!model?.id) continue
      out.push({
        id: model.id,
        provider: 'claude',
        label: model.display_name,
        // Added to the API in Mar 2026; older/proxied deployments may omit it,
        // in which case the context renders as '?' rather than a guess.
        maxInputTokens: (model as { max_input_tokens?: number }).max_input_tokens
      })
    }
    return out
  } catch {
    return []
  }
}

let cached: { at: number; models: ModelInfo[] } | null = null

/**
 * Effective model catalog: bundled defaults from config.ts, overridden or
 * extended by a user-writable models.json under userData, then extended again
 * by a live discovery pass (Anthropic's Models API + the Codex CLI) so a model
 * released after this build still appears, flagged as newly discovered.
 *
 * Result is memoized for CATALOG_TTL_MS; pass `force` to re-probe now.
 */
export async function buildModelsCatalog(force = false): Promise<ModelInfo[]> {
  if (!force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models

  // Run both discovery calls concurrently — one CLI/API being slow (or
  // hanging up to its own timeout) shouldn't serialize with the other.
  const [codex, claude] = await Promise.all([discoverCodexModels(), discoverClaudeModels()])
  const live = [...claude, ...codex]

  // A pass that found nothing (offline, not logged in) must not erase what we
  // knew last time, so fall back to the cache instead of an empty list.
  let discovered = live
  if (live.length > 0) saveDiscoveryCache(live)
  else discovered = loadDiscoveryCache()

  const models = mergeCatalog(MODELS, loadOverrides(), discovered)
  cached = { at: Date.now(), models }
  // Publish to config.ts so cost math uses override/discovered pricing too.
  setCatalog(models)
  return models
}
