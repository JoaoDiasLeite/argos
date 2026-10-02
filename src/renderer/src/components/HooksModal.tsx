import { useEffect, useState } from 'react'
import { ClaudeHooks, ClaudeHookEntry, HOOK_EVENTS, HookEvent } from '../types'
import Sheet from './Sheet'
import './HooksModal.css'

interface Props {
  onClose: () => void
}

interface NewHookForm {
  event: HookEvent
  matcher: string
  command: string
}

const EMPTY_FORM: NewHookForm = { event: 'PreToolUse', matcher: '', command: '' }

export default function HooksModal({ onClose }: Props) {
  const [hooks, setHooks] = useState<ClaudeHooks>({})
  const [form, setForm] = useState<NewHookForm>(EMPTY_FORM)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)

  useEffect(() => {
    window.electronAPI.getClaudeHooks().then(setHooks)
  }, [])

  const persist = async (next: ClaudeHooks) => {
    setSaveError(null)
    const result = await window.electronAPI.setClaudeHooks(next)
    if (!result.ok) {
      setSaveError(result.error ?? 'Unknown error saving hooks')
      return
    }
    // Use the merged hooks returned by the main process (includes unknown events)
    setHooks(result.hooks ?? next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const addHook = async () => {
    const cmd = form.command.trim()
    if (!cmd) return
    const entry: ClaudeHookEntry = {
      hooks: [{ type: 'command', command: cmd }]
    }
    if (form.matcher.trim()) entry.matcher = form.matcher.trim()

    const existing = hooks[form.event] ?? []
    await persist({ ...hooks, [form.event]: [...existing, entry] })
    setForm(EMPTY_FORM)
  }

  const removeHook = async (event: string, idx: number) => {
    const list = (hooks[event] ?? []).filter((_, i) => i !== idx)
    const next = { ...hooks }
    if (list.length === 0) {
      // Send empty array so setClaudeHooks knows to delete the key
      next[event] = []
    } else {
      next[event] = list
    }
    await persist(next)
  }

  // Display all known events that have entries, plus any unknown event keys from file
  const knownEventSet = new Set<string>(HOOK_EVENTS)
  const allEventKeys = [
    ...HOOK_EVENTS.filter((ev) => hooks[ev]?.length),
    ...Object.keys(hooks).filter((k) => !knownEventSet.has(k) && hooks[k]?.length)
  ]

  const hasAny = Object.keys(hooks).some((k) => hooks[k]?.length > 0)

  return (
    <Sheet
      title="Hooks"
      width={520}
      onClose={onClose}
      footer={
        <>
          <span className="help perms-saved">{saved ? 'Saved' : ''}</span>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <span className="help">Esc closes</span>
        </>
      }
    >
      <div className="hooks-body">
        <p className="help">
          Shell commands Claude Code runs on lifecycle events. Saved to <code>~/.claude/settings.json</code> as you
          edit.
        </p>

        {saveError && (
          <div className="block err" role="alert">
            {saveError}
          </div>
        )}

        {hasAny ? (
          allEventKeys.map((event) => (
            <div key={event} className="hooks-group">
              <div className="eyebrow">{event}</div>
              {(hooks[event] ?? []).map((entry, idx) => (
                <div key={idx} className="hooks-entry">
                  {entry.matcher && (
                    <span className="chip mono" title="Matcher (tool glob)">
                      {entry.matcher}
                    </span>
                  )}
                  <code className="hooks-command">{entry.hooks[0]?.command ?? ''}</code>
                  <button
                    type="button"
                    className="perms-remove"
                    onClick={() => removeHook(event, idx)}
                    aria-label={`Remove hook ${idx} from ${event}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ))
        ) : (
          <p className="help">No hooks configured.</p>
        )}

        <div
          className="hooks-form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') void addHook()
          }}
        >
          <div className="eyebrow">Add hook</div>

          <div className="form-group">
            <label htmlFor="hook-event">Event</label>
            <select
              id="hook-event"
              className="text-input"
              value={form.event}
              onChange={(e) => setForm((f) => ({ ...f, event: e.target.value as HookEvent }))}
            >
              {HOOK_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="hook-matcher">
              Matcher<span className="optional">optional</span>
            </label>
            <input
              id="hook-matcher"
              className="text-input mono"
              value={form.matcher}
              onChange={(e) => setForm((f) => ({ ...f, matcher: e.target.value }))}
              placeholder="Tool name glob, e.g. Bash"
              spellCheck={false}
            />
          </div>

          <div className="form-group">
            <label htmlFor="hook-command">Command</label>
            <input
              id="hook-command"
              className="text-input mono"
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="Shell command to run"
              spellCheck={false}
            />
          </div>

          <div className="hooks-form-actions">
            <button type="button" className="btn-ghost" onClick={addHook} disabled={!form.command.trim()}>
              Add hook
            </button>
          </div>
        </div>

        <div className="hooks-json-toggle">
          <button type="button" className="btn-text" onClick={() => setShowJson((v) => !v)}>
            {showJson ? 'Hide JSON' : 'Show JSON'}
          </button>
        </div>
        {showJson && <pre className="hooks-json">{JSON.stringify(hooks, null, 2)}</pre>}
      </div>
    </Sheet>
  )
}
