import { getRemoteClient } from './sftp'
import {
  listContainersCommand,
  parseContainerListing,
  type ContainerRuntime,
  type RemoteContainer
} from './remote-containers-pure'
import { t } from './i18n'

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

function runExec(hostId: string, command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return getRemoteClient(hostId, { interactive: true }).then((res) => {
    if (!res.ok) return { ok: false as const, error: res.error }
    return new Promise((resolve) => {
      let done = false
      let stdout = ''
      let channel: { close: () => void } | null = null
      const finish = (r: { ok: true; stdout: string } | { ok: false; error: string }) => {
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
      const timer = setTimeout(() => finish({ ok: false, error: t('main.containers.timedOut') }), TIMEOUT_MS)
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
            if (stdout.length > MAX_OUTPUT) finish({ ok: true, stdout: stdout.slice(0, MAX_OUTPUT) })
          })
          // Drained so the channel never stalls on a full stderr window; not shown.
          stream.stderr?.on('data', () => {})
          stream.on('close', () => finish({ ok: true, stdout }))
        })
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
  })
}

export async function remoteContainers(hostId: string): Promise<ContainerListResult> {
  if (typeof hostId !== 'string' || !hostId) return { ok: false, error: t('main.ssh.hostNotFound') }
  try {
    const res = await runExec(hostId, listContainersCommand())
    if (!res.ok) return { ok: false, error: res.error }
    const listing = parseContainerListing(res.stdout)
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
