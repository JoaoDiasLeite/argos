/**
 * POSIX single-quoting, safe for any byte but NUL: it's becomes 'it'\''s'. Not
 * wsl-oneshot-pure's shQuote: its template literal turns the replacement into three
 * plain quotes, which drops the apostrophe.
 */
export function shQuote(s: string): string {
  return "'" + s.split("'").join("'\\''") + "'"
}

/**
 * The body of the `.command` file mac-terminal.ts opens in Terminal.app for a CLI login.
 * `open -a Terminal` runs it without the Automation permission that scripting Terminal
 * through osascript needs.
 *
 * - zsh as a login shell reads .zprofile (Homebrew's shellenv) but not .zshrc, where
 *   nvm and friends usually put node — so the app's PATH, already merged with the
 *   user's login shell (shell-env.ts), is exported explicitly.
 * - The file deletes itself first; it holds nothing secret, but it should not linger.
 * - After the login command the window drops into the user's shell, so the login URL or
 *   an error stays readable — as the Linux and Windows launchers do.
 *
 * `command` is a shell line built by the caller (quote its parts); every env value is
 * quoted here.
 */
export function loginCommandScript(opts: {
  command: string
  env: Record<string, string>
  path?: string
  cwd?: string
}): string {
  const lines = ['#!/bin/zsh -l', 'rm -f -- "$0"']
  if (opts.path) lines.push(`export PATH=${shQuote(opts.path)}`)
  for (const [k, v] of Object.entries(opts.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
    lines.push(`export ${k}=${shQuote(v)}`)
  }
  if (opts.cwd) lines.push(`cd ${shQuote(opts.cwd)} || true`)
  lines.push('clear', opts.command, 'exec "${SHELL:-/bin/zsh}" -l', '')
  return lines.join('\n')
}

/** The env-prefixed command line shown in the UI as the manual fallback. */
export function shownCommand(command: string, env: Record<string, string>): string {
  const prefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shQuote(v)} `)
    .join('')
  return `${prefix}${command}`
}
