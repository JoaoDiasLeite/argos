/**
 * The handover of one ops run: the operator's own incident file (`INC-…md`), in European
 * Portuguese, built from the run's ledger lines and nothing else. It mirrors the files
 * the operator writes by hand after a diagnosis: a field table, the resumo, the timeline,
 * the root cause, what was ruled out, other findings, recommended actions, open points
 * and the commands that ran. The prose comes from the model's `note` calls (summary,
 * hypotheses, findings, events, actions); the commands section is generated from the
 * calls and the operator asks, exactly as the ledger has them.
 *
 * Unlike the client report it is not sanitised: it stays with us, commands and all.
 */

import type { OpsCallSummary, OpsRunSummary } from './ops-audit-pure'
import { runHostIds } from './ops-audit-pure'
import { canonicalCommand } from './ops-gate-pure'
import type { ClientReportOptions } from './ops-report-pure'
import type { OpsAuditLine, OpsNote } from './ops-types'

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD in Lisbon time: the day the operator lived the run on. */
export function lisbonDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(new Date(iso))
  const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Text on one line, for bullets and headings. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A table cell: one line, and a pipe cannot open a new column. */
const cell = (text: string): string => oneLine(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

/** A comment inside a fenced block: one line, so it cannot run into the next command. */
const comment = (text: string): string => `# ${oneLine(text)}`

/** A fence longer than any backtick run inside, so a command cannot close it early. */
function fence(body: string, lang = ''): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${body.replace(/\n$/, '')}\n${ticks}`
}

/** Inline code that survives a backtick inside. */
function code(text: string): string {
  const t = oneLine(text)
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(longest + 1)
  return longest ? `${ticks} ${t} ${ticks}` : `${ticks}${t}${ticks}`
}

/** `text (evidência: …)`, the evidence only when there is one. */
const withEvidence = (text: string, evidence?: string): string =>
  evidence && evidence.trim() ? `${oneLine(text)} (evidência: ${oneLine(evidence)})` : oneLine(text)

// ─── File name ────────────────────────────────────────────────────────────────────

/** ASCII kebab-case: accents stripped, anything else a dash. */
export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** How many words of the task name the file. */
const THEME_WORDS = 6

/**
 * `INC-<YYYY-MM-DD>-<cliente>-<tema>.md`, like the operator's own files. The theme is the
 * task's first words, or the runbook's name without a task; an empty part is left out.
 * The caller adds `-2`, `-3`… when the name is taken.
 */
export function handoverFileName(s: { startedAt: string; client?: string; task?: string; runbook: string }): string {
  const theme = slug((s.task ?? '').trim().split(/\s+/).slice(0, THEME_WORDS).join(' ')) || slug(s.runbook)
  const parts = ['INC', lisbonDate(s.startedAt), slug(s.client ?? ''), theme].filter((p) => p !== '')
  return `${parts.join('-')}.md`
}

// ─── Folding the notes ─────────────────────────────────────────────────────────────

interface Hypothesis {
  id: string
  text: string
  status: NonNullable<OpsNote['status']>
  evidence?: string
}

interface OperatorAsk {
  askId: string
  cmd: string
  why: string
  host?: string
  answered?: { output?: string; declined?: true }
}

interface Folded {
  summary?: string
  /** First-seen order; the latest note of each id gives its text, status and evidence. */
  hypotheses: Hypothesis[]
  findings: OpsNote[]
  events: OpsNote[]
  actions: OpsNote[]
  asks: OperatorAsk[]
}

function fold(lines: OpsAuditLine[], runId: string): Folded {
  const f: Folded = { hypotheses: [], findings: [], events: [], actions: [], asks: [] }
  const byId = new Map<string, Hypothesis>()
  const asks = new Map<string, OperatorAsk>()
  for (const { event: e } of lines) {
    if (e.runId !== runId) continue
    if (e.kind === 'note') {
      const n = e.note
      if (n.kind === 'summary') f.summary = n.text
      else if (n.kind === 'finding') f.findings.push(n)
      else if (n.kind === 'event') f.events.push(n)
      else if (n.kind === 'action') f.actions.push(n)
      else if (n.kind === 'hypothesis' && n.id) {
        const next: Hypothesis = { id: n.id, text: n.text, status: n.status ?? 'open', ...(n.evidence ? { evidence: n.evidence } : {}) }
        const prev = byId.get(n.id)
        if (prev) Object.assign(prev, next, n.evidence ? {} : { evidence: prev.evidence })
        else {
          byId.set(n.id, next)
          f.hypotheses.push(next)
        }
      }
    } else if (e.kind === 'operator.asked') {
      const a: OperatorAsk = { askId: e.askId, cmd: e.cmd, why: e.why, ...(e.host ? { host: e.host } : {}) }
      asks.set(e.askId, a)
      f.asks.push(a)
    } else if (e.kind === 'operator.answered') {
      const a = asks.get(e.askId)
      if (a) a.answered = e.declined ? { declined: true } : { output: e.output ?? '' }
    }
  }
  return f
}

// ─── Commands ─────────────────────────────────────────────────────────────────────

/** Went to the host: neither the gate nor the operator stopped it, and it started or finished. */
function ran(c: OpsCallSummary): boolean {
  if (c.decision === 'deny' || c.answer === 'deny' || c.answer === 'stop') return false
  return c.startedAt !== undefined || c.exitCode !== undefined
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [])

/** One call as a line of shell: the canonical command, or a comment for a file tool. */
function callLine(c: OpsCallSummary): string {
  const raw = (c.rawInput && typeof c.rawInput === 'object' ? c.rawInput : {}) as Record<string, unknown>
  const p = c.path ?? (typeof raw.path === 'string' ? raw.path : '')
  switch (c.tool) {
    case 'run':
      if (c.argv && c.argv.length) return canonicalCommand(c.argv)
      return typeof raw.cmd === 'string' ? oneLine(raw.cmd) : '# (comando não registado)'
    case 'script':
      return canonicalCommand([typeof raw.name === 'string' ? raw.name : 'script', ...strings(raw.args)])
    case 'read':
      return comment(`ler ${p}`)
    case 'list':
      return comment(`listar ${p}`)
    case 'write':
      return comment(`escrever ${p}`)
  }
}

/** The trailing comment of a call that did not end with exit 0; empty when it did. */
function exitNote(c: OpsCallSummary): string {
  if (c.timedOut) return '  # timeout'
  if (c.exitCode === undefined) return '  # sem fim registado'
  if (c.exitCode === null) return '  # morto, sem código de saída'
  return c.exitCode === 0 ? '' : `  # exit ${c.exitCode}`
}

function commandsSection(s: OpsRunSummary, f: Folded, hostName: (id: string, fallback: string) => string): string[] {
  const out: string[] = ['## Comandos executados', '']
  const done = s.calls.filter(ran)
  const denied = s.calls.filter((c) => c.decision === 'deny')
  const byOperator = f.asks.filter((a) => a.answered && !a.answered.declined)
  if (!done.length && !denied.length && !byOperator.length) return [...out, '_Nenhum comando executado._', '']

  if (done.length) {
    const readOnly = done.every((c) => c.class === 'read')
    out.push(readOnly ? '### Pelo Argos (só leitura)' : '### Pelo Argos', '')
    // Several hosts: each run of calls on one host under that host's name.
    const many = new Set(done.map((c) => c.hostId)).size > 1
    const body: string[] = []
    let last: string | undefined
    for (const c of done) {
      if (many && c.hostId !== last) {
        if (body.length) body.push('')
        body.push(comment(hostName(c.hostId, c.host)))
        last = c.hostId
      }
      body.push(callLine(c) + exitNote(c))
    }
    out.push(fence(body.join('\n'), 'bash'), '')
  }

  if (denied.length) {
    out.push('### Recusados pela policy', '')
    out.push(fence(denied.map((c) => `${callLine(c)}  ${comment(c.reason)}`).join('\n'), 'bash'), '')
  }

  if (byOperator.length) {
    out.push('### Corridos por ti', '')
    const body = byOperator.map((a) => `${comment(a.why)}\n${a.cmd.replace(/\r\n/g, '\n')}`)
    out.push(fence(body.join('\n\n'), 'bash'), '')
  }
  return out
}

// ─── Handover ─────────────────────────────────────────────────────────────────────

/**
 * The handover markdown. `lines` are the run's ledger lines (others are ignored); `opts`
 * are the client report's host options, used here only to name a host the run's start
 * did not list. Deterministic: the same lines always give the same text.
 */
export function renderHandover(summary: OpsRunSummary, lines: OpsAuditLine[], opts?: ClientReportOptions): string {
  const s = summary
  const f = fold(lines, s.runId)
  const known = [...s.hosts, ...(opts?.hosts ?? [])]
  const hostName = (id: string, fallback: string): string => known.find((h) => h.id === id)?.name || fallback || id

  const task = s.task ? oneLine(s.task).replace(/[.\s]+$/, '') : ''
  const client = s.client ? oneLine(s.client) : ''
  const title = task || s.runbook.name
  const out: string[] = [`# Incidente: ${title}${client ? ` (${client})` : ''}`, '']

  const servers = runHostIds(s).map((id) => {
    const h = known.find((x) => x.id === id)
    const name = h?.name || s.calls.find((c) => c.hostId === id)?.host || id
    return h?.host && h.host !== name ? `${code(name)}: ${h.host}` : code(name)
  })
  const open = f.hypotheses.some((h) => h.status === 'open')
  const rows: [string, string][] = [['Data do despiste', lisbonDate(s.startedAt)]]
  if (client) rows.push(['Cliente', client])
  rows.push([servers.length > 1 ? 'Servidores' : 'Servidor', servers.length ? servers.join('; ') : 'Nenhum'])
  if (s.ticket && oneLine(s.ticket)) rows.push(['Ticket', oneLine(s.ticket)])
  rows.push(['Runbook', s.runbook.name])
  rows.push(['Execução', code(s.runId)])
  rows.push(['Estado', open || s.ok !== true ? 'Em aberto' : 'Por fechar'])
  out.push('| Campo | Valor |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), '')

  // The other half of a handover to a runbook intervention, either way round.
  if (s.parentRunId) out.push(`Na sequência do despiste ${code(s.parentRunId)}.`, '')
  if (s.handover) {
    const child = s.handover.childRunId ? ` (execução ${code(s.handover.childRunId)})` : ''
    out.push(`Seguimento: intervenção ${s.handover.runbook}${child}.`, '')
  }

  out.push('## Resumo', '', f.summary ? f.summary.trim() : '_Por preencher._', '')

  if (f.events.length) {
    out.push('## Linha temporal', '', '| Quando | O quê | Evidência |', '|---|---|---|')
    for (const e of f.events) out.push(`| ${cell(e.at ?? '')} | ${cell(e.text)} | ${cell(e.evidence ?? '')} |`)
    out.push('')
  }

  const confirmed = f.hypotheses.filter((h) => h.status === 'confirmed')
  out.push('## Causa raiz', '')
  if (confirmed.length) out.push(...confirmed.map((h) => `- ${withEvidence(h.text, h.evidence)}`))
  else out.push('_Por confirmar._')
  out.push('')

  const ruledOut = f.hypotheses.filter((h) => h.status === 'ruled_out')
  if (ruledOut.length) {
    out.push('## O que foi descartado', '', '| Hipótese | Porque foi descartada |', '|---|---|')
    for (const h of ruledOut) out.push(`| ${cell(h.text)} | ${cell(h.evidence ?? '')} |`)
    out.push('')
  }

  if (f.findings.length) {
    out.push('## Outros achados', '', ...f.findings.map((n) => `- ${withEvidence(n.text, n.evidence)}`), '')
  }

  if (f.actions.length) {
    out.push('## Ações recomendadas', '')
    const now = f.actions.filter((a) => a.when !== 'later')
    const later = f.actions.filter((a) => a.when === 'later')
    if (now.length) out.push('**Já:**', '', ...now.map((a) => `- [ ] ${withEvidence(a.text, a.evidence)}`), '')
    if (later.length) out.push('**Depois:**', '', ...later.map((a) => `- [ ] ${withEvidence(a.text, a.evidence)}`), '')
  }

  // An ask with no answer at all (the ledger lost it) counts as not run.
  const notRun = f.asks.filter((a) => !a.answered || a.answered.declined)
  const openPoints = [
    ...f.hypotheses.filter((h) => h.status === 'open').map((h) => withEvidence(h.text, h.evidence)),
    ...notRun.map((a) => `Não corrido: ${code(a.cmd)} (${oneLine(a.why)})`)
  ]
  if (openPoints.length) out.push('## Pontos em aberto', '', ...openPoints.map((p) => `- ${p}`), '')

  out.push(...commandsSection(s, f, hostName))
  return out.join('\n').replace(/\n+$/, '') + '\n'
}
