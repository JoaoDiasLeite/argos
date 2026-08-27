import { app, Notification, shell } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import {
  HookInput,
  NOTIFY_SHOW_FLAG,
  NotifyPayload,
  buildDeepLink,
  encodeNotifyPayload,
  encodedDirFor,
  isUrgent,
  notificationTitle,
  parseDeepLink,
  parseHookInput,
  projectLabel
} from './notify-hook-pure'
import { titleFromTranscript } from './notify-title'

/**
 * The process Claude Code's `Notification` hook starts.
 *
 * Two roles, told apart by argv:
 *
 * - **relay** (`--notify-hook`): read the hook's stdin JSON, work out what the
 *   notification says, and hand it to the running Argos through Electron's own
 *   single-instance channel — which is also how it learns whether Argos is running
 *   at all. Then exit. It must exit: Claude Code waits for this process, so a
 *   notifier that lingers is a notifier that stalls the CLI.
 * - **show** (`--notify-hook-show <payload>`): the detached process the relay
 *   starts when Argos is closed. It shows the notification itself and stays alive
 *   only long enough for the click, which opens Argos on the conversation.
 *
 * Everything here is best-effort and ends in `app.exit(0)`. A broken notifier must
 * never be the reason a session stops.
 */

/**
 * How long the detached process waits for a click before giving up.
 *
 * Nothing is blocked on this — the hook process is long gone — but a process per
 * unclicked notification is not free either, and a toast nobody answered in a
 * minute is one they will answer in the app instead.
 */
const CLICK_WINDOW_MS = 60_000

/** How long the stream fallback waits before giving up on a payload. */
const STDIN_TIMEOUT_MS = 2_000

/**
 * `ARGOS_NOTIFY_DRYRUN=1` prints what the hook worked out and shows nothing.
 *
 * Everything on this path is swallowed on purpose — a broken notifier must not be
 * the reason a session stops — which also means a notifier that does nothing looks
 * exactly like one that was never wired up. This is the line that tells the two
 * apart without reproducing the hook's environment by hand:
 *
 *   echo '{"cwd":"…","transcript_path":"…","session_id":"…"}' | Argos.exe --notify-hook
 */
function dryRun(fields: Record<string, unknown>): boolean {
  if (process.env.ARGOS_NOTIFY_DRYRUN !== '1') return false
  process.stdout.write(`${JSON.stringify(fields, null, 2)}\n`)
  return true
}

/**
 * The hook's payload, read from file descriptor 0.
 *
 * Measured on Windows: in Electron's main process `process.stdin` as a stream
 * delivers nothing at all — no `data`, no `end` — while a direct read of the same
 * descriptor returns the whole payload. So the descriptor is the primary path and
 * the stream is the fallback, not the other way around. This looked exactly like a
 * hook that was never wired up.
 *
 * The direct read blocks until the writer closes, which Claude Code does as soon as
 * it has written the JSON.
 */
function readStdin(): Promise<string> {
  try {
    return Promise.resolve(fs.readFileSync(0, 'utf-8'))
  } catch {
    // A non-blocking pipe (EAGAIN) or no descriptor at all — try the stream.
    return readStdinStream()
  }
}

function readStdinStream(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve(data)
    }
    // Reading the payload can't be what hangs the CLI either.
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    timer.unref?.()
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      finish()
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

/**
 * Turn a hook payload into the notification it becomes.
 *
 * The conversation's name comes from a bounded read of its transcript, and an
 * unreadable transcript is a normal outcome — a hook firing inside WSL hands us a
 * path this side of the boundary can't open. The project name is a good enough
 * subject on its own, so the notification still goes out.
 */
export async function buildNotifyPayload(input: HookInput): Promise<NotifyPayload> {
  const project = projectLabel(input.cwd)
  const conversation = await titleFromTranscript(input.transcriptPath)
  const encodedDir = encodedDirFor(input.transcriptPath)
  const link =
    input.sessionId && encodedDir
      ? buildDeepLink({ encodedDir, sessionId: input.sessionId })
      : null
  return {
    title: notificationTitle(project, conversation || project),
    body: input.message || 'Claude needs you',
    link: link ?? '',
    urgent: isUrgent(input.notificationType)
  }
}

/**
 * Show one hook notification. `onClick` is what the click does — focus the running
 * window, or open the app through the protocol from the detached process.
 */
export function showHookNotification(payload: NotifyPayload, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: payload.title,
    body: payload.body,
    silent: !payload.urgent,
    urgency: payload.urgent ? 'critical' : 'normal'
  })
  n.on('click', onClick)
  n.show()
}

/** Spawn ourselves, detached, to show a notification this process can't stay for. */
function spawnDetachedShow(payload: NotifyPayload): void {
  try {
    const args = app.isPackaged ? [] : [app.getAppPath()]
    args.push(NOTIFY_SHOW_FLAG, encodeNotifyPayload(payload))
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
  } catch {
    // Nothing to fall back to, and nothing worth failing the hook over.
  }
}

/**
 * The relay role. Returns without showing anything when Argos is running: the lock
 * request carries the payload to it, and its `second-instance` handler takes over.
 */
export async function runNotifyRelay(): Promise<void> {
  try {
    const raw = await readStdin()
    const input = parseHookInput(raw)
    if (!input) {
      dryRun({ error: 'stdin was not a JSON object', bytes: raw.length })
      return
    }
    const payload = await buildNotifyPayload(input)
    // The lock is the question and the delivery in one call: not getting it means an
    // Argos is already running, and it has just been handed the payload.
    const alone = app.requestSingleInstanceLock({ argosNotify: payload })
    if (dryRun({ ...payload, delivery: alone ? 'detached process' : 'the running Argos' })) {
      if (alone) app.releaseSingleInstanceLock()
      return
    }
    if (!alone) return
    // We are the only Argos there is — and we are about to exit, so we must not sit
    // on the lock a real launch is waiting for.
    app.releaseSingleInstanceLock()
    spawnDetachedShow(payload)
  } catch (err) {
    // Best effort, always. Falling over here would surface as a hook error in the
    // user's session, which is a worse outcome than a missed notification.
    dryRun({ error: String(err) })
  }
}

/** The detached role: show it, wait for the click, then go. */
export function runNotifyShow(payload: NotifyPayload): void {
  const quit = (): void => app.exit(0)
  const timer = setTimeout(quit, CLICK_WINDOW_MS)
  showHookNotification(payload, () => {
    clearTimeout(timer)
    // The protocol client is registered by the real app, so this starts it (or
    // focuses it, if it came up in the meantime) on the right conversation.
    if (payload.link) shell.openExternal(payload.link).catch(() => {})
    // Long enough for the launch to be handed off, not long enough to hang around.
    setTimeout(quit, 1_000)
  })
}

/** The payload a `second-instance` event is carrying, if it is carrying one. */
export function notifyPayloadFrom(additionalData: unknown): NotifyPayload | null {
  if (!additionalData || typeof additionalData !== 'object') return null
  const p = (additionalData as { argosNotify?: unknown }).argosNotify
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (typeof o.title !== 'string' || !o.title) return null
  // Re-validated, like every other entry point: any process on the machine can ask
  // for this lock, and the value ends up as a URL the app opens.
  const link = typeof o.link === 'string' && parseDeepLink(o.link) ? o.link : ''
  return {
    title: o.title,
    body: typeof o.body === 'string' ? o.body : '',
    link,
    urgent: o.urgent === true
  }
}
