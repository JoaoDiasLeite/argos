// companion. The desktop pet and its bubble (src/renderer/src/companion/*).
//
// `day.*` starts a line ("Tomorrow, Tue 3 Nov"), `dayInline.*` sits inside a sentence
// ("What's for tomorrow at 14:00?"). Times and dates come from Intl, not from here.
export default {
  'pet.label': 'Argos. Click to write, drag to move.',

  'day.today': 'Today',
  'day.tomorrow': 'Tomorrow',
  'day.yesterday': 'Yesterday',
  'dayInline.today': 'today',
  'dayInline.tomorrow': 'tomorrow',
  'dayInline.yesterday': 'yesterday',
  'when.dayAt': '{day} at {time}',
  'when.dayTime': '{day}, {time}',
  'span.min': '{n} min',
  'span.hour': '{n} h',
  'span.day': '{n} d',

  'input.label': 'Write a todo or a note',
  'input.placeholder': 'What do you need?',
  'input.help': 'Enter saves · Esc closes',
  'needsTitle.question': "What's for {when}?",

  'receipt.saved': 'Saved',
  'receipt.savedNoDate': 'Saved without a date',
  'receipt.noteSaved': 'Note saved',
  'receipt.reminder': 'reminder',
  'receipt.reminderAt': 'reminder at {time}',
  'receipt.edit': 'Edit',
  'receipt.setDate': 'Set date',
  'receipt.undo': 'Undo',
  'receipt.undone': 'Undone',

  'query.title': 'On the list',
  'query.range': '{from} to {to}',
  'query.empty': 'Nothing on the list for that.',

  'reminder.late': 'late {span}',
  'reminder.done': 'Done',
  'reminder.snooze10': '+10 min',
  'reminder.snoozeMore': 'More ways to snooze',
  'reminder.open': 'Open',
  'reminder.help': 'Enter marks it done · Esc closes',
  'reminder.queued.one': '1 more waiting',
  'reminder.queued.other': '{n} more waiting',
  'snooze.10m': '10 minutes',
  'snooze.1h': '1 hour',
  'snooze.tomorrow': 'Tomorrow morning',
  'snooze.pick': 'Pick…',
  'snooze.pickLabel': 'Snooze until',
  'snooze.ok': 'OK',

  'catchup.title.one': '1 reminder passed',
  'catchup.title.other': '{n} reminders passed',
  'catchup.launch': 'while Argos was closed',
  'catchup.dnd': 'while you were on quiet',
  'catchup.toggle': 'Show or hide the list',
  'catchup.markDone': 'Mark "{title}" done',
  'catchup.seeAll': 'See all'
} satisfies Record<string, string>
