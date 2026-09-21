import { describe, it, expect } from 'vitest'
import {
  OscScanner,
  isApprovalNotification,
  APPROVAL_PREFIX,
  MAX_CARRY
} from './terminal-osc-pure'

/**
 * The notification channel behind the amber "waiting for you" mark on a terminal chat.
 *
 * The cases that matter are the split ones: a pty breaks its chunks wherever the pipe
 * did, and a scanner that only worked on whole sequences would drop notifications
 * intermittently — which is indistinguishable from the CLI not sending them.
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ST = ESC + '\\'

/** An OSC 9 notification as it appears on the wire. */
const notify = (text: string, term: string = BEL): string => ESC + ']9;' + text + term

describe('OscScanner', () => {
  it('finds a notification delivered in one chunk', () => {
    const s = new OscScanner()
    expect(s.feed('t1', 'output ' + notify('all done') + ' more')).toEqual(['all done'])
  })

  it('finds one split across chunks', () => {
    const s = new OscScanner()
    const whole = notify('Approval requested: "rm -rf"')
    // Split at every position: the pipe can break anywhere, so all of them must work.
    for (let cut = 1; cut < whole.length; cut++) {
      const one = new OscScanner()
      const a = one.feed('t1', whole.slice(0, cut))
      const b = one.feed('t1', whole.slice(cut))
      expect([...a, ...b]).toEqual(['Approval requested: "rm -rf"'])
    }
    expect(s.feed('t1', whole)).toHaveLength(1)
  })

  it('accepts ST as a terminator as well as BEL', () => {
    const s = new OscScanner()
    expect(s.feed('t1', notify('done', ST))).toEqual(['done'])
  })

  it('returns two notifications from one chunk', () => {
    const s = new OscScanner()
    expect(s.feed('t1', notify('one') + 'between' + notify('two'))).toEqual(['one', 'two'])
  })

  it('ignores OSC codes that are not notifications', () => {
    const s = new OscScanner()
    // Title (0) and hyperlink (8) run past constantly — the real capture had 434 of them
    // against a single notification.
    const title = ESC + ']0;some window title' + BEL
    const link = ESC + ']8;;https://example.com' + BEL
    expect(s.feed('t1', title + link)).toEqual([])
  })

  it('does not mistake a longer code that starts with 9', () => {
    const s = new OscScanner()
    expect(s.feed('t1', ESC + ']99;not us' + BEL)).toEqual([])
  })

  it('keeps ordinary output from accumulating in the carry', () => {
    const s = new OscScanner()
    s.feed('t1', 'x'.repeat(10_000))
    // Nothing is open, so nothing is held: the next chunk starts from nothing.
    expect(s.feed('t1', notify('done'))).toEqual(['done'])
  })

  it('abandons an unterminated sequence past the cap', () => {
    const s = new OscScanner()
    s.feed('t1', ESC + ']9;' + 'x'.repeat(MAX_CARRY + 100))
    // The runaway was dropped rather than carried, so a later real one still lands.
    expect(s.feed('t1', notify('done'))).toEqual(['done'])
  })

  it('carries a trailing ESC into the next chunk', () => {
    const s = new OscScanner()
    expect(s.feed('t1', 'text' + ESC)).toEqual([])
    expect(s.feed('t1', ']9;done' + BEL)).toEqual(['done'])
  })

  it('keeps ptys apart', () => {
    const s = new OscScanner()
    s.feed('a', ESC + ']9;from a')
    s.feed('b', ESC + ']9;from b')
    expect(s.feed('a', BEL)).toEqual(['from a'])
    expect(s.feed('b', BEL)).toEqual(['from b'])
  })

  it('drops a half sequence when the pty is forgotten', () => {
    const s = new OscScanner()
    s.feed('t1', ESC + ']9;half of something')
    s.forget('t1')
    // A replacement pty on the same id must not complete the dead one's sequence.
    expect(s.feed('t1', ' and the rest' + BEL)).toEqual([])
  })
})

describe('isApprovalNotification', () => {
  it('recognises the prefix Codex uses when it is waiting on the user', () => {
    expect(isApprovalNotification(APPROVAL_PREFIX + ' "C:/windows/System32/cmd.exe"')).toBe(true)
  })

  it('tolerates leading whitespace', () => {
    expect(isApprovalNotification('  ' + APPROVAL_PREFIX + ' "x"')).toBe(true)
  })

  it('treats a finished turn as not an approval', () => {
    // The real payload for a completed turn is the assistant's own text.
    expect(isApprovalNotification('```text hello ```')).toBe(false)
    expect(isApprovalNotification('')).toBe(false)
  })
})
