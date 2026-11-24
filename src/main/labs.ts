// The one place main reads the "experimental features" switch. Read from the live config
// on every call, never cached, so a change in Settings applies to the next connection,
// click or terminal without a restart. The decisions themselves live in labs-pure.ts.
import { getConfig } from './config'
import { labsFromConfig } from './labs-pure'

export function isLabsOn(): boolean {
  return labsFromConfig(getConfig().labs)
}
