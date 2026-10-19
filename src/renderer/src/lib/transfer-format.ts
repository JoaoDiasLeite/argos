import type { TFunction } from '../../../shared/i18n'

/** Sizes in the export / import dialogs: B, KB, MB or GB. */
export function transferBytes(t: TFunction, n: number): string {
  if (n < 1024) return t('settings.transfer.bytes.b', { n })
  if (n < 1024 * 1024) return t('settings.transfer.bytes.kb', { n: (n / 1024).toFixed(1) })
  if (n < 1024 * 1024 * 1024) return t('settings.transfer.bytes.mb', { n: (n / (1024 * 1024)).toFixed(1) })
  return t('settings.transfer.bytes.gb', { n: (n / (1024 * 1024 * 1024)).toFixed(2) })
}
