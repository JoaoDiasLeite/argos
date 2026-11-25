import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  mainWindowCloseAction,
  microphoneAccessFromStatus,
  microphoneSettingsUrl,
  shouldStartHidden,
  trafficLightPosition
} from './main-window-pure'

describe('trafficLightPosition', () => {
  it('centres the buttons on the title bar', () => {
    expect(trafficLightPosition(TITLE_BAR_HEIGHT)).toEqual({ x: 14, y: 11 })
    expect(trafficLightPosition(40)).toEqual({ x: 14, y: 13 })
  })
  it('never goes above the window', () => {
    expect(trafficLightPosition(8).y).toBe(0)
  })
})

describe('shouldStartHidden', () => {
  const base = { argv: ['argos'], openedAtLogin: false, startMinimized: false, isDev: false }
  it('shows by default', () => expect(shouldStartHidden(base)).toBe(false))
  it('hides on --hidden', () => expect(shouldStartHidden({ ...base, argv: ['argos', '--hidden'] })).toBe(true))
  it('hides when macOS opened it at login', () => expect(shouldStartHidden({ ...base, openedAtLogin: true })).toBe(true))
  it('honours start minimized outside dev only', () => {
    expect(shouldStartHidden({ ...base, startMinimized: true })).toBe(true)
    expect(shouldStartHidden({ ...base, startMinimized: true, isDev: true })).toBe(false)
  })
})

describe('mainWindowCloseAction', () => {
  const win = { platform: 'win32' as const, isQuitting: false, hasTray: true, isDev: false, closeToTray: true }
  it('lets a quit in progress through', () => {
    expect(mainWindowCloseAction({ ...win, isQuitting: true })).toBe('proceed')
    expect(mainWindowCloseAction({ ...win, platform: 'darwin', isQuitting: true })).toBe('proceed')
  })
  it('hides to the tray on Windows only with a tray and the preference on', () => {
    expect(mainWindowCloseAction(win)).toBe('hide')
    expect(mainWindowCloseAction({ ...win, hasTray: false })).toBe('quit')
    expect(mainWindowCloseAction({ ...win, closeToTray: false })).toBe('quit')
    expect(mainWindowCloseAction({ ...win, platform: 'linux', closeToTray: false })).toBe('quit')
  })
  it('always hides on macOS, tray or not', () => {
    const mac = { ...win, platform: 'darwin' as const }
    expect(mainWindowCloseAction(mac)).toBe('hide')
    expect(mainWindowCloseAction({ ...mac, hasTray: false, closeToTray: false })).toBe('hide')
  })
  it('quits a dev instance everywhere', () => {
    expect(mainWindowCloseAction({ ...win, isDev: true })).toBe('quit')
    expect(mainWindowCloseAction({ ...win, platform: 'darwin', isDev: true })).toBe('quit')
  })
})

describe('microphone access', () => {
  it('passes final answers through and asks on not-determined', () => {
    expect(microphoneAccessFromStatus('granted')).toBe('granted')
    expect(microphoneAccessFromStatus('denied')).toBe('denied')
    expect(microphoneAccessFromStatus('restricted')).toBe('restricted')
    expect(microphoneAccessFromStatus('not-determined')).toBeNull()
    expect(microphoneAccessFromStatus('unknown')).toBe('unsupported')
  })
  it('opens the right settings page', () => {
    expect(microphoneSettingsUrl('darwin')).toContain('Privacy_Microphone')
    expect(microphoneSettingsUrl('win32')).toBe('ms-settings:privacy-microphone')
    expect(microphoneSettingsUrl('linux')).toBeNull()
  })
})
