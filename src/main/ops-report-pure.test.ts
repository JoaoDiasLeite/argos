import { describe, it, expect } from 'vitest'
import {
  clientReportWarnings,
  renderClientReport,
  renderInternalReport,
  sanitizeForClient,
  type ClientReportOptions
} from './ops-report-pure'
import type { OpsCallSummary, OpsRunSummary } from './ops-audit-pure'

const HOSTS = [
  { id: 'h1', name: 'web-1', host: '10.20.0.11' },
  { id: 'h2', name: 'pg-main', host: 'pg-main.internal.example' },
  { id: 'h3', name: 'mail-1', host: '192.168.1.9' }
]

const OPTS: ClientReportOptions = {
  hostGroups: { web: ['web-*'], db: ['pg-main'] },
  hosts: HOSTS
}

function call(over: Partial<OpsCallSummary> & { callId: string }): OpsCallSummary {
  return {
    tool: 'run',
    hostId: 'h1',
    host: 'web-1',
    class: 'read',
    decision: 'allow',
    reason: 'matched allow[0]',
    rawInput: null,
    exitCode: 0,
    timedOut: false,
    durationMs: 800,
    stdoutHead: '',
    stderrHead: '',
    ...over
  }
}

const READ_WEB = call({
  callId: 'c1',
  title: 'A verificação do estado do serviço em web-1',
  rule: '^systemctl status tomcat9$',
  argv: ['systemctl', 'status', 'tomcat9'],
  rawInput: { tool: 'run', hostId: 'h1', cmd: 'systemctl status tomcat9' },
  stdoutHead: 'tomcat9.service Apache Tomcat\nActive: active (running)'
})
const READ_DB = call({
  callId: 'c2',
  hostId: 'h2',
  host: 'pg-main',
  title: 'A verificação da disponibilidade da base de dados',
  rule: '^pg_isready -h localhost$',
  argv: ['pg_isready', '-h', 'localhost'],
  stdoutHead: 'localhost:5432 - accepting connections'
})
const SUDO_RESTART = call({
  callId: 'c3',
  class: 'mutate',
  decision: 'ask',
  answer: 'allow',
  title: 'O reinício controlado do serviço',
  rule: '^sudo systemctl restart tomcat9$',
  argv: ['sudo', 'systemctl', 'restart', 'tomcat9'],
  durationMs: 4100
})

function run(calls: OpsCallSummary[], over: Partial<OpsRunSummary> = {}): OpsRunSummary {
  return {
    runId: 'run-42',
    startedAt: '2026-03-05T10:00:00.000Z',
    endedAt: '2026-03-05T10:07:00.000Z',
    runbook: {
      name: 'verificar-e-reiniciar-servico',
      path: '/repo/runbooks/verificar-e-reiniciar-servico',
      policySha256: 'a'.repeat(64),
      runbookMdSha256: 'b'.repeat(64),
      platform: '*Acme Portal*'
    },
    hosts: [HOSTS[0], HOSTS[1]],
    model: 'claude-opus',
    planText: '1. check web\n2. check db\n3. restart',
    planDecision: 'approved',
    calls,
    ok: true,
    costUsd: 0.4321,
    ...over
  }
}

const GOLDEN = run([READ_WEB, READ_DB, SUDO_RESTART])

/** Golden plus a denied path read, a failed run and a timed-out run. */
const MESSY = run([
  READ_WEB,
  call({
    callId: 'd1',
    tool: 'read',
    decision: 'deny',
    reason: 'path outside read.paths',
    title: 'A leitura da configuração',
    path: '/etc/tomcat9/server.xml',
    rawInput: { tool: 'read', hostId: 'h1', path: '/etc/tomcat9/server.xml' },
    exitCode: undefined
  }),
  call({
    callId: 'f1',
    class: 'mutate',
    title: 'A limpeza da cache',
    argv: ['/opt/scripts/purge-cache.sh', '--all'],
    rawInput: { tool: 'script', hostId: 'h1', name: 'purge-cache.sh', args: ['--all'] },
    exitCode: 2,
    stderrHead: 'purge failed: permission denied on /var/cache/tomcat9'
  }),
  call({ callId: 't1', title: 'A recolha de métricas', argv: ['vmstat', '5', '10'], exitCode: null, timedOut: true }),
  SUDO_RESTART
])

describe('renderClientReport', () => {
  it('renders the golden fixture', () => {
    expect(renderClientReport(GOLDEN, OPTS)).toBe(
      [
        '## Assunto',
        '',
        'Intervenção técnica: Verificar e reiniciar servico',
        '',
        '## Descrição',
        '',
        'Foi efetuada uma intervenção técnica no [servidor de aplicações] e no [servidor de base de dados], em 05-03-2026. A intervenção incidiu sobre a plataforma *Acme Portal*.',
        '',
        '- A verificação do estado do serviço em [servidor de aplicações].',
        '- A verificação da disponibilidade da base de dados.',
        '- O reinício controlado do serviço.',
        '',
        '## Motivo',
        '',
        'Intervenção planeada, executada na janela acordada com a entidade.',
        '',
        'Data da intervenção: 05-03-2026.',
        ''
      ].join('\n')
    )
  })

  it('has exactly the three headings, and no greeting or sign-off', () => {
    for (const s of [GOLDEN, MESSY]) {
      const out = renderClientReport(s, OPTS)
      expect(out.split('\n').filter((l) => l.startsWith('#'))).toEqual([
        '## Assunto',
        '## Descrição',
        '## Motivo'
      ])
      expect(out).not.toMatch(/cumprimentos|caro|exmo|olá|você/i)
      expect(out.trimEnd().split('\n').pop()).toMatch(/^Data da intervenção: \d{2}-\d{2}-\d{4}\.$/)
    }
  })

  it('never writes an em or en dash, even when a title has one', () => {
    const s = run([call({ callId: 'x', title: 'A verificação — rápida – do serviço' })], {
      runbook: { ...GOLDEN.runbook, name: 'teste—um' }
    })
    for (const r of [GOLDEN, MESSY, s]) expect(renderClientReport(r, OPTS)).not.toMatch(/[–—]/)
  })

  it('leaves nothing executable: no argv word, path, script name, rule or output', () => {
    for (const s of [GOLDEN, MESSY]) {
      const out = renderClientReport(s, OPTS).toLowerCase()
      const forbidden = new Set<string>()
      for (const c of s.calls) {
        for (const w of c.argv ?? []) if (w.length >= 3) forbidden.add(w)
        if (c.path) forbidden.add(c.path)
        if (c.rule) forbidden.add(c.rule)
        for (const head of [c.stdoutHead, c.stderrHead])
          for (const tok of (head ?? '').split(/\s+/)) if (tok.length >= 3) forbidden.add(tok)
      }
      forbidden.add('purge-cache.sh')
      for (const f of forbidden) expect(out, f).not.toContain(f.toLowerCase())
    }
  })

  it('replaces every address and stored host name with a role', () => {
    const s = run(
      [
        call({ callId: 'a', title: 'A verificação de 10.20.0.11, pg-main.internal.example e fe80::1ff:fe23:4567:890a' }),
        call({ callId: 'b', title: 'O teste a 172.16.4.4 e a MAIL-1' })
      ],
      { hosts: HOSTS }
    )
    const out = renderClientReport(s, OPTS)
    expect(out).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
    expect(out).not.toMatch(/[0-9a-f]*:[0-9a-f]*:[0-9a-f]*/i)
    for (const h of HOSTS) {
      expect(out.toLowerCase()).not.toContain(h.name.toLowerCase())
      expect(out.toLowerCase()).not.toContain(h.host.toLowerCase())
    }
    expect(out).toContain('[servidor de base de dados]')
    expect(out).toContain('no [servidor de aplicações], no [servidor de base de dados] e no [servidor]')
  })

  it('lists only concluded calls as steps and says the rest were not concluded', () => {
    const out = renderClientReport(MESSY, OPTS)
    const steps = out.split('\n').filter((l) => l.startsWith('- '))
    expect(steps).toEqual([
      '- A verificação do estado do serviço em [servidor de aplicações].',
      '- O reinício controlado do serviço.'
    ])
    expect(out).toContain('Uma ou mais operações não foram concluídas nesta janela.')
    expect(renderClientReport(GOLDEN, OPTS)).not.toContain('não foram concluídas')
  })

  it('says all-read runs changed nothing', () => {
    const out = renderClientReport(run([READ_WEB, READ_DB]), OPTS)
    expect(out).toContain('Diagnóstico e verificação do estado do serviço, sem alterações à configuração.')
    expect(out).not.toContain('Intervenção planeada')
  })

  it('a denied mutate does not make the run a change', () => {
    const denied = { ...SUDO_RESTART, decision: 'deny' as const, answer: undefined }
    expect(renderClientReport(run([READ_WEB, denied]), OPTS)).toContain('sem alterações à configuração')
  })

  it('renders an untitled step as an unnamed technical operation', () => {
    const out = renderClientReport(run([call({ callId: 'n', title: undefined })]), OPTS)
    expect(out).toContain('- Operação técnica.')
  })

  it('names the platform as the runbook spells it, and none when the runbook does not say', () => {
    const cases: [string | undefined, string | null][] = [
      ['*Acme Portal*', '*Acme Portal*'],
      ['acmeForms', 'acmeForms'],
      [undefined, null]
    ]
    for (const [platform, name] of cases) {
      const s = run([READ_WEB], { runbook: { ...GOLDEN.runbook, platform } })
      const out = renderClientReport(s, OPTS)
      if (name) expect(out).toContain(`A intervenção incidiu sobre a plataforma ${name}.`)
      else expect(out).not.toContain('plataforma')
    }
  })

  it('dates the intervention on the Lisbon calendar, as DD-MM-AAAA', () => {
    // 23:30 UTC in July is 00:30 the next day in Lisbon.
    const s = run([READ_WEB], { startedAt: '2026-07-05T23:30:00.000Z', endedAt: '2026-07-05T23:40:00.000Z' })
    const out = renderClientReport(s, OPTS)
    expect(out).toContain('em 06-07-2026.')
    expect(out).toContain('Data da intervenção: 06-07-2026.')
  })

  it('a run with no calls says nothing was executed', () => {
    expect(renderClientReport(run([]), OPTS)).toContain('Não foi executada nenhuma operação nesta janela.')
  })
})

describe('sanitizeForClient', () => {
  const base = { ...OPTS, argv: [] as string[][], paths: [] as string[] }

  it('maps hosts to roles by group, longest name first', () => {
    const opts = {
      ...base,
      hosts: [...HOSTS, { id: 'h4', name: 'web-10', host: '10.20.0.12' }]
    }
    expect(sanitizeForClient('web-10 e web-1 e pg-main', opts)).toBe(
      '[servidor de aplicações] e [servidor de aplicações] e [servidor de base de dados]'
    )
    expect(sanitizeForClient('mail-1', opts)).toBe('[servidor]')
  })

  it('replaces IPv4 with and without CIDR, and IPv6, but keeps a time of day', () => {
    expect(sanitizeForClient('rede 10.1.2.0/24 e ::1 e 2001:db8::7 às 10:30:00', base)).toBe(
      'rede [servidor] e [servidor] e [servidor] às 10:30:00'
    )
  })

  it('removes the whole token around an executable word, keeping sentence punctuation', () => {
    const opts = { ...base, argv: [['nginx', '-t']], paths: ['/etc/hosts'] }
    expect(sanitizeForClient('Teste ao nginx.conf e a /etc/hosts.', opts)).toBe('Teste ao [omitido] e a [omitido].')
    // a two-letter argv word is too short to police without wrecking prose
    expect(sanitizeForClient('-t fica', opts)).toBe('-t fica')
  })

  it('cannot match an argv word inside a placeholder it already wrote', () => {
    const many = Array.from({ length: 150 }, (_, i) => `w${i}x`)
    const text = many.join(' ') + ' 100 servidor'
    const out = sanitizeForClient(text, { ...base, argv: [many, ['100', 'servidor']] })
    expect(out).toBe(Array(152).fill('[omitido]').join(' '))
  })
})

describe('clientReportWarnings', () => {
  it('lists concluded calls without a title, and nothing for a fully titled run', () => {
    expect(clientReportWarnings(GOLDEN)).toEqual([])
    const s = run([READ_WEB, call({ callId: 'n', title: undefined, rule: '^uptime$' }), call({ callId: 'd', title: undefined, decision: 'deny' })])
    const w = clientReportWarnings(s)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/^Call 2 \(run on web-1\) \(rule `\^uptime\$`\) has no step title/)
  })
})

describe('renderInternalReport', () => {
  it('carries everything: header, plan, each call, totals', () => {
    const out = renderInternalReport(MESSY)
    expect(out).toContain('# Ops run: verificar-e-reiniciar-servico')
    expect(out).toContain('- Run: `run-42`')
    expect(out).toContain('- Started: 2026-03-05T10:00:00.000Z')
    expect(out).toContain('- Ended: 2026-03-05T10:07:00.000Z')
    expect(out).toContain('- Model: claude-opus')
    expect(out).toContain('- Cost: $0.4321')
    expect(out).toContain('  - web-1 (10.20.0.11)')
    expect(out).toContain('  - pg-main (pg-main.internal.example)')
    expect(out).toContain('1. check web\n2. check db\n3. restart')
    expect(out).toContain('Plan decision: approved')
    expect(out).toContain('1. **run** on web-1 · read · allow')
    expect(out).toContain('2. **read** on web-1 · read · deny')
    expect(out).toContain('Path: `/etc/tomcat9/server.xml`')
    expect(out).toContain('```\n   systemctl status tomcat9\n   ```')
    expect(out).toContain('Status: exit 2, 800 ms')
    expect(out).toContain('Status: timed out')
    expect(out).toContain('5. **run** on web-1 · mutate · ask → allow')
    expect(out).toContain('purge failed: permission denied on /var/cache/tomcat9')
    expect(out).toContain(
      '**Totals:** 5 calls, 3 allowed, 1 asked (1 approved), 1 denied, 1 non-zero exits, 1 timed out.'
    )
    expect(out).not.toContain('Client report warnings')
  })

  it('lists the logged plan steps with their commands, ahead of the plan text', () => {
    const out = renderInternalReport(
      run([], {
        planSteps: [
          { title: 'check web', commands: ['systemctl status puma'], verdict: 'runs', hostName: 'web-1' },
          { title: 'restart', commands: ['sudo systemctl restart puma', 'systemctl is-active puma'], verdict: 'asks' }
        ]
      })
    )
    expect(out).toContain(
      '## Plan\n\n1. check web (web-1) – `systemctl status puma`\n2. restart – `sudo systemctl restart puma` · `systemctl is-active puma`\n'
    )
    expect(out).not.toContain('1. check web\n2. check db')
    expect(renderInternalReport(run([], { planText: undefined }))).toContain('_No plan recorded._')
  })

  it('flags untitled steps for the runbook author', () => {
    const out = renderInternalReport(run([call({ callId: 'n', title: undefined })]))
    expect(out).toContain('## Client report warnings')
    expect(out).toContain('Title: none (shown to the client as "operação técnica")')
  })

  it('fences output that itself contains backticks', () => {
    const out = renderInternalReport(run([call({ callId: 'b', stdoutHead: 'a ``` b' })]))
    expect(out).toContain('   ````\n   a ``` b\n   ````')
  })
})

describe('client report titles after the first VM run', () => {
  it('keeps argv words that appear in a title, and lists a repeated title once', () => {
    const s = run([
      call({ callId: 'a', title: 'Verificação da versão do nginx', argv: ['nginx', '-v'] }),
      call({ callId: 'b', title: 'Verificação do estado de um serviço', argv: ['systemctl', 'status', 'nginx'] }),
      call({ callId: 'c', title: 'Verificação do estado de um serviço', argv: ['systemctl', 'status', 'redis'] })
    ])
    const out = renderClientReport(s, OPTS)
    expect(out).toContain('- Verificação da versão do nginx.')
    expect(out.split('\n').filter((l) => l === '- Verificação do estado de um serviço.')).toHaveLength(1)
    expect(out).not.toContain('[omitido]')
    expect(out).not.toContain('Procedeu-se')
  })
})

describe('reports of an intervention (task, ticket, client, scope)', () => {
  const INTERVENTION = run([READ_WEB, SUDO_RESTART], {
    hosts: [HOSTS[0]],
    task: '  Reiniciar o tomcat9 no\nweb-1 após a renovação do certificado.  ',
    ticket: 'WM-1234',
    client: 'Câmara Municipal de Exemplo',
    scope: { kind: 'host', hostId: 'h1' }
  })

  it('the client Assunto is the sanitised task, and the header names client and ticket', () => {
    const out = renderClientReport(INTERVENTION, OPTS)
    const head = out.split('\n').slice(0, 7)
    expect(head).toEqual([
      '## Assunto',
      '',
      'Intervenção técnica: Reiniciar o [omitido] no [servidor de aplicações] após a renovação do certificado',
      '',
      '## Descrição',
      '',
      'Cliente: Câmara Municipal de Exemplo · Ticket: WM-1234'
    ])
    expect(out).toContain('\n\nFoi efetuada uma intervenção técnica no [servidor de aplicações], em 05-03-2026.')
  })

  it('the header carries only the parts present, and none when neither is', () => {
    const ticketOnly = renderClientReport(run([READ_WEB], { ticket: 'WM-9' }), OPTS)
    expect(ticketOnly).toContain('## Descrição\n\nTicket: WM-9\n\nFoi efetuada')
    const neither = renderClientReport(run([READ_WEB], { client: '  ' }), OPTS)
    expect(neither).toContain('## Descrição\n\nFoi efetuada')
    // No task: the runbook-name subject, as before interventions.
    expect(neither).toContain('Intervenção técnica: Verificar e reiniciar servico\n')
  })

  it('the internal report lists task, ticket, client and scope in its header', () => {
    const out = renderInternalReport(INTERVENTION)
    expect(out).toContain(
      [
        '- Run: `run-42`',
        '- Task: Reiniciar o tomcat9 no web-1 após a renovação do certificado.',
        '- Ticket: WM-1234',
        '- Client: Câmara Municipal de Exemplo',
        '- Scope: locked to web-1',
        '- Runbook:'
      ].join('\n')
    )
    const open = renderInternalReport(
      run([READ_WEB], {
        scope: { kind: 'open' },
        hostAnswers: [
          { hostId: 'h1', host: 'web-1', answer: 'approved' },
          { hostId: 'h2', host: 'pg-main', answer: 'denied' }
        ]
      })
    )
    expect(open).toContain('- Scope: open (any host the runbook allows); web-1 approved, pg-main denied\n')
    expect(renderInternalReport(GOLDEN)).not.toMatch(/- (Task|Ticket|Client|Scope):/)
  })
})
