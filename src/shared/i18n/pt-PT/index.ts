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
import settings from './settings'
import app from './app'
import sidebar from './sidebar'
import shortcuts from './shortcuts'
import onboarding from './onboarding'
import home from './home'
import projects from './projects'
import sessions from './sessions'
import planner from './planner'
import sprints from './sprints'
import remote from './remote'
import ops from './ops'
import usage from './usage'
import mcp from './mcp'
import accounts from './accounts'
import chat from './chat'
import editor from './editor'

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
