/**
 * Pure half of the Remote Session's Containers pane (src/main/remote-containers.ts): the
 * listing script that runs on the host, the parser for what it prints, and the command
 * that opens a shell inside one container. Kept free of ssh2 and electron so it is
 * unit-testable.
 *
 * The listing asks docker first, then podman, and tries `sudo -n` when the plain call is
 * refused (a login user outside the `docker` group is the usual case on a server). `-n`
 * never prompts: a sudo that wants a password just fails, and the pane says so.
 *
 * The format avoids `{{.State}}`, which older docker (CentOS 7's 1.13) does not know and
 * would fail the whole listing over; "running" is read off `{{.Status}}` ("Up 3 hours").
 * Fields are joined with `|`, which no container id, name, image, port list or status
 * contains, rather than `\t`, whose escape docker and podman each handle their own way.
 *
 * The listing asks for the published ports and the two compose labels too, so the pane can
 * group containers by compose project. Only those two label values, never `{{.Labels}}`:
 * other labels are free text and may hold the separator. A runtime that refuses the longer
 * format (`.Label` is not known everywhere) is asked again with the four-field one, and its
 * containers are listed ungrouped. Status stays the last field in both.
 */

import { stripAnsi } from './secret-prompt-pure'

export type ContainerRuntime = 'docker' | 'podman'

export interface RemoteContainer {
  /** The short id as `ps` prints it; the only value ever put into a command. */
  id: string
  name: string
  image: string
  status: string
  running: boolean
  /** `com.docker.compose.project`, when the container belongs to a compose project. */
  project?: string
  /** `com.docker.compose.service`: the service's name inside that project. */
  service?: string
  /** Published ports as `host→container` (`8080→80`, `/udp` kept), without duplicates for
   *  the IPv4 and IPv6 bindings of one port. Absent when the runtime gave no port column. */
  ports?: string[]
}

export type ContainerListing =
  | { kind: 'list'; runtime: ContainerRuntime; sudo: boolean; containers: RemoteContainer[] }
  | { kind: 'none' }
  | { kind: 'failed'; runtime: ContainerRuntime; detail: string }
  | { kind: 'garbled' }

const MARK = '@@argos-containers'
/** The full row: ports and compose labels before the status. Seven fields. */
export const CONTAINER_FORMAT =
  '{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Status}}'
/** What any docker or podman understands. Four fields. */
export const CONTAINER_FORMAT_BASIC = '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'

/** Container ids as docker and podman print them: 12 hex characters, or the full 64. */
export const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/

/** POSIX single-quoting, as ssh.ts's shQuote does it. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The command run over an SSH exec channel. Wrapped in `sh -c` because the exec runs in the
 * login user's own shell, which may not be POSIX.
 */
export function listContainersCommand(): string {
  const script = [
    `F=${shQuote(CONTAINER_FORMAT)}`,
    `F0=${shQuote(CONTAINER_FORMAT_BASIC)}`,
    'for rt in docker podman; do',
    '  command -v "$rt" >/dev/null 2>&1 || continue',
    `  if out=$("$rt" ps -a --format "$F" 2>&1) || out=$("$rt" ps -a --format "$F0" 2>&1); then printf '%s %s\\n' ${MARK} "$rt"; printf '%s\\n' "$out"; exit 0; fi`,
    `  if out2=$(sudo -n "$rt" ps -a --format "$F" 2>/dev/null) || out2=$(sudo -n "$rt" ps -a --format "$F0" 2>/dev/null); then printf '%s sudo %s\\n' ${MARK} "$rt"; printf '%s\\n' "$out2"; exit 0; fi`,
    `  printf '%s failed %s\\n' ${MARK} "$rt"; printf '%s\\n' "$out" | head -n 3; exit 0`,
    'done',
    `printf '%s none\\n' ${MARK}`
  ].join('\n')
  return `sh -c ${shQuote(script)}`
}

/** Reads what listContainersCommand printed. Anything before the marker (a noisy login
 *  banner on stdout) is skipped. */
export function parseContainerListing(stdout: string): ContainerListing {
  const lines = stdout.replace(/\r/g, '').split('\n')
  const at = lines.findIndex((l) => l.startsWith(`${MARK} `))
  if (at === -1) return { kind: 'garbled' }
  const head = lines[at].slice(MARK.length + 1).trim().split(/\s+/)
  const rest = lines.slice(at + 1)

  if (head[0] === 'none') return { kind: 'none' }
  if (head[0] === 'failed') {
    const runtime = asRuntime(head[1])
    if (!runtime) return { kind: 'garbled' }
    return { kind: 'failed', runtime, detail: rest.map((l) => l.trim()).filter(Boolean).join('\n') }
  }

  const sudo = head[0] === 'sudo'
  const runtime = asRuntime(sudo ? head[1] : head[0])
  if (!runtime) return { kind: 'garbled' }

  return { kind: 'list', runtime, sudo, containers: parseContainerRows(rest) }
}

/** The rows of a `ps -a` in either format, running first, then by name: the ones you can
 *  enter are what you came for. Lines that are not a row are skipped. */
export function parseContainerRows(lines: string[]): RemoteContainer[] {
  const containers: RemoteContainer[] = []
  for (const line of lines) {
    const c = parseRow(line)
    if (c) containers.push(c)
  }
  containers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
  return containers
}

function asRuntime(s: string | undefined): ContainerRuntime | null {
  return s === 'docker' || s === 'podman' ? s : null
}

function parseRow(line: string): RemoteContainer | null {
  const parts = line.replace(/\r$/, '').trim().split('|')
  if (parts.length < 4) return null
  const [id, name, image] = parts
  if (!CONTAINER_ID_RE.test(id)) return null
  const full = parts.length >= 7
  const status = parts.slice(full ? 6 : 3).join('|').trim()
  const row: RemoteContainer = { id, name: name.trim(), image: image.trim(), status, running: /^up\b/i.test(status) }
  if (full) {
    // Docker prints `<no value>` for a label the container does not have; podman, nothing.
    const label = (v: string) => {
      const x = v.trim()
      return x && x !== '<no value>' ? x : undefined
    }
    const project = label(parts[4])
    const service = label(parts[5])
    if (project) row.project = project
    if (service) row.service = service
    row.ports = parsePorts(parts[3])
  }
  return row
}

/**
 * The published ports out of a `{{.Ports}}` column, as `host→container`. Docker writes
 * `0.0.0.0:8080->80/tcp, :::8080->80/tcp, 22/tcp`; podman `0.0.0.0:8080->80/tcp`. A port
 * that is only exposed (`22/tcp`) is not reachable from outside and is left out; `/tcp`
 * is dropped as the default, `/udp` kept.
 */
export function parsePorts(column: string): string[] {
  const out: string[] = []
  for (const part of column.split(',')) {
    const m = /(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(\w+)\s*$/.exec(part.trim())
    if (!m) continue
    const text = `${m[1]}→${m[2]}${m[3] === 'tcp' ? '' : `/${m[3]}`}`
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/**
 * Typed into the session's terminal to enter a container: bash when the image has it, sh
 * otherwise. Only the validated id goes in, never the name or anything else the host sent.
 * Null for an id that is not one.
 */
export function containerShellCommand(runtime: ContainerRuntime, sudo: boolean, id: string): string | null {
  const args = containerShellArgs(runtime, id)
  if (!args) return null
  return `${sudo ? 'sudo ' : ''}${runtime} ${args.slice(0, -1).join(' ')} ${shQuote(args[args.length - 1])}`
}

/**
 * The same, as an argument vector for a local pty (this computer's docker), where nothing
 * goes through a shell: `exec -it <id> sh -c <pick>`. Null for an id that is not one.
 */
export function containerShellArgs(runtime: ContainerRuntime, id: string): string[] | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (!CONTAINER_ID_RE.test(id)) return null
  return ['exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
}

/** The tail sizes a logs tab offers. Only these ever reach a command line. */
export const CONTAINER_LOG_TAILS = ['200', '500', '2000', 'all'] as const
export type ContainerLogTail = (typeof CONTAINER_LOG_TAILS)[number]

export interface ContainerLogsOptions {
  /** `-f`: keep streaming. Off, the command prints what is there and exits. */
  follow: boolean
  tail: ContainerLogTail
  timestamps: boolean
}

/**
 * The logs options as they came over IPC, checked field by field. The tail is matched
 * against the fixed list and the list's own string is returned, never the input: a number
 * is accepted for the numeric sizes, any other type is refused (so `['all']`, whose String
 * is 'all', is not). The two switches must be real booleans. Null for anything else.
 */
export function readContainerLogsOptions(raw: unknown): ContainerLogsOptions | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as { follow?: unknown; tail?: unknown; timestamps?: unknown }
  if (typeof o.follow !== 'boolean' || typeof o.timestamps !== 'boolean') return null
  let tail: ContainerLogTail | undefined
  if (typeof o.tail === 'string') tail = CONTAINER_LOG_TAILS.find((x) => x === o.tail)
  else if (typeof o.tail === 'number') tail = CONTAINER_LOG_TAILS.find((x) => x !== 'all' && Number(x) === o.tail)
  if (!tail) return null
  return { follow: o.follow, tail, timestamps: o.timestamps }
}

/**
 * A container's logs as an argument vector for a local pty: `logs --tail <n> [-t] [-f]
 * <id>`. Only the validated id and the fixed-list tail go in. Null when either is not one.
 */
export function containerLogsArgs(runtime: ContainerRuntime, id: string, opts: unknown): string[] | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (typeof id !== 'string' || !CONTAINER_ID_RE.test(id)) return null
  const o = readContainerLogsOptions(opts)
  if (!o) return null
  return ['logs', '--tail', o.tail, ...(o.timestamps ? ['--timestamps'] : []), ...(o.follow ? ['-f'] : []), id]
}

/**
 * The same as one command line for an SSH exec channel, with `sudo` when the listing
 * needed it, exactly as the shell does. Every argument is already in a fixed set or a hex
 * id; the id is quoted anyway. Null for anything invalid.
 */
export function containerLogsCommand(runtime: ContainerRuntime, sudo: boolean, id: string, opts: unknown): string | null {
  const args = containerLogsArgs(runtime, id, opts)
  if (!args) return null
  return `${sudo === true ? 'sudo ' : ''}${runtime} ${args.slice(0, -1).join(' ')} ${shQuote(args[args.length - 1])}`
}

// ─── Start, stop and restart (experimental) ──────────────────────────────────

/** What a container or a compose project can be asked to do. Only these words ever reach a
 *  command line. */
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'] as const
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number]

export function isContainerAction(x: unknown): x is ContainerAction {
  return typeof x === 'string' && (CONTAINER_ACTIONS as readonly string[]).includes(x)
}

/** How long each action may take before it is given up on. A stop waits out docker's own
 *  grace period (10 s per container) and then some; a restart is a stop plus a start. */
export const CONTAINER_ACTION_TIMEOUT_MS: Record<ContainerAction, number> = {
  start: 60000,
  stop: 60000,
  restart: 90000
}

/**
 * `<action> <id>` as an argument vector for this computer's runtime. Null for anything that
 * is not a validated id and a word from the fixed list.
 */
export function containerActionArgs(runtime: ContainerRuntime, id: unknown, action: unknown): string[] | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (typeof id !== 'string' || !CONTAINER_ID_RE.test(id)) return null
  if (!isContainerAction(action)) return null
  return [action, id]
}

/**
 * The same as one command line for an SSH exec channel. These run without a pty, so the
 * sudo is `sudo -n`, as the listing's: nothing could answer a password prompt, and the
 * listing only reported sudo because `sudo -n` worked.
 */
export function containerActionCommand(runtime: ContainerRuntime, sudo: boolean, id: unknown, action: unknown): string | null {
  const args = containerActionArgs(runtime, id, action)
  if (!args) return null
  return `${sudo === true ? 'sudo -n ' : ''}${runtime} ${args[0]} ${shQuote(args[1])}`
}

/** Compose project names as compose itself allows them. */
export const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/
export const COMPOSE_PROJECT_MAX = 64

export function isComposeProject(x: unknown): x is string {
  return typeof x === 'string' && x.length <= COMPOSE_PROJECT_MAX && COMPOSE_PROJECT_RE.test(x)
}

/** Which compose program runs a project action: the runtime's own `compose` subcommand
 *  (v2, which finds the project by its labels, no compose file needed), or the old
 *  standalone `docker-compose`. */
export type ComposeFlavour = 'plugin' | 'standalone'

/**
 * A project action as a program and an argument vector: `<runtime> compose -p <project>
 * <action>`, or `docker-compose -p <project> <action>`. Podman has no standalone fallback
 * here. Null for an invalid project or action.
 */
export function composeActionArgv(
  runtime: ContainerRuntime,
  flavour: ComposeFlavour,
  project: unknown,
  action: unknown
): { cmd: string; args: string[] } | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (!isComposeProject(project) || !isContainerAction(action)) return null
  if (flavour === 'plugin') return { cmd: runtime, args: ['compose', '-p', project, action] }
  if (flavour === 'standalone' && runtime === 'docker') return { cmd: 'docker-compose', args: ['-p', project, action] }
  return null
}

/** The same as one command line for an SSH exec channel, `sudo -n` as for a container. The
 *  project is already in a quote-free alphabet; it is quoted anyway. */
export function composeActionCommand(
  runtime: ContainerRuntime,
  sudo: boolean,
  flavour: ComposeFlavour,
  project: unknown,
  action: unknown
): string | null {
  const argv = composeActionArgv(runtime, flavour, project, action)
  if (!argv) return null
  const args = argv.args.map((a, i) => (argv.args[i - 1] === '-p' ? shQuote(a) : a))
  return `${sudo === true ? 'sudo -n ' : ''}${argv.cmd} ${args.join(' ')}`
}

/**
 * The probe that says whether a compose program is there: its exit code is read, not its
 * output. Checked before the action rather than read off the action's error, so a project
 * action that really failed is never run a second time another way.
 */
export function composeProbeArgv(runtime: ContainerRuntime, flavour: ComposeFlavour): { cmd: string; args: string[] } | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (flavour === 'plugin') return { cmd: runtime, args: ['compose', 'version'] }
  if (flavour === 'standalone' && runtime === 'docker') return { cmd: 'docker-compose', args: ['version'] }
  return null
}

export function composeProbeCommand(runtime: ContainerRuntime, sudo: boolean, flavour: ComposeFlavour): string | null {
  const argv = composeProbeArgv(runtime, flavour)
  if (!argv) return null
  return `${sudo === true ? 'sudo -n ' : ''}${argv.cmd} ${argv.args.join(' ')}`
}

/**
 * What a failed action printed, for the row's note: escape sequences and blank lines out,
 * and only the last few lines (compose prints its progress on stderr before the error).
 * Empty when there is nothing readable.
 */
export function actionErrorText(stderr: string, maxLines = 4, maxChars = 400): string {
  const lines = stripAnsi(String(stderr ?? '').replace(/\r/g, ''))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const text = lines.slice(-maxLines).join('\n')
  return text.length > maxChars ? `…${text.slice(text.length - maxChars + 1)}` : text
}

// ─── CPU and memory (experimental) ───────────────────────────────────────────

export const STATS_FORMAT = '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'
export const STATS_TIMEOUT_MS = 15000

export interface ContainerStats {
  /** The id as stats printed it: docker prints 12 characters, podman may print more. */
  id: string
  /** Percent of one CPU, so above 100 on a busy multi-core host. Null when not given. */
  cpu: number | null
  /** `245MiB / 7.6GiB`, as the runtime wrote it. Empty when not given. */
  mem: string
  memPerc: number | null
}

export function containerStatsArgs(runtime: ContainerRuntime): string[] | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  return ['stats', '--no-stream', '--format', STATS_FORMAT]
}

export function containerStatsCommand(runtime: ContainerRuntime, sudo: boolean): string | null {
  const args = containerStatsArgs(runtime)
  if (!args) return null
  return `${sudo === true ? 'sudo -n ' : ''}${runtime} ${args.slice(0, -1).join(' ')} ${shQuote(args[args.length - 1])}`
}

function percent(v: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(v ?? '')
  return m ? Number(m[1]) : null
}

const MEM_USAGE_RE = /^[0-9.]+\s*[A-Za-z]{0,3}\s*\/\s*[0-9.]+\s*[A-Za-z]{0,3}$/

/**
 * The rows of a `stats --no-stream` in STATS_FORMAT. Values the runtime could not read
 * (`--`, a stopped container's empty fields) come back as null; a memory column that is
 * not plain sizes is dropped rather than passed on, since the row shows it as is. Lines
 * that are not a row are skipped.
 */
export function parseContainerStats(stdout: string): ContainerStats[] {
  const out: ContainerStats[] = []
  for (const raw of String(stdout ?? '').replace(/\r/g, '').split('\n')) {
    const parts = raw.trim().split('|')
    if (parts.length !== 4) continue
    const id = parts[0].trim()
    if (!CONTAINER_ID_RE.test(id)) continue
    const mem = parts[2].trim()
    out.push({
      id,
      cpu: percent(parts[1]),
      mem: MEM_USAGE_RE.test(mem) ? mem.replace(/\s+/g, ' ') : '',
      memPerc: percent(parts[3])
    })
  }
  return out
}

/** The stats row for a listed container: one id is a prefix of the other, whichever of the
 *  two the runtime shortened. */
export function statsFor(stats: ContainerStats[], id: string): ContainerStats | undefined {
  if (typeof id !== 'string' || id.length < 12) return undefined
  return stats.find((s) => s.id.startsWith(id) || id.startsWith(s.id))
}
