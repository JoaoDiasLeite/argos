// Pure builder for the .reg script that adds or removes the Explorer "Open with Argos"
// context-menu entries. One `reg import` of this script replaces the handful of separate
// reg.exe runs (each with its own conhost) the app used to start on every launch.
//
// Two keys cover both cases the user reaches from Explorer:
//   • Directory\shell\Argos            — right-clicking a folder icon
//   • Directory\Background\shell\Argos — right-clicking empty space *inside* a folder
// Each has a `command` subkey whose default value launches us with `--folder "%V"`,
// where Explorer substitutes %V with the folder path.

const BASE = 'HKEY_CURRENT_USER\\Software\\Classes\\Directory'
export const MENU_KEYS = [`${BASE}\\shell\\Argos`, `${BASE}\\Background\\shell\\Argos`]
// Keys written under the app's former name. Their `command` still points at the old exe, so
// they'd sit in the Explorer menu as a dead "Open with Claude GUI" entry.
export const LEGACY_MENU_KEYS = [`${BASE}\\shell\\ClaudeGUI`, `${BASE}\\Background\\shell\\ClaudeGUI`]

export interface ExplorerMenuPlan {
  /** true writes the entries, false deletes them, undefined leaves them alone. */
  enabled?: boolean
  /** Also delete the pre-rename ClaudeGUI entries. */
  removeLegacy?: boolean
  /** The command Explorer runs (already containing `--folder "%V"`). */
  command: string
  /** Path shown as the menu entry's icon. */
  icon: string
}

/** Quote a REG_SZ value for a .reg file: backslashes and double quotes are escaped. */
export function regString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The .reg script for a plan, or null when there is nothing to do. Deleting a key that
 * doesn't exist is a no-op for `reg import`, so removals need no existence check.
 */
export function buildExplorerMenuReg(plan: ExplorerMenuPlan): string | null {
  const sections: string[] = []
  if (plan.removeLegacy) {
    for (const key of LEGACY_MENU_KEYS) sections.push(`[-${key}]`)
  }
  if (plan.enabled === false) {
    for (const key of MENU_KEYS) sections.push(`[-${key}]`)
  } else if (plan.enabled === true) {
    for (const key of MENU_KEYS) {
      sections.push(`[${key}]\r\n@="Open with Argos"\r\n"Icon"=${regString(plan.icon)}`)
      sections.push(`[${key}\\command]\r\n@=${regString(plan.command)}`)
    }
  }
  if (sections.length === 0) return null
  return `Windows Registry Editor Version 5.00\r\n\r\n${sections.join('\r\n\r\n')}\r\n`
}
