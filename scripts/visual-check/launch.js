// Launches the built app with an isolated userData dir so a visual check never
// collides with (or pollutes) a running dev/production instance. Optionally
// deep-links to a view after startup via VISUAL_CHECK_VIEW.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const userData = process.env.VISUAL_CHECK_USERDATA || path.join(__dirname, 'userdata')
app.setPath('userData', userData)
const view = process.env.VISUAL_CHECK_VIEW
if (view) {
  app.whenReady().then(() => {
    // Same channel plan-limit notification clicks use; the renderer validates names.
    // Two sends: the renderer may not have registered its listener at the first.
    for (const delay of [6000, 10000]) {
      setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('app:open-view', view)
        }
      }, delay)
    }
  })
}
// Deep-link to a Claude Code conversation, the way a notification click does.
// VISUAL_CHECK_CC_SESSION is the JSON target: {"encodedDir":"-x","sessionId":"…"}.
const ccSession = process.env.VISUAL_CHECK_CC_SESSION
if (ccSession) {
  app.whenReady().then(() => {
    for (const delay of [6000, 10000]) {
      setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('app:open-cc-session', JSON.parse(ccSession))
        }
      }, delay)
    }
  })
}

require(path.join(__dirname, '..', '..', 'out', 'main', 'index.js'))
