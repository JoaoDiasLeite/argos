import * as path from 'path'

/**
 * Pure helpers for the Linux desktop: which terminal emulator to open a login in,
 * which user bin dirs a launcher-started app is missing from PATH, and how to write
 * the XDG autostart entry. No fs or process access here — linux-desktop.ts feeds the
 * environment in.
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

/**
 * User bin dirs where the agent CLIs usually live, for PATH. An app started from a
 * desktop launcher inherits the session's PATH, not the one the user's shell rc builds,
 * so the CLIs' install dirs are often missing: `~/.local/bin` (Claude Code's native
 * installer), mise's shims (how Omarchy provides node, so npm-installed codex/gemini),
 * and the npm prefix the docs suggest for global installs.
 */
export function userBinDirs(home: string, xdgDataHome?: string): string[] {
  const dataHome = xdgDataHome || path.posix.join(home, '.local', 'share')
  return [
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(dataHome, 'mise', 'shims'),
    path.posix.join(home, '.npm-global', 'bin')
  ]
}

/** `current` with any of `extra` it lacks appended — the user's own PATH keeps priority. */
export function withPathDirs(current: string | undefined, extra: string[]): string {
  const dirs = (current || '').split(':').filter(Boolean)
  for (const dir of extra) {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs.join(':')
}

// Desktop Entry spec: an Exec argument containing a reserved character is wrapped in
// double quotes, and inside them `"`, `` ` ``, `$` and `\` are backslash-escaped. A
// literal `%` is `%%` (a bare one starts a field code).
function quoteExecArg(arg: string): string {
  const escaped = arg.replace(/%/g, '%%')
  if (!/[\s"'\\><~|&;$*?#()`]/.test(escaped)) return escaped
  return `"${escaped.replace(/(["`$\\])/g, '\\$1')}"`
}

/** The XDG autostart entry that launches `exe` with `args` at login. */
export function autostartDesktopEntry(exe: string, args: string[]): string {
  // The file's string-value escaping runs before the Exec quoting is read, so every
  // backslash the quoting produced has to be doubled once more to survive it.
  const exec = [exe, ...args].map(quoteExecArg).join(' ').replace(/\\/g, '\\\\')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Argos',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}
