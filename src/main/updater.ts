import { app, Notification } from 'electron'
import { is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'

// Auto-update via electron-updater, backed by GitHub Releases (see the "publish"
// block in package.json). Kept as its own module so index.ts just wires it up.

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

export type UpdaterStateKind =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloaded'
  | 'error'

interface UpdaterState {
  state: UpdaterStateKind
  version?: string
  error?: string
}

// 'disabled' is the resting state for dev builds — there's no packaged installer to
// swap in, and unpackaged runs have no update feed to check against.
const state: UpdaterState = { state: 'disabled' }

let notify: ((channel: string, payload: unknown) => void) | null = null

function emit(): void {
  notify?.('updater:event', { ...state })
}

/**
 * Wire up electron-updater's event handlers and kick off periodic checks. Skipped
 * entirely in dev: `is.dev` runs are unpackaged, have no update feed, and would
 * otherwise spam GitHub's API on every `npm run dev`.
 */
export function initUpdater(notifyFn: (channel: string, payload: unknown) => void): void {
  notify = notifyFn

  if (is.dev) {
    state.state = 'disabled'
    return
  }

  state.state = 'idle'

  autoUpdater.on('checking-for-update', () => {
    state.state = 'checking'
    state.error = undefined
    emit()
  })

  autoUpdater.on('update-available', (info) => {
    state.state = 'available'
    state.version = info.version
    emit()
  })

  autoUpdater.on('update-not-available', () => {
    state.state = 'not-available'
    emit()
  })

  autoUpdater.on('update-downloaded', (info) => {
    state.state = 'downloaded'
    state.version = info.version
    emit()

    // Nudge the user out-of-band too — the settings modal isn't always open when the
    // download finishes. Clicking it installs immediately instead of waiting for the
    // next natural restart.
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `Argos ${info.version} will install on next restart.`
      })
      n.on('click', () => quitAndInstall())
      n.show()
    }
  })

  autoUpdater.on('error', (err) => {
    state.state = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    emit()
  })

  // First check shortly after launch (let startup settle), then on a steady cadence.
  // Both paths swallow network errors silently — an unreachable GitHub (offline, a
  // corporate proxy, etc.) must never surface a dialog or interrupt the user; the
  // 'error' event handler above already records it for the Settings status line.
  setTimeout(() => {
    runCheck()
  }, 10_000)
  setInterval(() => {
    runCheck()
  }, 4 * 60 * 60 * 1000)
}

function runCheck(): void {
  try {
    autoUpdater.checkForUpdates()?.catch(() => {
      // Network/feed errors during background checks are already reflected via the
      // 'error' event; nothing more to do here besides not letting it become an
      // unhandled rejection.
    })
  } catch {
    /* same as above — never let an auto check throw or dialog */
  }
}

export function getUpdaterState(): UpdaterState & { currentVersion: string } {
  return { currentVersion: app.getVersion(), ...state }
}

/** Manual "Check for updates" trigger from Settings. Returns the state once the
 *  check has been kicked off (the renderer then follows 'updater:event' for
 *  progress, same as the background checks). */
export function checkNow(): UpdaterState & { currentVersion: string } {
  if (state.state !== 'disabled') {
    runCheck()
  }
  return getUpdaterState()
}

/**
 * Quit and install the downloaded update. The app normally closes-to-tray (see
 * index.ts's mainWindow 'close' handler), which would otherwise swallow a plain
 * app.quit(). electron-updater's quitAndInstall() sidesteps that: it calls
 * app.quit()/app.exit() itself and fires 'before-quit' first, which is where
 * index.ts sets `isQuitting = true` — so the tray-hiding logic never gets a chance
 * to intercept this close. The explicit args make the intent unambiguous:
 * `isSilent = false` shows the NSIS installer UI, `isForceRunAfter = true`
 * relaunches the app once the install finishes.
 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}
