// The English dictionary: the source of truth for every key.
//
// To add a namespace: create `en/<name>.ts` (a flat `{ 'area.thing': 'Text' }` object,
// `satisfies Record<string, string>`), import it here, add it to `namespaces` and spread
// `prefix('<name>', <name>)` into `en`. Then register it in pt-PT/index.ts, whose type
// makes forgetting to do so a typecheck error.
import { prefix } from '../prefix'
import common from './common'
import main from './main'
import settings from './settings'

export const namespaces = { common, main, settings }

export const en = {
  ...prefix('common', common),
  ...prefix('main', main),
  ...prefix('settings', settings)
}

export type MessageKey = keyof typeof en
