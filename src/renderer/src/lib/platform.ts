import { acceleratorKeys, formatAccelerator } from './accelerator'

/**
 * The OS this window runs on, from the preload (`process.platform`). Read once: it does
 * not change while the app runs. Empty where there is no preload (tests).
 */
export const PLATFORM: string =
  (typeof window !== 'undefined' && (window as { electronAPI?: { platform?: string } }).electronAPI?.platform) || ''

export const IS_DARWIN = PLATFORM === 'darwin'

/** An Electron accelerator as this platform's user reads it (see lib/accelerator.ts). */
export function displayAccelerator(accelerator: string): string {
  return formatAccelerator(accelerator, PLATFORM)
}

/** The same, split into one key per <kbd>. */
export function displayAcceleratorKeys(accelerator: string): string[] {
  return acceleratorKeys(accelerator, PLATFORM)
}
