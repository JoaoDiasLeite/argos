import { describe, expect, it } from 'vitest'
import { join } from 'path'
import {
  DOWNLOAD_TOTAL_BYTES,
  MODEL_FILES,
  WHISPER_DOWNLOAD,
  argosModelsDir,
  badMembers,
  cleanTranscript,
  megabytes,
  meetingNotesModelsDir,
  modelPaths,
  parseWav,
  progressFraction,
  recognizerConfig,
  resolveModelRoot,
  tarExtractArgs,
  vadConfig,
  voiceShortcutCandidates,
  voiceThreads
} from './companion-voice-pure'
import { encodeWav16 } from '../shared/companion-wav'

const MN = join('C:', 'Users', 'x', 'AppData', 'Local', 'meeting-notes', 'models')
const OWN = join('C:', 'ud', 'companion', 'models')

/** A size function over a set of present files. */
const sizes = (present: string[]) => (p: string) => (present.includes(p) ? 100 : -1)

describe('model folders', () => {
  it("meeting-notes' folder is under LOCALAPPDATA, on Windows only", () => {
    expect(meetingNotesModelsDir('win32', { LOCALAPPDATA: join('C:', 'L') })).toBe(join('C:', 'L', 'meeting-notes', 'models'))
    expect(meetingNotesModelsDir('win32', {})).toBeNull()
    expect(meetingNotesModelsDir('linux', { LOCALAPPDATA: '/x' })).toBeNull()
    expect(argosModelsDir(join('C:', 'ud'))).toBe(OWN)
  })

  it('names the four files under a root', () => {
    const p = modelPaths(MN)
    expect(p.vad).toBe(join(MN, 'silero_vad.onnx'))
    expect(p.encoder).toBe(join(MN, 'sherpa-onnx-whisper-turbo', 'turbo-encoder.int8.onnx'))
    expect(p.decoder).toBe(join(MN, 'sherpa-onnx-whisper-turbo', 'turbo-decoder.int8.onnx'))
    expect(p.tokens).toBe(join(MN, 'sherpa-onnx-whisper-turbo', 'turbo-tokens.txt'))
  })

  const candidates = [
    { source: 'meeting-notes' as const, dir: MN },
    { source: 'argos' as const, dir: OWN }
  ]

  it("prefers meeting-notes' copy when it is complete", () => {
    const all = [...Object.values(modelPaths(MN)), ...Object.values(modelPaths(OWN))]
    expect(resolveModelRoot(candidates, sizes(all))).toEqual({ source: 'meeting-notes', dir: MN })
  })

  it("falls back to Argos's own when meeting-notes lacks a file", () => {
    const partial = Object.values(modelPaths(MN)).slice(1)
    const present = [...partial, ...Object.values(modelPaths(OWN))]
    expect(resolveModelRoot(candidates, sizes(present))).toEqual({ source: 'argos', dir: OWN })
  })

  it('skips a missing folder and an empty file, and gives up when nothing is complete', () => {
    const own = Object.values(modelPaths(OWN))
    expect(resolveModelRoot([{ source: 'meeting-notes', dir: null }, candidates[1]], sizes(own))).toEqual({ source: 'argos', dir: OWN })
    const emptyVad = (p: string): number => (p.endsWith('silero_vad.onnx') ? 0 : 100)
    expect(resolveModelRoot([candidates[1]], emptyVad)).toBeNull()
    expect(resolveModelRoot(candidates, () => -1)).toBeNull()
  })
})

describe('install', () => {
  it('extracts only the int8 model and its tokens', () => {
    expect(tarExtractArgs('a.tar.bz2', 'dest', WHISPER_DOWNLOAD.members)).toEqual([
      '-xjf',
      'a.tar.bz2',
      '-C',
      'dest',
      MODEL_FILES.encoder,
      MODEL_FILES.decoder,
      MODEL_FILES.tokens
    ])
  })

  it('reports members that did not come out', () => {
    expect(badMembers(() => 10)).toEqual([])
    expect(badMembers((m) => (m === MODEL_FILES.decoder ? 0 : m === MODEL_FILES.tokens ? -1 : 5))).toEqual([
      MODEL_FILES.decoder,
      MODEL_FILES.tokens
    ])
  })

  it('progress math', () => {
    expect(DOWNLOAD_TOTAL_BYTES).toBe(643_854 + 563_790_207)
    expect(megabytes(DOWNLOAD_TOTAL_BYTES)).toBe(564)
    expect(megabytes(78_400_000)).toBe(78)
    expect(megabytes(-5)).toBe(0)
    expect(progressFraction(50, 200)).toBe(0.25)
    expect(progressFraction(300, 200)).toBe(1)
    expect(progressFraction(5, 0)).toBe(0)
    expect(progressFraction(NaN, 10)).toBe(0)
  })
})

describe('engine config', () => {
  it('caps threads at 8 and never goes below 1', () => {
    expect(voiceThreads(22)).toBe(8)
    expect(voiceThreads(4)).toBe(4)
    expect(voiceThreads(0)).toBe(1)
  })

  it('reads Portuguese with the turbo int8 files', () => {
    const c = recognizerConfig(MN, 8)
    expect(c.modelConfig.whisper).toEqual({
      encoder: modelPaths(MN).encoder,
      decoder: modelPaths(MN).decoder,
      language: 'pt',
      task: 'transcribe'
    })
    expect(c.modelConfig.numThreads).toBe(8)
    expect(c.modelConfig.provider).toBe('cpu')
    expect(c.featConfig.sampleRate).toBe(16000)
    expect(vadConfig(MN).sileroVad).toEqual({
      model: modelPaths(MN).vad,
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      windowSize: 512
    })
  })
})

describe('parseWav', () => {
  it('reads what the bubble encodes', () => {
    const r = parseWav(new Uint8Array(encodeWav16(new Float32Array([0, 0.5, -0.5, -1]))))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sampleRate).toBe(16000)
    expect(r.samples.length).toBe(4)
    expect(r.samples[1]).toBeCloseTo(0.5, 3)
    expect(r.samples[3]).toBe(-1)
    expect(r.seconds).toBeCloseTo(4 / 16000)
  })

  it('refuses other formats and garbage', () => {
    const wav = new Uint8Array(encodeWav16(new Float32Array(16)))
    const at44k = wav.slice()
    new DataView(at44k.buffer).setUint32(24, 44100, true)
    expect(parseWav(at44k)).toEqual({ ok: false, error: 'invalid' })
    const stereo = wav.slice()
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(parseWav(stereo)).toEqual({ ok: false, error: 'invalid' })
    expect(parseWav(new Uint8Array(10))).toEqual({ ok: false, error: 'invalid' })
    expect(parseWav(new Uint8Array(100))).toEqual({ ok: false, error: 'invalid' })
  })

  it('refuses more than 30 s, and more than 2 MB', () => {
    expect(parseWav(new Uint8Array(encodeWav16(new Float32Array(16000 * 30))))).toMatchObject({ ok: true })
    expect(parseWav(new Uint8Array(encodeWav16(new Float32Array(16000 * 31))))).toEqual({ ok: false, error: 'too-long' })
    expect(parseWav(new Uint8Array(2 * 1024 * 1024 + 1))).toEqual({ ok: false, error: 'too-long' })
  })

  it('skips a chunk before data', () => {
    const plain = new Uint8Array(encodeWav16(new Float32Array([0.25])))
    const list = new Uint8Array([...'LIST'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]))
    const withList = new Uint8Array(plain.length + list.length)
    withList.set(plain.subarray(0, 36))
    withList.set(list, 36)
    withList.set(plain.subarray(36), 36 + list.length)
    const r = parseWav(withList)
    expect(r.ok && r.samples.length).toBe(1)
  })
})

describe('transcript', () => {
  it("removes Whisper's markers and tidies spaces", () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('')
    expect(cleanTranscript(' (música) ')).toBe('')
    expect(cleanTranscript('  Ligar ao Rui amanhã às 14h. ')).toBe('Ligar ao Rui amanhã às 14h.')
    expect(cleanTranscript('Ligar ao Rui [risos] amanhã\n às 14h ♪')).toBe('Ligar ao Rui amanhã às 14h')
    expect(cleanTranscript('*música* Olá , mundo')).toBe('Olá, mundo')
  })
})

describe('voiceShortcutCandidates', () => {
  it('tries the preferred one first, without repeats', () => {
    const d = ['Ctrl+Alt+S', 'Ctrl+Shift+Alt+S']
    expect(voiceShortcutCandidates('', d)).toEqual(d)
    expect(voiceShortcutCandidates('Ctrl+Alt+Space', d)).toEqual(['Ctrl+Alt+Space', ...d])
    expect(voiceShortcutCandidates('Ctrl+Shift+Alt+S', d)).toEqual(['Ctrl+Shift+Alt+S', 'Ctrl+Alt+S'])
  })
})
