import { execFile } from 'child_process'
import {
  CONTAINER_ACTION_TIMEOUT_MS,
  STATS_TIMEOUT_MS,
  actionErrorText,
  composeActionArgv,
  composeActionCommand,
  composeProbeArgv,
  composeProbeCommand,
  containerActionArgs,
  containerActionCommand,
  containerStatsArgs,
  containerStatsCommand,
  isComposeProject,
  isContainerAction,
  parseContainerStats,
  statsFor,
  type ComposeFlavour,
  type ContainerAction
} from './remote-containers-pure'
import { knownListing, type ContainerSourceKey, type KnownListing } from './container-listings'
import { runExecStatus } from './remote-containers'
import { t } from './i18n'

/**
 * Start, stop and restart a container or a whole compose project, and read the running
 * containers' CPU and memory, for the Containers panel (experimental: index.ts refuses all
 * of it with labs off). The source is a host id, or null for this computer. The runtime and
 * sudo come from the last listing main saw for that source (container-listings.ts), and the
 * container or project must be in it. Commands are built from validated values only: over
 * SSH as one command line on an exec channel of the host's connection, locally as an
 * argument vector with no shell. Never throws across the IPC boundary.
 */

export type ContainerActionResult = { ok: true } | { ok: false; error: string; reason?: 'labs-off' | 'unsupported' }

export type ContainerStatsResult =
  | { ok: true; stats: Record<string, { cpu: number | null; mem: string; memPerc: number | null }> }
  | { ok: false; reason?: 'labs-off' }

const MAX_OUTPUT = 1024 * 1024

type Ran = { ok: true; code: number | null; stdout: string; stderr: string } | { ok: false; error: string; timedOut?: boolean; missing?: boolean }

function runLocal(cmd: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (e.code === 'ENOENT') return resolve({ ok: false, error: e.message, missing: true })
        if (e.killed) return resolve({ ok: false, error: e.message, timedOut: true })
        resolve({ ok: true, code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout), stderr: String(stderr || err.message) })
      })
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** One program and its arguments, run where the source is: locally as given, remotely as
 *  the command line the pure builders made from the same values. */
function run(source: ContainerSourceKey, local: { cmd: string; args: string[] }, remote: string, timeoutMs: number): Promise<Ran> {
  return source === null ? runLocal(local.cmd, local.args, timeoutMs) : runExecStatus(source, remote, timeoutMs)
}

function sourceOk(source: unknown): source is ContainerSourceKey {
  return source === null || (typeof source === 'string' && source.length > 0)
}

function outcome(ran: Ran, runtime: string, action: ContainerAction, timeoutMs: number): ContainerActionResult {
  if (!ran.ok) {
    if (ran.timedOut) {
      return { ok: false, error: t('main.containers.actionTimedOut', { runtime, s: Math.round(timeoutMs / 1000) }) }
    }
    return { ok: false, error: ran.error }
  }
  // The exit code decides: compose writes its progress to stderr even when all went well.
  if (ran.code === 0) return { ok: true }
  const detail = actionErrorText(ran.stderr) || actionErrorText(ran.stdout)
  return {
    ok: false,
    error: detail || t('main.containers.actionFailed', { runtime, action, code: ran.code ?? '—' })
  }
}

export async function containerAction(source: unknown, id: unknown, action: unknown): Promise<ContainerActionResult> {
  try {
    if (!sourceOk(source)) return { ok: false, error: t('main.ssh.hostNotFound') }
    const known = knownListing(source)
    if (!known) return { ok: false, error: t('main.containers.notListed') }
    const args = containerActionArgs(known.runtime, id, action)
    const command = containerActionCommand(known.runtime, known.sudo, id, action)
    if (!args || !command || !isContainerAction(action)) return { ok: false, error: t('main.containers.actionInvalid') }
    if (!known.ids.includes(id as string)) return { ok: false, error: t('main.containers.notListed') }
    const timeoutMs = CONTAINER_ACTION_TIMEOUT_MS[action]
    const ran = await run(source, { cmd: known.runtime, args }, command, timeoutMs)
    return outcome(ran, known.runtime, action, timeoutMs)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Whether this compose program answers here, by exit code only. */
async function composeAvailable(source: ContainerSourceKey, known: KnownListing, flavour: ComposeFlavour): Promise<boolean> {
  const argv = composeProbeArgv(known.runtime, flavour)
  const command = composeProbeCommand(known.runtime, known.sudo, flavour)
  if (!argv || !command) return false
  const ran = await run(source, argv, command, 15000)
  return ran.ok && ran.code === 0
}

export async function composeAction(source: unknown, project: unknown, action: unknown): Promise<ContainerActionResult> {
  try {
    if (!sourceOk(source)) return { ok: false, error: t('main.ssh.hostNotFound') }
    const known = knownListing(source)
    if (!known) return { ok: false, error: t('main.containers.notListed') }
    if (!isComposeProject(project) || !isContainerAction(action)) return { ok: false, error: t('main.containers.projectInvalid') }
    if (!known.projects.has(project)) return { ok: false, error: t('main.containers.notListed') }

    // `<runtime> compose` first. Docker falls back to the standalone docker-compose only
    // when the subcommand is not there at all; podman has no fallback, and says so.
    let flavour: ComposeFlavour | null = null
    if (await composeAvailable(source, known, 'plugin')) flavour = 'plugin'
    else if (known.runtime === 'docker' && (await composeAvailable(source, known, 'standalone'))) flavour = 'standalone'
    if (!flavour) {
      return {
        ok: false,
        reason: 'unsupported',
        error: t(known.runtime === 'podman' ? 'main.containers.podmanComposeMissing' : 'main.containers.composeMissing')
      }
    }
    const argv = composeActionArgv(known.runtime, flavour, project, action)
    const command = composeActionCommand(known.runtime, known.sudo, flavour, project, action)
    if (!argv || !command) return { ok: false, error: t('main.containers.projectInvalid') }
    // A project's stop waits out each container's grace period in turn, so it gets the
    // same time per action as one container, times how many there are, within reason.
    const n = Math.min(Math.max(known.projects.get(project) ?? 1, 1), 5)
    const timeoutMs = CONTAINER_ACTION_TIMEOUT_MS[action] * n
    const ran = await run(source, argv, command, timeoutMs)
    return outcome(ran, argv.cmd, action, timeoutMs)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The running containers' CPU and memory, keyed by the listed id they belong to. Quiet on
 * purpose: anything that goes wrong is just `{ ok: false }`, and the rows show no figures.
 */
export async function containerStats(source: unknown): Promise<ContainerStatsResult> {
  try {
    if (!sourceOk(source)) return { ok: false }
    const known = knownListing(source)
    if (!known || known.running === 0) return { ok: false }
    const args = containerStatsArgs(known.runtime)
    const command = containerStatsCommand(known.runtime, known.sudo)
    if (!args || !command) return { ok: false }
    const ran = await run(source, { cmd: known.runtime, args }, command, STATS_TIMEOUT_MS)
    if (!ran.ok || ran.code !== 0) return { ok: false }
    const rows = parseContainerStats(ran.stdout)
    const stats: Record<string, { cpu: number | null; mem: string; memPerc: number | null }> = {}
    for (const id of known.ids) {
      const s = statsFor(rows, id)
      if (s) stats[id] = { cpu: s.cpu, mem: s.mem, memPerc: s.memPerc }
    }
    return { ok: true, stats }
  } catch {
    return { ok: false }
  }
}
