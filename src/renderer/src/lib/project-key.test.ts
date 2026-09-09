import { describe, it, expect } from 'vitest'
import { projectKey } from './project-key'

describe('projectKey', () => {
  it('treats backslash and forward slash separators as the same path', () => {
    expect(projectKey('C:\\dev\\claude-gui')).toBe(projectKey('C:/dev/claude-gui'))
  })

  it('folds case, so a folder recorded with different casing collapses to one key', () => {
    expect(projectKey('C:\\dev\\claude-gui')).toBe(projectKey('C:\\dev\\Claude-GUI'))
  })

  it('strips a trailing separator', () => {
    expect(projectKey('C:\\dev\\claude-gui\\')).toBe(projectKey('C:\\dev\\claude-gui'))
    expect(projectKey('/home/me/proj/')).toBe(projectKey('/home/me/proj'))
  })

  it('returns an empty string for an empty path', () => {
    expect(projectKey('')).toBe('')
  })
})
