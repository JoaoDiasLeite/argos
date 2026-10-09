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
  runbookForbiddenEntries,
  runbookForbiddenError,
  runbookName,
  scriptPinError,
  type LoadedRunbook,
  type LoadRunbookResult
} from './ops-runbook-pure'
import type { OpsHostRef } from './ops-types'
import { t } from './i18n'
import { makeT, type TFunction } from '../shared/i18n'

export type { LoadedRunbook, LoadRunbookResult } from './ops-runbook-pure'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * A script read at call time answers the model and lands in the ops ledger, both of
 * which stay English; only the load-time refusals are for the screen.
 */
const tEn = makeT('en')

/** A required regular file, refused past `max` before it is read. */
async function readCapped(
  file: string,
  max: number,
  tr: TFunction
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const name = path.basename(file)
  try {
    const st = await fsp.lstat(file)
    if (!st.isFile()) return { ok: false, error: tr('runbook.load.notRegularFile', { file: name }) }
    if (st.size > max) return { ok: false, error: tr('runbook.load.fileTooLarge', { file: name, size: st.size, max }) }
    return { ok: true, bytes: await fsp.readFile(file) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: tr('runbook.load.fileMissing', { file: name }) }
    return { ok: false, error: tr('runbook.load.readFailed', { file: name, error: message(e) }) }
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
    return { ok: false, error: t('runbook.load.listScriptsFailed', { error: message(e) }) }
  }
  const hashes: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const r = await readCapped(path.join(dir, entry.name), OPS_MAX_SCRIPT_BYTES, t)
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
    if (!runbookName(abs)) return { ok: false, error: t('runbook.load.nameChars', { dir: abs }) }
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isDirectory()) return { ok: false, error: t('runbook.load.notFolder', { dir: abs }) }

    // The folder becomes the ops CLI's cwd, so CLI config inside it (hooks, CLAUDE.md)
    // would run or inject outside the gate — see runbookForbiddenEntries.
    const rootEntries = await fsp.readdir(abs).catch(() => [] as string[])
    const forbidden = runbookForbiddenEntries(rootEntries)
    if (forbidden.length) return { ok: false, error: runbookForbiddenError(forbidden, t) }

    const md = await readCapped(path.join(abs, 'RUNBOOK.md'), OPS_MAX_RUNBOOK_FILE_BYTES, t)
    if (!md.ok) return md
    const policy = await readCapped(path.join(abs, 'policy.json'), OPS_MAX_RUNBOOK_FILE_BYTES, t)
    if (!policy.ok) return policy
    const scripts = await hashScripts(path.join(abs, 'scripts'))
    if (!scripts.ok) return scripts

    return assembleRunbook(
      {
        dir: abs,
        runbookMd: md.bytes,
        policyJson: policy.bytes,
        scriptHashes: scripts.hashes,
        hosts: storedHosts()
      },
      t
    )
  } catch (e) {
    return { ok: false, error: t('runbook.load.failed', { error: message(e) }) }
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
    const r = await readCapped(path.join(runbook.scriptsDir, name), OPS_MAX_SCRIPT_BYTES, tEn)
    if (!r.ok) return r
    const sha256 = sha256Hex(r.bytes)
    const err = scriptPinError(runbook.policy, name, sha256)
    if (err) return { ok: false, error: err }
    return { ok: true, content: r.bytes, sha256 }
  } catch (e) {
    return { ok: false, error: `Could not read script ${name}: ${message(e)}` }
  }
}
