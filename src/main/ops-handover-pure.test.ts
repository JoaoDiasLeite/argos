import { describe, it, expect } from 'vitest'
import { handoverFileName, lisbonDate, renderHandover, slug } from './ops-handover-pure'
import { summarizeRun } from './ops-audit-pure'
import type { OpsAuditEvent, OpsAuditLine, OpsNote } from './ops-types'

const RUN = 'run-1'
const HOSTS = [
  { id: 'h1', name: 'cmtvwiremaze', host: '192.168.0.38' },
  { id: 'h2', name: 'pg-main', host: '10.0.0.5' }
]

/** Ledger lines one minute apart from 2026-10-19 16:00Z (17:00 in Lisbon). */
function ledger(events: OpsAuditEvent[]): OpsAuditLine[] {
  const t0 = Date.parse('2026-10-19T16:00:00Z')
  return events.map((event, i) => ({ at: new Date(t0 + i * 60_000).toISOString(), prev: 'x', event }))
}

const start = (over: Partial<Extract<OpsAuditEvent, { kind: 'run.start' }>> = {}): OpsAuditEvent => ({
  kind: 'run.start',
  runId: RUN,
  appSessionId: 'term-1',
  runbook: { name: 'despiste', path: '/app/runbooks/despiste', policySha256: 'p', runbookMdSha256: 'r' },
  hosts: HOSTS,
  model: 'claude-opus-5-5',
  scope: { kind: 'host', hostId: 'h1' },
  ...over
})

const note = (n: OpsNote): OpsAuditEvent => ({ kind: 'note', runId: RUN, note: n })

function call(
  callId: string,
  over: { tool?: 'run' | 'script' | 'read' | 'list'; argv?: string[]; path?: string; rawInput?: unknown; cls?: 'read' | 'mutate'; decision?: 'allow' | 'deny'; reason?: string; exitCode?: number | null; hostId?: string }
): OpsAuditEvent[] {
  const decided: OpsAuditEvent = {
    kind: 'call.decided',
    runId: RUN,
    callId,
    tool: over.tool ?? 'run',
    hostId: over.hostId ?? 'h1',
    host: over.hostId === 'h2' ? 'pg-main' : 'cmtvwiremaze',
    rawInput: over.rawInput ?? null,
    ...(over.argv ? { argv: over.argv } : {}),
    ...(over.path ? { path: over.path } : {}),
    class: over.cls ?? 'read',
    decision: over.decision ?? 'allow',
    reason: over.reason ?? 'matched allow[0]'
  }
  if (over.decision === 'deny') return [decided]
  return [
    decided,
    { kind: 'call.started', runId: RUN, callId },
    {
      kind: 'call.finished',
      runId: RUN,
      callId,
      exitCode: over.exitCode === undefined ? 0 : over.exitCode,
      timedOut: false,
      durationMs: 10,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: '',
      stderrSha256: '',
      stdoutHead: '',
      stderrHead: ''
    }
  ]
}

function render(events: OpsAuditEvent[]): string {
  const lines = ledger(events)
  const s = summarizeRun(lines, RUN)
  if (!s) throw new Error('no run.start')
  return renderHandover(s, lines, { hostGroups: {}, hosts: HOSTS })
}

const FULL: OpsAuditEvent[] = [
  start({ task: 'Puma não arranca pelo monit.', client: 'CM Torres Vedras', ticket: 'WM-123' }),
  note({ kind: 'hypothesis', id: 'oom', text: 'Puma morto pelo OOM killer', status: 'open' }),
  note({ kind: 'hypothesis', id: 'tty', text: 'Bloqueio à espera de um TTY', status: 'open' }),
  note({ kind: 'hypothesis', id: 'disk', text: 'Disco cheio', status: 'open' }),
  ...call('c1', { argv: ['journalctl', '-b', '-t', 'monit'] }),
  ...call('c2', { tool: 'script', rawInput: { name: 'snapshot.sh', args: ['--short'] }, exitCode: 2 }),
  ...call('c3', { tool: 'read', path: '/etc/monit.d/puma.conf' }),
  ...call('c4', { tool: 'list', path: '/var/log' }),
  ...call('c5', { argv: ['rm', '-rf', '/tmp/x'], cls: 'mutate', decision: 'deny', reason: 'no allow rule matches' }),
  note({ kind: 'event', text: 'Reboot', at: '19 out 15:07', evidence: 'last -x' }),
  note({ kind: 'event', text: '3× timeout | unmonitor', at: '19 out 15:10' }),
  note({ kind: 'hypothesis', id: 'oom', text: 'Puma morto pelo OOM killer', status: 'ruled_out', evidence: 'RAM 1.4/15 GiB, sem OOM' }),
  note({ kind: 'hypothesis', id: 'tty', text: 'Bloqueio à espera de um TTY', status: 'confirmed', evidence: 'wchan=pipe_read' }),
  note({ kind: 'finding', text: 'Timeout do monit de 30s', evidence: 'puma.conf' }),
  note({ kind: 'summary', text: 'Primeiro resumo.' }),
  note({ kind: 'summary', text: 'O puma bloqueia no nginx.sh configure.\n\nSem TTY, o read fica à espera.' }),
  note({ kind: 'action', text: 'Reportar ao WMCP', when: 'now' }),
  note({ kind: 'action', text: 'Ativar journal persistente', when: 'later' }),
  { kind: 'operator.asked', runId: RUN, askId: 'a1', cmd: "sudo grep -h 'puma' /var/log/messages", why: 'histórico do monit', hostId: 'h1' },
  { kind: 'operator.answered', runId: RUN, askId: 'a1', output: 'Oct 17 ...' },
  { kind: 'operator.asked', runId: RUN, askId: 'a2', cmd: 'sudo cat /var/log/nginx/error.log', why: 'confirmar os 502' },
  { kind: 'operator.answered', runId: RUN, askId: 'a2', declined: true },
  { kind: 'run.end', runId: RUN, ok: true, costUsd: 0.1 }
]

describe('renderHandover', () => {
  it('renders every section from the notes, calls and operator asks', () => {
    const md = render(FULL)
    expect(md).toMatch(/^# Incidente: Puma não arranca pelo monit \(CM Torres Vedras\)\n\n\| Campo \| Valor \|\n\|---\|---\|\n/)
    expect(md).toContain('| Data do despiste | 2026-10-19 |')
    expect(md).toContain('| Cliente | CM Torres Vedras |')
    expect(md).toContain('| Servidor | `cmtvwiremaze`: 192.168.0.38 |')
    expect(md).toContain('| Ticket | WM-123 |')
    expect(md).toContain('| Runbook | despiste |')
    expect(md).toContain('| Execução | `run-1` |')
    // The disk hypothesis is still open.
    expect(md).toContain('| Estado | Em aberto |')
    expect(md).not.toContain('Responsável')

    expect(md).toContain('## Resumo\n\nO puma bloqueia no nginx.sh configure.\n\nSem TTY, o read fica à espera.\n')
    expect(md).not.toContain('Primeiro resumo')
    expect(md).toContain(
      '## Linha temporal\n\n| Quando | O quê | Evidência |\n|---|---|---|\n| 19 out 15:07 | Reboot | last -x |\n| 19 out 15:10 | 3× timeout \\| unmonitor |  |\n'
    )
    expect(md).toContain('## Causa raiz\n\n- Bloqueio à espera de um TTY (evidência: wchan=pipe_read)\n')
    expect(md).toContain(
      '## O que foi descartado\n\n| Hipótese | Porque foi descartada |\n|---|---|\n| Puma morto pelo OOM killer | RAM 1.4/15 GiB, sem OOM |\n'
    )
    expect(md).toContain('## Outros achados\n\n- Timeout do monit de 30s (evidência: puma.conf)\n')
    expect(md).toContain('## Ações recomendadas\n\n**Já:**\n\n- [ ] Reportar ao WMCP\n\n**Depois:**\n\n- [ ] Ativar journal persistente\n')
    expect(md).toContain('## Pontos em aberto\n\n- Disco cheio\n- Não corrido: `sudo cat /var/log/nginx/error.log` (confirmar os 502)\n')

    expect(md).toContain(
      '## Comandos executados\n\n### Pelo Argos (só leitura)\n\n```bash\n' +
        'journalctl -b -t monit\nsnapshot.sh --short  # exit 2\n# ler /etc/monit.d/puma.conf\n# listar /var/log\n```\n'
    )
    expect(md).toContain('### Recusados pela policy\n\n```bash\nrm -rf /tmp/x  # no allow rule matches\n```\n')
    expect(md).toContain("### Corridos por ti\n\n```bash\n# histórico do monit\nsudo grep -h 'puma' /var/log/messages\n```\n")
    // Sections in the INC files' order.
    const order = ['## Resumo', '## Linha temporal', '## Causa raiz', '## O que foi descartado', '## Outros achados', '## Ações recomendadas', '## Pontos em aberto', '## Comandos executados']
    expect(order.map((h) => md.indexOf(h))).toEqual([...order.map((h) => md.indexOf(h))].sort((a, b) => a - b))
    expect(md.endsWith('```\n')).toBe(true)
  })

  it('is deterministic', () => {
    expect(render(FULL)).toBe(render(FULL))
  })

  it('says "Por fechar" when nothing is open and the run ended ok, and drops "só leitura" after a change', () => {
    const md = render([
      start({ scope: { kind: 'open' } }),
      ...call('c1', { argv: ['systemctl', 'restart', 'puma'], cls: 'mutate' }),
      ...call('c2', { argv: ['pg_isready'], hostId: 'h2', exitCode: null }),
      note({ kind: 'hypothesis', id: 'x', text: 'X', status: 'confirmed' }),
      { kind: 'run.end', runId: RUN, ok: true, costUsd: 0 }
    ])
    expect(md).toContain('| Estado | Por fechar |')
    expect(md).toContain('| Servidores | `cmtvwiremaze`: 192.168.0.38; `pg-main`: 10.0.0.5 |')
    expect(md).toContain('### Pelo Argos\n\n```bash\n# cmtvwiremaze\nsystemctl restart puma\n\n# pg-main\npg_isready  # morto, sem código de saída\n```')
  })

  it('renders an empty run with only the fixed sections', () => {
    expect(render([start()])).toBe(
      [
        '# Incidente: despiste',
        '',
        '| Campo | Valor |',
        '|---|---|',
        '| Data do despiste | 2026-10-19 |',
        '| Servidor | `cmtvwiremaze`: 192.168.0.38 |',
        '| Runbook | despiste |',
        '| Execução | `run-1` |',
        '| Estado | Em aberto |',
        '',
        '## Resumo',
        '',
        '_Por preencher._',
        '',
        '## Causa raiz',
        '',
        '_Por confirmar._',
        '',
        '## Comandos executados',
        '',
        '_Nenhum comando executado._',
        ''
      ].join('\n')
    )
  })
})

describe('handover file name', () => {
  it('slugs the client and the first words of the task, accents stripped', () => {
    expect(slug('CM Torres Vedras')).toBe('cm-torres-vedras')
    expect(slug('  Ação: São João!  ')).toBe('acao-sao-joao')
    expect(
      handoverFileName({ startedAt: '2026-10-19T16:00:00Z', client: 'CM Torres Vedras', task: 'Puma não arranca pelo monit depois do reboot', runbook: 'despiste' })
    ).toBe('INC-2026-10-19-cm-torres-vedras-puma-nao-arranca-pelo-monit-depois.md')
  })

  it('falls back to the runbook name and leaves out empty parts', () => {
    expect(handoverFileName({ startedAt: '2026-10-19T16:00:00Z', runbook: 'despiste' })).toBe('INC-2026-10-19-despiste.md')
    expect(handoverFileName({ startedAt: '2026-10-19T16:00:00Z', client: '—', task: '   ', runbook: '' })).toBe('INC-2026-10-19.md')
  })

  it('dates by the Lisbon day', () => {
    expect(lisbonDate('2026-07-14T23:30:00Z')).toBe('2026-07-15')
    expect(lisbonDate('2026-12-14T23:30:00Z')).toBe('2026-12-14')
  })
})

describe('handover to a runbook intervention', () => {
  it('folds run.handover and run.start.parentRunId into the summary', () => {
    const lines = ledger([start(), { kind: 'run.handover', runId: RUN, childRunId: 'run-2', runbook: 'reload-wmcp' }])
    expect(summarizeRun(lines, RUN)?.handover).toEqual({ runbook: 'reload-wmcp', childRunId: 'run-2' })
    expect(summarizeRun(ledger([start({ parentRunId: 'run-0' })]), RUN)?.parentRunId).toBe('run-0')
    expect(summarizeRun(ledger([start()]), RUN)).not.toHaveProperty('handover')
  })

  it('the diagnosis handover names the intervention that followed it', () => {
    const out = render([
      start(),
      { kind: 'run.handover', runId: RUN, childRunId: 'run-2', runbook: 'reload-wmcp' },
      { kind: 'run.end', runId: RUN, ok: true, costUsd: 0 }
    ])
    expect(out).toContain('Seguimento: intervenção reload-wmcp (execução `run-2`).')
    expect(out.indexOf('Seguimento:')).toBeLessThan(out.indexOf('## Resumo'))
  })

  it('the intervention handover names the diagnosis it follows', () => {
    const out = render([start({ parentRunId: 'run-0', runbook: { name: 'reload-wmcp', path: '/rb/reload-wmcp', policySha256: 'p', runbookMdSha256: 'r' } })])
    expect(out).toContain('Na sequência do despiste `run-0`.')
    expect(render([start()])).not.toContain('Na sequência')
  })
})
