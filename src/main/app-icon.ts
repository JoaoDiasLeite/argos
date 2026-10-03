import { app } from 'electron'
import { join } from 'path'
import { isDevInstance } from './dev-instance'

// The window and tray icons are read by Electron's native code, which cannot open a file
// inside app.asar. build/icon.png is listed in asarUnpack, so in a packaged app point at
// the copy next to the archive; in dev there is no asar and the path is left alone.
// Resolved from the app root, not __dirname: the bundler may put this module in a shared
// chunk, where __dirname is not out/main.
// A dev instance gets the transparent, mark-only variant so it reads apart from prod.
export function appIconPath(): string {
  const file = isDevInstance ? 'icon-dev.png' : 'icon.png'
  return join(app.getAppPath(), 'build', file).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}
