// Accounts modal, account picker and model picker.
export default {
  // Accounts modal
  'modal.title': 'Accounts',
  'row.nameAria': 'Account name',
  'row.default': 'Default',
  'row.relogin': 'Re-login',
  'row.login': 'Log in',
  'row.setDefault': 'Set default',
  'row.remove': 'Remove',
  'status.loggedIn': 'Logged in',
  'status.runLogin': 'Run the login to authenticate this account',
  'login.title': 'Finish logging in',
  'login.hint': 'A terminal should have opened. Complete the login in your browser, then refresh. If no terminal opened, run this command yourself:',
  'login.refresh': 'Refresh status',
  'login.dismiss': 'Dismiss',
  'add.button': 'Add & log in',
  'claude.intro': 'Each account is a separate Claude Code login. Switch the active account from the account picker in the sidebar; new chats use the selected account.',
  'claude.usesMachineLogin': 'Uses this machine’s Claude Code login',
  'claude.newName': 'New account name (e.g. Work, Personal)',
  'provider.intro': 'Each account is a separate {provider} login. Switch the active account from the sidebar account picker when a {provider} model is selected.',
  'provider.usesMachineLogin': 'Uses this machine’s {provider} CLI login',
  'provider.newName': 'New {provider} account name (e.g. Work, Personal)',
  'antigravity.intro': 'Gemini models run through Antigravity, Google’s agentic CLI, launched with {cmd}. It uses a single machine-wide login stored in your OS keyring, so there is just one account.',
  'antigravity.meta': 'Machine-wide login via agy, stored in your OS keyring',
  'antigravity.loginHint': 'Log in opens Antigravity in a terminal. Complete the Google sign-in there.',

  // Account picker
  'picker.title': 'Account for this chat',
  'picker.fallback': 'Account',
  'picker.notLoggedIn': 'Not logged in',
  'picker.manage': 'Manage accounts',

  // Model picker
  'model.new': 'new',
  'model.discoveredTitle': 'Detected via live discovery — not yet in the bundled catalog',
  'model.discoveredMeta': 'new — pricing not catalogued yet',
  'model.discoveredMetaCtx': '{context} · new — pricing not catalogued yet',
  'model.comingSoon': 'Coming soon',
  'model.price': '{context} · ${input}/${output} per Mtok'
} satisfies Record<string, string>
