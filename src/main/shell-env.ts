import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import {
  appendPathDirs,
  darwinFallbackDirs,
  parseEnvDump,
  shellEnvCommand,
  shellEnvUpdates
} from './shell-env-pure'

/**
 * macOS: give this process the PATH the user's own Terminal has. An app started from
 * Finder or the Dock inherits launchd's minimal PATH, so a bare `codex`, `gemini`, `agy`,
 * an npm-installed `claude` (whose shebang needs `node`) and MCP servers run through
 * `npx` are all "command not found". Linux has extendLinuxPath (linux-desktop.ts) for
 * the same problem; Windows needs neither.
 */

const SHELL_TIMEOUT_MS = 4000

/** Sync half: the usual install dirs that exist, appended. Cheap, safe to call first. */
export function extendDarwinPathStatic(): void {
  if (process.platform !== 'darwin') return
  try {
    const dirs = darwinFallbackDirs(os.homedir()).filter((d) => {
      try {
        return fs.statSync(d).isDirectory()
      } catch {
        return false
      }
    })
    process.env.PATH = appendPathDirs(process.env.PATH, dirs)
  } catch {
    /* never fail startup over PATH */
  }
}

/** Run the login shell once and return its stdout, or '' on any failure or timeout. */
function readLoginShellOutput(): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh'
    let out = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(out)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ilc', shellEnvCommand()], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Keep oh-my-zsh and friends from updating or attaching tmux on this throwaway run.
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' },
        detached: false
      })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      out = ''
      finish()
    }, SHELL_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      // An rc file that floods stdout should not grow this without bound.
      if (out.length < 4 * 1024 * 1024) out += chunk
    })
    child.on('error', () => {
      out = ''
      finish()
    })
    child.on('close', finish)
  })
}

let darwinEnvPromise: Promise<void> | null = null

/**
 * Async half: read the login shell's environment once (`$SHELL -ilc`, 4 s cap) and
 * merge its PATH (missing dirs in front) and SSH_AUTH_SOCK (only when unset) into
 * process.env. Memoised, never rejects, a no-op off macOS. Also applies the static
 * fallback dirs, so a failed or slow shell still leaves Homebrew and ~/.local/bin on PATH.
 */
export function extendDarwinEnv(): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  if (darwinEnvPromise) return darwinEnvPromise
  darwinEnvPromise = (async () => {
    try {
      const env = parseEnvDump(await readLoginShellOutput())
      if (env) Object.assign(process.env, shellEnvUpdates(process.env, env))
    } catch {
      /* keep launchd's env */
    }
    extendDarwinPathStatic()
  })()
  return darwinEnvPromise
}
