/**
 * Loads a runbook folder from disk (docs/OPS_AGENT_PLAN.md §2): RUNBOOK.md, policy.json and
 * the hashes of scripts/. The validation is ops-runbook-pure.ts; this file only reads,
 * and never writes under a runbook. Every export returns a result shape.
 */
import { promises as fsp } from 'fs'
import * as path from 'path'
import { listHosts } from './ssh'
import { sha256Hex } from './ops-audit-pure'
import {
  assembleRunbook,
  OPS_MAX_RUNBOOK_FILE_BYTES,
  OPS_MAX_SCRIPT_BYTES,
  runbookName,
  scriptPinError,
  type LoadedRunbook,
  type LoadRunbookResult
} from './ops-runbook-pure'
import type { OpsHostRef } from './ops-types'

export type { LoadedRunbook, LoadRunbookResult } from './ops-runbook-pure'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A required regular file, refused past `max` before it is read. */
async function readCapped(file: string, max: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  try {
    const st = await fsp.lstat(file)
    if (!st.isFile()) return { ok: false, error: `${path.basename(file)} is not a regular file.` }
    if (st.size > max) return { ok: false, error: `${path.basename(file)} is ${st.size} bytes; the limit is ${max}.` }
    return { ok: true, bytes: await fsp.readFile(file) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: `${path.basename(file)} is missing from the runbook folder.` }
    return { ok: false, error: `Could not read ${path.basename(file)}: ${message(e)}` }
  }
}

/**
 * sha256 of every regular file directly in scripts/. Symlinks and subfolders are left
 * out on purpose: a pinned script must be the bytes in the repo, not whatever a link
 * points at today. A missing scripts/ is an empty map.
 */
async function hashScripts(dir: string): Promise<{ ok: true; hashes: Record<string, string> } | { ok: false; error: string }> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, hashes: {} }
    return { ok: false, error: `Could not list scripts/: ${message(e)}` }
  }
  const hashes: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const r = await readCapped(path.join(dir, entry.name), OPS_MAX_SCRIPT_BYTES)
    if (!r.ok) return r
    hashes[entry.name] = sha256Hex(r.bytes)
  }
  return { ok: true, hashes }
}

function storedHosts(): OpsHostRef[] {
  return listHosts().map((h) => ({ id: h.id, name: h.name, host: h.host }))
}

export async function loadRunbook(dir: string): Promise<LoadRunbookResult> {
  try {
    const abs = path.resolve(dir)
    if (!runbookName(abs)) return { ok: false, error: `Runbook folder name must be letters, digits, ".", "_" or "-": ${abs}` }
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isDirectory()) return { ok: false, error: `Not a folder: ${abs}` }

    const md = await readCapped(path.join(abs, 'RUNBOOK.md'), OPS_MAX_RUNBOOK_FILE_BYTES)
    if (!md.ok) return md
    const policy = await readCapped(path.join(abs, 'policy.json'), OPS_MAX_RUNBOOK_FILE_BYTES)
    if (!policy.ok) return policy
    const scripts = await hashScripts(path.join(abs, 'scripts'))
    if (!scripts.ok) return scripts

    return assembleRunbook({
      dir: abs,
      runbookMd: md.bytes,
      policyJson: policy.bytes,
      scriptHashes: scripts.hashes,
      hosts: storedHosts()
    })
  } catch (e) {
    return { ok: false, error: `Could not load runbook: ${message(e)}` }
  }
}

/**
 * Re-read and re-hash a script right before it runs. The load-time hash only proves what
 * the file was when the run started; an edit since then is a refusal showing both hashes.
 */
export async function readScript(
  runbook: LoadedRunbook,
  name: string
): Promise<{ ok: true; content: Buffer; sha256: string } | { ok: false; error: string }> {
  try {
    if (!runbook.policy.scripts.some((s) => s.name === name)) {
      return { ok: false, error: `Script ${name} is not listed in policy.json.` }
    }
    // The policy validator already holds names to a plain charset; this is the belt to it.
    if (name !== path.basename(name) || name === '.' || name === '..') {
      return { ok: false, error: `Invalid script name: ${name}` }
    }
    const r = await readCapped(path.join(runbook.scriptsDir, name), OPS_MAX_SCRIPT_BYTES)
    if (!r.ok) return r
    const sha256 = sha256Hex(r.bytes)
    const err = scriptPinError(runbook.policy, name, sha256)
    if (err) return { ok: false, error: err }
    return { ok: true, content: r.bytes, sha256 }
  } catch (e) {
    return { ok: false, error: `Could not read script ${name}: ${message(e)}` }
  }
}
