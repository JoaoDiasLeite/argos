import { describe, expect, it } from 'vitest'
import { createSilenceGate, downsample, encodeWav16, formatElapsed, joinChunks, meterLevel, rms } from './companion-wav'

const ascii = (buf: ArrayBuffer, at: number, n: number): string =>
  String.fromCharCode(...new Uint8Array(buf, at, n))

describe('encodeWav16', () => {
  it('writes a 44-byte PCM mono 16 kHz header', () => {
    const buf = encodeWav16(new Float32Array(100))
    const v = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 200)
    expect(ascii(buf, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 200)
    expect(ascii(buf, 8, 4)).toBe('WAVE')
    expect(ascii(buf, 12, 4)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16)
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(ascii(buf, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(200)
  })

  it('scales and clips samples to int16', () => {
    const v = new DataView(encodeWav16(new Float32Array([0, 1, -1, 2, -2, 0.5])))
    expect([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384])
  })
})

describe('downsample', () => {
  it('48 kHz to 16 kHz keeps a third of the samples', () => {
    expect(downsample(new Float32Array(48000), 48000).length).toBe(16000)
    expect(downsample(new Float32Array(4800 + 2), 48000).length).toBe(1600)
  })

  it('44.1 kHz to 16 kHz rounds down', () => {
    expect(downsample(new Float32Array(44100), 44100).length).toBe(16000)
    expect(downsample(new Float32Array(1000), 44100).length).toBe(Math.floor((1000 * 16000) / 44100))
  })

  it('averages each span and copies at equal rates', () => {
    expect(Array.from(downsample(new Float32Array([0, 0.3, 0.6, 1, 1, 1]), 48000))).toEqual([
      expect.closeTo(0.3, 5),
      expect.closeTo(1, 5)
    ])
    const same = new Float32Array([0.1, 0.2])
    const copy = downsample(same, 16000)
    expect(Array.from(copy)).toEqual(Array.from(same))
    expect(copy).not.toBe(same)
  })

  it('returns nothing for a bad rate', () => {
    expect(downsample(new Float32Array(10), 0).length).toBe(0)
  })
})

describe('levels', () => {
  it('rms and the meter', () => {
    expect(rms(new Float32Array([]))).toBe(0)
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5)
    expect(meterLevel(0)).toBe(0)
    expect(meterLevel(1)).toBe(1)
    expect(meterLevel(0.001)).toBe(0)
    expect(meterLevel(0.0316)).toBeCloseTo(0.5, 1)
  })

  it('joins chunks in order', () => {
    expect(Array.from(joinChunks([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })

  it('formats the elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(3400)).toBe('0:03')
    expect(formatElapsed(80_000)).toBe('1:20')
  })
})

describe('createSilenceGate', () => {
  it('never stops before speech was heard', () => {
    const g = createSilenceGate(0.02, 1500)
    expect(g.feed(0, 0)).toBe('continue')
    expect(g.feed(0, 10_000)).toBe('continue')
    expect(g.heard).toBe(false)
  })

  it('stops after 1.5 s of quiet that follows speech, and speech resets the wait', () => {
    const g = createSilenceGate(0.02, 1500)
    g.feed(0.1, 0)
    expect(g.feed(0.001, 100)).toBe('continue')
    expect(g.feed(0.001, 1500)).toBe('continue')
    expect(g.feed(0.2, 1550)).toBe('continue')
    expect(g.feed(0.001, 1600)).toBe('continue')
    expect(g.feed(0.001, 3099)).toBe('continue')
    expect(g.feed(0.001, 3100)).toBe('stop')
  })
})
