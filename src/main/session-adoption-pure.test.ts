import { describe, it, expect } from 'vitest'
import { descendsFrom, parsePidPairs, pickAdopted, MAX_ANCESTRY_DEPTH } from './session-adoption-pure'

/**
 * A real chain from this machine, read out of the process table while a chat's terminal
 * was running: the pty is the PowerShell the app spawned, which runs the `claude.cmd`
 * shim, which runs the CLI. Everything below starts from these numbers, so a passing
 * test is a test against the shape a local launch actually has.
 */
const PTY = 30664 // powershell.exe -NoLogo -NoProfile -Command "& $env:CLAUDE_BIN …"
const SHIM = 24852 // cmd.exe /c "claude.cmd --session-id …"
const CLI = 65744 // claude.exe
const ELECTRON = 5764 // the app itself, parent of every pty

const TABLE = new Map<number, number>([
  [CLI, SHIM],
  [SHIM, PTY],
  [PTY, ELECTRON],
  [ELECTRON, 1]
])

describe('descendsFrom', () => {
  it('follows a real pty → shim → cli chain', () => {
    expect(descendsFrom(CLI, PTY, TABLE)).toBe(true)
  })

  it('is false for a sibling under the same app', () => {
    const otherPty = 49764
    const table = new Map(TABLE).set(otherPty, ELECTRON)
    expect(descendsFrom(CLI, otherPty, table)).toBe(false)
  })

  it('is false for a pid the table does not know', () => {
    expect(descendsFrom(999999, PTY, TABLE)).toBe(false)
  })

  it('does not follow a chain past the depth ceiling', () => {
    // A ladder one longer than the walk is allowed to climb.
    const deep = new Map<number, number>()
    for (let i = 1; i <= MAX_ANCESTRY_DEPTH + 2; i++) deep.set(i, i + 1)
    expect(descendsFrom(1, MAX_ANCESTRY_DEPTH + 3, deep)).toBe(false)
    expect(descendsFrom(1, 2, deep)).toBe(true)
  })

  it('terminates on a self-parenting entry', () => {
    // pid reuse mid-read can produce one; the walk must end rather than spin.
    expect(descendsFrom(7, PTY, new Map([[7, 7]]))).toBe(false)
  })
})

describe('pickAdopted', () => {
  const candidate = { sessionId: '4592a595-bc69-4f8a-b453-339a80e6ac64', pid: CLI }

  it('adopts the one session running under the pty', () => {
    expect(pickAdopted([candidate], PTY, TABLE)).toBe(candidate.sessionId)
  })

  it('adopts nothing when no candidate descends from the pty', () => {
    expect(pickAdopted([candidate], 49764, TABLE)).toBe(null)
  })

  /**
   * The rule that keeps a wrong adoption from being worse than no adoption: a chat
   * pointed at someone else's session shows their title and imports their transcript.
   */
  it('refuses to guess when two sessions descend from one pty', () => {
    const second = { sessionId: 'cea2ecd0-3bf5-4a1c-94f4-6a59c1d42bdc', pid: 88888 }
    const table = new Map(TABLE).set(second.pid, PTY)
    expect(pickAdopted([candidate, second], PTY, table)).toBe(null)
  })

  it('refuses a pid that is not a pid', () => {
    expect(pickAdopted([candidate], 0, TABLE)).toBe(null)
    expect(pickAdopted([candidate], -1, TABLE)).toBe(null)
  })
})

describe('parsePidPairs', () => {
  it('reads PowerShell CSV output', () => {
    const csv = ['"ProcessId","ParentProcessId"', `"${CLI}","${SHIM}"`, `"${SHIM}","${PTY}"`].join('\r\n')
    expect(parsePidPairs(csv)).toEqual(
      new Map([
        [CLI, SHIM],
        [SHIM, PTY]
      ])
    )
  })

  it('reads whitespace-columned ps output, header and all', () => {
    const ps = ['  PID  PPID', `  ${CLI}  ${SHIM}`, `  ${SHIM}  ${PTY}`].join('\n')
    expect(parsePidPairs(ps)).toEqual(
      new Map([
        [CLI, SHIM],
        [SHIM, PTY]
      ])
    )
  })

  it('drops lines that are not two integers', () => {
    expect(parsePidPairs('nonsense\n\n"12"\n"1","2","3"')).toEqual(new Map())
  })
})
