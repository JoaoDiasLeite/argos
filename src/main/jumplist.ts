import { app } from 'electron'
import { t } from './i18n'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile } from './json-file'

// Windows Jump List: the menu that pops from the taskbar/Start icon on right-click.
// We surface a "New terminal" task plus the most recently active project folders, each
// re-launching the app with the same argv routing as the Explorer context menu.

const sessionsDir = path.join(app.getPath('userData'), 'sessions')

// Dev prefix so electron.exe boots our app (mirrors shell-integration.launchCommand),
// but for Jump List `args` we want ONLY the arguments — `program` is the exe itself.
function argsFor(extra: string): string {
  return app.isPackaged ? extra : `"${app.getAppPath()}" ${extra}`
}

interface RecentProject {
  projectPath: string
  lastActive: number
}

// Scan session files for distinct projectPaths, keyed by most recent activity.
function recentProjects(max: number): RecentProject[] {
  const byPath = new Map<string, number>()
  let files: string[]
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    try {
      const s = readJsonFile<{ projectPath?: string; updatedAt?: number }>(path.join(sessionsDir, f))
      const p = s.projectPath
      if (!p || typeof p !== 'string') continue
      const last = s.updatedAt || 0
      byPath.set(p, Math.max(byPath.get(p) ?? 0, last))
    } catch {
      /* skip unreadable/corrupt session file */
    }
  }
  return [...byPath.entries()]
    .map(([projectPath, lastActive]) => ({ projectPath, lastActive }))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, max)
}

let timer: NodeJS.Timeout | null = null

function buildAndSet(): void {
  try {
    const exe = process.execPath
    const projects = recentProjects(7)
    const recentItems = projects.map((p) => ({
      type: 'task' as const,
      program: exe,
      args: argsFor(`--folder "${p.projectPath}"`),
      title: path.basename(p.projectPath) || p.projectPath,
      description: p.projectPath,
      iconPath: exe,
      iconIndex: 0
    }))

    const categories: Electron.JumpListCategory[] = [
      {
        type: 'tasks',
        items: [
          {
            type: 'task',
            program: exe,
            // --new-chat stays the argv, so a Jump List pinned by an older build still works.
            args: argsFor('--new-chat'),
            title: t('main.jumplist.newTerminal'),
            description: 'Start a new Argos terminal',
            iconPath: exe,
            iconIndex: 0
          }
        ]
      }
    ]
    if (recentItems.length > 0) {
      categories.push({ type: 'custom', name: 'Recent projects', items: recentItems })
    }

    // setJumpList can fail (e.g. items rejected by the shell) — never let it crash.
    app.setJumpList(categories)
  } catch {
    /* jump list is decorative — ignore any failure */
  }
}

/**
 * Rebuild the Jump List from current sessions. Debounced so a burst of session
 * saves during streaming doesn't rebuild repeatedly.
 */
export function refreshJumpList(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(buildAndSet, 2000)
}
