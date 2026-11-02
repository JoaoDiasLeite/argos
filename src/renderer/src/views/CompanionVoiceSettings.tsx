// Settings → Companheiro, the dictation rows (docs/COMPANION_PLAN.md §4.2): the dictation
// shortcut, where the speech model comes from (meeting-notes' copy, or Argos's own after
// a one-time 564 MB download), and the line that says the audio stays on this computer.
import type { CompanionPrefs } from '../types'
import { useT } from '../i18n'
import Select from '../components/Select'
import { useVoiceStatus } from '../companion/dictation'

const api = window.electronAPI.companion

export default function CompanionVoiceSettings({
  prefs,
  busy,
  registeredShortcut,
  onChange
}: {
  prefs: CompanionPrefs
  busy: boolean
  /** The dictation accelerator main got ('' if none). */
  registeredShortcut: string
  onChange: (patch: Partial<CompanionPrefs>) => void
}) {
  const t = useT()
  const [status, refresh] = useVoiceStatus(true)

  const modelLine = ((): { text: string; error?: boolean } => {
    if (!status) return { text: t('settings.companion.voice.model.checking') }
    if (!status.platformSupported) return { text: t('settings.companion.voice.model.unsupported'), error: true }
    if (status.modelSource === 'meeting-notes') return { text: t('settings.companion.voice.model.meetingNotes') }
    if (status.modelSource === 'argos' && status.modelDir) return { text: t('settings.companion.voice.model.own', { dir: status.modelDir }) }
    if (status.error && !status.downloading) return { text: t('settings.companion.voice.model.failed', { error: status.error }), error: true }
    return { text: t('settings.companion.voice.model.missing') }
  })()

  const p = status?.downloading ? status.progress : null

  return (
    <>
      <div className="srow">
        <div className="srow-text">
          <span className="srow-label">{t('settings.companion.voice.shortcut.label')}</span>
          <span className="help">{t('settings.companion.voice.shortcut.hint')}</span>
          {registeredShortcut ? (
            <span className="help">{t('settings.companion.voice.shortcut.registered', { shortcut: registeredShortcut })}</span>
          ) : (
            <span className="help settings-error">{t('settings.companion.voice.shortcut.failed')}</span>
          )}
        </div>
        {/* Never one of Teams' Ctrl+Shift letters (M/A/S/E/K/O/D/H/B). */}
        <Select
          className="settings-select"
          value={prefs.voiceShortcut}
          disabled={busy}
          onChange={(e) => onChange({ voiceShortcut: e.target.value })}
          aria-label={t('settings.companion.voice.shortcut.label')}
        >
          <option value="">{t('settings.companion.voice.shortcut.auto')}</option>
          <option value="Ctrl+Alt+S">Ctrl+Alt+S</option>
          <option value="Ctrl+Shift+Alt+S">Ctrl+Shift+Alt+S</option>
          <option value="Ctrl+Alt+V">Ctrl+Alt+V</option>
          <option value="Ctrl+Alt+M">Ctrl+Alt+M</option>
        </Select>
      </div>
      <div className="srow">
        <div className="srow-text">
          <span className="srow-label">{t('settings.companion.voice.model.label')}</span>
          <span className={`help${modelLine.error ? ' settings-error' : ''} settings-voice-model`}>{modelLine.text}</span>
          {p && (
            <span className="settings-voice-progress">
              <span
                className="settings-voice-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((p.received / Math.max(1, p.total)) * 100)}
              >
                <i style={{ width: `${p.phase === 'extract' ? 100 : Math.min(100, (p.received / Math.max(1, p.total)) * 100)}%` }} />
              </span>
              <span className="help settings-voice-mb">
                {p.phase === 'extract'
                  ? t('companion.voice.extracting')
                  : t('companion.voice.progress', { received: Math.round(p.received / 1e6), total: Math.round(p.total / 1e6) })}
              </span>
            </span>
          )}
        </div>
        {status?.downloading ? (
          <button type="button" className="btn-ghost" onClick={() => void api.voiceCancelInstall().then(refresh)}>
            {t('settings.companion.voice.model.cancel')}
          </button>
        ) : status?.modelPresent ? (
          <span className="settings-voice-ready">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12l5 5 9-10" />
            </svg>
            {t('settings.companion.voice.model.ready')}
          </span>
        ) : status?.platformSupported ? (
          <button type="button" className="btn-ghost" onClick={() => void api.voiceInstall().then(refresh)}>
            {t('settings.companion.voice.model.download')}
          </button>
        ) : null}
      </div>
      <p className="help settings-voice-privacy">{t('settings.companion.voice.privacy')}</p>
    </>
  )
}
