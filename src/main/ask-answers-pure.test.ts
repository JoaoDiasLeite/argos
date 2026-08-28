import { describe, it, expect } from 'vitest'
import {
  ASK_RESULT_PREFIX,
  DecidableMessage,
  askDecisionText,
  askQuestionText,
  parseAskAnswers,
  stripPreviewBlocks,
  withDecisions
} from './ask-answers-pure'

const q = (question: string, header: string, labels: string[]) => ({
  question,
  header,
  options: labels.map((label) => ({ label, description: 'x' }))
})

describe('parseAskAnswers', () => {
  // The case that forced anchoring instead of a regex: the statement itself has
  // quotes in it, and /"([^"]+)"="([^"]+)"/ cuts it in half.
  it('reads an answer whose question contains quotes', () => {
    const questions = [q('Which entries move to the "system" bubble?', 'Scope', ['isMeta: true', 'Compact summary'])]
    const text = `${ASK_RESULT_PREFIX} "Which entries move to the "system" bubble?"="isMeta: true". You can now continue with these answers in mind.`
    const r = parseAskAnswers(questions, text)!
    expect(r).toHaveLength(1)
    expect(r[0].chosen).toEqual(['isMeta: true'])
    expect(r[0].rejected).toEqual(['Compact summary'])
    expect(r[0].header).toBe('Scope')
  })

  it('keeps a label that contains a comma whole', () => {
    const questions = [q('Fix it?', 'Metadata', ['Yes, fix everything (Recommended)', 'Just the bubble, for now'])]
    const text = `${ASK_RESULT_PREFIX} "Fix it?"="Yes, fix everything (Recommended)". You can now continue.`
    const r = parseAskAnswers(questions, text)!
    expect(r[0].chosen).toEqual(['Yes, fix everything (Recommended)'])
    expect(r[0].rejected).toEqual(['Just the bubble, for now'])
  })

  // Without "longest first", "Yes" would also match inside "Yes, fix everything".
  it('does not turn a label that prefixes another into two choices', () => {
    const questions = [q('Fix it?', 'M', ['Yes', 'Yes, fix everything'])]
    const r = parseAskAnswers(questions, `${ASK_RESULT_PREFIX} "Fix it?"="Yes, fix everything". You can now continue.`)!
    expect(r[0].chosen).toEqual(['Yes, fix everything'])
  })

  it('reads several questions from one call, multi-select included', () => {
    const questions = [
      q('Which entries?', 'Scope', ['isMeta: true', '<task-notification>', 'Auto-compact summary', '[Request interrupted by user]']),
      q('Fix the counts?', 'Metadata', ['Yes, fix everything', 'Just the bubble'])
    ]
    const text = `${ASK_RESULT_PREFIX} "Which entries?"="isMeta: true, <task-notification>, Auto-compact summary", "Fix the counts?"="Yes, fix everything". You can now continue with these answers in mind.`
    const r = parseAskAnswers(questions, text)!
    expect(r).toHaveLength(2)
    expect(r[0].chosen).toEqual(['isMeta: true', '<task-notification>', 'Auto-compact summary'])
    expect(r[0].rejected).toEqual(['[Request interrupted by user]'])
    expect(r[1].chosen).toEqual(['Yes, fix everything'])
  })

  it('keeps the chosen mockup out of the choice', () => {
    const questions = [q('How do I draw it?', 'Form', ['One block', 'Two blocks'])]
    const text = `${ASK_RESULT_PREFIX} "How do I draw it?"="One block" selected preview:\n┌────────┐\n│ CHOICE │\n└────────┘. You can now continue.`
    const r = parseAskAnswers(questions, text)!
    expect(r[0].chosen).toEqual(['One block'])
  })

  it('sends a free-text answer to custom, with no label chosen', () => {
    const questions = [q('Which colour?', 'Colour', ['Blue', 'Green'])]
    const r = parseAskAnswers(questions, `${ASK_RESULT_PREFIX} "Which colour?"="grey, like the mockup". You can now continue.`)!
    expect(r[0].chosen).toEqual([])
    expect(r[0].custom).toBe('grey, like the mockup')
    expect(r[0].rejected).toEqual(['Blue', 'Green'])
  })

  it('drops a question the result never answered', () => {
    const questions = [q('Answered?', 'A', ['Yes']), q('Never asked?', 'B', ['No'])]
    const r = parseAskAnswers(questions, `${ASK_RESULT_PREFIX} "Answered?"="Yes". You can now continue.`)!
    expect(r).toHaveLength(1)
    expect(r[0].question).toBe('Answered?')
  })

  // The format belongs to the harness and can change without notice. On that day
  // the viewer goes back to what it did before rather than drawing a wrong block.
  it('returns null instead of guessing at a format it does not know', () => {
    const questions = [q('Which colour?', 'Colour', ['Blue'])]
    expect(parseAskAnswers(questions, 'the user answered something')).toBeNull()
    expect(parseAskAnswers(questions, '')).toBeNull()
    expect(parseAskAnswers(questions, `${ASK_RESULT_PREFIX} "Another question?"="Blue".`)).toBeNull()
    expect(parseAskAnswers([], `${ASK_RESULT_PREFIX} "x"="y".`)).toBeNull()
    expect(parseAskAnswers(undefined, `${ASK_RESULT_PREFIX} "x"="y".`)).toBeNull()
  })
})

describe('stripPreviewBlocks', () => {
  it('removes the mockup and keeps the rest of the text', () => {
    const text = `${ASK_RESULT_PREFIX} "A?"="One" selected preview:\n┌──┐\n└──┘, "B?"="Two". You can now continue.`
    const clean = stripPreviewBlocks(text)
    expect(clean).toContain('"A?"="One"')
    expect(clean).toContain('"B?"="Two"')
    expect(clean).not.toContain('┌')
  })
})

describe('askDecisionText', () => {
  it('is the readable answer, without the mockup or the trailer', () => {
    const text = `${ASK_RESULT_PREFIX} "Which colour?"="Blue" selected preview:\n┌──┐. You can now continue with these answers in mind.`
    expect(askDecisionText(text)).toBe(`${ASK_RESULT_PREFIX} "Which colour?"="Blue"`)
  })

  it('is null for an ordinary tool result, and for a failed one', () => {
    expect(askDecisionText('Found 3 files')).toBeNull()
    expect(askDecisionText(`${ASK_RESULT_PREFIX} "a"="b"`, true)).toBeNull()
    expect(askDecisionText(undefined)).toBeNull()
  })
})

describe('askQuestionText', () => {
  // Indexing the raw JSON gives snippets of `"questions":` rather than the
  // statement the owner actually read.
  it('is the statement and its options as prose', () => {
    const input = { questions: [q('Which colour?', 'Colour', ['Blue', 'Green'])] }
    expect(askQuestionText(input)).toBe('Which colour?\nBlue — x\nGreen — x')
  })

  it('is null when there is nothing shaped like a question', () => {
    expect(askQuestionText({})).toBeNull()
    expect(askQuestionText({ questions: [] })).toBeNull()
    expect(askQuestionText(null)).toBeNull()
  })
})

describe('withDecisions', () => {
  const questions = [q('Which colour?', 'Colour', ['Blue', 'Green'])]
  const answered = `${ASK_RESULT_PREFIX} "Which colour?"="Blue". You can now continue.`
  const asked = (result?: string, isError = false): DecidableMessage => ({
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 't1', tool: 'AskUserQuestion', input: { questions }, result, isError }],
    timestamp: 5
  })

  it('replaces the pair with one turn of the owner’s', () => {
    const out = withDecisions([asked(answered)])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].toolCalls).toEqual([])
    expect(out[0].decisions?.[0].chosen).toEqual(['Blue'])
  })

  it('keeps what the assistant said alongside the question', () => {
    const m = asked(answered)
    m.text = 'Before I go on:'
    const out = withDecisions([m])
    expect(out.map((x) => x.role)).toEqual(['assistant', 'user'])
    expect(out[0].text).toBe('Before I go on:')
    expect(out[0].toolCalls).toEqual([])
  })

  // The tool call is only dropped when there is a block to put in its place, so a
  // format we stop recognising degrades to the two tool bubbles of before.
  it('leaves the tool call alone when the answer cannot be read', () => {
    const out = withDecisions([asked('the user picked something')])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    expect(out[0].toolCalls).toHaveLength(1)
    expect(out[0].decisions).toBeUndefined()
  })

  it('leaves an unanswered question as the question it is', () => {
    const out = withDecisions([asked(undefined)])
    expect(out[0].toolCalls).toHaveLength(1)
  })

  it('leaves a failed call alone', () => {
    const out = withDecisions([asked(answered, true)])
    expect(out[0].toolCalls).toHaveLength(1)
  })

  it('does not touch ordinary tool calls', () => {
    const m: DecidableMessage = {
      role: 'assistant',
      text: 'reading',
      toolCalls: [{ id: 't2', tool: 'Read', input: { file_path: 'x' }, result: 'ok' }],
      timestamp: 1
    }
    expect(withDecisions([m])).toEqual([m])
  })
})
