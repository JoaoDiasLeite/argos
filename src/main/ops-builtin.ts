import { app } from 'electron'
import * as path from 'path'

/**
 * The read-only despiste runbook that ships with Argos (resources/runbooks/despiste).
 * Packaged, electron-builder copies it to `<resources>/runbooks` (build.extraResources);
 * unpackaged, it is read from the source, found from this bundle (`out/main`) rather than
 * from app.getAppPath(), which is wherever the entry script sits (the visual-check
 * launcher's is not the repo root).
 * It lives inside the app and is never written to; no runbook is (ops:save-report writes to
 * the folders of Settings).
 */
export function builtinRunbookDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runbooks', 'despiste')
    : path.join(__dirname, '..', '..', 'resources', 'runbooks', 'despiste')
}
