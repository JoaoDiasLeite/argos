import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CompanionBubblePayload, CompanionPetState } from '../types'

// Placeholder pet and bubble so the windows and their IPC can be exercised end to end.
// Batch D replaces both with the real Pet / Bubble components (docs/COMPANION_PLAN.md
// §11). One page for both windows, told apart by the hash main loads it with.

const api = window.electronAPI.companion

function Pet() {
  const [state, setState] = useState<CompanionPetState>('idle')
  useEffect(() => {
    api.state().then((s) => setState(s.petState)).catch(() => {})
    return api.onPetState(setState)
  }, [])
  return (
    <div style={{ width: 220, height: 220, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <svg
        width={96}
        height={96}
        viewBox="0 0 96 96"
        style={{ marginBottom: 17, cursor: 'grab' }}
        // Main follows the cursor between these two; the capture keeps the mouseup ours.
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          api.dragStart()
        }}
        onPointerUp={() => api.dragEnd()}
        onPointerCancel={() => api.dragEnd()}
      >
        <rect x={4} y={10} width={88} height={82} rx={30} fill={state === 'alert' ? '#e8590c' : '#f08c3a'} />
        <circle cx={34} cy={44} r={5} fill="#2b1d12" />
        <circle cx={62} cy={44} r={5} fill="#2b1d12" />
        <ellipse cx={48} cy={64} rx={14} ry={10} fill="#f6e3c6" />
      </svg>
    </div>
  )
}

function Bubble() {
  const [bubble, setBubble] = useState<CompanionBubblePayload | null>(null)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.state().then((s) => s.bubble && setBubble(s.bubble)).catch(() => {})
    const offMode = api.onBubbleMode((b) => {
      setBubble(b)
      setAnswer('')
    })
    const offShown = api.onShown(() => {
      setText('')
      setAnswer('')
      input.current?.focus()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') api.bubbleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMode()
      offShown()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Main sizes the window to whatever the content measures.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => api.bubbleSize(Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const submit = async (): Promise<void> => {
    if (!text.trim()) return
    const r = await api.capture(text, 'text')
    setAnswer(r ? `${r.kind}${r.todo ? `: ${r.todo.title}` : r.results ? ` (${r.results.length})` : ''}` : 'nothing')
    if (r && r.kind !== 'needs-title') setText('')
  }

  const reminder = bubble?.mode === 'reminder' ? bubble.payload.reminder : null
  return (
    <div ref={box} style={{ width: 320, padding: 12, boxSizing: 'border-box', font: '13px system-ui', color: '#f4efe8', background: '#262220', borderRadius: 8 }}>
      {bubble?.mode === 'input' && (
        <input
          ref={input}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      )}
      {reminder && (
        <div>
          <div>{reminder.title}</div>
          <button onClick={() => void api.done(reminder.todoId, true)}>Feito</button>
          <button onClick={() => void api.snooze(reminder.todoId, { minutes: 10 })}>+10 min</button>
          <button onClick={() => void api.dismiss(reminder.todoId)}>Fechar</button>
        </div>
      )}
      {bubble?.mode === 'catchup' && <div>{bubble.payload.reminders.map((r) => r.title).join(' · ')}</div>}
      {answer && <div>{answer}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{location.hash === '#bubble' ? <Bubble /> : <Pet />}</React.StrictMode>
)
