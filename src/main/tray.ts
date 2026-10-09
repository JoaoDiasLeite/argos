import { Tray, Menu, nativeImage } from 'electron'
import { appIconPath } from './app-icon'
import { t } from './i18n'

// System tray: keeps the app alive when the window is closed,
// and gives quick access to the main window, a new chat, and the quick launcher.

let tray: Tray | null = null
// Kept so the context menu can be rebuilt later (e.g. when the shortcut label or the
// language changes) without the caller having to re-supply the action callbacks.
let trayActions: TrayActions | null = null
let trayShortcut = ''

export interface TrayActions {
  onShowMain: () => void
  onNewChat: () => void
  onToggleOverlay: () => void
  onQuit: () => void
}

function buildMenu(actions: TrayActions, overlayShortcut: string): Menu {
  return Menu.buildFromTemplate([
    { label: t('main.tray.open'), click: actions.onShowMain },
    { label: t('main.tray.newTerminal'), click: actions.onNewChat },
    {
      label: overlayShortcut
        ? t('main.tray.quickLauncherWithShortcut', { shortcut: overlayShortcut })
        : t('main.tray.quickLauncher'),
      click: actions.onToggleOverlay
    },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: actions.onQuit }
  ])
}

/** Returns the created tray, or null when no usable icon exists (close-to-tray is
 *  disabled in that case so the app can't be stranded invisible). */
export function createTray(actions: TrayActions, overlayShortcut: string): Tray | null {
  const icon = nativeImage.createFromPath(appIconPath())
  if (icon.isEmpty()) return null

  trayActions = actions
  trayShortcut = overlayShortcut
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Argos')
  tray.setContextMenu(buildMenu(actions, overlayShortcut))
  tray.on('click', actions.onShowMain)
  return tray
}

/** Rebuild the context menu with an updated quick-launcher shortcut label. No-op
 *  if the tray hasn't been created (or has been torn down). */
export function updateTrayShortcutLabel(shortcut: string): void {
  trayShortcut = shortcut
  if (!tray || !trayActions) return
  tray.setContextMenu(buildMenu(trayActions, shortcut))
}

/** Rebuild the context menu in the current language. No-op if no tray exists. */
export function refreshTrayMenu(): void {
  if (!tray || !trayActions) return
  tray.setContextMenu(buildMenu(trayActions, trayShortcut))
}

/** Update the tray hover tooltip (e.g. live plan usage). No-op if no tray exists. */
export function updateTrayTooltip(text: string): void {
  if (!tray) return
  tray.setToolTip(text || 'Argos')
}
