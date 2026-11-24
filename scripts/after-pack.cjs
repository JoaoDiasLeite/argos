// electron-builder afterPack hook: runs on the unpacked app, before it is signed.
//
// node-pty's macOS prebuilds ship prebuilds/darwin-*/spawn-helper without the
// execute bit (the npm tarball stores it as 0644), and node-pty spawns every
// terminal through it — without the bit each one fails with "posix_spawnp
// failed". Linux builds node-pty from source and Windows has no helper, so only
// macOS needs this.
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = `${context.packager.appInfo.productFilename}.app`
  const prebuilds = path.join(
    context.appOutDir,
    app,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds'
  )
  if (!fs.existsSync(prebuilds)) throw new Error(`afterPack: ${prebuilds} not found`)
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755)
      console.log(`  • afterPack: made ${path.relative(context.appOutDir, helper)} executable`)
    }
  }
}
