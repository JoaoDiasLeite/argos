// The bubble's dictation, the parts with no audio device (docs/COMPANION_PLAN.md §4.2):
// the microphone's float samples down to 16 kHz, into the 16-bit mono WAV main parses
// (companion-voice-pure.ts parseWav), plus the meter, the timer and the silence stop.

export const TARGET_RATE = 16_000

/**
 * Resample to `toRate` by averaging each output sample's span of input — a box filter,
 * which is enough anti-aliasing for speech going to 16 kHz. Equal rates copy.
 * Output length is floor(input.length × toRate / fromRate).
 */
export function downsample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) return new Float32Array(0)
  if (fromRate === toRate) return input.slice()
  const outLength = Math.floor((input.length * toRate) / fromRate)
  const out = new Float32Array(outLength)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / (end - start)
  }
  return out
}

/** Float samples in [-1, 1] → a 16-bit PCM mono WAV, clipped rather than wrapped. */
export function encodeWav16(samples: Float32Array, sampleRate = TARGET_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  v.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true)
  }
  return buf
}

/** Concatenate the recorder's chunks. */
export function joinChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** A level for the meter, 0..1: -60 dBFS and below is empty, 0 dBFS full. */
export function meterLevel(value: number): number {
  if (!(value > 0)) return 0
  const db = 20 * Math.log10(value)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

/** "0:03", "1:20". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** RMS above this is speech (about -34 dBFS, over the noise suppressor's floor). */
export const SPEECH_RMS = 0.02
/** After speech, this much quiet ends the recording. */
export const SILENCE_STOP_MS = 1500
/** The hard stop. */
export const MAX_RECORD_MS = 30_000

/**
 * Auto-stop: nothing happens until speech is heard, then `SILENCE_STOP_MS` of continuous
 * quiet says 'stop'. Before any speech it never stops on its own (only the 30 s cap does).
 */
export function createSilenceGate(threshold = SPEECH_RMS, silenceMs = SILENCE_STOP_MS) {
  let heard = false
  let quietSince: number | null = null
  return {
    feed(level: number, now: number): 'continue' | 'stop' {
      if (level >= threshold) {
        heard = true
        quietSince = null
        return 'continue'
      }
      if (!heard) return 'continue'
      if (quietSince === null) quietSince = now
      return now - quietSince >= silenceMs ? 'stop' : 'continue'
    },
    get heard(): boolean {
      return heard
    }
  }
}
