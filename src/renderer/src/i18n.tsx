// The renderer's side of i18n: one provider per window, holding the current language.
//
// Every window (main, overlay, pill, popout, toast) wraps its root in <I18nProvider>.
// The provider reads `config.ui.language` once and then follows `onUiPrefs`, which the
// main process broadcasts to every window on each write, so a change in Settings
// re-renders all of them at once with no restart.
//
// Components: `const t = useT()` then `t('settings.general.language.label')`.
// Helpers outside components take `t` / `locale` as parameters; there is no global.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { localeOf, makeT, normalizeLanguage, type Language, type TFunction } from '../../shared/i18n'

interface I18nValue {
  language: Language
  t: TFunction
  /** For Intl / toLocale* calls. `undefined` for English, i.e. the OS's own format. */
  locale: string | undefined
}

function valueFor(language: Language): I18nValue {
  return { language, t: makeT(language), locale: localeOf(language) }
}

const I18nContext = createContext<I18nValue>(valueFor('en'))

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>('en')

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .getConfig()
      .then((config) => {
        if (!cancelled) setLanguage(normalizeLanguage(config.ui?.language))
      })
      .catch(() => {})
    const off = window.electronAPI.onUiPrefs((ui) => setLanguage(normalizeLanguage(ui?.language)))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const value = useMemo(() => valueFor(language), [language])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** The translator for the current language. */
export function useT(): TFunction {
  return useContext(I18nContext).t
}

/** The current language, and the locale to hand Intl / toLocale* calls. */
export function useLanguage(): { language: Language; locale: string | undefined } {
  const { language, locale } = useContext(I18nContext)
  return { language, locale }
}
