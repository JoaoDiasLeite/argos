// The app's translations: typed dictionaries and the few functions that read them.
//
// Shared by the main process and every renderer window, so it imports nothing from
// electron, react or node. English (en/) is the source of truth for the set of keys;
// pt-PT/ is typed against it. See en/index.ts for how to add a namespace.
import { en, type MessageKey } from './en'
import { ptPT } from './pt-PT'

export type { MessageKey }

export type Language = 'en' | 'pt-PT'

export const DEFAULT_LANGUAGE: Language = 'en'

/** Every selectable language, labelled in its own language (what a picker shows). */
export const LANGUAGES: readonly { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'pt-PT', label: 'Português (Portugal)' }
]

export type MessageParams = Record<string, string | number>

export type TFunction = (key: MessageKey, params?: MessageParams) => string

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, 'pt-PT': ptPT }

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'pt-PT'
}

/** A stored or received value as a Language; anything unrecognised (or absent) is 'en'. */
export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE
}

/**
 * `{name}` interpolation. A placeholder with no matching param is left as written, so a
 * forgotten param shows up on screen instead of silently vanishing.
 */
export function format(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  )
}

const cache = new Map<Language, TFunction>()

/**
 * The translator for one language. Falls back to English for a key the dictionary does
 * not have (only possible at runtime through a cast), then to the key itself.
 */
export function makeT(language: Language): TFunction {
  const lang = normalizeLanguage(language)
  let t = cache.get(lang)
  if (!t) {
    const dict = DICTIONARIES[lang]
    t = (key, params) => format(dict[key] ?? en[key] ?? key, params)
    cache.set(lang, t)
  }
  return t
}

/**
 * The BCP 47 locale for Intl/toLocale* calls. `undefined` for English on purpose: it
 * keeps the OS's own date and number formatting, which is what users had before
 * languages existed.
 */
export function localeOf(language: Language): string | undefined {
  return language === 'pt-PT' ? 'pt-PT' : undefined
}

/** Keys `K` for which both `K.one` and `K.other` exist. */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.other` ? (`${Base}.one` extends MessageKey ? Base : never) : never
}[MessageKey]

/**
 * `plural(t, 'settings.general.hooks.count', n)` picks `.one` for n === 1 and `.other`
 * otherwise, and formats it with `{n}` plus any extra params. That rule is right for
 * both English and European Portuguese (0 is plural in both).
 */
export function plural(t: TFunction, key: PluralKey, n: number, params?: MessageParams): string {
  const form = n === 1 ? 'one' : 'other'
  return t(`${key}.${form}` as MessageKey, { ...params, n })
}
