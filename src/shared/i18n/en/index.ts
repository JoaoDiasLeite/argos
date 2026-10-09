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

export const namespaces = { common, main, settings, app, sidebar, shortcuts, onboarding, home, projects, sessions, planner, sprints, remote, ops, usage, mcp, accounts, chat, editor }

export const en = {
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

export type MessageKey = keyof typeof en
