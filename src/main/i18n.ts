// The main process's translator, bound to `config.ui.language`.
//
// It reads the language from the live config on every call rather than caching it, so
// a fresh launch, a dev "sync from prod" reload and a Settings change all take effect
// without anyone having to remember to refresh it. What does need telling is anything
// that rendered text once and keeps it (the tray menu, the application menu): the
// `config:set-ui` handler in index.ts compares `currentLanguage()` before and after the
// write and rebuilds those.
import { getConfig } from './config'
import { localeOf, makeT, normalizeLanguage, type Language, type MessageKey, type MessageParams } from '../shared/i18n'

export function currentLanguage(): Language {
  return normalizeLanguage(getConfig().ui?.language)
}

/** The current locale for Intl / toLocale* calls; `undefined` for English (OS format). */
export function currentLocale(): string | undefined {
  return localeOf(currentLanguage())
}

export function t(key: MessageKey, params?: MessageParams): string {
  return makeT(currentLanguage())(key, params)
}
