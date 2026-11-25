// The command line of a headless `claude -p` inside a WSL distro. It is handed to
// `bash -lic` as one string, so every value that does not come from this file is quoted:
// the model comes from settings and the tool names include an MCP server's name, which is
// whatever the distro's MCP config calls it.

/** POSIX single-quote: safe for any byte but NUL. */
export function shQuote(s: string): string {
  // `'\\''` in a template literal is the four characters ' \ ' ' (close, escaped quote,
  // reopen); `'\''` would be three quotes and let the rest of the value out of the quoting.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface OneShotOptions {
  model?: string
  tools?: string[]
  allowedTools?: string[]
  /** The Linux folder to run in; without it (or in a Windows home mount) the distro's $HOME. */
  cwd?: string
}

export function oneShotCommand(opts: OneShotOptions, useHome: boolean): string {
  const flags = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
  if (opts.model) flags.push('--model', shQuote(opts.model))
  // An empty list is forwarded too: `--tools ''` disables every built-in tool.
  if (opts.tools !== undefined) flags.push('--tools', shQuote(opts.tools.join(',')))
  if (opts.allowedTools?.length) flags.push('--allowedTools', shQuote(opts.allowedTools.join(',')))
  const cd = useHome || !opts.cwd ? 'cd "$HOME" && ' : `cd -- ${shQuote(opts.cwd)} && `
  return `${cd}claude ${flags.join(' ')}`
}
