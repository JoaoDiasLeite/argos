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

// Seed renderer localStorage, for state that otherwise only exists after a gesture.
// VISUAL_CHECK_LOCALSTORAGE is a JSON object of {key: value}; values are JSON-encoded
// into the store. The pane layout lives there, so without this a split view could only
// be photographed by dragging — and this flow deliberately never synthesises input
// (a stray click can land on the user's real windows).
//
// Written, then the page is reloaded: the app reads this during startup, so seeding a
// live renderer would be too late. Once per window, or the reload would loop.
const seedLocalStorage = process.env.VISUAL_CHECK_LOCALSTORAGE
if (seedLocalStorage) {
  const seeded = new WeakSet()
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => {
      // Skip the small always-on-top helpers: the layout being seeded is the main window's.
      if (win.isDestroyed() || win.getBounds().width <= 600 || seeded.has(win)) return
      seeded.add(win)
      const entries = JSON.stringify(seedLocalStorage)
      win.webContents
        .executeJavaScript(
          `(() => { const e = JSON.parse(${entries}); for (const k of Object.keys(e)) localStorage.setItem(k, JSON.stringify(e[k])) })()`
        )
        .then(() => !win.isDestroyed() && win.webContents.reload())
        .catch(() => {})
    })
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

// Patch the seeded config before the app reads it. VISUAL_CHECK_CONFIG_PATCH is a JSON
// object, merged one level deep into the copied config.json. It exists for settings the
// renderer cannot be talked into after startup — `ui.workMode: 'terminal'` above all,
// which is what puts real terminals on screen instead of chat transcripts, and so the
// only way to photograph anything about how terminals render.
//
// Written here rather than in run.ps1 because PowerShell 5.1 writes UTF-8 with a BOM by
// default, and the seed files are deliberately BOM-free.
const configPatch = process.env.VISUAL_CHECK_CONFIG_PATCH
if (configPatch) {
  const fs = require('fs')
  const configPath = path.join(userData, 'config.json')
  try {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const patch = JSON.parse(configPatch)
    for (const [key, value] of Object.entries(patch)) {
      current[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...current[key], ...value }
          : value
    }
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8')
  } catch {
    // A missing or unreadable config is the app's problem to report, not ours to mask.
  }
}

require(path.join(__dirname, '..', '..', 'out', 'main', 'index.js'))
