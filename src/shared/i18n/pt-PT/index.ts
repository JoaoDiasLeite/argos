// The European Portuguese dictionary.
//
// A translated namespace is `pt-PT/<name>.ts`, typed `Record<keyof typeof en, string>`
// against its English twin, so a missing or extra key fails typecheck. A namespace not
// translated yet is registered with the English file itself; swap the import when its
// translation lands. Either way `ptPT` must cover every MessageKey, so forgetting to
// register a namespace here is also a typecheck error.
import { prefix } from '../prefix'
import type { MessageKey } from '../en'
import common from './common'
import main from './main'
import settings from '../en/settings'

export const ptPT: Record<MessageKey, string> = {
  ...prefix('common', common),
  ...prefix('main', main),
  ...prefix('settings', settings)
}
