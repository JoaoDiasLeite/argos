import { useEffect, useState } from 'react'
import { UpdaterState } from '../types'
import './TitleBar.css'

interface Props {
  maximized: boolean
}

/**
 * Custom window chrome for the frameless window: a draggable bar with our own
 * minimize / maximize / close controls, styled to match the theme. The native
 * frame is hidden (see createWindow in the main process).
 */
export default function TitleBar({ maximized }: Props) {
  const toggleMaximize = () => window.electronAPI.windowMaximizeToggle()

  // Ambient "restart to update" pill: mirrors the same 'updater:event' feed the
  // Settings modal listens to, so the pill shows up even if Settings was never
  // opened for this session (e.g. the download finished in the background).
  const [updater, setUpdater] = useState<UpdaterState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.updaterState().then((s) => {
      if (!cancelled) setUpdater(s)
    })
    const off = window.electronAPI.onUpdaterEvent((s) => {
      if (!cancelled) setUpdater((prev) => ({ ...(prev ?? s), ...s }))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return (
    <div className="titlebar" onDoubleClick={toggleMaximize}>
      <div className="titlebar-brand">
        <span className="titlebar-logo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="titlebar-title">Argos</span>
      </div>

      <div className="titlebar-drag" />

      {updater?.state === 'downloaded' && (
        <button
          className="titlebar-update-pill"
          onClick={() => window.electronAPI.updaterInstall()}
          title={`Install Argos v${updater.version ?? ''} and relaunch`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
          Restart to update
        </button>
      )}

      <div className="titlebar-controls" onDoubleClick={(e) => e.stopPropagation()}>
        <button
          className="titlebar-btn"
          onClick={() => window.electronAPI.windowMinimize()}
          aria-label="Minimize"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          onClick={toggleMaximize}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              <rect x="1.5" y="2.5" width="5" height="5" />
              <path d="M3.5 2.5V1.5h5v5h-1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn close"
          onClick={() => window.electronAPI.windowClose()}
          aria-label="Close"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
