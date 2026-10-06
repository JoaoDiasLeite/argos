/**
 * Two renderings of one ops run (docs/OPS_AGENT_PLAN.md §5, §5.1).
 *
 * The internal report is for us: everything the ledger has, in English.
 *
 * The client report is the Relatório Técnico de Intervenção, the one artefact of the ops
 * agent that leaves the company. It is built from step titles only, in formal European
 * Portuguese, and every piece of text that came from the runbook or the ledger goes
 * through `sanitizeForClient` so no command, path, address or host name survives. The
 * fixed sentences are ours and are written to need no sanitising.
 */

import type { OpsCallSummary, OpsRunSummary } from './ops-audit-pure'
import type { OpsHostRef, OpsPolicy } from './ops-types'

// ─── Shared helpers ───────────────────────────────────────────────────────────────

/** Executed to completion: not denied, not refused at the prompt, exit 0, no timeout. */
/** The host as the operator knows it: its stored name, falling back to the address. */
function hostLabel(summary: OpsRunSummary, c: OpsCallSummary): string {
  return summary.hosts.find((h) => h.id === c.hostId)?.name || c.host || c.hostId || 'unknown host'
}

function concluded(c: OpsCallSummary): boolean {
  if (c.decision === 'deny') return false
  if (c.answer === 'deny' || c.answer === 'stop') return false
  if (c.timedOut) return false
  return c.exitCode === 0
}

/** Went to the host (or was meant to): what decides whether the run changed anything. */
function attempted(c: OpsCallSummary): boolean {
  return c.decision !== 'deny' && c.answer !== 'deny' && c.answer !== 'stop'
}

/** A fence longer than any backtick run inside, so stdout cannot close it early. */
function fence(body: string, lang = ''): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${body.replace(/\n$/, '')}\n${ticks}`
}

/** Shell-ish quoting for display only; nothing executes this string. */
function argvLine(argv: string[]): string {
  return argv.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')
}

// ─── Internal report ──────────────────────────────────────────────────────────────

/**
 * Calls the client report can only describe as "operação técnica", because the rule that
 * let them through has no `title`. Only calls that would appear as client steps are
 * listed: a denied or failed call is not described step by step, so its title is moot.
 */
export function clientReportWarnings(summary: OpsRunSummary): string[] {
  const out: string[] = []
  summary.calls.forEach((c, i) => {
    if (!concluded(c) || (c.title && c.title.trim())) return
    const rule = c.rule ? ` (rule \`${c.rule}\`)` : ''
    out.push(
      `Call ${i + 1} (${c.tool} on ${hostLabel(summary, c)})${rule} has no step title; ` +
        'the client report shows it as "operação técnica". Add a `title` to the rule in policy.json.'
    )
  })
  return out
}

/** Hosts that kept no syslog trace of what ran on them: the ledger is their only record. */
export function hostSyslogWarnings(summary: OpsRunSummary): string[] {
  return (summary.syslogUnavailable ?? []).map(
    (w) => `${w.host} has no syslog record of this run's commands (${w.reason}); the ledger is the only record there.`
  )
}

/** Operator-typed text on one line, so a newline cannot break the report's structure. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function scopeLine(s: OpsRunSummary): string {
  if (!s.scope) return 'not recorded'
  if (s.scope.kind === 'host') {
    const id = s.scope.hostId
    const name = s.hosts.find((h) => h.id === id)?.name ?? id
    return `locked to ${name}`
  }
  const answers = (s.hostAnswers ?? []).map((a) => `${a.host} ${a.answer}`)
  return `open (any host the runbook allows)${answers.length ? `; ${answers.join(', ')}` : ''}`
}

function callStatus(c: OpsCallSummary): string {
  if (c.decision === 'deny') return 'not run (denied)'
  if (c.answer === 'deny') return 'not run (refused at the prompt)'
  if (c.answer === 'stop') return 'not run (run stopped at the prompt)'
  if (c.timedOut) return 'timed out'
  if (c.exitCode === undefined) return 'no finish recorded'
  if (c.exitCode === null) return 'killed (no exit code)'
  return `exit ${c.exitCode}`
}

export function renderInternalReport(summary: OpsRunSummary): string {
  const s = summary
  const out: string[] = []
  out.push(`# Ops run: ${s.runbook.name}`, '')
  out.push(`- Run: \`${s.runId}\``)
  if (s.task) out.push(`- Task: ${oneLine(s.task)}`)
  if (s.ticket) out.push(`- Ticket: ${oneLine(s.ticket)}`)
  if (s.client) out.push(`- Client: ${oneLine(s.client)}`)
  if (s.scope) out.push(`- Scope: ${scopeLine(s)}`)
  out.push(`- Runbook: \`${s.runbook.path}\` (policy sha256 \`${s.runbook.policySha256}\`)`)
  if (s.runbook.platform) out.push(`- Platform: ${s.runbook.platform}`)
  out.push(`- Started: ${s.startedAt}`)
  out.push(`- Ended: ${s.endedAt ?? 'not recorded'}`)
  out.push(`- Model: ${s.model}`)
  out.push(`- Cost: ${s.costUsd === undefined ? 'not recorded' : `$${s.costUsd.toFixed(4)}`}`)
  const outcome =
    s.ok === undefined ? 'unknown (no run.end)' : s.aborted ? 'aborted' : s.ok ? 'ok' : 'failed'
  out.push(`- Outcome: ${outcome}${s.error ? ` (${s.error})` : ''}`)
  out.push('- Hosts:')
  if (s.hosts.length === 0) out.push('  - none')
  for (const h of s.hosts) out.push(`  - ${h.name} (${h.host})`)
  out.push('')

  out.push('## Plan', '')
  if (s.planSteps && s.planSteps.length > 0) {
    s.planSteps.forEach((p, i) => {
      const cmds = p.commands.map((c) => `\`${c}\``).join(' · ')
      const host = p.hostName ? ` (${p.hostName})` : ''
      out.push(`${i + 1}. ${p.title}${host}${cmds ? ` – ${cmds}` : ''}${p.skipped ? ' (skipped)' : ''}`)
    })
  } else {
    out.push(s.planText && s.planText.trim() ? s.planText.trim() : '_No plan recorded._')
  }
  out.push('', `Plan decision: ${s.planDecision ?? 'not recorded'}`, '')

  out.push('## Calls', '')
  if (s.calls.length === 0) out.push('_No calls._', '')
  s.calls.forEach((c, i) => {
    const decision = c.answer ? `${c.decision} → ${c.answer}` : c.decision
    out.push(`${i + 1}. **${c.tool}** on ${hostLabel(summary, c)} · ${c.class} · ${decision}`)
    const pad = '   '
    const detail: string[] = []
    detail.push(`Reason: ${c.reason}`)
    if (c.title) detail.push(`Title: ${c.title}`)
    else detail.push('Title: none (shown to the client as "operação técnica")')
    if (c.rule) detail.push(`Rule: \`${c.rule}\``)
    if (c.path) detail.push(`Path: \`${c.path}\``)
    if (c.backup) detail.push(`Backup: \`${c.backup.backupPath}\``)
    const timing = c.durationMs !== undefined ? `, ${c.durationMs} ms` : ''
    detail.push(`Status: ${callStatus(c)}${timing}`)
    for (const d of detail) out.push(`${pad}${d}`)
    const blocks: [string, string | undefined][] = [
      ['argv', c.argv && c.argv.length ? argvLine(c.argv) : undefined],
      ['stdout', c.stdoutHead || undefined],
      ['stderr', c.stderrHead || undefined]
    ]
    for (const [label, body] of blocks) {
      if (body === undefined) continue
      out.push('', `${pad}${label}:`, '')
      for (const l of fence(body).split('\n')) out.push(l ? pad + l : '')
    }
    out.push('')
  })

  const n = s.calls
  const count = (f: (c: OpsCallSummary) => boolean): number => n.filter(f).length
  const asked = count((c) => c.decision === 'ask')
  const askedAllowed = count((c) => c.decision === 'ask' && c.answer === 'allow')
  out.push(
    `**Totals:** ${n.length} calls, ${count((c) => c.decision === 'allow')} allowed, ` +
      `${asked} asked (${askedAllowed} approved), ${count((c) => c.decision === 'deny')} denied, ` +
      `${count((c) => typeof c.exitCode === 'number' && c.exitCode !== 0)} non-zero exits, ` +
      `${count((c) => c.timedOut === true)} timed out.`
  )

  const syslog = hostSyslogWarnings(s)
  if (syslog.length) {
    out.push('', '## Host syslog warnings', '')
    for (const w of syslog) out.push(`- ${w}`)
  }

  const warnings = clientReportWarnings(s)
  if (warnings.length) {
    out.push('', '## Client report warnings', '')
    for (const w of warnings) out.push(`- ${w}`)
  }
  return out.join('\n') + '\n'
}

// ─── Client report ────────────────────────────────────────────────────────────────

export interface ClientReportOptions {
  /** Group name -> host names or globs, from the policy. */
  hostGroups: Record<string, string[]>
  /** Every stored host, so names and addresses are known. */
  hosts: OpsHostRef[]
}

const ROLE_DB = '[servidor de base de dados]'
const ROLE_APP = '[servidor de aplicações]'
const ROLE_ANY = '[servidor]'
const OMITTED = '[omitido]'

function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${src}$`, 'i')
}

/** The role a host plays, from the names of the policy groups it belongs to. */
function roleOf(hostName: string, groups: Record<string, string[]>): string {
  const names = Object.entries(groups)
    .filter(([, members]) => members.some((m) => globToRegExp(m).test(hostName)))
    .map(([g]) => g.toLowerCase())
  if (names.some((g) => g.includes('db'))) return ROLE_DB
  if (names.some((g) => g.includes('web') || g.includes('app'))) return ROLE_APP
  return ROLE_ANY
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g
/** Two or more colons between hex groups; a run of only digits needs `::` or five groups so a time like 10:30:00 survives. */
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%\w+)?(?:\/\d{1,3})?(?![\w:])/gi
function looksLikeIpv6(tok: string): boolean {
  if (tok.includes('::')) return true
  if (/[a-f]/i.test(tok)) return true
  return (tok.match(/:/g) ?? []).length >= 4
}

const DASHES = /[‐-―−]/g

/**
 * Make a piece of runbook- or ledger-derived text safe to hand to a client. Order:
 * host names and addresses first (they become roles, not "[omitido]"), then IP shapes,
 * then anything executable (argv words of 3+ chars, paths). Every replacement goes in as
 * a private-use sentinel and is restored at the end, so a later pass cannot match inside
 * a placeholder an earlier pass wrote. A match takes its whole token with it, so
 * `nginx.conf` does not survive as `[omitido].conf`.
 */
export function sanitizeForClient(
  text: string,
  opts: ClientReportOptions & { argv: string[][]; paths: string[] }
): string {
  const slots: string[] = []
  const put = (value: string): string => {
    slots.push(value)
    // The slot index is itself a private-use character, so an argv word such as `100`
    // cannot match inside a placeholder.
    return `${String.fromCharCode(0xe100 + slots.length - 1)}`
  }
  let t = text

  // 1. Stored host names and addresses, longest first so `web-10` is not eaten by `web-1`.
  const hostTerms: { term: string; role: string }[] = []
  for (const h of opts.hosts) {
    const role = roleOf(h.name, opts.hostGroups)
    for (const term of [h.name, h.host]) if (term && term.trim()) hostTerms.push({ term, role })
  }
  hostTerms.sort((a, b) => b.term.length - a.term.length)
  for (const { term, role } of hostTerms) {
    // Short names would match inside ordinary words; give those word boundaries.
    const re =
      term.length >= 3
        ? new RegExp(escapeRe(term), 'gi')
        : new RegExp(`(?<![\\w.-])${escapeRe(term)}(?![\\w-])`, 'gi')
    t = t.replace(re, () => put(role))
  }

  // 2. Any address left that is not a stored host.
  t = t.replace(IPV4, () => put(ROLE_ANY))
  t = t.replace(IPV6, (m) => (looksLikeIpv6(m) ? put(ROLE_ANY) : m))

  // 3. Anything executable: argv words and paths, as case-insensitive substrings.
  const exec = new Set<string>()
  for (const argv of opts.argv) for (const w of argv) if (w.length >= 3) exec.add(w.toLowerCase())
  for (const p of opts.paths) if (p.length >= 3) exec.add(p.toLowerCase())
  const terms = [...exec].sort((a, b) => b.length - a.length)
  const tokenChar = /[^\s,;()"'«»-]/
  for (const term of terms) {
    const re = new RegExp(escapeRe(term), 'i')
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const end = m.index + m[0].length
      let a = m.index
      let b = end
      while (a > 0 && tokenChar.test(t[a - 1])) a--
      while (b < t.length && tokenChar.test(t[b])) b++
      // Leave a sentence's closing punctuation in place.
      while (b > end && /[.:!?]/.test(t[b - 1])) b--
      t = t.slice(0, a) + put(OMITTED) + t.slice(b)
    }
  }

  t = t.replace(/([-])/g, (_, c: string) => slots[c.charCodeAt(0) - 0xe100])
  return t.replace(DASHES, '-')
}

const PRODUCT: Record<NonNullable<OpsPolicy['platform']>, string> = {
  cityfy: '*WireMaze Cityfy Platform*',
  wirerecruit: 'wireRecruit',
  wireforms: 'wireForms',
  wirechannel: 'wireChannel',
  wirefix: 'wireFix',
  wirepaper: 'wirePaper'
}

/**
 * DD-MM-AAAA in Lisbon time: the intervention happened on a Portuguese calendar day,
 * and a late-evening run in summer is already the next day in UTC.
 */
function ptDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(new Date(iso))
  const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}


function joinPt(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
}

/** Every executable word and path this run's ledger knows of, for the sanitiser. */
function executableTerms(summary: OpsRunSummary): { argv: string[][]; paths: string[] } {
  const argv: string[][] = []
  const paths: string[] = []
  for (const c of summary.calls) {
    if (c.argv) argv.push(c.argv)
    if (c.path) paths.push(c.path)
    if (c.backup) paths.push(c.backup.path, c.backup.backupPath)
    // What the model asked for, in case it differs from what the gate normalised.
    const raw = c.rawInput as Record<string, unknown> | null
    if (raw && typeof raw === 'object') {
      if (typeof raw.cmd === 'string') argv.push(raw.cmd.split(/\s+/))
      if (typeof raw.name === 'string') argv.push([raw.name])
      if (Array.isArray(raw.args)) argv.push(raw.args.filter((a): a is string => typeof a === 'string'))
      if (typeof raw.path === 'string') paths.push(raw.path)
    }
    if (c.rule) argv.push(c.rule.replace(/^\^|\$$/g, '').split(/\s+/))
  }
  return { argv, paths }
}

export function renderClientReport(summary: OpsRunSummary, opts: ClientReportOptions): string {
  const s = summary
  const clean = (text: string): string => sanitizeForClient(text, { ...opts, ...executableTerms(s) })

  // The operator's task is the subject when there is one; it is free text, so it goes
  // through the full sanitiser like anything else from the ledger.
  const task = s.task ? oneLine(s.task).replace(/[.\s]+$/, '') : ''
  const name = task || s.runbook.name.replace(/[-_]+/g, ' ').trim()
  const subject = clean(name ? name[0].toUpperCase() + name.slice(1) : 'Intervenção')

  const day = ptDate(s.startedAt)
  const endDay = s.endedAt ? ptDate(s.endedAt) : day
  const roles = [...new Set(s.hosts.map((h) => roleOf(h.name, opts.hostGroups)))]

  const desc: string[] = []
  let opening = 'Foi efetuada uma intervenção técnica'
  if (roles.length) opening += ` ${joinPt(roles.map((r) => `no ${r}`))}`
  opening += `, em ${day}.`
  desc.push(opening)
  const product = s.runbook.platform ? PRODUCT[s.runbook.platform] : undefined
  if (product) desc.push(`A intervenção incidiu sobre a plataforma ${product}.`)

  // Titles are the runbook author's client-facing words, so they are sanitised only for
  // host names and addresses, not for argv words: on the first real run "Verificação da
  // versão do nginx" came out as "versão do [omitido]" because `nginx` was an argv word.
  // Listed as plain noun phrases, not "Procedeu-se a <title>": the contraction (à / ao)
  // depends on the noun's gender, which a title does not declare. Repeated titles (the same
  // check on several services) are listed once.
  const titleClean = (text: string): string => sanitizeForClient(text, { ...opts, argv: [], paths: [] })
  const header = [
    ...(s.client && oneLine(s.client) ? [`Cliente: ${titleClean(oneLine(s.client))}`] : []),
    ...(s.ticket && oneLine(s.ticket) ? [`Ticket: ${titleClean(oneLine(s.ticket))}`] : [])
  ].join(' · ')
  const steps = s.calls.filter(concluded)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const c of steps) {
    const line = c.title && c.title.trim() ? titleClean(c.title.trim().replace(/[.\s]+$/, '')) + '.' : 'Operação técnica.'
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  const notConcluded = s.calls.some((c) => !concluded(c))
  if (s.calls.length === 0) lines.push('Não foi executada nenhuma operação nesta janela.')

  const mutated = s.calls.some((c) => attempted(c) && c.class === 'mutate')
  const motive = mutated
    ? 'Intervenção planeada, executada na janela acordada com a entidade.'
    : 'Diagnóstico e verificação do estado do serviço, sem alterações à configuração.'

  const out: string[] = []
  out.push('## Assunto', '', `Intervenção técnica: ${subject}`, '')
  out.push('## Descrição', '')
  if (header) out.push(header, '')
  out.push(desc.join(' '), '')
  if (lines.length) out.push(...lines.map((l) => `- ${l}`), '')
  if (notConcluded) out.push('Uma ou mais operações não foram concluídas nesta janela.', '')
  out.push('## Motivo', '', motive, '')
  out.push(`Data da intervenção: ${endDay === day ? day : `${day} a ${endDay}`}.`)
  return out.join('\n').replace(DASHES, '-') + '\n'
}
