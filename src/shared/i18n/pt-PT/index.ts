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
import app from '../en/app'
import sidebar from '../en/sidebar'
import shortcuts from '../en/shortcuts'
import onboarding from '../en/onboarding'
import home from '../en/home'
import projects from '../en/projects'
import sessions from '../en/sessions'
import planner from '../en/planner'
import sprints from '../en/sprints'
import remote from '../en/remote'
import ops from '../en/ops'
import usage from '../en/usage'
import mcp from '../en/mcp'
import accounts from '../en/accounts'
import chat from '../en/chat'
import editor from '../en/editor'

export const ptPT: Record<MessageKey, string> = {
  ...prefix('common', common),
  ...prefix('main', main),
  ...prefix('settings', settings),
  ...prefix('app', app),
  ...prefix('sidebar', sidebar),
  ...prefix('shortcuts', shortcuts),
  ...prefix('onboarding', onboarding),
  ...prefix('home', home),
  ...prefix('projects', projects),
  ...prefix('sessions', sessions),
  ...prefix('planner', planner),
  ...prefix('sprints', sprints),
  ...prefix('remote', remote),
  ...prefix('ops', ops),
  ...prefix('usage', usage),
  ...prefix('mcp', mcp),
  ...prefix('accounts', accounts),
  ...prefix('chat', chat),
  ...prefix('editor', editor)
}
