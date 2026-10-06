import { useEffect, useState } from 'react'
import ChatTerminal from '../components/ChatTerminal'
import { applyTheme, zoomFor } from '../lib/theme'
import type { ChatPopoutSpec } from '../types'

/**
 * A chat popped out of the main window (src/main/chat-popout.ts): its terminal alone,
 * attached to the pty the pane had. Main keeps the pty and its scrollback, so mounting
 * here reattaches and replays rather than starting the CLI again. Closing the window
 * hands the chat back to the main window's panes; the pty keeps running throughout.
 */
export default function Popout() {
  const sessionId = new URLSearchParams(window.location.search).get('sessionId') ?? ''
  const [spec, setSpec] = useState<ChatPopoutSpec | null | undefined>(undefined)

  useEffect(() => {
    window.electronAPI.getConfig().then((config) => {
      applyTheme(document.documentElement, config.ui)
      window.electronAPI.setZoom(zoomFor(config.ui))
    })
    // Follow theme changes made in the main window while this one is open.
    const off = window.electronAPI.onUiPrefs((ui) => {
      applyTheme(document.documentElement, ui)
      window.electronAPI.setZoom(zoomFor(ui))
    })
    window.electronAPI
      .popoutSpec(sessionId)
      .then(setSpec)
      .catch(() => setSpec(null))
    return off
  }, [sessionId])

  if (spec === undefined) return null
  if (spec === null) {
    return (
      <div className="popout">
        <p className="popout-missing">This chat is no longer popped out.</p>
      </div>
    )
  }
  return (
    <div className="popout">
      <div className="popout-term">
        <ChatTerminal
          terminalId={spec.terminalId}
          cwd={spec.cwd}
          accountId={spec.accountId}
          provider={spec.provider}
          wslDistro={spec.wslDistro}
          remoteHostId={spec.remoteHostId}
          resumeSessionId={spec.resumeSessionId}
          pinSessionId={spec.pinSessionId}
          active
          closable={false}
        />
      </div>
    </div>
  )
}
