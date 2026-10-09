// The Home view: the start box, what is running, what needs you, recent work.
export default {
  'time.justNow': 'just now',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',

  'duration.lessThanMinute': '<1 min',
  'duration.minutes': '{n} min',
  'duration.hoursMinutes': '{h} h {m} min',
  'duration.hours': '{h} h',
  'duration.days': '{n} d',

  'header.dayTitle': '{weekday}, {day} {month}',

  'plan.window.default': 'plan window',
  'plan.window.weekly': 'weekly window',
  'plan.window.hours': '{n}-hour window',
  'plan.window.days': '{n}-day window',
  'plan.resets': 'resets {time}',
  'plan.resetsOn': 'resets {day} {time}',
  'plan.noAccount': 'No account connected · Settings › Connection',
  'plan.account': '{name} account',
  'plan.usage': '{name} account at {pct} % of the {window}',
  'plan.usageWithReset': '{usage} · {reset}',
  'plan.label': 'Plan window',
  'plan.title': '{name} · {window}',
  'plan.pct': '{pct} %',
  'plan.pctWithReset': '{pct} % · {reset}',
  'plan.barLabel': '{pct} % of the window used',

  'select.empty': 'Nothing yet',

  'start.prompt': 'What are we doing?',
  'start.project': 'Project',
  'start.cli': 'CLI',
  'start.account': 'Account',
  'start.newProject': 'New project',
  'start.submit': 'Start',
  'start.hint': "Ctrl+Enter starts in a new terminal · the folder is the project's root",

  'body.empty': 'Nothing running, nothing waiting. Start something above.',

  'recent.title': 'Pick up where you left off',
  'recent.showMore': 'Show {n} more',

  'projects.title': 'Recent projects',
  'projects.readingGit': 'Reading git status',
  'projects.noGit': 'no git',

  'side.label': 'What is live',

  'needs.label': 'Needs you',
  'needs.title': 'Needs you · {n}',
  'needs.none': 'Nothing waiting for you.',
  'needs.oldest': 'oldest {time}',

  'running.label': 'Running',
  'running.title': 'Running · {n}',
  'running.none': 'Nothing running.',
  'running.group.chats': 'Chats',
  'running.group.servers': 'Servers',
  'running.group.interventions': 'Interventions',

  'repos.label': 'Uncommitted work',
  'repos.title': 'Uncommitted work · {n}',
  'repos.clean': 'All recent repos are clean.',
  'repos.counting': 'Counting changes',
  'repos.files.one': '{n} file',
  'repos.files.other': '{n} files'
} satisfies Record<string, string>
