// The companion's speech engine, on its own thread (docs/COMPANION_PLAN.md §4.2).
//
// A worker_threads Worker, so loading Whisper (~4 s) and decoding a clip (~1 s) never
// hold up the main process, which polls the cursor every 50 ms for the pet. It is its own
// bundle (electron.vite.config.ts) and imports nothing of the app: only `sherpa-onnx-node`,
// so the packaged copy can run from app.asar.unpacked beside the unpacked addon without
// reaching a shared chunk inside the archive. Every config arrives ready-made from
// companion-voice-engine.ts; this file only runs it.
//
// Electron forbids external ArrayBuffers, so every sherpa call that takes an
// `enableExternalBuffer` flag is given `false`.
import { parentPort } from 'worker_threads'
import type * as Sherpa from 'sherpa-onnx-node'

/** Main → worker. */
export type VoiceWorkerRequest =
  | { id: number; op: 'load'; recognizer: unknown }
  | { id: number; op: 'transcribe'; recognizer: unknown; vad: unknown; samples: Float32Array; sampleRate: number }

/** Worker → main: the first message says whether the addon loaded; the rest answer requests. */
export type VoiceWorkerMessage =
  | { op: 'ready'; ok: true; version: string }
  | { op: 'ready'; ok: false; error: string }
  | { id: number; ok: true; text: string; noSpeech: boolean; speechSeconds: number; loadMs: number; decodeMs: number }
  | { id: number; ok: false; error: string }

/** Less speech than this after VAD is "nothing heard": Whisper is not asked. */
const MIN_SPEECH_SECONDS = 0.1

let sherpa: typeof Sherpa | null = null
let recognizer: Sherpa.OfflineRecognizer | null = null
let recognizerKey = ''

const post = (m: VoiceWorkerMessage): void => parentPort?.postMessage(m)

/** The recognizer for this config, built once and kept while the worker lives. */
function ensureRecognizer(config: unknown): { rec: Sherpa.OfflineRecognizer; loadMs: number } {
  const key = JSON.stringify(config)
  if (recognizer && recognizerKey === key) return { rec: recognizer, loadMs: 0 }
  const started = Date.now()
  recognizer = null
  recognizer = new sherpa!.OfflineRecognizer(config)
  recognizerKey = key
  return { rec: recognizer, loadMs: Date.now() - started }
}

/** The speech in a clip, end to end; empty when Silero heard none. */
function speechOnly(config: unknown, samples: Float32Array): Float32Array {
  const vad = new sherpa!.Vad(config, 60)
  const window = 512
  for (let i = 0; i < samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, Math.min(samples.length, i + window)))
  }
  vad.flush()
  const segments: Float32Array[] = []
  while (!vad.isEmpty()) {
    segments.push(new Float32Array(vad.front(false).samples))
    vad.pop()
  }
  const out = new Float32Array(segments.reduce((n, s) => n + s.length, 0))
  let at = 0
  for (const s of segments) {
    out.set(s, at)
    at += s.length
  }
  return out
}

function handle(req: VoiceWorkerRequest): VoiceWorkerMessage {
  if (req.op === 'load') {
    const { loadMs } = ensureRecognizer(req.recognizer)
    return { id: req.id, ok: true, text: '', noSpeech: true, speechSeconds: 0, loadMs, decodeMs: 0 }
  }
  const speech = speechOnly(req.vad, req.samples)
  const speechSeconds = speech.length / req.sampleRate
  // No speech: say so, rather than let Whisper invent a sentence out of the silence.
  if (speechSeconds < MIN_SPEECH_SECONDS) {
    return { id: req.id, ok: true, text: '', noSpeech: true, speechSeconds, loadMs: 0, decodeMs: 0 }
  }
  const { rec, loadMs } = ensureRecognizer(req.recognizer)
  const started = Date.now()
  const stream = rec.createStream()
  stream.acceptWaveform({ samples: speech, sampleRate: req.sampleRate })
  rec.decode(stream)
  const text = rec.getResult(stream).text ?? ''
  return { id: req.id, ok: true, text, noSpeech: false, speechSeconds, loadMs, decodeMs: Date.now() - started }
}

try {
  // A plain require: the bundle is CommonJS and the package is external.
  sherpa = require('sherpa-onnx-node') as typeof Sherpa
  post({ op: 'ready', ok: true, version: String(sherpa.version ?? '') })
} catch (e) {
  post({ op: 'ready', ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) })
}

parentPort?.on('message', (req: VoiceWorkerRequest) => {
  if (!sherpa) {
    post({ id: req.id, ok: false, error: 'the speech engine did not load' })
    return
  }
  try {
    post(handle(req))
  } catch (e) {
    post({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})
