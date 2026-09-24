import * as path from 'path'

/**
 * Pure helpers for the Linux desktop: which terminal emulator to open a login in.
 * No fs or process access here — linux-desktop.ts feeds the environment in.
 */

type ArgvStyle = 'direct' | 'dash-e' | 'double-dash' | 'wezterm'

// Known emulators and how each takes a command. `xdg-terminal-exec` comes first: it is
// the freedesktop default-terminal launcher (what Omarchy binds its terminal key to), so
// it opens whichever terminal the user picked. `x-terminal-emulator` is the Debian
// equivalent; the rest are a best-effort sweep for systems with neither.
const TERMINALS: [string, ArgvStyle][] = [
  ['xdg-terminal-exec', 'direct'],
  ['x-terminal-emulator', 'dash-e'],
  ['alacritty', 'dash-e'],
  ['ghostty', 'dash-e'],
  ['kitty', 'direct'],
  ['foot', 'direct'],
  ['wezterm', 'wezterm'],
  ['gnome-terminal', 'double-dash'],
  ['konsole', 'dash-e'],
  ['xfce4-terminal', 'dash-e'],
  ['xterm', 'dash-e']
]

function argvFor(style: ArgvStyle, command: string[]): string[] {
  switch (style) {
    case 'direct':
      return command
    case 'dash-e':
      return ['-e', ...command]
    case 'double-dash':
      return ['--', ...command]
    case 'wezterm':
      return ['start', '--', ...command]
  }
}

/**
 * The terminals to try, in order, each with the argv that runs `script` in a login
 * shell and leaves the window open afterwards (so a login URL or error stays
 * readable). `$TERMINAL`, when set, goes right after xdg-terminal-exec; an emulator
 * we don't know is assumed to take `-e`, the most common convention.
 */
export function terminalCandidates(
  script: string,
  terminalEnv?: string
): { bin: string; args: string[] }[] {
  const command = ['bash', '-lc', `${script}; exec bash`]
  const list = TERMINALS.map(([bin, style]) => ({ bin, args: argvFor(style, command) }))
  if (terminalEnv) {
    const known = TERMINALS.find(([bin]) => bin === path.posix.basename(terminalEnv))
    list.splice(1, 0, { bin: terminalEnv, args: argvFor(known ? known[1] : 'dash-e', command) })
  }
  return list
}
