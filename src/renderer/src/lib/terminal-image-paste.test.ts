import { describe, it, expect } from 'vitest'
import { imagePasteRoute } from './terminal-image-paste'

describe('imagePasteRoute', () => {
  it('lets a local CLI read the clipboard itself, whatever it is', () => {
    const local = { cliRunning: true, distroReadsClipboard: null } as const
    expect(imagePasteRoute({ ...local, provider: 'claude' })).toBe('cli-clipboard')
    expect(imagePasteRoute({ ...local, provider: 'codex' })).toBe('cli-clipboard')
  })

  it('refuses over SSH, where the file and the shell are on different machines', () => {
    expect(
      imagePasteRoute({ remoteHostId: 'host1', provider: 'claude', cliRunning: true, distroReadsClipboard: true })
    ).toBe('refuse')
  })

  it('lets Claude Code in a capable distro read the clipboard itself', () => {
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'claude', cliRunning: true, distroReadsClipboard: true })
    ).toBe('cli-clipboard')
  })

  it('writes the file for a distro that cannot reach the clipboard', () => {
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'claude', cliRunning: true, distroReadsClipboard: false })
    ).toBe('file')
  })

  it('writes the file while the probe has not answered', () => {
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'claude', cliRunning: true, distroReadsClipboard: null })
    ).toBe('file')
  })

  it('keeps the other CLIs on the file path inside a distro', () => {
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'codex', cliRunning: true, distroReadsClipboard: true })
    ).toBe('file')
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'gemini', cliRunning: true, distroReadsClipboard: true })
    ).toBe('file')
  })

  it('hands a plain shell the path, having no CLI to paste into', () => {
    expect(
      imagePasteRoute({ provider: 'claude', cliRunning: false, distroReadsClipboard: null })
    ).toBe('file')
    expect(
      imagePasteRoute({ wslDistro: 'Ubuntu', provider: 'claude', cliRunning: false, distroReadsClipboard: true })
    ).toBe('file')
  })
})
