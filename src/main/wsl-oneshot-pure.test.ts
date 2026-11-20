import { describe, expect, it } from 'vitest'
import { oneShotCommand, shQuote } from './wsl-oneshot-pure'

describe('oneShotCommand', () => {
  it('quotes the model, the tools and the allowed tools', () => {
    const cmd = oneShotCommand(
      { model: 'claude-sonnet-4-5', tools: ['Read', 'Grep'], allowedTools: ['mcp__gitlab', 'Read'], cwd: '/home/u/repo' },
      false
    )
    expect(cmd).toBe(
      "cd -- '/home/u/repo' && claude -p --output-format stream-json --verbose --permission-mode bypassPermissions" +
        " --model 'claude-sonnet-4-5' --tools 'Read,Grep' --allowedTools 'mcp__gitlab,Read'"
    )
  })

  it('keeps an MCP server name with shell characters as one word', () => {
    const cmd = oneShotCommand({ allowedTools: ["mcp__x; touch /tmp/p #'`$(id)`"] }, true)
    expect(cmd).toContain(`--allowedTools ${shQuote("mcp__x; touch /tmp/p #'`$(id)`")}`)
    expect(cmd.endsWith(`'mcp__x; touch /tmp/p #'\''\`$(id)\`'`)).toBe(true)
  })

  it('keeps a model with spaces or a command substitution as one word', () => {
    expect(oneShotCommand({ model: 'x $(reboot)' }, true)).toContain("--model 'x $(reboot)'")
  })

  it('forwards an empty tool list, which turns every built-in tool off', () => {
    expect(oneShotCommand({ tools: [] }, true)).toContain("--tools ''")
  })

  it('runs in $HOME without a folder or when told to', () => {
    expect(oneShotCommand({}, false).startsWith('cd "$HOME" && claude ')).toBe(true)
    expect(oneShotCommand({ cwd: '/mnt/c/Users/u' }, true).startsWith('cd "$HOME" && claude ')).toBe(true)
  })

  it('does not read a folder that starts with a dash as an option', () => {
    expect(oneShotCommand({ cwd: '-P' }, false).startsWith("cd -- '-P' && ")).toBe(true)
  })
})
