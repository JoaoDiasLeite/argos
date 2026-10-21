#!/usr/bin/env node
/**
 * Recompute the sha256 of every script a runbook's policy.json lists, in place.
 *
 *   node scripts/pin-runbook.mjs resources/runbooks/despiste
 *
 * The hash is over the file's exact bytes, the same way src/main/ops-runbook.ts hashes
 * scripts/ at load time. The file is rewritten as 2-space JSON with a trailing newline
 * and LF endings, so a re-pin only changes the hashes that changed. A listed script with
 * no file, or a file in scripts/ that policy.json does not list, is an error: pinning
 * must never hide a script the policy does not know about.
 */
import { createHash } from 'crypto'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/pin-runbook.mjs <runbook folder>')
  process.exit(2)
}

const root = resolve(dir)
const policyPath = join(root, 'policy.json')
const scriptsDir = join(root, 'scripts')
const policy = JSON.parse(readFileSync(policyPath, 'utf8').replace(/^﻿/, ''))
const scripts = Array.isArray(policy.scripts) ? policy.scripts : []

const onDisk = new Set(
  readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
)
const listed = new Set(scripts.map((s) => s.name))

let failed = false
for (const name of onDisk) {
  if (!listed.has(name)) {
    console.error(`scripts/${name} is not listed in policy.json`)
    failed = true
  }
}

let changed = 0
for (const entry of scripts) {
  if (!onDisk.has(entry.name)) {
    console.error(`policy.json lists ${entry.name}, but scripts/${entry.name} does not exist`)
    failed = true
    continue
  }
  const bytes = readFileSync(join(scriptsDir, entry.name))
  if (bytes.includes(0x0d)) {
    console.error(`scripts/${entry.name} has CR line endings; the hash would differ between checkouts`)
    failed = true
    continue
  }
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (entry.sha256 !== sha) {
    console.log(`${entry.name}: ${entry.sha256 ?? '(none)'} -> ${sha}`)
    entry.sha256 = sha
    changed++
  }
}

if (failed) process.exit(1)
writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n')
console.log(changed === 0 ? 'all script hashes already current' : `pinned ${changed} script(s)`)
