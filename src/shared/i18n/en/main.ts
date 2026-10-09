// Main-process text: tray, application menu, native dialogs and notifications.
export default {
  'tray.open': 'Open Argos',
  'tray.newTerminal': 'New terminal',
  'tray.quickLauncher': 'Quick launcher',
  'tray.quickLauncherWithShortcut': 'Quick launcher ({shortcut})',
  'tray.quit': 'Quit Argos',

  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.reload': 'Reload',
  'menu.forceReload': 'Force Reload',
  'menu.toggleDevTools': 'Toggle Developer Tools',
  'menu.resetZoom': 'Actual Size',
  'menu.zoomIn': 'Zoom In',
  'menu.zoomOut': 'Zoom Out',
  'menu.minimize': 'Minimize',
  'menu.close': 'Close',

  'notify.trayHint.title': 'Argos is still running',
  'notify.trayHint.body': 'The app keeps running in the system tray. Use the tray icon to reopen or quit.',

  'sshTrust.storeUnreadable': 'SSH trust store could not be read. Connection refused.',
  'sshTrust.changed.title': 'SSH host key changed',
  'sshTrust.changed.message': 'Connection to {endpoint} was refused.',
  'sshTrust.changed.detail':
    'Trusted: {known}\nReceived: {fingerprint}\nVerify the server identity with its administrator before changing trust.',
  'sshTrust.verify.title': 'Verify SSH server',
  'sshTrust.verify.message': 'Trust {endpoint}?',
  'sshTrust.verify.detail':
    'Server fingerprint:\n{fingerprint}\nCompare this with the fingerprint supplied by the server administrator.',
  'sshTrust.verify.trust': 'Trust this server',

  'planUsage.window.session': 'Session (5h)',
  'planUsage.window.weekAll': 'Week · all models',
  'planUsage.window.weekOpus': 'Week · Opus',
  'planUsage.window.weekSonnet': 'Week · Sonnet',
  'planUsage.short.session': 'Session',
  'planUsage.short.week': 'Week',
  'planUsage.tooltip': 'Argos — {parts}',
  'planUsage.tooltip.part': '{window} {pct}%',
  'planUsage.alert.title': 'Plan limit warning — {account}',
  'planUsage.alert.body': '{window} window {pct}% used',
  'planUsage.alert.bodyWithReset': '{window} window {pct}% used · {reset}',
  'planUsage.reset.soon': 'resets soon',
  'planUsage.reset.minutes': 'resets in {m}m',
  'planUsage.reset.hours': 'resets in {h}h {m}m'
} satisfies Record<string, string>
