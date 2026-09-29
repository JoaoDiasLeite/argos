/**
 * Whether a write xterm is about to send to a pty is only reports it makes on its own
 * account — focus in/out, the pointer moving under a CLI's mouse tracking, answers to the
 * CLI's queries — with no keystroke in it.
 *
 * Mirrors isTerminalReport in main/terminal-busy-pure.ts, which explains why each of these
 * matters; the renderer cannot import from main, so keep the two in step.
 */
const TERMINAL_REPORT = [
  /\x1b\[[IO]/, // focus in / out
  /\x1b\[<\d+;\d+;\d+[Mm]/, // SGR mouse (1006)
  /\x1b\[M[\s\S]{3}/, // X10 / normal mouse
  /\x1b\[[?>][\d;]*c/, // device attributes (DA1 / DA2)
  /\x1b\[\??\d+;\d+R/, // cursor position
  /\x1b\[0n/, // device status
  /\x1b\[\??\d+;\d+\$y/, // mode report (DECRPM)
  /\x1b\[\d+;\d+;\d+t/, // window size reports
  /\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC answers (colours)
  /\x1bP[^\x1b]*\x1b\\/ // DCS answers (DECRQSS)
]
  .map((r) => r.source)
  .join('|')
const ONLY_REPORTS = new RegExp(`^(?:${TERMINAL_REPORT})+$`)

export function isTerminalReport(data: string): boolean {
  return ONLY_REPORTS.test(data)
}
