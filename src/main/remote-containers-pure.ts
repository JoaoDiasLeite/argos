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
 * Fields are joined with `|`, which no container id, name, image or status contains, rather
 * than `\t`, whose escape docker and podman each handle their own way.
 */

export type ContainerRuntime = 'docker' | 'podman'

export interface RemoteContainer {
  /** The short id as `ps` prints it; the only value ever put into a command. */
  id: string
  name: string
  image: string
  status: string
  running: boolean
}

export type ContainerListing =
  | { kind: 'list'; runtime: ContainerRuntime; sudo: boolean; containers: RemoteContainer[] }
  | { kind: 'none' }
  | { kind: 'failed'; runtime: ContainerRuntime; detail: string }
  | { kind: 'garbled' }

const MARK = '@@argos-containers'
const FORMAT = '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'

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
    `F=${shQuote(FORMAT)}`,
    'for rt in docker podman; do',
    '  command -v "$rt" >/dev/null 2>&1 || continue',
    `  if out=$("$rt" ps -a --format "$F" 2>&1); then printf '%s %s\\n' ${MARK} "$rt"; printf '%s\\n' "$out"; exit 0; fi`,
    `  if out2=$(sudo -n "$rt" ps -a --format "$F" 2>/dev/null); then printf '%s sudo %s\\n' ${MARK} "$rt"; printf '%s\\n' "$out2"; exit 0; fi`,
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

  const containers: RemoteContainer[] = []
  for (const line of rest) {
    const c = parseRow(line)
    if (c) containers.push(c)
  }
  // Running first, then by name: the ones you can enter are what you came for.
  containers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name))
  return { kind: 'list', runtime, sudo, containers }
}

function asRuntime(s: string | undefined): ContainerRuntime | null {
  return s === 'docker' || s === 'podman' ? s : null
}

function parseRow(line: string): RemoteContainer | null {
  const parts = line.trim().split('|')
  if (parts.length < 4) return null
  const [id, name, image] = parts
  const status = parts.slice(3).join('|').trim()
  if (!CONTAINER_ID_RE.test(id)) return null
  return { id, name: name.trim(), image: image.trim(), status, running: /^up\b/i.test(status) }
}

/**
 * Typed into the session's terminal to enter a container: bash when the image has it, sh
 * otherwise. Only the validated id goes in, never the name or anything else the host sent.
 * Null for an id that is not one.
 */
export function containerShellCommand(runtime: ContainerRuntime, sudo: boolean, id: string): string | null {
  if (runtime !== 'docker' && runtime !== 'podman') return null
  if (!CONTAINER_ID_RE.test(id)) return null
  const pick = shQuote('command -v bash >/dev/null 2>&1 && exec bash || exec sh')
  return `${sudo ? 'sudo ' : ''}${runtime} exec -it ${id} sh -c ${pick}`
}
