import { join } from 'path'

// The window and tray icons are read by Electron's native code, which cannot open a file
// inside app.asar. build/icon.png is listed in asarUnpack, so in a packaged app point at
// the copy next to the archive; in dev there is no asar and the path is left alone.
export function appIconPath(): string {
  return join(__dirname, '../../build/icon.png').replace(
    /app\.asar([\\/])/,
    'app.asar.unpacked$1'
  )
}
