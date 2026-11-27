import { execFile } from 'child_process'
import {
  CONTAINER_FORMAT,
  CONTAINER_FORMAT_BASIC,
  parseContainerRows,
  type ContainerRuntime,
  type RemoteContainer
} from './remote-containers-pure'
import { t } from './i18n'
import { rememberListing } from './container-listings'

/**
 * The Servers screen's local containers: this computer's docker (Docker Desktop on
 * Windows), or podman when there is no docker. Read-only, like the remote pane; a shell
 * inside one is a pty that remote-shell.ts opens (localContainerShellCreate). Run without a
 * shell, with an argument vector, so nothing here is ever parsed as a command line.
 * Never throws across the IPC boundary.
 */

export interface LocalContainerList {
  ok: boolean
  error?: string
  /** Null when neither docker nor podman is installed. */
  runtime?: ContainerRuntime | null
  /** The runtime is installed but its engine is not answering (Docker Desktop stopped). */
  notRunning?: boolean
  sudo?: false
  containers?: RemoteContainer[]
}

const TIMEOUT_MS = 15000
const MAX_OUTPUT = 1024 * 1024

type Run = { kind: 'ok'; stdout: string } | { kind: 'missing' } | { kind: 'failed'; detail: string }

function run(cmd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ kind: 'ok', stdout: String(stdout) })
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return resolve({ kind: 'missing' })
        const killed = (err as { killed?: boolean }).killed
        const detail = killed ? t('main.containers.localTimedOut', { runtime: cmd }) : String(stderr || err.message).trim()
        resolve({ kind: 'failed', detail })
      })
    } catch (e) {
      resolve({ kind: 'failed', detail: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** What docker and podman print when the CLI is there and the engine behind it is not.
 *  Docker 28 says "failed to connect to the docker API at …", older ones "error during
 *  connect" or "Cannot connect to the Docker daemon". */
const ENGINE_DOWN_RE =
  /cannot connect to the docker daemon|failed to connect to the docker api|error during connect|docker_engine|dockerdesktoplinuxengine|daemon is running|cannot connect to podman|unable to connect to podman/i

export async function localContainers(): Promise<LocalContainerList> {
  const r = await listLocal()
  rememberListing(null, r.ok && r.runtime ? { runtime: r.runtime, sudo: false, containers: r.containers ?? [] } : null)
  return r
}

async function listLocal(): Promise<LocalContainerList> {
  try {
    for (const runtime of ['docker', 'podman'] as const) {
      let res = await run(runtime, ['ps', '-a', '--format', CONTAINER_FORMAT])
      if (res.kind === 'missing') continue
      // A runtime that does not know `.Label` refuses the long format: list ungrouped.
      if (res.kind === 'failed' && !ENGINE_DOWN_RE.test(res.detail)) {
        const basic = await run(runtime, ['ps', '-a', '--format', CONTAINER_FORMAT_BASIC])
        if (basic.kind !== 'missing') res = basic
      }
      if (res.kind === 'ok') {
        return { ok: true, runtime, sudo: false, containers: parseContainerRows(res.stdout.split('\n')) }
      }
      if (res.kind === 'failed') {
        if (ENGINE_DOWN_RE.test(res.detail)) return { ok: false, runtime, notRunning: true }
        return {
          ok: false,
          runtime,
          error: t('main.containers.localFailed', { runtime, detail: res.detail.split('\n').slice(0, 3).join('\n') || '—' })
        }
      }
    }
    return { ok: true, runtime: null, containers: [] }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
