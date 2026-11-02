// The slice of sherpa-onnx-node (1.13.8) the companion's dictation uses. The package ships
// JSDoc, not .d.ts. Electron forbids external ArrayBuffers, so every call that takes an
// `enableExternalBuffer` flag must be given `false` (companion-voice.ts does).
declare module 'sherpa-onnx-node' {
  export interface OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
  }
  export interface OfflineRecognizerResult {
    text: string
  }
  export class OfflineRecognizer {
    constructor(config: unknown)
    static createAsync(config: unknown): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
    getResult(stream: OfflineStream): OfflineRecognizerResult
  }
  export interface SpeechSegment {
    start: number
    samples: Float32Array
  }
  export class Vad {
    constructor(config: unknown, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(enableExternalBuffer?: boolean): SpeechSegment
    pop(): void
    flush(): void
  }
  export const version: string
}
