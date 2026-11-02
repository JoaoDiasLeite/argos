import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionVoiceStatus } from '../types'
import { useT } from '../i18n'
import { MicrophoneError, startRecording, type MicError, type Recording } from './recorder'
import { MAX_RECORD_MS, createSilenceGate, formatElapsed, meterLevel } from '../../../shared/companion-wav'

// Push-to-talk in the bubble (docs/COMPANION_PLAN.md §4.2, "as built"): a toggle — the
// mic button or the dictation shortcut starts it; the second press, Enter, the mic again,
// 1.5 s of quiet after speech or 30 s stop it; Esc throws it away. The text lands in the
// input for João to correct and send himself — it is never submitted on its own.

const api = window.electronAPI.companion

/** Bars in the level meter. */
const BARS = 16

export type DictationState =
  | { kind: 'idle' }
  | { kind: 'needs-model' }
  | { kind: 'unsupported' }
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing'; preparing: boolean }
  | { kind: 'no-speech' }
  | { kind: 'error'; error: MicError | 'transcribe' }

export interface Dictation {
  state: DictationState
  status: CompanionVoiceStatus | null
  levels: number[]
  /** Recording or transcribing: Esc and Enter belong to the dictation. */
  busy: boolean
  toggle: () => void
  stop: () => void
  cancel: () => void
  /** Clear a leftover line ("Não ouvi nada.", an error) when the bubble is summoned again. */
  reset: () => void
  install: () => void
  cancelInstall: () => void
}

/** The voice status, kept current by the install's progress events. */
export function useVoiceStatus(
  enabled: boolean
): [CompanionVoiceStatus | null, () => void, (status: CompanionVoiceStatus) => void] {
  const [status, setStatus] = useState<CompanionVoiceStatus | null>(null)
  const refresh = useCallback(() => {
    api
      .voiceStatus()
      .then(setStatus)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!enabled) return
    refresh()
    return api.onVoiceProgress(setStatus)
  }, [enabled, refresh])
  return [status, refresh, setStatus]
}

export function useDictation(enabled: boolean, onText: (text: string) => void): Dictation {
  const [status, refreshStatus, setStatus] = useVoiceStatus(enabled)
  const [state, setState] = useState<DictationState>({ kind: 'idle' })
  const [levels, setLevels] = useState<number[]>(() => new Array(BARS).fill(0))
  const recording = useRef<Recording | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const statusRef = useRef(status)
  statusRef.current = status
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const hardStop = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bumped by every start and cancel: a start that finds it moved on was cancelled meanwhile. */
  const attempt = useRef(0)

  const phase = (p: 'idle' | 'recording' | 'transcribing'): void => api.voicePhase(p)

  const clearHardStop = (): void => {
    if (hardStop.current) clearTimeout(hardStop.current)
    hardStop.current = null
  }

  const cancel = useCallback((): void => {
    attempt.current++
    clearHardStop()
    recording.current?.cancel()
    recording.current = null
    if (stateRef.current.kind !== 'transcribing') {
      setState({ kind: 'idle' })
      phase('idle')
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const rec = recording.current
    if (!rec || stateRef.current.kind !== 'recording') return
    recording.current = null
    clearHardStop()
    const preparing = !(statusRef.current?.warm ?? false)
    setState({ kind: 'transcribing', preparing })
    phase('transcribing')
    try {
      const wav = await rec.stop()
      const r = await api.voiceTranscribe(wav)
      if (!r.ok) {
        setState({ kind: 'error', error: 'transcribe' })
      } else if (r.noSpeech || !r.text) {
        setState({ kind: 'no-speech' })
      } else {
        setState({ kind: 'idle' })
        onTextRef.current(r.text)
      }
    } catch {
      setState({ kind: 'error', error: 'transcribe' })
    } finally {
      phase('idle')
      refreshStatus()
    }
  }, [refreshStatus])

  const start = useCallback(async (): Promise<void> => {
    // Fresh every time: the models may have appeared (or gone) since the bubble last asked.
    const mine = ++attempt.current
    setState({ kind: 'starting' })
    const s = await api.voiceStatus().catch(() => statusRef.current)
    if (s) {
      statusRef.current = s
      setStatus(s)
    }
    // Esc (or the bubble hidden) while asking.
    if (attempt.current !== mine) return
    if (!s || !s.platformSupported) {
      setState({ kind: 'unsupported' })
      return
    }
    if (!s.available) {
      setState({ kind: 'needs-model' })
      return
    }
    setLevels(new Array(BARS).fill(0))
    const gate = createSilenceGate()
    try {
      const rec = await startRecording((level) => {
        setLevels((prev) => [...prev.slice(1), meterLevel(level)])
        if (gate.feed(level, performance.now()) === 'stop') void stop()
      })
      // Cancelled (Esc, the bubble hidden) while the microphone was opening.
      if (attempt.current !== mine) {
        rec.cancel()
        return
      }
      recording.current = rec
      api.voicePrepare()
      phase('recording')
      setState({ kind: 'recording', startedAt: Date.now() })
      hardStop.current = setTimeout(() => void stop(), MAX_RECORD_MS)
    } catch (e) {
      setState({ kind: 'error', error: e instanceof MicrophoneError ? e.kind : 'failed' })
      phase('idle')
    }
  }, [stop, setStatus])

  const toggle = useCallback((): void => {
    const k = stateRef.current.kind
    if (k === 'recording') void stop()
    else if (k === 'starting') cancel()
    else if (k !== 'transcribing') void start()
  }, [start, stop, cancel])

  // The model finished downloading while the "needs a model" line was up.
  useEffect(() => {
    if (state.kind === 'needs-model' && status?.available) setState({ kind: 'idle' })
  }, [state.kind, status?.available])

  // The bubble hidden mid-recording, or the view gone: the microphone goes too.
  useEffect(() => api.onBubbleHidden(cancel), [cancel])
  useEffect(() => () => cancel(), [cancel])

  return {
    state,
    status,
    levels,
    busy: state.kind === 'recording' || state.kind === 'starting' || state.kind === 'transcribing',
    toggle,
    stop: () => void stop(),
    cancel,
    reset: () => {
      const k = stateRef.current.kind
      if (k === 'no-speech' || k === 'error' || k === 'unsupported' || k === 'needs-model') setState({ kind: 'idle' })
    },
    install: () => void api.voiceInstall().catch(() => {}),
    cancelInstall: () => void api.voiceCancelInstall().catch(() => {})
  }
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function MicButton({ dictation }: { dictation: Dictation }) {
  const t = useT()
  const recording = dictation.state.kind === 'recording'
  return (
    <button
      type="button"
      className={`bq-mic${recording ? ' on' : ''}`}
      aria-label={recording ? t('companion.voice.stop') : t('companion.voice.start')}
      title={recording ? t('companion.voice.stop') : t('companion.voice.start')}
      aria-pressed={recording}
      disabled={dictation.state.kind === 'transcribing'}
      onClick={dictation.toggle}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  )
}

/** "12 / 564 MB" and a bar, or "A extrair…". */
export function ModelProgress({ status, onCancel }: { status: CompanionVoiceStatus; onCancel: () => void }) {
  const t = useT()
  const p = status.progress
  if (!p) return null
  const fraction = p.total > 0 ? Math.min(1, p.received / p.total) : 0
  return (
    <div className="bq-progress">
      <div className="bq-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <i style={{ width: `${p.phase === 'extract' ? 100 : fraction * 100}%` }} />
      </div>
      <span className="help num bq-progress-mb">
        {p.phase === 'extract'
          ? t('companion.voice.extracting')
          : t('companion.voice.progress', { received: Math.round(p.received / 1e6), total: Math.round(p.total / 1e6) })}
      </span>
      <button type="button" className="btn-secondary small" onClick={onCancel}>
        {t('companion.voice.cancel')}
      </button>
    </div>
  )
}

/** What the bubble shows under (or instead of) the input while dictating. */
export function DictationPanel({ dictation }: { dictation: Dictation }) {
  const t = useT()
  const { state, status } = dictation
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (state.kind !== 'recording') return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [state.kind])

  switch (state.kind) {
    case 'recording':
      return (
        <div className="bq-voice-rec" aria-live="polite">
          <span className="bq-rec-dot" aria-hidden="true" />
          <span className="bq-meter" aria-hidden="true">
            {dictation.levels.map((l, i) => (
              <i key={i} style={{ height: `${Math.max(12, Math.round(l * 100))}%` }} />
            ))}
          </span>
          <span className="num bq-elapsed">{formatElapsed(now - state.startedAt)}</span>
          <span className="help bq-voice-help">{t('companion.voice.recordingHelp')}</span>
        </div>
      )
    case 'starting':
      return <div className="help">{t('companion.voice.starting')}</div>
    case 'transcribing':
      return (
        <div className="bq-voice-busy help" aria-live="polite">
          {state.preparing ? t('companion.voice.preparing') : t('companion.voice.transcribing')}
        </div>
      )
    case 'no-speech':
      return <div className="help">{t('companion.voice.noSpeech')}</div>
    case 'unsupported':
      return <div className="help">{t('companion.voice.unsupported')}</div>
    case 'error':
      return (
        <div className="help bq-err">
          {state.error === 'denied'
            ? t('companion.voice.denied')
            : state.error === 'no-device'
              ? t('companion.voice.noDevice')
              : state.error === 'transcribe'
                ? t('companion.voice.transcribeFailed')
                : t('companion.voice.micFailed')}
        </div>
      )
    case 'needs-model':
      if (status?.downloading) return <ModelProgress status={status} onCancel={dictation.cancelInstall} />
      return (
        <div className="bq-voice-need">
          <span className="help">{status?.error ? t('companion.voice.installFailed') : t('companion.voice.needsModel')}</span>
          <button type="button" className="btn-secondary small" onClick={dictation.install}>
            {t('companion.voice.download')}
          </button>
        </div>
      )
    case 'idle':
      return null
  }
}
