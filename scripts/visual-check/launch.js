// Launches the built app with an isolated userData dir so a visual check never
// collides with (or pollutes) a running dev/production instance. Optionally
// deep-links to a view after startup via VISUAL_CHECK_VIEW.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const userData = process.env.VISUAL_CHECK_USERDATA || path.join(__dirname, 'userdata')
app.setPath('userData', userData)
// Widen the main window when asked. Layouts with a breakpoint above the default window
// size are invisible otherwise — the Home view only opens its third column past 1500px,
// and a capture at the default size says nothing about it.
//
// Applied twice, for the same reason the deep link below is: the window may not exist at
// the first attempt. Only the main window is touched — the app also opens small
// always-on-top helpers, and the wide one is the only one worth resizing.
const wide = process.env.VISUAL_CHECK_WIDE
if (wide) {
  const [w, h] = wide.split("x").map((v) => parseInt(v, 10))
  // Explicit bounds, not `maximize()`: this window does not honour maximising (it stays
  // the size it was and the capture comes back unchanged), while setBounds takes.
  const width = Number.isFinite(w) && w > 0 ? w : 1900
  const height = Number.isFinite(h) && h > 0 ? h : 1150
  app.whenReady().then(() => {
    for (const delay of [5000, 9000]) {
      setTimeout(() => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          // The app also opens small always-on-top helpers; the main window is the
          // only wide one and the only one worth resizing.
          if (win.getBounds().width <= 600) continue
          win.setBounds({ x: 0, y: 0, width, height })
        }
      }, delay)
    }
  })
}

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
