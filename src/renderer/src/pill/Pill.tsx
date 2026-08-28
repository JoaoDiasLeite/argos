import { useState, useEffect } from 'react'
import { applyPalette } from '../lib/palettes'

// Agent status pill window. A tiny always-on-top "picture-in-picture" surface shown
// while a run is in flight and the main window is hidden/minimized. It reflects live
// run state (spinner while running, ✓/✗ when done) and jumps back to the app on click.
// The main process drives it via pill:update, sending partial payloads that we merge:
// sessionName arrives once on run start, tool updates stream in, and the state flips
// running→done/error at the end.

type PillState = 'running' | 'done' | 'error'

interface PillData {
  state: PillState
  sessionName: string
  tool: string | null
}

// A single pill:update may carry only some fields; anything omitted is left as-is.
type PillUpdate = Partial<PillData>

export default function Pill() {
  const [data, setData] = useState<PillData>({ state: 'running', sessionName: '', tool: null })

  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config) => applyPalette(document.documentElement, config.ui.theme, config.ui.palette))

    const off = window.electronAPI.onPillUpdate((update: PillUpdate) => {
      setData((prev) => ({
        state: update.state ?? prev.state,
        sessionName: update.sessionName ?? prev.sessionName,
        // tool may be explicitly set to null (e.g. on run start) — respect that.
        tool: update.tool !== undefined ? update.tool : prev.tool
      }))
    })
    return off
  }, [])

  const icon =
    data.state === 'done' ? (
      <span className="pill-glyph pill-done" aria-hidden>
        ✓
      </span>
    ) : data.state === 'error' ? (
      <span className="pill-glyph pill-error" aria-hidden>
        ✗
      </span>
    ) : (
      <svg className="pill-spinner spin" viewBox="0 0 24 24" width="16" height="16" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="3"
        />
        <path
          d="M12 3 a9 9 0 0 1 9 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    )

  return (
    <div className={`pill-shell pill-${data.state}`}>
      {icon}
      <span className="pill-name" title={data.sessionName}>
        {data.sessionName || 'Working…'}
      </span>
      {data.state === 'running' && data.tool && <span className="pill-tool">{data.tool}</span>}
      <button
        className="pill-open"
        title="Open app"
        aria-label="Open app"
        onClick={() => window.electronAPI.pillOpenMain()}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
          <path
            d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}
