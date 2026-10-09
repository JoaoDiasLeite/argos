// Settings screen. Batch 0 holds the nav and the General section; the other sections
// add their keys here as they are migrated.
export default {
  'nav.ariaLabel': 'Settings sections',
  'nav.back': 'Back to app',
  'nav.title': 'Settings',

  'section.appearance': 'Appearance',
  'section.general': 'General',
  'section.connection': 'Connection',
  'section.system': 'System',
  'section.ops': 'Ops audit',
  'section.about': 'About',

  'row.actionAria': '{action} {label}',

  'general.backgroundModel.label': 'Model for background tasks',
  'general.backgroundModel.hint': 'Runs headless work: standup, sprint backfill and planner assist.',
  'general.language.label': 'Language',
  'general.language.hint': 'Menus, labels and messages across the app.',
  'general.density.label': 'Density',
  'general.density.hint': 'How much breathing room lists and rows get.',
  'general.density.comfortable': 'Comfortable',
  'general.density.compact': 'Compact',
  'general.weekPlanner.label': 'Weekly planner',
  'general.weekPlanner.hint': 'Shows the Week mode next to Sprint.',
  'general.archived.label': 'Chats from before 2.0',
  'general.archived.hint.one': '1 chat saved as Markdown when Argos became terminal-only.',
  'general.archived.hint.other': '{n} chats saved as Markdown when Argos became terminal-only.',
  'general.archived.openFolder': 'Open folder',
  'general.permissions.label': 'Permissions',
  'general.permissions.value': '{allow} allow · {deny} deny · {ask} ask',
  'general.hooks.label': 'Hooks',
  'general.hooks.none': 'No hooks',
  'general.hooks.count.one': '{n} hook',
  'general.hooks.count.other': '{n} hooks',
  'general.hooks.events.one': '{n} event',
  'general.hooks.events.other': '{n} events',
  'general.hooks.value': '{hooks} on {events}',
  'general.notifications.label': 'Session notifications',
  'general.notifications.on': 'Wired up · toast when a chat needs you',
  'general.notifications.off': 'Not wired up'
} satisfies Record<string, string>
