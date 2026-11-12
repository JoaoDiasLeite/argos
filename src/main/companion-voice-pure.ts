/**
 * The companion's dictation, the parts with no Electron and no native addon
 * (docs/COMPANION_PLAN.md §4.2): where the speech models live, the clip the bubble sends,
 * the voice-activity segments, and what comes back from Whisper. companion-voice.ts runs
 * the engine; this is what its tests can reach.
 *
 * The engine is sherpa-onnx with Silero VAD and Whisper large-v3-turbo int8 — the same
 * models the meeting-notes plugin keeps in %LOCALAPPDATA%\meeting-notes\models, which are
 * reused read-only when present.
 */
import { join } from 'path'
import type { Language } from '../shared/i18n'

/** The folder inside a models root that holds the Whisper files. */
export const WHISPER_DIR = 'sherpa-onnx-whisper-turbo'

export const MODEL_FILES = {
  vad: 'silero_vad.onnx',
  encoder: `${WHISPER_DIR}/turbo-encoder.int8.onnx`,
  decoder: `${WHISPER_DIR}/turbo-decoder.int8.onnx`,
  tokens: `${WHISPER_DIR}/turbo-tokens.txt`
} as const

/**
 * What the first-use download fetches. sherpa-onnx publishes no checksums for these, so
 * each download is checked by its size, and the installed files against MODEL_SHA256. (In meeting-notes' copy, extracted from this archive, they
 * are 674,716,297 / 361,080,764 / 816,730 bytes — about 1 GB on disk.)
 */
export const VAD_DOWNLOAD = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  bytes: 643_854
} as const
export const WHISPER_DOWNLOAD = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
  bytes: 563_790_207,
  /** Only the int8 model and its tokens; the archive also carries the fp32 model and test wavs. */
  members: [MODEL_FILES.encoder, MODEL_FILES.decoder, MODEL_FILES.tokens] as string[]
} as const
export const DOWNLOAD_TOTAL_BYTES = VAD_DOWNLOAD.bytes + WHISPER_DOWNLOAD.bytes

/**
 * SHA-256 of each file the download installs, checked before it is moved into place:
 * a size can match a truncated or tampered file, a hash cannot. sherpa-onnx publishes
 * none, so these were taken from meeting-notes' copy (same release, same sizes as above)
 * on 2026-11-12. A mismatch deletes the file and fails the install.
 */
export const MODEL_SHA256: Record<keyof typeof MODEL_FILES, string> = {
  vad: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  encoder: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b',
  decoder: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547',
  tokens: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
}

/** The files whose hash is not the pinned one (null = could not be read). */
export function hashMismatches(
  files: readonly (keyof typeof MODEL_FILES)[],
  sha256: (file: keyof typeof MODEL_FILES) => string | null
): (keyof typeof MODEL_FILES)[] {
  return files.filter((f) => sha256(f)?.toLowerCase() !== MODEL_SHA256[f])
}

/** The rate the bubble records at and the models expect. */
export const SAMPLE_RATE = 16_000
/** A clip longer than this is refused (the bubble stops recording at 30 s). */
export const MAX_CLIP_SECONDS = 30
/** And a payload bigger than this, whatever its header says. */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024
/** The warm recognizer is dropped after this long without a dictation. */
export const IDLE_UNLOAD_MS = 5 * 60 * 1000

export const VAD_CONFIG = { threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512 } as const

// ─── Models ──────────────────────────────────────────────────────────────────

/** meeting-notes' models folder, on Windows only (it is a Windows plugin). */
export function meetingNotesModelsDir(platform: string, env: Record<string, string | undefined>): string | null {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return null
  return join(env.LOCALAPPDATA, 'meeting-notes', 'models')
}

/** Argos's own copy, downloaded on first use. */
export function argosModelsDir(userData: string): string {
  return join(userData, 'companion', 'models')
}

export function modelPaths(root: string): Record<keyof typeof MODEL_FILES, string> {
  return {
    vad: join(root, MODEL_FILES.vad),
    encoder: join(root, MODEL_FILES.encoder),
    decoder: join(root, MODEL_FILES.decoder),
    tokens: join(root, MODEL_FILES.tokens)
  }
}

export interface ModelCandidate {
  source: 'meeting-notes' | 'argos'
  dir: string | null
}

/**
 * The first candidate whose four files are all there and non-empty: meeting-notes' copy
 * before Argos's own. `size` returns -1 for a missing file.
 */
export function resolveModelRoot(
  candidates: ModelCandidate[],
  size: (path: string) => number
): { source: 'meeting-notes' | 'argos'; dir: string } | null {
  for (const c of candidates) {
    if (!c.dir) continue
    const paths = Object.values(modelPaths(c.dir))
    if (paths.every((p) => size(p) > 0)) return { source: c.source, dir: c.dir }
  }
  return null
}

/** `tar -xjf <archive> -C <dest> <members…>` — Windows' built-in bsdtar reads bzip2. */
export function tarExtractArgs(archive: string, dest: string, members: string[]): string[] {
  return ['-xjf', archive, '-C', dest, ...members]
}

/** The members that did not come out of the archive (missing or empty). `size` is -1 for missing. */
export function badMembers(size: (member: string) => number): string[] {
  return WHISPER_DOWNLOAD.members.filter((member) => !(size(member) > 0))
}

/** 0..1 of a download, safe for a missing or zero total. */
export function progressFraction(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, received / total))
}

/** Whole megabytes (10^6), as Settings shows "78 / 564 MB". */
export function megabytes(bytes: number): number {
  return Math.round(Math.max(0, bytes) / 1e6)
}

// ─── The engine ──────────────────────────────────────────────────────────────

/** Threads for the recognizer: up to 8 (the spike's sweet spot), never more than the cores. */
export function voiceThreads(cpuCount: number): number {
  return Math.max(1, Math.min(8, Math.floor(cpuCount) || 1))
}

/**
 * Whisper's language code for the app's UI language: dictation is read in the language
 * the app is set to, so an English UI is not transcribed as Portuguese.
 */
export function whisperLanguage(uiLanguage: Language): 'en' | 'pt' {
  return uiLanguage === 'pt-PT' ? 'pt' : 'en'
}

/** sherpa-onnx's OfflineRecognizer config for Whisper turbo; Portuguese unless told otherwise. */
export function recognizerConfig(root: string, threads: number, language = 'pt') {
  const p = modelPaths(root)
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: p.encoder, decoder: p.decoder, language, task: 'transcribe' },
      tokens: p.tokens,
      numThreads: threads,
      provider: 'cpu'
    }
  }
}

export function vadConfig(root: string) {
  return {
    sileroVad: { model: modelPaths(root).vad, ...VAD_CONFIG },
    sampleRate: SAMPLE_RATE,
    numThreads: 1
  }
}

// ─── The clip ────────────────────────────────────────────────────────────────

export type ParsedClip =
  | { ok: true; samples: Float32Array; sampleRate: number; seconds: number }
  | { ok: false; error: 'invalid' | 'too-long' }

/**
 * A 16 kHz mono 16-bit PCM WAV, as the bubble encodes it, to float samples in [-1, 1).
 * Anything else — another rate, stereo, float PCM, a truncated header — is 'invalid';
 * over 30 s (or 2 MB) is 'too-long'. Walks the chunks, so a LIST chunk before data is fine.
 */
export function parseWav(bytes: Uint8Array): ParsedClip {
  if (bytes.byteLength > MAX_CLIP_BYTES) return { ok: false, error: 'too-long' }
  if (bytes.byteLength < 44) return { ok: false, error: 'invalid' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, error: 'invalid' }
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
        return { ok: false, error: 'invalid' }
      }
      const len = Math.min(size, bytes.byteLength - body) & ~1
      const n = len / 2
      const seconds = n / SAMPLE_RATE
      if (seconds > MAX_CLIP_SECONDS + 0.5) return { ok: false, error: 'too-long' }
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(body + i * 2, true) / 32768
      return { ok: true, samples, sampleRate: SAMPLE_RATE, seconds }
    }
    at = body + size + (size & 1)
  }
  return { ok: false, error: 'invalid' }
}

/**
 * What Whisper said, tidied: its bracketed markers ("[BLANK_AUDIO]", "(música)",
 * "*risos*", "♪") removed, lines joined, spaces collapsed. Empty when that was all it said.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** The dictation accelerators to try, the preferred one first, without repeats. */
export function voiceShortcutCandidates(preferred: string | undefined, defaults: readonly string[]): string[] {
  return [preferred, ...defaults].filter((a, i, arr): a is string => !!a && arr.indexOf(a) === i)
}
