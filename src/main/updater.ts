import { app, Notification, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { t } from './i18n'
import { updaterLogger } from './updater-log'

// Auto-update via electron-updater, backed by GitHub Releases (see the "publish"
// block in package.json). Kept as its own module so index.ts just wires it up.

// macOS builds are ad-hoc signed, not signed with an Apple Developer ID, and
// Squirrel.Mac refuses to install an update whose signature it cannot verify. There
// the updater only checks: a new version is announced and the release page opened,
// and the person installs the dmg by hand.
const manualInstall = process.platform === 'darwin'

autoUpdater.autoDownload = !manualInstall
autoUpdater.autoInstallOnAppQuit = !manualInstall

const RELEASES_URL = 'https://github.com/JoaoDiasLeite/argos/releases'

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
  /** True where updates are installed by hand (macOS): 'available' then means "out",
   *  not "downloading", and quitAndInstall opens the release page. */
  manual?: boolean
}

// 'disabled' is the resting state for dev builds — there's no packaged installer to
// swap in, and unpackaged runs have no update feed to check against.
const state: UpdaterState = { state: 'disabled', manual: manualInstall }

let notify: ((channel: string, payload: unknown) => void) | null = null
/** The last version announced on macOS, so a 4-hourly check doesn't repeat it. */
let announced: string | undefined

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

  autoUpdater.logger = updaterLogger
  // Enough to read a report without asking which build it came from. On Linux the
  // update replaces the AppImage file itself, so where that file lives matters too.
  updaterLogger.info(
    `Argos ${app.getVersion()} on ${process.platform}-${process.arch}` +
      (process.env.APPIMAGE ? ` (AppImage ${process.env.APPIMAGE})` : '')
  )

  autoUpdater.on('checking-for-update', () => {
    state.state = 'checking'
    state.error = undefined
    emit()
  })

  autoUpdater.on('update-available', (info) => {
    state.state = 'available'
    state.version = info.version
    emit()

    // Nothing downloads on macOS, so this is the moment to say a version is out —
    // once per version: every later check finds the same one until it is installed.
    if (manualInstall && announced !== info.version && Notification.isSupported()) {
      announced = info.version
      const n = new Notification({
        title: t('main.updater.availableTitle'),
        body: t('main.updater.availableBody', { version: info.version })
      })
      n.on('click', () => quitAndInstall())
      n.show()
    }
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
        title: t('main.updater.readyTitle'),
        body: t('main.updater.readyBody', { version: info.version })
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
 * `isSilent = true` installs without showing the NSIS installer UI,
 * `isForceRunAfter = true` relaunches the app once the install finishes.
 */
export function quitAndInstall(): void {
  if (manualInstall) {
    const url = state.version ? `${RELEASES_URL}/tag/v${state.version}` : RELEASES_URL
    void shell.openExternal(url)
    return
  }
  autoUpdater.quitAndInstall(true, true)
}
