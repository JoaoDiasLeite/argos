import { Worker } from 'worker_threads'
import { cpus } from 'os'
import {
  IDLE_UNLOAD_MS,
  SAMPLE_RATE,
  cleanTranscript,
  parseWav,
  recognizerConfig,
  vadConfig,
  voiceThreads
} from './companion-voice-pure'
import type { VoiceWorkerMessage, VoiceWorkerRequest } from './companion-voice-worker'
import type { CompanionVoiceResult } from './companion-types'

// The main-process side of the speech engine (docs/COMPANION_PLAN.md §4.2): starts the
// worker (companion-voice-worker.ts) on demand, asks it one thing at a time, and ends it
// after five idle minutes, which frees the recognizer and its ~1 GB with it. No Electron
// import, so a test driver can run it under the repo's electron.exe on its own.

type Reply = Exclude<VoiceWorkerMessage, { op: 'ready' }>
type RequestBody = VoiceWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export interface VoiceEngineOptions {
  /** The built worker script (out/main/companion-voice-worker.js, unpacked when packaged). */
  workerPath: string
  idleMs?: number
  log?: (line: string) => void
}

export interface TranscribeOptions {
  /** Whisper's language; Portuguese unless a test says otherwise. */
  language?: string
}

/** The engine's own answer, with the timings the driver and the log want. */
export type EngineResult = CompanionVoiceResult & { speechSeconds?: number; loadMs?: number; decodeMs?: number }

export class VoiceEngine {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, (r: Reply) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private loadedKey = ''
  /** null until the addon has been tried; then whether it loaded, and why not. */
  engineOk: boolean | null = null
  engineError: string | null = null

  constructor(private readonly opts: VoiceEngineOptions) {}

  /** The recognizer is in memory: the next dictation skips the ~4 s load. */
  get warm(): boolean {
    return !!this.worker && this.loadedKey !== ''
  }

  /** Whether the addon loads here; tried once (in a short-lived worker), then remembered. */
  async probe(): Promise<boolean> {
    if (this.engineOk !== null) return this.engineOk
    try {
      await this.start()
      this.armIdle()
    } catch {
      // engineError holds the reason
    }
    return this.engineOk ?? false
  }

  /** Load the recognizer now, while the recording runs. */
  async prepare(modelDir: string, opts: TranscribeOptions = {}): Promise<void> {
    if (this.busy) return
    const recognizer = recognizerConfig(modelDir, voiceThreads(cpus().length), opts.language)
    const key = JSON.stringify(recognizer)
    if (this.loadedKey === key && this.worker) return
    const r = await this.request({ op: 'load', recognizer })
    if (r.ok) {
      this.loadedKey = key
      if (r.loadMs) this.opts.log?.(`[companion] speech recognizer loaded in ${r.loadMs} ms`)
    }
  }

  /** A WAV from the bubble → text. One at a time; the clip only ever lives in memory. */
  async transcribe(bytes: Uint8Array, modelDir: string, opts: TranscribeOptions = {}): Promise<EngineResult> {
    if (this.busy) return { ok: false, error: 'busy' }
    const clip = parseWav(bytes)
    if (!clip.ok) return { ok: false, error: clip.error }
    this.busy = true
    const started = Date.now()
    try {
      const recognizer = recognizerConfig(modelDir, voiceThreads(cpus().length), opts.language)
      const r = await this.request(
        { op: 'transcribe', recognizer, vad: vadConfig(modelDir), samples: clip.samples, sampleRate: SAMPLE_RATE },
        [clip.samples.buffer as ArrayBuffer]
      )
      if (!r.ok) return { ok: false, error: 'failed', detail: r.error }
      if (!r.noSpeech) this.loadedKey = JSON.stringify(recognizer)
      if (r.loadMs) this.opts.log?.(`[companion] speech recognizer loaded in ${r.loadMs} ms`)
      const text = cleanTranscript(r.text)
      return {
        ok: true,
        text,
        ms: Date.now() - started,
        noSpeech: r.noSpeech || text === '',
        speechSeconds: r.speechSeconds,
        loadMs: r.loadMs,
        decodeMs: r.decodeMs
      }
    } catch (e) {
      return { ok: false, error: 'failed', detail: e instanceof Error ? e.message : String(e) }
    } finally {
      this.busy = false
    }
  }

  /** End the worker now (idle, or the app quitting). */
  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const w = this.worker
    this.worker = null
    this.ready = null
    this.loadedKey = ''
    for (const resolve of this.pending.values()) resolve({ id: 0, ok: false, error: 'the speech engine stopped' })
    this.pending.clear()
    void w?.terminate()
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    const worker = new Worker(this.opts.workerPath)
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      worker.once('message', (m: VoiceWorkerMessage) => {
        if ('op' in m && m.op === 'ready') {
          this.engineOk = m.ok
          this.engineError = m.ok ? null : m.error
          if (m.ok) resolve()
          else {
            this.dispose()
            reject(new Error(m.error))
          }
        }
      })
      worker.on('message', (m: VoiceWorkerMessage) => {
        if ('id' in m) {
          const resolveReply = this.pending.get(m.id)
          this.pending.delete(m.id)
          resolveReply?.(m)
        }
      })
      worker.on('error', (e) => {
        this.opts.log?.(`[companion] the speech worker failed: ${e instanceof Error ? e.stack : String(e)}`)
        if (this.engineOk === null) {
          this.engineOk = false
          this.engineError = e instanceof Error ? e.message : String(e)
        }
        if (this.worker === worker) this.dispose()
        reject(e)
      })
      worker.on('exit', () => {
        if (this.worker === worker) this.dispose()
      })
    })
    // A rejection nobody awaited yet must not surface as unhandled.
    this.ready.catch(() => {})
    return this.ready
  }

  private async request(body: RequestBody, transfer: ArrayBuffer[] = []): Promise<Reply> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    try {
      await this.start()
      const worker = this.worker
      if (!worker) return { id: 0, ok: false, error: 'the speech engine stopped' }
      const id = this.nextId++
      return await new Promise<Reply>((resolve) => {
        this.pending.set(id, resolve)
        worker.postMessage({ ...body, id } as VoiceWorkerRequest, transfer)
      })
    } finally {
      this.armIdle()
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.busy || this.pending.size) return this.armIdle()
      this.dispose()
    }, this.opts.idleMs ?? IDLE_UNLOAD_MS)
    // Never what keeps a process (or a test driver) alive.
    this.idleTimer.unref?.()
  }
}
