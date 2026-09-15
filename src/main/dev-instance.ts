import { app } from 'electron'
import * as path from 'path'
import { migrateUserDataDir, MigrationOptions, MigrationResult, resyncUserDataDir } from './migrate-userdata'

/**
 * Lets `npm run dev` run beside an installed Argos.
 *
 * Electron keys the single-instance lock on userData, so while dev and prod shared a
 * directory the dev launch found the lock taken and quit. An unpackaged run gets its own
 * `argos-dev` directory instead — which also keeps the two processes from writing the
 * same config.json and store.json under each other.
 *
 * Imported first by index.ts, as a side effect: several modules read userData into
 * module-level constants the moment they load, so the path has to move before they do.
 *
 * On the first dev launch the directory is seeded from prod, so dev opens on real data
 * rather than an empty app. Two things are deliberately not copied:
 *  - `cc-accounts` and `provider-accounts`, which are used from prod's directory instead.
 *    They hold OAuth logins and the sessions Claude Code writes; a copy would fork a
 *    refresh token that only one side can go on using, and show a frozen session list.
 *  - `scheduler`, since a copy would fire every routine twice.
 * `Local State` is carried because it holds the key safeStorage encrypted the SSH hosts
 * and API key with; without it those files cannot be read.
 */
const SEED: MigrationOptions = {
  skip: ['scheduler'],
  carry: ['Local State'],
  shared: ['cc-accounts', 'provider-accounts']
}

function prodDir(): string {
  return path.join(app.getPath('appData'), 'argos')
}

// Only while userData is still prod's: a launcher that already chose a directory (the
// visual-check script sets an isolated one before loading the bundle) keeps it.
// Compared case-insensitively: Windows paths are, and Electron may spell the name either way.
export const isDevInstance =
  !app.isPackaged &&
  path.resolve(app.getPath('userData')).toLowerCase() === path.resolve(prodDir()).toLowerCase()

if (isDevInstance) {
  const devDir = path.join(app.getPath('appData'), 'argos-dev')
  app.setPath('userData', devDir)
  const seed = migrateUserDataDir(prodDir(), devDir, SEED)
  if (seed.detail) console.log(`[dev-userdata] ${seed.detail}`)
}

/**
 * Replace dev's copy of prod's data with a fresh one. Callers reload whatever they hold
 * in memory afterwards — this only touches the disk.
 */
export function syncDevFromProd(): MigrationResult {
  if (!isDevInstance) return { migrated: false, detail: 'not a dev instance' }
  return resyncUserDataDir(prodDir(), app.getPath('userData'), SEED)
}
