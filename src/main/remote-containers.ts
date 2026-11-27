import { getRemoteClient } from './sftp'
import {
  listContainersCommand,
  parseContainerListing,
  type ContainerRuntime,
  type RemoteContainer
} from './remote-containers-pure'
import { t } from './i18n'
import { rememberListing } from './container-listings'

/**
 * The Remote Session's Containers pane: lists a host's docker (or podman) containers over
 * an exec channel on the SAME ssh2 connection the file browser and terminal already use
 * (sftp.ts getRemoteClient). Read-only: entering a container is a tab of its own, whose
 * channel remote-shell.ts opens on an `exec -it` built from the validated id. Never throws
 * across the IPC boundary.
 */

export interface ContainerListResult {
  ok: boolean
  error?: string
  /** Null when the host has neither docker nor podman. */
  runtime?: ContainerRuntime | null
  /** The listing only worked through `sudo -n`, so the shell command uses sudo too. */
  sudo?: boolean
  containers?: RemoteContainer[]
}

const TIMEOUT_MS = 20000
const MAX_OUTPUT = 1024 * 1024
const MAX_STDERR = 16 * 1024

/** What one exec on the host came back with. `code` is null when the channel closed
 *  without an exit status (a dropped connection). */
export type ExecStatus =
  | { ok: true; code: number | null; stdout: string; stderr: string }
  | { ok: false; error: string; timedOut?: boolean }

/**
 * Runs one command on an exec channel of the host's shared connection, with no pty, and
 * reports its exit code, stdout and stderr (each capped). Gives up after `timeoutMs`, closing
 * the channel; whatever the command started on the host may still be going on.
 */
export function runExecStatus(hostId: string, command: string, timeoutMs: number): Promise<ExecStatus> {
  return getRemoteClient(hostId, { interactive: true }).then((res) => {
    if (!res.ok) return { ok: false as const, error: res.error }
    return new Promise<ExecStatus>((resolve) => {
      let done = false
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let channel: { close: () => void } | null = null
      const finish = (r: ExecStatus) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          channel?.close()
        } catch {
          // no-op
        }
        resolve(r)
      }
      const timer = setTimeout(() => finish({ ok: false, error: t('main.containers.timedOut'), timedOut: true }), timeoutMs)
      try {
        res.conn.exec(command, (err, stream) => {
          if (err) return finish({ ok: false, error: err.message })
          // Timed out before the channel opened: close it rather than leave it on the
          // shared connection, which only has so many.
          if (done) {
            try {
              stream.close()
            } catch {
              // no-op
            }
            return
          }
          channel = stream
          stream.on('data', (d: Buffer) => {
            stdout += d.toString('utf8')
            if (stdout.length > MAX_OUTPUT) finish({ ok: true, code, stdout: stdout.slice(0, MAX_OUTPUT), stderr })
          })
          // Read, and kept short, so the channel never stalls on a full stderr window.
          stream.stderr?.on('data', (d: Buffer) => {
            stderr = (stderr + d.toString('utf8')).slice(-MAX_STDERR)
          })
          stream.on('exit', (c: number | null) => {
            code = typeof c === 'number' ? c : null
          })
          stream.on('close', () => finish({ ok: true, code, stdout, stderr }))
        })
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  })
}

/** The listing's exec: only stdout matters, the script itself reports how it went. */
async function runExec(hostId: string, command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const r = await runExecStatus(hostId, command, TIMEOUT_MS)
  return r.ok ? { ok: true, stdout: r.stdout } : { ok: false, error: r.error }
}

export async function remoteContainers(hostId: string): Promise<ContainerListResult> {
  if (typeof hostId !== 'string' || !hostId) return { ok: false, error: t('main.ssh.hostNotFound') }
  try {
    const res = await runExec(hostId, listContainersCommand())
    if (!res.ok) {
      rememberListing(hostId, null)
      return { ok: false, error: res.error }
    }
    const listing = parseContainerListing(res.stdout)
    rememberListing(hostId, listing.kind === 'list' ? listing : null)
    switch (listing.kind) {
      case 'none':
        return { ok: true, runtime: null, containers: [] }
      case 'failed':
        return {
          ok: false,
          runtime: listing.runtime,
          error: t('main.containers.failed', { runtime: listing.runtime, detail: listing.detail || '—' })
        }
      case 'garbled':
        return { ok: false, error: t('main.containers.garbled') }
      case 'list':
        return {
          ok: true,
          runtime: listing.runtime,
          sudo: listing.sudo,
          containers: listing.containers
        }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
