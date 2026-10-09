/**
 * Turning a runbook folder's bytes into a LoadedRunbook (docs/OPS_AGENT_PLAN.md §2).
 * Pure: the caller (ops-runbook.ts) reads the files and the stored hosts and hands the
 * bytes in, so every refusal here is testable without a disk or Electron.
 *
 * Argos reads runbooks and never writes them, so nothing here tries to repair a file:
 * anything off is a refusal the owner fixes in the repo.
 */
import * as path from 'path'
import { sha256Hex } from './ops-audit-pure'
import { parsePolicy, resolveHostGroups } from './ops-policy-pure'
import type { OpsHostRef, OpsPolicy, OpsRunbookRef } from './ops-types'
import type { TFunction } from '../shared/i18n'

/** RUNBOOK.md and policy.json are text someone reviews; anything bigger is a mistake. */
export const OPS_MAX_RUNBOOK_FILE_BYTES = 256 * 1024
/** A script is uploaded whole on every call; past this it is not a runbook script. */
export const OPS_MAX_SCRIPT_BYTES = 16 * 1024 * 1024

export interface LoadedRunbook {
  ref: OpsRunbookRef
  policy: OpsPolicy
  /** RUNBOOK.md text, appended verbatim to the system prompt. */
  guidelines: string
  scriptsDir: string
  warnings: string[]
  /** Stored hosts that belong to at least one policy group, with those groups. */
  hosts: { host: OpsHostRef; groups: string[] }[]
}

export type LoadRunbookResult = { ok: true; runbook: LoadedRunbook } | { ok: false; error: string; errors?: string[] }

const NAME = /^[A-Za-z0-9._-]+$/

/**
 * The runbook's name is its folder's basename, and it ends up in report file names and
 * the ledger, so it is held to a plain charset rather than escaped later. `.` and `..`
 * are not names.
 */
export function runbookName(dir: string): string | null {
  // Either separator, so a Windows path names the same folder on every platform.
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  if (!NAME.test(base) || base === '.' || base === '..') return null
  return base
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Entries a runbook folder must not carry. The ops terminal starts Claude Code with the
 * runbook folder as cwd, and the CLI honours project config found there: `.claude/`
 * carries hooks, which run shell on THIS machine outside --disallowedTools; CLAUDE.md /
 * CLAUDE.local.md are injected into the model silently beside RUNBOOK.md; `.mcp.json`
 * names extra MCP servers (--strict-mcp-config already ignores it — this is the belt).
 * A runbook is reviewable text and scripts; any of these is a refusal, not a warning,
 * so a shared runbook cannot smuggle local execution past the gate.
 */
const RUNBOOK_FORBIDDEN_ENTRIES = ['.claude', '.mcp.json', 'claude.md', 'claude.local.md']

/** The forbidden entries present among a folder's root entry names, as found on disk. */
export function runbookForbiddenEntries(entryNames: string[]): string[] {
  return entryNames.filter((n) => RUNBOOK_FORBIDDEN_ENTRIES.includes(n.toLowerCase()))
}

export function runbookForbiddenError(found: string[], t: TFunction): string {
  return t('runbook.load.forbiddenEntries', { found: found.join(', ') })
}

export interface RunbookFiles {
  /** Absolute folder path. */
  dir: string
  runbookMd: Buffer
  policyJson: Buffer
  /** Every regular file in scripts/ → sha256 hex. */
  scriptHashes: Record<string, string>
  hosts: OpsHostRef[]
}

/**
 * Validate and assemble. Hashes are over the bytes as read, BOM and all. `t` words the
 * refusals and the policy diagnostics for the screen.
 */
export function assembleRunbook(files: RunbookFiles, t: TFunction): LoadRunbookResult {
  const name = runbookName(files.dir)
  if (!name) return { ok: false, error: t('runbook.load.nameMustMatch', { pattern: NAME.source, dir: files.dir }) }
  if (files.runbookMd.length > OPS_MAX_RUNBOOK_FILE_BYTES) {
    return {
      ok: false,
      error: t('runbook.load.fileTooLarge', { file: 'RUNBOOK.md', size: files.runbookMd.length, max: OPS_MAX_RUNBOOK_FILE_BYTES })
    }
  }
  if (files.policyJson.length > OPS_MAX_RUNBOOK_FILE_BYTES) {
    return {
      ok: false,
      error: t('runbook.load.fileTooLarge', { file: 'policy.json', size: files.policyJson.length, max: OPS_MAX_RUNBOOK_FILE_BYTES })
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(stripBom(files.policyJson.toString('utf-8')))
  } catch (e) {
    return { ok: false, error: t('runbook.load.invalidJson', { error: (e as Error).message }) }
  }
  const parsed = parsePolicy(raw, files.scriptHashes, files.hosts, t)
  if (!parsed.ok) {
    return { ok: false, error: t('runbook.load.policyErrors', { n: parsed.errors.length }), errors: parsed.errors }
  }
  const policy = parsed.policy

  const hosts = files.hosts
    .map((host) => ({ host, groups: resolveHostGroups(policy, host) }))
    .filter((h) => h.groups.length > 0)

  return {
    ok: true,
    runbook: {
      ref: {
        name,
        path: files.dir,
        policySha256: sha256Hex(files.policyJson),
        runbookMdSha256: sha256Hex(files.runbookMd),
        ...(policy.platform ? { platform: policy.platform } : {})
      },
      policy,
      guidelines: stripBom(files.runbookMd.toString('utf-8')),
      scriptsDir: path.join(files.dir, 'scripts'),
      warnings: parsed.warnings,
      hosts
    }
  }
}

/**
 * The call-time half of "sha256 matches at load time and again at call time": null when
 * the script is pinned and the bytes on disk still match, else the refusal to show.
 * English on purpose: the refusal is also written to the ops ledger and sent to the model.
 */
export function scriptPinError(policy: OpsPolicy, name: string, actualSha256: string): string | null {
  const rule = policy.scripts.find((s) => s.name === name)
  if (!rule) return `Script ${name} is not listed in policy.json.`
  if (rule.sha256.toLowerCase() !== actualSha256.toLowerCase()) {
    return `Script ${name} changed since the policy pinned it: policy.json has ${rule.sha256}, the file on disk is ${actualSha256}.`
  }
  return null
}
