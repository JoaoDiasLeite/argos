import { app, Tray, Menu, nativeImage, type NativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { appIconPath } from './app-icon'
import { currentLocale, t } from './i18n'
import { isQuiet, quietUntilDay } from './companion-quiet-pure'

// System tray: keeps the app alive when the window is closed,
// and gives quick access to the main window, a new chat, the quick launcher and the
// companion.

let tray: Tray | null = null
// Kept so the context menu can be rebuilt later (e.g. when the shortcut label or the
// language changes) without the caller having to re-supply the action callbacks.
let trayActions: TrayActions | null = null
let trayShortcut = ''

export interface TrayActions {
  onShowMain: () => void
  onNewChat: () => void
  onToggleOverlay: () => void
  onToggleCompanion: () => void
  /** Read each time the menu is built, for the companion entry's check mark. */
  isCompanionVisible: () => boolean
  /** "O que tenho hoje": the pet, with today's list in its bubble. */
  onCompanionToday: () => void
  /** Quiet mode (plan §3.3): until an instant, or null to switch it off. */
  onCompanionQuiet: (untilMs: number | null) => void
  /** Read each time the menu is built: when quiet mode ends, or null when it is off. */
  companionQuietUntil: () => number | null
  onQuit: () => void
}

/** "15:30", "amanhã, 09:00" or "qua 4 nov, 09:00": when a mute ends, for a menu label. */
export function quietUntilLabel(until: number, now = Date.now()): string {
  const locale = currentLocale()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(until)
  const day = quietUntilDay(until, now)
  if (day === 'today') return time
  if (day === 'tomorrow') return t('main.companion.quiet.tomorrowAt', { time })
  const date = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(until)
  return `${date}, ${time}`
}

const QUIET_HOUR_MS = 60 * 60_000

/** The menu as a template, exported so the visual check can log its labels. */
export function trayMenuTemplate(actions: TrayActions, overlayShortcut: string): MenuItemConstructorOptions[] {
  const until = actions.companionQuietUntil()
  const quiet = isQuiet(until, Date.now())
  return [
    { label: t('main.tray.open'), click: actions.onShowMain },
    { label: t('main.tray.newTerminal'), click: actions.onNewChat },
    {
      label: overlayShortcut
        ? t('main.tray.quickLauncherWithShortcut', { shortcut: overlayShortcut })
        : t('main.tray.quickLauncher'),
      click: actions.onToggleOverlay
    },
    {
      label: t('main.tray.companion'),
      type: 'checkbox',
      checked: actions.isCompanionVisible(),
      click: actions.onToggleCompanion
    },
    { label: t('main.companion.today'), click: actions.onCompanionToday },
    quiet
      ? {
          label: t('main.companion.quietOff', { until: quietUntilLabel(until!) }),
          click: () => actions.onCompanionQuiet(null)
        }
      : { label: t('main.companion.quietHour'), click: () => actions.onCompanionQuiet(Date.now() + QUIET_HOUR_MS) },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: actions.onQuit }
  ]
}

function buildMenu(actions: TrayActions, overlayShortcut: string): Menu {
  return Menu.buildFromTemplate(trayMenuTemplate(actions, overlayShortcut))
}

/** The macOS menu-bar icon: build/trayTemplate.png (16 px, with its @2x sibling for
 *  Retina, both from scripts/gen-icon.mjs), black + alpha so the menu bar tints it.
 *  Resolved like appIconPath(): the unpacked copy next to app.asar when packaged, the
 *  archive path as a fallback. Empty when neither exists. */
function macTrayTemplate(): NativeImage {
  const inAsar = join(app.getAppPath(), 'build', 'trayTemplate.png')
  const unpacked = inAsar.replace(/app\.asar([\\/])/,'app.asar.unpacked$1')
  for (const file of unpacked === inAsar ? [inAsar] : [unpacked, inAsar]) {
    // Loading the base name picks up trayTemplate@2x.png next to it.
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) {
      image.setTemplateImage(true)
      return image
    }
  }
  return nativeImage.createEmpty()
}

/** Returns the created tray, or null when no usable icon exists (close-to-tray is
 *  disabled in that case so the app can't be stranded invisible). */
export function createTray(actions: TrayActions, overlayShortcut: string): Tray | null {
  const isMac = process.platform === 'darwin'
  const template = isMac ? macTrayTemplate() : nativeImage.createEmpty()
  let trayIcon: NativeImage
  if (!template.isEmpty()) {
    trayIcon = template
  } else {
    const icon = nativeImage.createFromPath(appIconPath())
    if (icon.isEmpty()) return null
    trayIcon = icon.resize({ width: 16, height: 16 })
  }

  trayActions = actions
  trayShortcut = overlayShortcut
  tray = new Tray(trayIcon)
  tray.setToolTip('Argos')
  tray.setContextMenu(buildMenu(actions, overlayShortcut))
  // On macOS a click on a menu-bar item opens its menu ("Open" is its first entry);
  // also showing the main window on that click would pull it forward every time.
  if (!isMac) tray.on('click', actions.onShowMain)
  return tray
}

/** Rebuild the context menu with an updated quick-launcher shortcut label. No-op
 *  if the tray hasn't been created (or has been torn down). */
export function updateTrayShortcutLabel(shortcut: string): void {
  trayShortcut = shortcut
  if (!tray || !trayActions) return
  tray.setContextMenu(buildMenu(trayActions, shortcut))
}

/** Rebuild the context menu in the current language, after the companion was shown or
 *  hidden, or when quiet mode starts or ends (both read at build time). No-op if no tray exists. */
export function refreshTrayMenu(): void {
  if (!tray || !trayActions) return
  tray.setContextMenu(buildMenu(trayActions, trayShortcut))
}

/** Update the tray hover tooltip (e.g. live plan usage). No-op if no tray exists. */
export function updateTrayTooltip(text: string): void {
  if (!tray) return
  tray.setToolTip(text || 'Argos')
}
