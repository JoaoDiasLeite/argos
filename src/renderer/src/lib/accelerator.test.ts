import { describe, expect, it } from 'vitest'
import { acceleratorKeys, formatAccelerator } from './accelerator'

describe('formatAccelerator', () => {
  it('leaves Windows and Linux text exactly as written', () => {
    for (const p of ['win32', 'linux']) {
      expect(formatAccelerator('Ctrl+Alt+A', p)).toBe('Ctrl+Alt+A')
      expect(formatAccelerator('Alt+Space', p)).toBe('Alt+Space')
      expect(formatAccelerator('Ctrl+Shift+Alt+S', p)).toBe('Ctrl+Shift+Alt+S')
    }
  })

  it('reads CommandOrControl as Ctrl off macOS', () => {
    expect(formatAccelerator('CommandOrControl+Shift+K', 'win32')).toBe('Ctrl+Shift+K')
    expect(formatAccelerator('CmdOrCtrl+K', 'linux')).toBe('Ctrl+K')
  })

  it('uses the mac glyphs in the system order, with no plus', () => {
    expect(formatAccelerator('Ctrl+Alt+A', 'darwin')).toBe('⌃⌥A')
    expect(formatAccelerator('Ctrl+Shift+Alt+A', 'darwin')).toBe('⌃⌥⇧A')
    expect(formatAccelerator('Shift+Command+Option+Control+k', 'darwin')).toBe('⌃⌥⇧⌘K')
    expect(formatAccelerator('CommandOrControl+Shift+K', 'darwin')).toBe('⇧⌘K')
    expect(formatAccelerator('Alt+Space', 'darwin')).toBe('⌥Space')
    expect(formatAccelerator('Ctrl+Shift+Space', 'darwin')).toBe('⌃⇧Space')
  })

  it('prints named keys as macOS does', () => {
    expect(formatAccelerator('Cmd+Enter', 'darwin')).toBe('⌘↩')
    expect(formatAccelerator('Alt+Up', 'darwin')).toBe('⌥↑')
    expect(formatAccelerator('Ctrl+Plus', 'darwin')).toBe('⌃+')
    expect(formatAccelerator('Cmd+F12', 'darwin')).toBe('⌘F12')
  })

  it('passes an empty accelerator through', () => {
    expect(formatAccelerator('', 'darwin')).toBe('')
    expect(formatAccelerator('', 'win32')).toBe('')
  })
})

describe('acceleratorKeys', () => {
  it('splits as written off macOS', () => {
    expect(acceleratorKeys('Ctrl+Shift+Space', 'win32')).toEqual(['Ctrl', 'Shift', 'Space'])
    expect(acceleratorKeys('CmdOrCtrl+K', 'linux')).toEqual(['Ctrl', 'K'])
  })

  it('gives the mac glyphs in order on macOS', () => {
    expect(acceleratorKeys('Alt+Space', 'darwin')).toEqual(['⌥', 'Space'])
    expect(acceleratorKeys('Shift+Ctrl+Alt+a', 'darwin')).toEqual(['⌃', '⌥', '⇧', 'A'])
  })

  it('has no keys for no accelerator', () => {
    expect(acceleratorKeys('', 'darwin')).toEqual([])
  })
})
