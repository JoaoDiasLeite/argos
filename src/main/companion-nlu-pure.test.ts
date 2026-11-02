import { describe, it, expect } from 'vitest'
import { parseCapture, type ParseOptions } from './companion-nlu-pure'

// Monday 2 November 2026, 10:00 local — the reference time of the chrono-node spike.
const NOW = new Date(2026, 10, 2, 10, 0)

function parse(text: string, opts: Partial<ParseOptions> = {}): ReturnType<typeof parseCapture> {
  return parseCapture(text, { now: NOW, ...opts })
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local "YYYY-MM-DD HH:MM", so a failure reads as a date and not as epoch ms. */
function local(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "2026-11-03 14:00" for minute precision, "2026-11-03" for day precision. */
function when(text: string, opts: Partial<ParseOptions> = {}): string | null {
  const r = parse(text, opts)
  if (!r.when) return null
  const s = local(r.when.at)
  return r.when.precision === 'day' ? s.slice(0, 10) : s
}

describe('the 25 spike fixtures (docs/COMPANION_PLAN.md §5.1)', () => {
  it.each([
    ['ligar à câmara amanhã às 14h', '2026-11-03 14:00'],
    ['enviar relatório hoje às 17:30', '2026-11-02 17:30'],
    ['rever logs daqui a 20 minutos', '2026-11-02 10:20'],
    ['reiniciar puma daqui a 2 horas', '2026-11-02 12:00'],
    ['reunião sexta de manhã', '2026-11-06 09:00'],
    ['call com leiria sexta à tarde', '2026-11-06 14:00'],
    ['backup na sexta', '2026-11-06'],
    ['standup segunda que vem', '2026-11-09'],
    ['pagar fatura dia 12', '2026-11-12'],
    ['renovar certificado 12/11', '2026-11-12'],
    ['entregar proposta 12 de novembro', '2026-11-12'],
    ['almoço ao meio-dia', '2026-11-02 12:00'],
    ['ligar ao joão às 2 da tarde', '2026-11-02 14:00'],
    ['deploy às 14:30', '2026-11-02 14:30'],
    ['testar vpn amanhã 9h', '2026-11-03 09:00'],
    ['ver isto depois de amanhã', '2026-11-04'],
    ['preparar sprint na próxima semana', '2026-11-09'],
    ['tenho de fazer isto amanhã até às 14h', '2026-11-03 14:00'],
    ['quinta às 10h30 migração', '2026-11-05 10:30'],
    ['lembra-me em 15 minutos de beber água', '2026-11-02 10:15'],
    ['terça à noite atualizar runbook', '2026-11-03 20:00'],
    ['amanhã de manhã ver tickets', '2026-11-03 09:00'],
    ['14h30 reunião com cliente', '2026-11-02 14:30'],
    ['dia 5 às 16h formação', '2026-11-05 16:00'],
    ['call with team tomorrow at 2pm', '2026-11-03 14:00']
  ])('%s → %s', (text, expected) => {
    const r = parse(text)
    expect(r.intent).toBe('todo')
    expect(when(text)).toBe(expected)
    expect(r.confidence).toBe(1)
  })

  it.each([
    ['ligar à câmara amanhã às 14h', 'Ligar à câmara'],
    ['lembra-me em 15 minutos de beber água', 'Beber água'],
    ['tenho de fazer isto amanhã até às 14h', 'Fazer isto'],
    ['backup na sexta', 'Backup'],
    ['standup segunda que vem', 'Standup'],
    ['pagar fatura dia 12', 'Pagar fatura'],
    ['ligar ao joão às 2 da tarde', 'Ligar ao joão'],
    ['quinta às 10h30 migração', 'Migração'],
    ['terça à noite atualizar runbook', 'Atualizar runbook'],
    ['amanhã de manhã ver tickets', 'Ver tickets'],
    ['14h30 reunião com cliente', 'Reunião com cliente'],
    ['dia 5 às 16h formação', 'Formação'],
    ['preparar sprint na próxima semana', 'Preparar sprint'],
    ['call with team tomorrow at 2pm', 'Call with team']
  ])('titles "%s" as "%s"', (text, title) => {
    expect(parse(text).title).toBe(title)
  })

  it('reports the matched span over the date words', () => {
    const text = 'ligar à câmara amanhã às 14h'
    const r = parse(text)
    expect(r.matchedSpan).not.toBeNull()
    expect(text.slice(...r.matchedSpan!)).toBe('amanhã às 14h')
  })
})

describe('relative days and durations', () => {
  it.each([
    ['fazer isto hoje', '2026-11-02'],
    ['fazer isto amanha', '2026-11-03'],
    ['para a semana rever contrato', '2026-11-09'],
    ['semana que vem tratar disto', '2026-11-09'],
    ['daqui a 3 dias ver isto', '2026-11-05'],
    ['ver logs dentro de 10 minutos', '2026-11-02 10:10'],
    ['rever daqui a meia hora', '2026-11-02 10:30'],
    ['ligar em duas horas', '2026-11-02 12:00'],
    ['rever daqui a uma hora', '2026-11-02 11:00'],
    ['parar em cinco min', '2026-11-02 10:05'],
    ['ver isto daqui a 2h', '2026-11-02 12:00']
  ])('%s → %s', (text, expected) => {
    expect(when(text)).toBe(expected)
  })
})

describe('weekdays', () => {
  it('reads a bare weekday as the next one strictly after today', () => {
    // Today is Monday: "segunda" is next week's.
    expect(when('standup segunda')).toBe('2026-11-09')
    expect(when('ver isto na terça-feira')).toBe('2026-11-03')
    expect(when('ir ao domingo')).toBe('2026-11-08')
  })

  it('reads "que vem" / "próxima" as next calendar week', () => {
    expect(when('reunião na próxima sexta')).toBe('2026-11-13')
    expect(when('reunião sexta que vem')).toBe('2026-11-13')
    // On a Sunday, next week starts tomorrow.
    expect(when('standup segunda que vem', { now: new Date(2026, 10, 8, 10, 0) })).toBe('2026-11-09')
  })

  it('leaves "segunda vez" alone', () => {
    expect(parse('tentar pela segunda vez').when).toBeNull()
  })
})

describe('times', () => {
  it('reads a time with no date as today if still ahead, else tomorrow', () => {
    expect(when('deploy às 9h')).toBe('2026-11-03 09:00')
    expect(when('deploy às 10:00')).toBe('2026-11-03 10:00')
    expect(when('deploy às 10:01')).toBe('2026-11-02 10:01')
  })

  it('keeps an explicit today even when the time has passed', () => {
    expect(when('hoje às 9h ver isto')).toBe('2026-11-02 09:00')
  })

  it('reads a bare 1–7 as afternoon, with less confidence', () => {
    const r = parse('ligar às 2')
    expect(local(r.when!.at)).toBe('2026-11-02 14:00')
    expect(r.confidence).toBe(0.7)
    expect(parse('ligar às 9').confidence).toBe(1)
    expect(when('ligar às 9')).toBe('2026-11-03 09:00')
  })

  it('lets a day part settle a bare hour', () => {
    const morning = parse('amanhã de manhã às 7 correr')
    expect(local(morning.when!.at)).toBe('2026-11-03 07:00')
    expect(morning.confidence).toBe(1)
    expect(when('amanhã à noite às 9 jantar')).toBe('2026-11-03 21:00')
  })

  it('reads "da manhã" / "da noite" after the hour', () => {
    expect(when('amanhã às 9 da manhã')).toBe('2026-11-03 09:00')
    expect(when('sair às 8 da noite')).toBe('2026-11-02 20:00')
    expect(when('amanhã 9 da manhã')).toBe('2026-11-03 09:00')
  })

  it('reads midnight as the 00:00 that ends the day', () => {
    expect(when('backup à meia-noite')).toBe('2026-11-03 00:00')
    expect(when('backup amanhã à meia-noite')).toBe('2026-11-04 00:00')
  })

  it('reads the day parts', () => {
    expect(when('rever isto à tarde')).toBe('2026-11-02 14:00')
    expect(when('rever isto à noite')).toBe('2026-11-02 20:00')
    // 09:00 has passed, so "de manhã" with no day is tomorrow's.
    expect(when('rever isto de manhã')).toBe('2026-11-03 09:00')
    expect(when('rever isto de manhã', { morningHour: 11 })).toBe('2026-11-02 11:00')
  })

  it('does not take "as" as "às" before a bare number', () => {
    expect(parse('rever as 3 propostas').when).toBeNull()
  })
})

describe('dates', () => {
  it('rolls "dia N" both ways around today', () => {
    expect(when('dia 2 fechar mês')).toBe('2026-11-02')
    expect(when('dia 5 formação')).toBe('2026-11-05')
    expect(when('dia 1 fechar mês')).toBe('2026-12-01')
    // From the 20th, the 12th is next month's.
    expect(when('pagar fatura dia 12', { now: new Date(2026, 10, 20, 10, 0) })).toBe('2026-12-12')
    // November has no 31st; the next month with one is December.
    expect(when('dia 31 balanço')).toBe('2026-12-31')
  })

  it('reads dd/mm and month names, rolling a past one to next year', () => {
    expect(when('renovar 1/11')).toBe('2027-11-01')
    expect(when('renovar 3/1/2027')).toBe('2027-01-03')
    expect(when('entregar 3 de março')).toBe('2027-03-03')
    expect(when('entregar 12 novembro 2027')).toBe('2027-11-12')
    expect(when('no dia 24 de dezembro jantar')).toBe('2026-12-24')
    expect(when('submit on november 20th')).toBe('2026-11-20')
  })

  it('rejects impossible dates', () => {
    expect(parse('ver 31/11/2026').when).toBeNull()
    expect(parse('ver 12/13').when).toBeNull()
  })
})

describe('numbers that are not dates', () => {
  it.each([
    'estacionar a 20 metros',
    'ver o ticket #48213',
    'atualizar para a versão 2.9',
    'reiniciar 10 servidores',
    'abrir a porta 5432',
    'ping 10.0.0.5',
    'migrar 3 bases de dados em 2 servidores'
  ])('%s', (text) => {
    const r = parse(text)
    expect(r.when).toBeNull()
    expect(r.matchedSpan).toBeNull()
    expect(r.confidence).toBe(0)
    expect(r.remindAt).toEqual([])
    expect(r.title).toBe(text.charAt(0).toUpperCase() + text.slice(1))
  })
})

describe('remindAt (plan §5.3)', () => {
  it('reminds lead minutes before a timed item', () => {
    expect(parse('tenho de fazer isto amanhã até às 14h').remindAt.map(local)).toEqual(['2026-11-03 13:50'])
    expect(parse('deploy às 14:30', { leadMinutes: 30 }).remindAt.map(local)).toEqual(['2026-11-02 14:00'])
  })

  it('reminds at the time itself when the lead is already past', () => {
    expect(parse('ver isto daqui a 5 minutos').remindAt.map(local)).toEqual(['2026-11-02 10:05'])
  })

  it('reminds at exactly the time asked for an explicit reminder', () => {
    const r = parse('lembra-me em 15 minutos de beber água')
    expect(r.isExplicitReminder).toBe(true)
    expect(r.remindAt.map(local)).toEqual(['2026-11-02 10:15'])
    const at = parse('avisa-me às 16h de sair')
    expect(at.isExplicitReminder).toBe(true)
    expect(at.title).toBe('Sair')
    expect(at.remindAt.map(local)).toEqual(['2026-11-02 16:00'])
  })

  it('reminds a day-precision item at the morning hour, or not at all once past', () => {
    expect(parse('backup na sexta').remindAt.map(local)).toEqual(['2026-11-06 09:00'])
    expect(parse('backup na sexta', { morningHour: 8 }).remindAt.map(local)).toEqual(['2026-11-06 08:00'])
    expect(parse('fazer isto hoje').remindAt).toEqual([])
    expect(parse('fazer isto hoje', { now: new Date(2026, 10, 2, 7, 0) }).remindAt.map(local)).toEqual([
      '2026-11-02 09:00'
    ])
  })

  it('has nothing to remind without a date', () => {
    const r = parse('comprar café')
    expect(r.when).toBeNull()
    expect(r.remindAt).toEqual([])
    expect(r.isExplicitReminder).toBe(false)
  })
})

describe('intents', () => {
  it('files a leading "nota:" as a note, dates and all', () => {
    const r = parse('nota: o servidor de leiria reinicia amanhã às 3h')
    expect(r.intent).toBe('note')
    expect(r.title).toBe('O servidor de leiria reinicia amanhã às 3h')
    expect(r.when).toBeNull()
    expect(r.remindAt).toEqual([])
    expect(parse('Note: vpn password rotates monthly').intent).toBe('note')
    expect(parse('anota: cliente prefere email').title).toBe('Cliente prefere email')
  })

  it('reads a question as a query over the day it names', () => {
    const r = parse('o que tenho amanhã?')
    expect(r.intent).toBe('query')
    expect(r.remindAt).toEqual([])
    expect(local(r.queryRange!.from)).toBe('2026-11-03 00:00')
    expect(local(r.queryRange!.to)).toBe('2026-11-04 00:00')
  })

  it('defaults a query to today, and spans a week for "próxima semana"', () => {
    const today = parse('o que tenho')
    expect(today.intent).toBe('query')
    expect(local(today.queryRange!.from)).toBe('2026-11-02 00:00')
    expect(local(today.queryRange!.to)).toBe('2026-11-03 00:00')
    const week = parse('o que tenho na próxima semana?')
    expect(local(week.queryRange!.from)).toBe('2026-11-09 00:00')
    expect(local(week.queryRange!.to)).toBe('2026-11-16 00:00')
  })

  it('reads English queries', () => {
    const r = parse('what do I have tomorrow?')
    expect(r.intent).toBe('query')
    expect(local(r.queryRange!.from)).toBe('2026-11-03 00:00')
  })
})

describe('English', () => {
  it.each([
    ['send report today at 5pm', '2026-11-02 17:00'],
    ['deploy at 14:00', '2026-11-02 14:00'],
    ['check logs in 30 minutes', '2026-11-02 10:30'],
    ['check logs in half an hour', '2026-11-02 10:30'],
    ['backup on friday', '2026-11-06'],
    ['plan sprint next week', '2026-11-09'],
    ['call them tonight', '2026-11-02 20:00'],
    ['lunch at noon', '2026-11-02 12:00'],
    ['review tomorrow at 9:30am', '2026-11-03 09:30']
  ])('%s → %s', (text, expected) => {
    expect(when(text)).toBe(expected)
  })

  it('strips "remind me to" from the title', () => {
    const r = parse('remind me in 10 minutes to stretch')
    expect(r.isExplicitReminder).toBe(true)
    expect(r.title).toBe('Stretch')
    expect(r.remindAt.map(local)).toEqual(['2026-11-02 10:10'])
  })
})

describe('confidence', () => {
  it('drops below 0.6 for two different dates', () => {
    const r = parse('reunião amanhã ou na sexta')
    expect(r.confidence).toBeLessThan(0.6)
    expect(when('reunião amanhã ou na sexta')).toBe('2026-11-03')
  })

  it('drops below 0.6 for a duration next to a time', () => {
    expect(parse('daqui a 20 minutos às 14h').confidence).toBeLessThan(0.6)
  })

  it('agrees when two words name the same day', () => {
    expect(parse('amanhã terça às 9h').confidence).toBe(1)
  })
})

describe('title cleanup', () => {
  it('drops trailing punctuation and capitalises', () => {
    expect(parse('ligar ao joão amanhã às 14h!').title).toBe('Ligar ao joão')
    expect(parse('preciso de rever o runbook amanhã.').title).toBe('Rever o runbook')
  })
})
