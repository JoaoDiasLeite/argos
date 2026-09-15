import { useEffect, useRef, useState } from 'react'
import { AgentDef, AgentSuggestion, ModelInfo, PermissionMode } from '../types'
import ModelPicker from '../components/ModelPicker'
import { useModalA11y } from '../hooks/useModalA11y'
import './views.css'
import './AgentsView.css'

interface Props {
  models: ModelInfo[]
  defaultModel: string
  onRun: (agent: AgentDef) => void
}

const TOOL_OPTIONS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite']
const ICON_OPTIONS = ['🤖', '🧠', '🔧', '🔍', '📝', '🚀', '🛡️', '⚡', '📊', '🧪']
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask each time',
  acceptEdits: 'Auto-accept edits',
  bypassPermissions: 'Full access (no prompts)',
  plan: 'Plan only (read-only)'
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function emptyAgent(defaultModel: string): AgentDef {
  return {
    id: genId(),
    name: '',
    icon: '🤖',
    systemPrompt: '',
    model: defaultModel,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

const DEFAULT_SUGGESTION_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']

/** Defensively sanitize one raw suggestion from the LLM before it ever touches state. */
function sanitizeSuggestion(raw: unknown): AgentSuggestion | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
  const systemPrompt = typeof r.systemPrompt === 'string' ? r.systemPrompt.trim() : ''
  if (!name || !systemPrompt) return null

  const icon = typeof r.icon === 'string' && ICON_OPTIONS.includes(r.icon) ? r.icon : '🤖'

  const rawTools = Array.isArray(r.allowedTools) ? r.allowedTools : []
  const allowedTools = rawTools.filter((t): t is string => typeof t === 'string' && TOOL_OPTIONS.includes(t))

  const reason = typeof r.reason === 'string' ? r.reason.trim() : ''

  return {
    name,
    icon,
    systemPrompt,
    allowedTools: allowedTools.length > 0 ? allowedTools : DEFAULT_SUGGESTION_TOOLS,
    reason
  }
}

function sanitizeSuggestions(data: unknown): AgentSuggestion[] {
  if (!data || typeof data !== 'object') return []
  const list = (data as Record<string, unknown>).suggestions
  if (!Array.isArray(list)) return []
  const out: AgentSuggestion[] = []
  for (const item of list) {
    const s = sanitizeSuggestion(item)
    if (s) out.push(s)
    if (out.length >= 5) break
  }
  return out
}

export default function AgentsView({ models, defaultModel, onRun }: Props) {
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [editing, setEditing] = useState<AgentDef | null>(null)

  const [suggestions, setSuggestions] = useState<AgentSuggestion[] | null>(null)
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  const load = async () => setAgents(await window.electronAPI.agentsList())
  useEffect(() => {
    load()
  }, [])

  const save = async () => {
    if (!editing || !editing.name.trim()) return
    await window.electronAPI.agentsSave({ ...editing, updatedAt: Date.now() })
    setEditing(null)
    load()
  }

  const remove = async (id: string) => {
    setAgents(await window.electronAPI.agentsDelete(id))
  }

  const runSuggest = async () => {
    setSuggestBusy(true)
    setSuggestError(null)
    const res = await window.electronAPI.agentsSuggest()
    setSuggestBusy(false)
    if (!res.ok) {
      setSuggestError(res.error || 'Something went wrong.')
      setSuggestions(null)
      return
    }
    const clean = sanitizeSuggestions(res.data)
    if (clean.length === 0) {
      setSuggestError('The model didn’t return any usable suggestions. Try again.')
      setSuggestions(null)
      return
    }
    setSuggestions(clean)
  }

  const useSuggestion = (s: AgentSuggestion) => {
    setEditing({
      ...emptyAgent(defaultModel),
      name: s.name,
      icon: s.icon,
      systemPrompt: s.systemPrompt,
      allowedTools: s.allowedTools
    })
  }

  const dismissSuggestion = (index: number) => {
    setSuggestions((prev) => (prev ? prev.filter((_, i) => i !== index) : prev))
  }

  const suggestButton = (
    <button className="btn-ghost" onClick={runSuggest} disabled={suggestBusy}>
      {suggestBusy ? (
        <>
          <span className="btn-spinner" /> Analyzing your history…
        </>
      ) : (
        '✨ Suggest from my history'
      )}
    </button>
  )

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Agents</h1>
          <p className="view-sub">Custom agents with their own prompt, model, and tools.</p>
        </div>
        <div className="header-actions">
          {suggestButton}
          <button className="btn-primary" onClick={() => setEditing(emptyAgent(defaultModel))}>
            + New agent
          </button>
        </div>
      </div>

      <div className="view-scroll">
        {(suggestions || suggestError) && (
          <div className="suggestions-section">
            <div className="suggestions-header">
              <div className="suggestions-title">Suggested for you</div>
              <button
                className="icon-btn"
                onClick={() => {
                  setSuggestions(null)
                  setSuggestError(null)
                }}
                aria-label="Clear suggestions"
                title="Clear suggestions"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {suggestError ? (
              <div className="suggestions-error">{suggestError}</div>
            ) : (
              <div className="suggestions-grid">
                {suggestions!.map((s, i) => (
                  <div key={`${s.name}-${i}`} className="agent-card suggestion-card">
                    <div className="agent-card-header">
                      <div className="agent-card-icon-chip">
                        <span className="agent-card-icon">{s.icon}</span>
                      </div>
                      <div className="agent-card-meta">
                        <div className="agent-card-name">{s.name}</div>
                      </div>
                    </div>
                    {s.reason && <div className="suggestion-reason">{s.reason}</div>}
                    <div className="agent-card-prompt">{s.systemPrompt}</div>
                    <div className="agent-card-tools">
                      {s.allowedTools.slice(0, 5).map((t) => (
                        <span key={t} className="tool-chip">{t}</span>
                      ))}
                      {s.allowedTools.length > 5 && <span className="tool-chip">+{s.allowedTools.length - 5}</span>}
                    </div>
                    <div className="agent-card-actions">
                      <button className="btn-primary small" onClick={() => useSuggestion(s)}>Use</button>
                      <button className="btn-text" onClick={() => dismissSuggestion(i)}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {agents.length === 0 ? (
          <div className="view-empty">
            <div>No agents yet. Create one to get started.</div>
            {!suggestions && !suggestError && suggestButton}
          </div>
        ) : (
          <div className="agents-grid">
            {agents.map((a) => (
              <div key={a.id} className="agent-card">
                <div className="agent-card-header">
                  <div className="agent-card-icon-chip">
                    <span className="agent-card-icon">{a.icon}</span>
                  </div>
                  <div className="agent-card-meta">
                    <div className="agent-card-name">{a.name}</div>
                    <div className="agent-card-model">{models.find((m) => a.model.startsWith(m.id))?.label ?? a.model}</div>
                  </div>
                </div>
                <div className="agent-card-prompt">{a.systemPrompt || 'No system prompt'}</div>
                <div className="agent-card-tools">
                  {a.allowedTools.slice(0, 5).map((t) => (
                    <span key={t} className="tool-chip">{t}</span>
                  ))}
                  {a.allowedTools.length > 5 && <span className="tool-chip">+{a.allowedTools.length - 5}</span>}
                </div>
                <div className="agent-card-actions">
                  <button className="btn-primary small" onClick={() => onRun(a)}>Run</button>
                  <button className="btn-ghost small" onClick={() => setEditing(a)}>Edit</button>
                  <button className="btn-text danger" onClick={() => remove(a.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <AgentEditor
          editing={editing}
          setEditing={setEditing}
          isExisting={!!agents.find((a) => a.id === editing.id)}
          models={models}
          onSave={save}
        />
      )}
    </div>
  )
}

interface EditorProps {
  editing: AgentDef
  setEditing: (agent: AgentDef | null) => void
  isExisting: boolean
  models: ModelInfo[]
  onSave: () => void
}

function AgentEditor({ editing, setEditing, isExisting, models, onSave }: EditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, () => setEditing(null))

  const toggleTool = (tool: string) => {
    const has = editing.allowedTools.includes(tool)
    setEditing({
      ...editing,
      allowedTools: has
        ? editing.allowedTools.filter((t) => t !== tool)
        : [...editing.allowedTools, tool]
    })
  }

  return (
    <div className="modal-backdrop" onClick={() => setEditing(null)}>
      <div
        className="modal wide"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="agent-editor-title">{isExisting ? 'Edit agent' : 'New agent'}</h3>
          <button className="icon-btn" onClick={() => setEditing(null)} aria-label="Close" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="agent-edit-row">
            <div className="form-group icon-group">
              <label>Icon</label>
              <div className="icon-options">
                {ICON_OPTIONS.map((ic) => (
                  <button
                    key={ic}
                    className={`icon-option ${editing.icon === ic ? 'selected' : ''}`}
                    onClick={() => setEditing({ ...editing, icon: ic })}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group grow">
              <label>Name</label>
              <input
                className="text-input"
                value={editing.name}
                placeholder="e.g. Code Reviewer"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                autoFocus
              />
            </div>
          </div>

          <div className="form-group">
            <label>System prompt</label>
            <textarea
              className="text-input textarea"
              rows={5}
              value={editing.systemPrompt}
              placeholder="Describe the agent's role, expertise, and how it should behave…"
              onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
            />
          </div>

          <div className="agent-edit-row">
            <div className="form-group">
              <label>Model</label>
              <ModelPicker
                models={models}
                value={editing.model}
                onChange={(m) => setEditing({ ...editing, model: m })}
              />
            </div>
            <div className="form-group grow">
              <label>Permissions</label>
              <select
                className="text-input"
                value={editing.permissionMode}
                onChange={(e) => setEditing({ ...editing, permissionMode: e.target.value as PermissionMode })}
              >
                {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((pm) => (
                  <option key={pm} value={pm}>{PERMISSION_LABELS[pm]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Allowed tools</label>
            <div className="tool-checklist">
              {TOOL_OPTIONS.map((t) => (
                <button
                  key={t}
                  className={`tool-toggle ${editing.allowedTools.includes(t) ? 'on' : ''}`}
                  onClick={() => toggleTool(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn-primary" onClick={onSave} disabled={!editing.name.trim()}>Save</button>
        </div>
      </div>
    </div>
  )
}
