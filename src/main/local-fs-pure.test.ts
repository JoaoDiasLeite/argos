import { describe, it, expect } from 'vitest'
import { isRootPath, posixToWslUnc } from './local-fs-pure'

describe('isRootPath', () => {
  it('accepts drive roots', () => {
    expect(isRootPath('C:\\')).toBe(true)
    expect(isRootPath('C:')).toBe(true)
    expect(isRootPath('D:/')).toBe(true)
  })

  it('accepts a bare UNC host and a UNC share root', () => {
    expect(isRootPath('\\\\wsl.localhost')).toBe(true)
    expect(isRootPath('\\\\wsl.localhost\\Ubuntu')).toBe(true)
    expect(isRootPath('\\\\wsl.localhost\\Ubuntu\\')).toBe(true)
  })

  it('accepts a POSIX root', () => {
    expect(isRootPath('/')).toBe(true)
  })

  it('rejects a real path under a root', () => {
    expect(isRootPath('C:\\Users\\me\\file.txt')).toBe(false)
    expect(isRootPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe(false)
    expect(isRootPath('/home/me')).toBe(false)
  })

  it('rejects non-string / empty input', () => {
    expect(isRootPath('')).toBe(false)
    expect(isRootPath(undefined)).toBe(false)
    expect(isRootPath(null)).toBe(false)
    expect(isRootPath(42)).toBe(false)
  })
})

describe('posixToWslUnc', () => {
  it('maps an absolute POSIX path to a UNC path under the distro share', () => {
    expect(posixToWslUnc('Ubuntu', '/home/me/project')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    )
  })

  it('handles the POSIX root', () => {
    expect(posixToWslUnc('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
  })

  it('treats a path missing its leading slash as absolute anyway', () => {
    expect(posixToWslUnc('Ubuntu', 'home/me')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me')
  })
})
