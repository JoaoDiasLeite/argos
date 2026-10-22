import { describe, expect, it } from 'vitest'
import { inputBoxHolds } from './terminal-input-box'

const RULE = '─'.repeat(80)
const PROMPT = 'Read RUNBOOK.md in this folder before you start, then wait for instructions.'

describe('inputBoxHolds', () => {
  it('sees a typed prompt still sitting in the box', () => {
    const rows = ['', ' Claude Code v2.1.308', '', RULE, `❯ ${PROMPT}`, RULE, '  despiste main', '  ⏵⏵ auto mode on']
    expect(inputBoxHolds(rows, PROMPT)).toBe(true)
  })

  it('reads a prompt wrapped over several rows', () => {
    const rows = [RULE, '❯ Read RUNBOOK.md in this folder before you start, then wait', '  for instructions.', RULE, '  status']
    expect(inputBoxHolds(rows, PROMPT)).toBe(true)
  })

  it('is false once submitted: the box is empty and the prompt is in the transcript above', () => {
    const rows = [`> ${PROMPT}`, '', '* Germinating… (6s · ↓ 96 tokens)', RULE, '❯ ', RULE, '  despiste main']
    expect(inputBoxHolds(rows, PROMPT)).toBe(false)
  })

  it('is false without two rules on screen', () => {
    expect(inputBoxHolds([`❯ ${PROMPT}`, RULE], PROMPT)).toBe(false)
    expect(inputBoxHolds([`❯ ${PROMPT}`], PROMPT)).toBe(false)
  })

  it('does not take a short rule-like line for the box', () => {
    const rows = ['────', `❯ ${PROMPT}`, '────']
    expect(inputBoxHolds(rows, PROMPT)).toBe(false)
  })
})
