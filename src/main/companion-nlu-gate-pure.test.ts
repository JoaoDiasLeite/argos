import { describe, it, expect } from 'vitest'
import { parseCapture } from './companion-nlu-pure'
import {
  buildWhenPrompt,
  needsModel,
  parseLocalStamp,
  parsedFromModel,
  unreadDateWords,
  utcOffset
} from './companion-nlu-gate-pure'
import { planCapture } from './companion-capture-pure'

// Monday 2 November 2026, 10:00 local — the spike's reference time.
const NOW = new Date(2026, 10, 2, 10, 0)
const OPTS = { now: NOW, leadMinutes: 10, morningHour: 9 }

const gate = (text: string): boolean => needsModel(text, parseCapture(text, OPTS))

const pad = (n: number): string => String(n).padStart(2, '0')
function local(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

describe('needsModel: the grammar handles these, so they stay instant', () => {
  it.each([
    // The 25 spike fixtures (docs/COMPANION_PLAN.md §5.1).
    'ligar à câmara amanhã às 14h',
    'enviar relatório hoje às 17:30',
    'rever logs daqui a 20 minutos',
    'reiniciar puma daqui a 2 horas',
    'reunião sexta de manhã',
    'call com leiria sexta à tarde',
    'backup na sexta',
    'standup segunda que vem',
    'pagar fatura dia 12',
    'renovar certificado 12/11',
    'entregar proposta 12 de novembro',
    'almoço ao meio-dia',
    'ligar ao joão às 2 da tarde',
    'deploy às 14:30',
    'testar vpn amanhã 9h',
    'ver isto depois de amanhã',
    'preparar sprint na próxima semana',
    'tenho de fazer isto amanhã até às 14h',
    'quinta às 10h30 migração',
    'lembra-me em 15 minutos de beber água',
    'terça à noite atualizar runbook',
    'amanhã de manhã ver tickets',
    '14h30 reunião com cliente',
    'dia 5 às 16h formação',
    'call with team tomorrow at 2pm'
  ])('%s', (text) => {
    expect(gate(text)).toBe(false)
  })

  it.each([
    // Plain todos with nothing date-ish.
    'comprar café',
    'rever o pull request do pedro',
    'atualizar o runbook do nginx',
    'buy milk',
    'ligar à câmara de vila real',
    'pagar 3 meses de renda',
    // A bare-hour guess is 0.7: still the grammar's call.
    'ligar às 3',
    // "em 15 minutos", "in 2 days": the grammar counts these.
    'reiniciar em 15 minutos',
    'call in 2 days',
    // Not a todo: notes and queries never go to the model.
    'nota: fim do mês fecha o sprint',
    'o que tenho no fim do mês?'
  ])('%s', (text) => {
    expect(gate(text)).toBe(false)
  })
})

describe('needsModel: these go to the model', () => {
  it.each([
    'pagar renda no fim do mês',
    'limpar a garagem no fim de semana',
    'ligar ao pedro depois do almoço',
    'enviar email antes do almoço',
    'rever logs ao fim da tarde',
    'planear sprint no início da semana',
    'reunião na semana a seguir',
    'renovar domínio daqui a uma semana e meia',
    'fechar faturas no mês que vem',
    'renovar seguro no próximo mês',
    'amanhã depois do almoço ligar ao rui',
    'pay rent at the end of the month',
    'call mum after lunch',
    'renew the cert next month',
    'deploy in 3 weeks'
  ])('%s', (text) => {
    expect(gate(text)).toBe(true)
  })

  it('a conflict below 0.6 goes, even with nothing else date-ish', () => {
    const parsed = parseCapture('backup amanhã daqui a 2 horas', OPTS)
    expect(parsed.confidence).toBeLessThan(0.6)
    expect(needsModel('backup amanhã daqui a 2 horas', parsed)).toBe(true)
  })

  it('names the phrase it did not read', () => {
    expect(unreadDateWords('pagar renda no fim do mês')).toBe('fim do mês')
    expect(unreadDateWords('rever logs ao fim da tarde')).toBe('fim da tarde')
    expect(unreadDateWords('comprar café')).toBeNull()
  })
})

describe('the prompt', () => {
  it('carries the local time, weekday, offset, language and the prefs, and the line as JSON', () => {
    const p = buildWhenPrompt({ text: 'pagar "renda" no fim do mês', now: NOW, language: 'pt-PT', leadMinutes: 10, morningHour: 8 })
    expect(p).toContain('Monday 2026-11-02T10:00')
    expect(p).toContain(`UTC${utcOffset(NOW)}`)
    expect(p).toContain('European Portuguese (pt-PT)')
    expect(p).toContain('08:00')
    expect(p).toContain('reminds 10 minutes before')
    expect(p).toContain('Line: "pagar \\"renda\\" no fim do mês"')
  })
})

describe('parseLocalStamp', () => {
  it('reads local wall time', () => {
    expect(local(parseLocalStamp('2026-11-30T09:00')!.getTime())).toBe('2026-11-30 09:00')
  })
  it('rejects dates and times that do not exist', () => {
    expect(parseLocalStamp('2026-02-30T09:00')).toBeNull()
    expect(parseLocalStamp('2026-11-30T24:00')).toBeNull()
    expect(parseLocalStamp('2026-13-01T09:00')).toBeNull()
    expect(parseLocalStamp('2026-11-30 09:00')).toBeNull()
    expect(parseLocalStamp('2026-11-30T09:00Z')).toBeNull()
  })
  it('keeps the wall time across a DST change (no fixed offsets)', () => {
    // Last Sunday of March 2027 is the EU spring-forward; any zone keeps 09:00 as 09:00.
    const d = parseLocalStamp('2027-03-29T09:00')!
    expect(d.getHours()).toBe(9)
    expect(d.getDate()).toBe(29)
    const before = parseLocalStamp('2027-03-27T09:00')!
    expect(before.getHours()).toBe(9)
  })
})

describe('parsedFromModel', () => {
  const text = 'pagar renda no fim do mês'
  const localParse = parseCapture(text, OPTS)

  it('a timed answer: due time plus the lead reminder, marked as the model', () => {
    const r = parsedFromModel(
      { title: 'Pagar renda', when: { at: '2026-11-30T14:00', precision: 'minute' }, isExplicitReminder: false },
      localParse,
      OPTS
    )!
    expect(r.title).toBe('Pagar renda')
    expect(r.when!.precision).toBe('minute')
    expect(local(r.when!.at)).toBe('2026-11-30 14:00')
    expect(r.remindAt.map(local)).toEqual(['2026-11-30 13:50'])
    expect(r.fromModel).toBe(true)
    expect(r.intent).toBe('todo')
  })

  it('precision day: the day at 00:00, reminded at the morning hour', () => {
    const r = parsedFromModel(
      { title: 'Pagar renda', when: { at: '2026-11-30T17:45', precision: 'day' }, isExplicitReminder: false },
      localParse,
      { ...OPTS, morningHour: 8 }
    )!
    expect(r.when!.precision).toBe('day')
    expect(local(r.when!.at)).toBe('2026-11-30 00:00')
    expect(r.remindAt.map(local)).toEqual(['2026-11-30 08:00'])
  })

  it('an explicit reminder reminds at the time itself', () => {
    const r = parsedFromModel(
      { title: 'Beber água', when: { at: '2026-11-02T13:30', precision: 'minute' }, isExplicitReminder: true },
      localParse,
      OPTS
    )!
    expect(r.isExplicitReminder).toBe(true)
    expect(r.remindAt.map(local)).toEqual(['2026-11-02 13:30'])
  })

  it('keeps the grammar’s "lembra-me" even if the model missed it', () => {
    const lp = parseCapture('lembra-me depois do almoço de ligar ao rui', OPTS)
    expect(lp.isExplicitReminder).toBe(true)
    const r = parsedFromModel(
      { title: 'Ligar ao Rui', when: { at: '2026-11-02T14:00', precision: 'minute' }, isExplicitReminder: false },
      lp,
      OPTS
    )!
    expect(r.isExplicitReminder).toBe(true)
    expect(r.remindAt.map(local)).toEqual(['2026-11-02 14:00'])
  })

  it('a DST-crossing answer keeps its local wall time', () => {
    const r = parsedFromModel(
      { title: 'Mudar a hora', when: { at: '2027-03-29T09:00', precision: 'minute' }, isExplicitReminder: false },
      localParse,
      OPTS
    )!
    expect(local(r.when!.at)).toBe('2027-03-29 09:00')
    expect(local(r.remindAt[0])).toBe('2027-03-29 08:50')
  })

  it('when null: undated, no marker, the model’s title', () => {
    const r = parsedFromModel({ title: 'Pagar renda', when: null, isExplicitReminder: false }, localParse, OPTS)!
    expect(r.when).toBeNull()
    expect(r.remindAt).toEqual([])
    expect(r.fromModel).toBe(false)
    expect(r.title).toBe('Pagar renda')
  })

  it('an empty title falls back to the grammar’s', () => {
    const r = parsedFromModel({ title: '  ', when: null, isExplicitReminder: false }, localParse, OPTS)!
    expect(r.title).toBe(localParse.title)
  })

  it.each([
    ['missing fields', { title: 'x' }],
    ['missing isExplicitReminder', { title: 'x', when: null }],
    ['wrong types', { title: 3, when: null, isExplicitReminder: false }],
    ['not an object', 'pagar renda'],
    ['null', null],
    ['bad precision', { title: 'x', when: { at: '2026-11-30T14:00', precision: 'hour' }, isExplicitReminder: false }],
    ['bad date format', { title: 'x', when: { at: '30/11/2026 14:00', precision: 'minute' }, isExplicitReminder: false }],
    ['a date that does not exist', { title: 'x', when: { at: '2026-11-31T14:00', precision: 'minute' }, isExplicitReminder: false }],
    ['an ISO string with a zone', { title: 'x', when: { at: '2026-11-30T14:00:00Z', precision: 'minute' }, isExplicitReminder: false }],
    ['in the past', { title: 'x', when: { at: '2026-11-01T14:00', precision: 'minute' }, isExplicitReminder: false }],
    ['a past day', { title: 'x', when: { at: '2026-11-01T00:00', precision: 'day' }, isExplicitReminder: false }],
    ['absurdly far ahead', { title: 'x', when: { at: '2099-11-30T14:00', precision: 'minute' }, isExplicitReminder: false }]
  ])('rejects %s', (_label, raw) => {
    expect(parsedFromModel(raw, localParse, OPTS)).toBeNull()
  })

  it('today as a day is not the past', () => {
    const r = parsedFromModel({ title: 'x', when: { at: '2026-11-02T00:00', precision: 'day' }, isExplicitReminder: false }, localParse, OPTS)
    expect(r).not.toBeNull()
  })

  it('aligns a monthly repeat to the model’s date', () => {
    const text = 'pagar a renda todos os meses no fim do mês'
    const r = parsedFromModel(
      { title: 'Pagar a renda', when: { at: '2026-11-30T00:00', precision: 'day' }, isExplicitReminder: false },
      parseCapture(text, OPTS),
      OPTS
    )!
    expect(local(r.when!.at).slice(0, 10)).toBe('2026-11-30')
    expect(r.repeat).toEqual({ every: 'month', monthDay: 30 })
  })

  it('moves a workday repeat the model put on a weekend to Monday', () => {
    const text = 'rever tickets de segunda a sexta depois do almoço'
    const r = parsedFromModel(
      { title: 'Rever tickets', when: { at: '2026-11-07T14:00', precision: 'minute' }, isExplicitReminder: false },
      parseCapture(text, OPTS),
      OPTS
    )!
    expect(local(r.when!.at)).toBe('2026-11-09 14:00')
    expect(r.repeat).toEqual({ every: 'weekday' })
  })
})

describe('planCapture with a model answer', () => {
  const text = 'pagar renda no fim do mês'
  const parsed = parsedFromModel(
    { title: 'Pagar renda', when: { at: '2026-11-30T00:00', precision: 'day' }, isExplicitReminder: false },
    parseCapture(text, OPTS),
    OPTS
  )!

  it('saves a todo with the model’s date and keeps the marker on the result', () => {
    const plan = planCapture({ text, source: 'text', parsed, todos: [], now: NOW.getTime(), newId: () => 'id1' })
    expect(plan.kind).toBe('todo')
    if (plan.kind !== 'todo') return
    expect(plan.todo.title).toBe('Pagar renda')
    expect(local(plan.todo.dueAt!)).toBe('2026-11-30 00:00')
    expect(plan.todo.duePrecision).toBe('day')
    expect(plan.todo.remindAt.map(local)).toEqual(['2026-11-30 09:00'])
    expect(plan.parsed.fromModel).toBe(true)
  })

  it('an undated model answer saves undated', () => {
    const undated = parsedFromModel({ title: 'Pagar renda', when: null, isExplicitReminder: false }, parseCapture(text, OPTS), OPTS)!
    const plan = planCapture({ text, source: 'voice', parsed: undated, todos: [], now: NOW.getTime(), newId: () => 'id2' })
    expect(plan.kind).toBe('todo')
    if (plan.kind !== 'todo') return
    expect(plan.todo.dueAt).toBeNull()
    expect(plan.todo.remindAt).toEqual([])
    expect(plan.todo.source).toBe('voice')
  })
})
