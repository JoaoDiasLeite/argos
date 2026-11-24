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
