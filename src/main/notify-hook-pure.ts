/**
 * Claude Code's `Notification` hook, and the deep link its click follows.
 *
 * Pure: no `fs`, no `electron`. The half worth testing is the half that decides
 * what reaches a URL and what reaches the user's `settings.json`.
 *
 * Argos already notifies about its own runs. This hook is the other direction:
 * Claude Code fires it for *every* session on the machine — a console, an IDE, one
 * stopped on an approval — so the notification names the conversation that is
 * waiting rather than the app that happens to be open.
 */

/** The fields of the hook's stdin JSON this feature uses. */
export interface HookInput {
  message: string
  cwd: string
  transcriptPath: string
  sessionId: string
  notificationType: string
}

/** Where a notification click should land. */
export interface SessionTarget {
  /** Argos source id ('local', 'wsl:<distro>', 'account:<id>'), when known. */
  sourceId?: string
  encodedDir: string
  sessionId: string
}

/**
 * A session id reaches the deep link as a query parameter and comes back out of it
 * addressing a file. Real ids are `[0-9a-f-]`; anything else is dropped rather than
 * escaped, because a value that needs escaping here is not a session id.
 */
const SESSION_ID = /^[0-9a-fA-F-]+$/
/** Same charset as `safeSessionPath`'s `SAFE_ID` — this value ends up as a path segment. */
const ENCODED_DIR = /^[A-Za-z0-9._-]+$/
/** Source ids carry a colon (`wsl:Ubuntu`), which the two above must not allow. */
const SOURCE_ID = /^[A-Za-z0-9:._-]+$/

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Parse the hook's stdin JSON. Returns null for anything that isn't an object. */
export function parseHookInput(raw: string): HookInput | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  return {
    message: str(o.message),
    cwd: str(o.cwd),
    transcriptPath: str(o.transcript_path),
    sessionId: sanitizeSessionId(str(o.session_id)),
    notificationType: str(o.notification_type)
  }
}

/** The id if it looks like one, '' otherwise. */
export function sanitizeSessionId(id: string): string {
  return SESSION_ID.test(id) ? id : ''
}

/**
 * Last path segment, for POSIX and Windows paths alike.
 *
 * The hook can fire from a WSL session while this code runs on Windows (or the
 * reverse), so neither separator can be assumed.
 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** Short project name shown in the notification: the working directory's own name. */
export function projectLabel(cwd: string): string {
  return baseName(cwd)
}

/**
 * The encoded project directory a transcript sits in — the parent of the `.jsonl`.
 *
 * Derived from the path rather than re-encoded from `cwd`: the encoding is Claude
 * Code's, and a session that started elsewhere and was filed here would disagree.
 */
export function encodedDirFor(transcriptPath: string): string {
  const parts = transcriptPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2) return ''
  const dir = parts[parts.length - 2]
  // A transcript filed under `archived/` still belongs to the project above it.
  if (dir === 'archived' && parts.length >= 3) return parts[parts.length - 3]
  return dir
}

/** How much of a conversation title a toast can show before the OS truncates it. */
export const TITLE_MAX = 60

/** `[project] conversation`, on one line. */
export function notificationTitle(project: string, conversation: string): string {
  const conv = conversation.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  if (!project) return conv
  return conv ? `[${project}] ${conv}` : `[${project}]`
}

// ─── Deep link ───────────────────────────────────────────────────────────────

export const PROTOCOL = 'argos'

/**
 * `argos://session?...` for a conversation.
 *
 * Every value is validated, not escaped: the parts that make up this URL come from
 * a hook payload written by another process, and a parameter that needs escaping to
 * be safe here would be one we could not address a file with anyway.
 */
export function buildDeepLink(target: SessionTarget): string | null {
  if (!SESSION_ID.test(target.sessionId)) return null
  if (!ENCODED_DIR.test(target.encodedDir)) return null
  const params = new URLSearchParams()
  params.set('dir', target.encodedDir)
  params.set('sid', target.sessionId)
  if (target.sourceId && SOURCE_ID.test(target.sourceId)) params.set('src', target.sourceId)
  return `${PROTOCOL}://session?${params.toString()}`
}

/**
 * The reverse, applied to whatever arrives on argv or `open-url`.
 *
 * Re-validated here rather than trusted from `buildDeepLink`: anything on the
 * machine can invoke a registered protocol, so this is an untrusted entry point.
 */
export function parseDeepLink(url: string): SessionTarget | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${PROTOCOL}:`) return null
  if (u.hostname !== 'session') return null
  const dir = u.searchParams.get('dir') ?? ''
  const sid = u.searchParams.get('sid') ?? ''
  if (!ENCODED_DIR.test(dir) || !SESSION_ID.test(sid)) return null
  const src = u.searchParams.get('src') ?? ''
  const target: SessionTarget = { encodedDir: dir, sessionId: sid }
  if (src && SOURCE_ID.test(src)) target.sourceId = src
  return target
}

/** The first `argos://` argument in an argv array, or null. */
export function extractDeepLink(argv: string[]): SessionTarget | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) {
      const target = parseDeepLink(arg)
      if (target) return target
    }
  }
  return null
}

// ─── The block the user pastes ───────────────────────────────────────────────

export const NOTIFY_FLAG = '--notify-hook'
/**
 * The second, internal flag: show this notification, don't relay it.
 *
 * Used only when Argos is not running. The process the hook starts must exit at
 * once — Claude Code waits for it, and a notifier that blocks the CLI is worse than
 * no notifier — so it hands the payload to a detached process of its own and quits.
 */
export const NOTIFY_SHOW_FLAG = '--notify-hook-show'

export type NotifyMode =
  | { kind: 'relay' }
  | { kind: 'show'; payload: NotifyPayload }
  /** Launched as a hook, but with nothing usable to do — exit, never fall through. */
  | { kind: 'abort' }

/** What a notification carries once the transcript has been read. */
export interface NotifyPayload {
  title: string
  body: string
  /** `argos://…`, or '' when the ids didn't validate — then there is nothing to click through to. */
  link: string
  urgent: boolean
}

/** Payloads travel to the detached process as one argv entry. */
export function encodeNotifyPayload(payload: NotifyPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
}

/**
 * The reverse, with the link re-validated.
 *
 * Argv is not a trusted channel just because we usually write it: this is the one
 * place a string becomes a URL the app will open.
 */
export function decodeNotifyPayload(encoded: string): NotifyPayload | null {
  let obj: unknown
  try {
    obj = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  const title = str(o.title)
  if (!title) return null
  const link = str(o.link)
  return {
    title,
    body: str(o.body),
    link: link && parseDeepLink(link) ? link : '',
    urgent: o.urgent === true
  }
}

/**
 * Which of the two hook roles this process was launched in, if either.
 *
 * Returns null for a normal launch. A hook flag with an unusable payload returns
 * `abort` rather than null: falling through would boot the entire application —
 * windows, tray, scheduler — because one notification arrived malformed.
 */
export function notifyHookMode(argv: string[]): NotifyMode | null {
  const showIdx = argv.indexOf(NOTIFY_SHOW_FLAG)
  if (showIdx !== -1) {
    const payload = decodeNotifyPayload(argv[showIdx + 1] ?? '')
    return payload ? { kind: 'show', payload } : { kind: 'abort' }
  }
  if (argv.includes(NOTIFY_FLAG)) return { kind: 'relay' }
  return null
}

/**
 * Does this notification want the user now?
 *
 * A session stopped on a permission prompt is blocked until someone answers; an
 * idle-timeout notice is not. Only the first earns a sound and a critical urgency.
 */
export function isUrgent(notificationType: string): boolean {
  return notificationType === 'permission_prompt'
}

/**
 * The command string for the hook entry.
 *
 * Quoted, and the executable path alone — no shell built-ins, no redirection — so
 * it runs the same whether Claude Code hands it to `cmd.exe` or to `sh`. Dev builds
 * run through `electron.exe`, which needs the app directory as its first argument.
 */
export function notifyHookCommand(exePath: string, appPath = ''): string {
  const appArg = appPath ? ` "${appPath}"` : ''
  return `"${exePath}"${appArg} ${NOTIFY_FLAG}`
}

/**
 * The same command as a WSL session can reach it.
 *
 * A hook that fires inside a distro runs under that distro's shell, where the
 * Windows path means nothing but `/mnt/<drive>/…` reaches the same executable.
 * Returns null for anything that isn't a drive-letter path.
 */
export function wslHookCommand(exePath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(exePath)
  if (!m) return null
  const rest = m[2].replace(/\\/g, '/')
  return `"/mnt/${m[1].toLowerCase()}/${rest}" ${NOTIFY_FLAG}`
}

/**
 * The `settings.json` fragment to paste.
 *
 * Printed, never written. `~/.claude/settings.json` is the user's file and holds
 * far more than this one hook; a merge written by us is a merge we would have to be
 * right about every time, against a schema that is not ours.
 */
export function hookSettingsBlock(command: string): string {
  return JSON.stringify(
    {
      hooks: {
        Notification: [{ matcher: '', hooks: [{ type: 'command', command }] }]
      }
    },
    null,
    2
  )
}

/**
 * Is a hook of ours already wired up in the user's settings?
 *
 * Matched on the flag, not on the whole command: the exe path changes with every
 * install location and an equality test would report "not installed" forever.
 */
export function notifyHookInstalled(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== 'object') return false
  const entries = (hooks as Record<string, unknown>).Notification
  if (!Array.isArray(entries)) return false
  return entries.some((entry) => {
    const inner = (entry as { hooks?: unknown })?.hooks
    if (!Array.isArray(inner)) return false
    return inner.some((h) => str((h as { command?: unknown })?.command).includes(NOTIFY_FLAG))
  })
}
