import { describe, it, expect } from 'vitest'
import { terminalCandidates } from './linux-desktop-pure'

describe('terminalCandidates', () => {
  const run = ['bash', '-lc', "claude login; exec bash"]

  it('tries the freedesktop launcher first, passing the command straight through', () => {
    expect(terminalCandidates('claude login')[0]).toEqual({ bin: 'xdg-terminal-exec', args: run })
  })

  it('speaks each emulator’s own way of taking a command', () => {
    const byBin = new Map(terminalCandidates('claude login').map((c) => [c.bin, c.args]))
    expect(byBin.get('alacritty')).toEqual(['-e', ...run])
    expect(byBin.get('kitty')).toEqual(run)
    expect(byBin.get('gnome-terminal')).toEqual(['--', ...run])
    expect(byBin.get('wezterm')).toEqual(['start', '--', ...run])
  })

  it('puts $TERMINAL right after the launcher, using the style of the emulator it names', () => {
    const list = terminalCandidates('claude login', '/usr/bin/kitty')
    expect(list[1]).toEqual({ bin: '/usr/bin/kitty', args: run })
  })

  it('assumes -e for a $TERMINAL it does not know', () => {
    const list = terminalCandidates('claude login', 'st')
    expect(list[1]).toEqual({ bin: 'st', args: ['-e', ...run] })
  })

  it('keeps the whole script as one argument, so quotes in it survive', () => {
    const [first] = terminalCandidates(`CLAUDE_CONFIG_DIR='/home/joão/a b' 'claude'`)
    expect(first.args[2]).toBe(`CLAUDE_CONFIG_DIR='/home/joão/a b' 'claude'; exec bash`)
  })
})
