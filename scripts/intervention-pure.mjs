/**
 * The base intervention's policy, built from the diagnosis's policy and the Jarvis catalog
 * (docs/BASE_INTERVENTION_PLAN.md §3). Pure: scripts/pin-intervention.mjs writes the result
 * to resources/runbooks/intervention/policy.json, and src/main/ops-intervention-runbook.test.ts
 * builds it again and fails when the file on disk differs, so neither a hand edit nor a
 * stale pin can ship.
 */

const VERSION = '[0-9]+\\.[0-9]+\\.[0-9]+(\\.[A-Za-z0-9]+)?'
const USER = '[a-z0-9._-]{1,64}'
const VALUE = '[A-Za-z0-9._-]{1,64}'
/** What the update runbook (Jarvis update_app/production) appends to a step's command. */
const STEP_SUFFIX = '( --(step|verify_of)=[0-9]{1,3}[a-z]?)?( --timing=true)?'

/** Updates run for minutes and print a lot; changes never run two at a time on a host. */
export const INTERVENTION_LIMITS = { timeoutMs: 600000, maxOutputBytes: 2097152, concurrentPerHost: 1 }

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One block per command: Name, What, Changes the server, Interactive, Command, Code. */
export function parseCatalog(text) {
  const entries = []
  for (const block of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const fields = {}
    for (const line of block.split('\n')) {
      const m = /^([A-Z][A-Za-z ]*): (.*)$/.exec(line)
      if (m) fields[m[1]] = m[2].trim()
    }
    if (!fields.Name) continue
    for (const key of ['What', 'Changes the server', 'Interactive', 'Command']) {
      if (!fields[key]) throw new Error(`catalog entry ${fields.Name} has no "${key}"`)
    }
    for (const key of ['Changes the server', 'Interactive']) {
      if (fields[key] !== 'yes' && fields[key] !== 'no') {
        throw new Error(`catalog entry ${fields.Name}: "${key}" is "${fields[key]}", not yes or no`)
      }
    }
    entries.push({
      name: fields.Name,
      what: fields.What,
      changes: fields['Changes the server'] === 'yes',
      interactive: fields.Interactive === 'yes',
      command: fields.Command
    })
  }
  if (entries.length === 0) throw new Error('the catalog has no commands')
  return entries
}

function placeholder(inner) {
  if (inner.includes('|')) return '(' + inner.split('|').map(escapeRe).join('|') + ')'
  if (inner === 'true' || inner === 'false') return inner
  if (/(^|_)version$/.test(inner)) return VERSION
  if (inner === 'user') return USER
  return VALUE
}

function tokenRe(token) {
  return token
    .split(/(<[^<>]+>)/)
    .map((part) => (part.startsWith('<') && part.endsWith('>') ? placeholder(part.slice(1, -1)) : escapeRe(part)))
    .join('')
}

/** The allow rule for one non-interactive catalog command. */
export function ruleFor(entry, title) {
  let re = '^'
  entry.command.split(' ').forEach((token, i) => {
    if (token.startsWith('[') || token.endsWith(']')) {
      if (!(token.startsWith('[') && token.endsWith(']')) || i === 0) {
        throw new Error(`catalog entry ${entry.name}: cannot read the optional part "${token}"`)
      }
      re += `( ${tokenRe(token.slice(1, -1))})?`
    } else {
      re += (i === 0 ? '' : ' ') + tokenRe(token)
    }
  })
  re += STEP_SUFFIX + '$'
  if (re.length >= 512) throw new Error(`catalog entry ${entry.name}: rule longer than 511 characters`)
  const rule = { hosts: ['todos'], cmd: re, class: entry.changes ? 'mutate' : 'read', title }
  return rule
}

/**
 * diagnosis: the parsed resources/runbooks/diagnosis/policy.json.
 * titles: the client-report title (pt-PT) of every non-interactive catalog command, and of
 * nothing else, so a command added to Jarvis cannot enter without a title.
 */
export function buildInterventionPolicy(diagnosis, catalogText, titles) {
  const entries = parseCatalog(catalogText)
  const runnable = entries.filter((e) => !e.interactive)
  const missing = runnable.filter((e) => !titles[e.name]).map((e) => e.name)
  if (missing.length) throw new Error(`no title in scripts/intervention/titles.json for: ${missing.join(', ')}`)
  const stale = Object.keys(titles).filter((name) => !runnable.some((e) => e.name === name))
  if (stale.length) throw new Error(`titles.json names commands the catalog does not run: ${stale.join(', ')}`)
  const clone = (v) => JSON.parse(JSON.stringify(v))
  return {
    version: 1,
    strict: true,
    hosts: clone(diagnosis.hosts),
    allow: [...clone(diagnosis.allow), ...runnable.map((e) => ruleFor(e, titles[e.name]))],
    scripts: clone(diagnosis.scripts),
    read: clone(diagnosis.read),
    limits: { ...INTERVENTION_LIMITS }
  }
}

/** The catalog commands the model never runs: it hands them to the operator. */
export function interactiveCommands(catalogText) {
  return parseCatalog(catalogText).filter((e) => e.interactive)
}
