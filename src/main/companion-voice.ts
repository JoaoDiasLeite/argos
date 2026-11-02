import { app, net } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join, sep } from 'path'
import {
  DOWNLOAD_TOTAL_BYTES,
  VAD_DOWNLOAD,
  WHISPER_DIR,
  WHISPER_DOWNLOAD,
  argosModelsDir,
  badMembers,
  meetingNotesModelsDir,
  resolveModelRoot,
  tarExtractArgs
} from './companion-voice-pure'
import { VoiceEngine } from './companion-voice-engine'
import type { CompanionVoiceResult, CompanionVoiceStatus } from './companion-types'

// The companion's dictation (docs/COMPANION_PLAN.md §4.2): sherpa-onnx with Silero VAD to
// cut the clip down to speech and Whisper large-v3-turbo int8 to read it, run in a worker
// thread (companion-voice-worker.ts via companion-voice-engine.ts) so the main process —
// which polls the cursor every 50 ms for the pet — never blocks on it. Audio arrives from
// the bubble as a WAV in memory and never touches the disk or the network (§8). The
// recognizer loads on first use (~4 s), stays warm, and goes with the worker after five
// idle minutes. This file adds the models: where they are, and the first-use download.

// ─── Models ──────────────────────────────────────────────────────────────────

const ownModelsDir = (): string => argosModelsDir(app.getPath('userData'))

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/** meeting-notes' copy first (read-only, never written), then Argos's own. */
function modelRoot(): ReturnType<typeof resolveModelRoot> {
  return resolveModelRoot(
    [
      { source: 'meeting-notes', dir: meetingNotesModelsDir(process.platform, process.env) },
      { source: 'argos', dir: ownModelsDir() }
    ],
    fileSize
  )
}


// ─── The engine ──────────────────────────────────────────────────────────────

/**
 * The worker script beside this bundle. Packaged, it is read from app.asar.unpacked
 * (package.json build.asarUnpack), next to the unpacked addon it requires.
 */
function workerPath(): string {
  return join(__dirname, 'companion-voice-worker.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

const engine = new VoiceEngine({ workerPath: workerPath(), log: (line) => console.log(line) })

/** Load the recognizer ahead of need — the bubble asks when recording starts. */
export function prepareVoice(): void {
  const root = modelRoot()
  if (!root || install || engine.engineOk === false) return
  engine.prepare(root.dir).catch((e) => console.error('[companion] the speech recognizer did not load:', e))
}

/** A WAV from the bubble → text; empty (noSpeech) when VAD heard none, and Whisper is not asked. */
export async function transcribe(bytes: Uint8Array): Promise<CompanionVoiceResult> {
  const root = modelRoot()
  if (!root || install || !(await engine.probe())) return { ok: false, error: 'unavailable' }
  const r = await engine.transcribe(bytes, root.dir)
  if (!r.ok) {
    if (r.error === 'failed') console.error('[companion] transcription failed:', r.detail)
    return r
  }
  return { ok: true, text: r.text, ms: r.ms, noSpeech: r.noSpeech }
}

/** The app is quitting: end the worker. */
export function disposeVoice(): void {
  engine.dispose()
}

// ─── Status and progress ─────────────────────────────────────────────────────

interface Install {
  abort: AbortController
  child: ChildProcess | null
  received: number
  phase: 'download' | 'extract'
}

let install: Install | null = null
let lastInstallError: string | null = null
let onProgress: (status: CompanionVoiceStatus) => void = () => {}

/** Where `companion:voice-progress` goes (index.ts: the bubble and the main window). */
export function setVoiceProgressListener(fn: (status: CompanionVoiceStatus) => void): void {
  onProgress = fn
}

/** The status, once the engine has been tried (a worker loading the addon, the first time only). */
export async function voiceStatus(): Promise<CompanionVoiceStatus> {
  await engine.probe()
  return currentStatus()
}

function currentStatus(): CompanionVoiceStatus {
  const root = modelRoot()
  return {
    available: engine.engineOk === true && !!root && !install,
    platformSupported: engine.engineOk !== false,
    modelPresent: !!root,
    modelSource: root?.source ?? null,
    modelDir: root?.dir ?? (install ? ownModelsDir() : null),
    warm: engine.warm,
    downloading: !!install,
    progress: install ? { received: install.received, total: DOWNLOAD_TOTAL_BYTES, phase: install.phase } : null,
    error: engine.engineOk === false ? engine.engineError : lastInstallError
  }
}

let lastPush = 0
function pushProgress(force = false): void {
  const now = Date.now()
  if (!force && now - lastPush < 200) return
  lastPush = now
  onProgress(currentStatus())
}

// ─── Install (first use) ─────────────────────────────────────────────────────

class Cancelled extends Error {}

/** One file to `<dest>.part`, size-checked, then renamed into place. Adds to install.received. */
async function download(job: Install, url: string, dest: string, bytes: number): Promise<void> {
  const part = `${dest}.part`
  const res = await net.fetch(url, { signal: job.abort.signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const out = createWriteStream(part)
  const start = job.received
  let got = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      job.received = start + got
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      pushProgress()
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  } catch (e) {
    out.destroy()
    rmSync(part, { force: true })
    throw job.abort.signal.aborted ? new Cancelled() : e
  }
  if (got !== bytes) {
    rmSync(part, { force: true })
    throw new Error(`${url} came down as ${got} bytes, expected ${bytes}`)
  }
  renameSync(part, dest)
}

function systemTar(): string {
  // Windows 10+ ships bsdtar, which reads bzip2; Git's GNU tar earlier on PATH would not.
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

function extract(job: Install, archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemTar(), tarExtractArgs(archive, dest, WHISPER_DOWNLOAD.members), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    job.child = child
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()).slice(-2000))
    child.on('error', reject)
    child.on('close', (code) => {
      job.child = null
      if (job.abort.signal.aborted) reject(new Cancelled())
      else if (code === 0) resolve()
      else reject(new Error(`tar exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))
    })
  })
}

/**
 * Fetch the models into userData/companion/models: the VAD, then the Whisper archive,
 * from which only the int8 model and its tokens are extracted (into a staging folder,
 * moved into place once they check out). The archive is deleted either way.
 */
async function runInstall(job: Install): Promise<void> {
  const dir = ownModelsDir()
  const staging = join(dir, '.staging')
  const archive = join(dir, 'sherpa-onnx-whisper-turbo.tar.bz2')
  mkdirSync(dir, { recursive: true })
  try {
    const vad = join(dir, 'silero_vad.onnx')
    if (fileSize(vad) === VAD_DOWNLOAD.bytes) job.received += VAD_DOWNLOAD.bytes
    else await download(job, VAD_DOWNLOAD.url, vad, VAD_DOWNLOAD.bytes)
    await download(job, WHISPER_DOWNLOAD.url, archive, WHISPER_DOWNLOAD.bytes)
    job.phase = 'extract'
    pushProgress(true)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    await extract(job, archive, staging)
    const bad = badMembers((m) => fileSize(join(staging, m)))
    if (bad.length) throw new Error(`the archive did not hold ${bad.join(', ')}`)
    rmSync(join(dir, WHISPER_DIR), { recursive: true, force: true })
    renameSync(join(staging, WHISPER_DIR), join(dir, WHISPER_DIR))
  } finally {
    rmSync(archive, { force: true })
    rmSync(`${archive}.part`, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Start the first-use download, unless the models are there or it is already running. */
export function installVoiceModels(): CompanionVoiceStatus {
  if (install || modelRoot()) return currentStatus()
  const job: Install = { abort: new AbortController(), child: null, received: 0, phase: 'download' }
  install = job
  lastInstallError = null
  pushProgress(true)
  runInstall(job)
    .catch((e) => {
      if (e instanceof Cancelled) return
      lastInstallError = e instanceof Error ? e.message : String(e)
      console.error('[companion] the speech model download failed:', e)
    })
    .finally(() => {
      if (install === job) install = null
      pushProgress(true)
    })
  return currentStatus()
}

export function cancelVoiceInstall(): CompanionVoiceStatus {
  if (install) {
    install.abort.abort()
    install.child?.kill()
  }
  return currentStatus()
}

