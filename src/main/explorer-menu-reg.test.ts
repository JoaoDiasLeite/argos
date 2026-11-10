import { describe, expect, it } from 'vitest'
import { buildExplorerMenuReg, regString } from './explorer-menu-reg'

const exe = 'C:\\Program Files\\Argos\\Argos.exe'
const command = `"${exe}" --folder "%V"`

describe('regString', () => {
  it('escapes backslashes and quotes and keeps %V literal', () => {
    expect(regString(command)).toBe('"\\"C:\\\\Program Files\\\\Argos\\\\Argos.exe\\" --folder \\"%V\\""')
  })
})

describe('buildExplorerMenuReg', () => {
  it('returns null when there is nothing to do', () => {
    expect(buildExplorerMenuReg({ command, icon: exe })).toBeNull()
  })

  it('writes both keys with icon and command, and drops the legacy ones', () => {
    const reg = buildExplorerMenuReg({ enabled: true, removeLegacy: true, command, icon: exe })!
    expect(reg.startsWith('Windows Registry Editor Version 5.00\r\n\r\n')).toBe(true)
    expect(reg).toContain('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ClaudeGUI]')
    expect(reg).toContain('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ClaudeGUI]')
    for (const key of ['shell\\Argos', 'Background\\shell\\Argos']) {
      const full = `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\${key}`
      expect(reg).toContain(`[${full}]\r\n@="Open with Argos"\r\n"Icon"=${regString(exe)}`)
      expect(reg).toContain(`[${full}\\command]\r\n@=${regString(command)}`)
    }
    expect(reg).not.toContain('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Argos]')
  })

  it('deletes both keys when disabled', () => {
    const reg = buildExplorerMenuReg({ enabled: false, command, icon: exe })!
    expect(reg).toContain('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\Argos]')
    expect(reg).toContain('[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\Argos]')
    expect(reg).not.toContain('ClaudeGUI')
    expect(reg).not.toContain('@=')
  })

  it('only drops the legacy keys when the toggle is left alone', () => {
    const reg = buildExplorerMenuReg({ removeLegacy: true, command, icon: exe })!
    expect(reg).toContain('ClaudeGUI')
    expect(reg).not.toContain('\\Argos]')
  })
})
