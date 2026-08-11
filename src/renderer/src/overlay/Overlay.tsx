import { useState, useEffect, useRef } from 'react'
import { Session } from '../types'

// Quick-launcher overlay window. Summoned via a global shortcut from anywhere in
// the OS; every action hands off to the main window and dismisses the overlay.

const RECENT_COUNT = 6

function applyTheme(theme: string, palette: string) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.palette = palette || 'warm-rust'
}

export default function Overlay() {
  const [prompt, setPrompt] = useState('')
  const [recent, setRecent] = useState<Session[]>([])
  const [selected, setSelected] = useState(-1)
  const [shortcut, setShortcut] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    const [config, sessions] = await Promise.all([
      window.electronAPI.getConfig(),
      window.electronAPI.listSessions()
    ])
    applyTheme(config.ui.theme, config.ui.palette)
    setRecent(
      [...sessions]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, RECENT_COUNT)
    )
  }

  useEffect(() => {
    refresh()
    window.electronAPI.overlayShortcut().then(setShortcut)
    // Each time the window is summoned: clear stale input, refresh data, refocus.
    const offShown = window.electronAPI.onOverlayShown(() => {
      setPrompt('')
      setSelected(-1)
      refresh()
      inputRef.current?.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.electronAPI.overlayHide()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offShown()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const submit = (quick: boolean) => {
    const text = prompt.trim()
    if (!text) return
    window.electronAPI.overlaySubmit({ prompt: text, quick })
    setPrompt('')
  }

  const openSession = (id: string) => window.electronAPI.overlayOpenSession(id)

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (prompt.trim()) submit(e.ctrlKey || e.metaKey)
      else if (selected >= 0 && recent[selected]) openSession(recent[selected].id)
      return
    }
    // Arrow keys browse recent chats only while the input is empty.
    if (!prompt.trim() && recent.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => (s + 1) % recent.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => (s <= 0 ? recent.length - 1 : s - 1))
      }
    }
  }

  return (
    <div className="overlay-shell">
      <div className="overlay-input-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 5.7a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-2a2 2 0 0 0 1.3-1.2L12 3z" />
        </svg>
        <input
          ref={inputRef}
          className="overlay-input"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            setSelected(-1)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Ask anything…"
          autoFocus
          spellCheck={false}
          aria-label="Prompt for a new chat"
        />
        <button
          className="overlay-open-app"
          onClick={() => window.electronAPI.overlayOpenMain()}
          title="Open Argos"
          aria-label="Open Argos"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h6v6" /><path d="M10 14L21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      </div>

      <div className="overlay-list" role="listbox" aria-label="Recent chats">
        {recent.length > 0 && <div className="overlay-section">Recent chats</div>}
        {recent.map((s, i) => (
          <button
            key={s.id}
            className={`overlay-item ${i === selected ? 'selected' : ''}`}
            onClick={() => openSession(s.id)}
            role="option"
            aria-selected={i === selected}
          >
            <span className="overlay-item-title">{s.name || 'New chat'}</span>
            <span className="overlay-item-sub">
              {s.remoteHostName ?? s.projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? ''}
            </span>
          </button>
        ))}
        {recent.length === 0 && (
          <div className="overlay-empty">Type a prompt and press Enter to start a chat.</div>
        )}
      </div>

      <div className="overlay-footer">
        <span><kbd>Enter</kbd> new chat</span>
        <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> quick chat</span>
        <span><kbd>Esc</kbd> dismiss</span>
        {shortcut && <span className="overlay-shortcut">{shortcut}</span>}
      </div>
    </div>
  )
}
