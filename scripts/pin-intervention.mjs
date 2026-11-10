#!/usr/bin/env node
/**
 * Rebuild resources/runbooks/intervention from the diagnosis and the Jarvis catalog.
 *
 *   node scripts/pin-intervention.mjs           rebuild from scripts/intervention/catalog.txt
 *   node scripts/pin-intervention.mjs --fetch   read the catalog from Jarvis first
 *
 * policy.json = the diagnosis's rules and scripts + one rule per non-interactive catalog
 * command (scripts/intervention-pure.mjs). The diagnosis's scripts are copied byte for byte
 * into intervention/scripts, since the gate looks scripts up in the runbook's own folder.
 * RUNBOOK.md is written by hand and left alone. Run it after `npm run pin:diagnosis`.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { buildInterventionPolicy } from './intervention-pure.mjs'

const CATALOG_URL = 'https://jarvis.cityfy.pt/api/v3/wmcp/catalog'
const root = resolve(import.meta.dirname, '..')
const diagnosisDir = join(root, 'resources/runbooks/diagnosis')
const outDir = join(root, 'resources/runbooks/intervention')
const catalogPath = join(root, 'scripts/intervention/catalog.txt')
const titlesPath = join(root, 'scripts/intervention/titles.json')

if (process.argv.includes('--fetch')) {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) {
    console.error(`${CATALOG_URL}: HTTP ${res.status}`)
    process.exit(1)
  }
  const text = (await res.text()).replace(/\r\n/g, '\n')
  const before = readFileSync(catalogPath, 'utf8')
  writeFileSync(catalogPath, text)
  console.log(before === text ? 'catalog unchanged' : 'catalog updated: review the diff of scripts/intervention/catalog.txt')
}

const diagnosis = JSON.parse(readFileSync(join(diagnosisDir, 'policy.json'), 'utf8').replace(/^﻿/, ''))
const policy = buildInterventionPolicy(
  diagnosis,
  readFileSync(catalogPath, 'utf8'),
  JSON.parse(readFileSync(titlesPath, 'utf8'))
)

const scriptsOut = join(outDir, 'scripts')
rmSync(scriptsOut, { recursive: true, force: true })
mkdirSync(scriptsOut, { recursive: true })
for (const name of readdirSync(join(diagnosisDir, 'scripts'))) {
  copyFileSync(join(diagnosisDir, 'scripts', name), join(scriptsOut, name))
}
writeFileSync(join(outDir, 'policy.json'), JSON.stringify(policy, null, 2) + '\n')
const mutate = policy.allow.filter((r) => r.class === 'mutate').length
console.log(`intervention: ${policy.allow.length} rules (${mutate} mutate), ${policy.scripts.length} scripts`)
