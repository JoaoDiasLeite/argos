import { downsample, encodeWav16, joinChunks, rms } from '../../../shared/companion-wav'

// The microphone, for one dictation (docs/COMPANION_PLAN.md §4.2): getUserMedia, an
// AudioWorklet (or a ScriptProcessor where the worklet will not load) collecting float
// samples, and, on stop, a 16 kHz mono WAV in memory. Every stop and cancel releases the
// tracks and closes the AudioContext; the audio is never written anywhere.

/** Posts the input in ~2048-sample batches rather than every 128-frame quantum. */
const WORKLET = `
class ArgosRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0 }
      }
    }
    return true
  }
}
registerProcessor('argos-recorder', ArgosRecorder)
`

export interface Recording {
  /** Stop and hand back the WAV (16 kHz mono 16-bit). */
  stop(): Promise<ArrayBuffer>
  /** Stop and throw the audio away. */
  cancel(): void
}

export type MicError = 'denied' | 'no-device' | 'failed'

export class MicrophoneError extends Error {
  constructor(public readonly kind: MicError) {
    super(kind)
  }
}

/** Start recording; `onChunk` gets each batch's RMS, for the meter and the silence stop. */
export async function startRecording(onChunk: (level: number) => void): Promise<Recording> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false
    })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicrophoneError('denied')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicrophoneError('no-device')
    throw new MicrophoneError('failed')
  }

  const ctx = new AudioContext()
  const chunks: Float32Array[] = []
  let closed = false
  const take = (data: Float32Array): void => {
    if (closed) return
    chunks.push(data)
    onChunk(rms(data))
  }

  let teardown: () => void = () => {}
  try {
    const source = ctx.createMediaStreamSource(stream)
    // Nodes are only pulled when they reach the destination; a muted gain keeps it silent.
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    let node: AudioNode
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const worklet = new AudioWorkletNode(ctx, 'argos-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => take(e.data)
      node = worklet
      teardown = () => {
        worklet.port.onmessage = null
      }
    } catch {
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)))
      node = proc
      teardown = () => {
        proc.onaudioprocess = null
      }
    }
    source.connect(node)
    node.connect(sink)
  } catch {
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
    throw new MicrophoneError('failed')
  }

  const release = (): void => {
    if (closed) return
    closed = true
    teardown()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => {})
  }

  return {
    async stop() {
      const rate = ctx.sampleRate
      release()
      return encodeWav16(downsample(joinChunks(chunks), rate))
    },
    cancel() {
      release()
      chunks.length = 0
    }
  }
}
