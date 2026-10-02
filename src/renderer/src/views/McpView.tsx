import { useEffect, useState } from 'react'
import { McpServer } from '../types'
import './views.css'
import './McpView.css'

export default function McpView() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // add-form state
  const [name, setName] = useState('')
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')

  const load = async () => {
    setLoading(true)
    setServers(await window.electronAPI.mcpList())
    setLoading(false)
  }
  useEffect(() => {
    load()
  }, [])

  const resetForm = () => {
    setName(''); setCommand(''); setArgsText(''); setUrl(''); setType('stdio'); setAdding(false)
  }

  const add = async () => {
    if (!name.trim()) return
    const cfg: Record<string, unknown> =
      type === 'stdio'
        ? { command: command.trim(), args: argsText.split(/\s+/).filter(Boolean) }
        : { type: 'http', url: url.trim() }
    setServers(await window.electronAPI.mcpUpsert(name.trim(), cfg))
    resetForm()
  }

  const remove = async (s: McpServer) => {
    setServers(await window.electronAPI.mcpRemove(s.name))
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>MCP Servers</h1>
          <p className="view-sub">Model Context Protocol servers available to the agent.</p>
        </div>
        <div className="header-actions">
          <button className="btn-ghost" onClick={load}>Refresh</button>
          <button className="btn-primary" onClick={() => setAdding(true)}>Add server</button>
        </div>
      </div>

      <div className="view-scroll">
        {loading ? (
          <div className="view-loading">
            <div className="view-spinner" />
            <span className="view-loading-text">Loading MCP config…</span>
          </div>
        ) : servers.length === 0 ? (
          <div className="view-empty">
            <svg className="view-empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4" />
            </svg>
            <span className="view-empty-msg">No MCP servers found in your local <code>~/.claude.json</code> or any connected WSL distro. Add one to give the agent extra tools and context.</span>
          </div>
        ) : (
          <div className="mcp-list">
            {servers.map((s) => {
              const key = `${s.source}-${s.scope}-${s.name}`
              return (
              <div key={key} className="mcp-card">
                <div className="mcp-card-head" onClick={() => setExpanded(expanded === key ? null : key)}>
                  <div className={`mcp-status ${s.needsAuth ? 'warn' : 'ok'}`} title={s.needsAuth ? 'Needs authentication' : 'Ready'} />
                  <div className="mcp-card-name">{s.name}</div>
                  <span className="chip">{s.transport}</span>
                  <span className="chip">{s.scope}</span>
                  <span className={`chip ${s.source === 'local' ? 'ok' : ''}`}>{s.source}</span>
                  {s.needsAuth && <span className="chip warn">auth needed</span>}
                  <div className="mcp-card-spacer" />
                  {s.scope === 'global' && s.source === 'local' && (
                    <button className="btn-text danger" onClick={(e) => { e.stopPropagation(); remove(s) }}>
                      Remove
                    </button>
                  )}
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round"
                    style={{ transform: expanded === key ? '' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--text-2)' }}
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
                <div className="mcp-card-summary">
                  {s.command ? <code>{s.command} {(s.args ?? []).join(' ')}</code> : s.url ? <code>{s.url}</code> : <span className="muted">no transport details</span>}
                  {s.projectPath && <div className="mcp-card-project">project: {s.projectPath}</div>}
                </div>
                {expanded === key && (
                  <pre className="mcp-card-config">{JSON.stringify(s.config, null, 2)}</pre>
                )}
              </div>
              )
            })}
          </div>
        )}
      </div>

      {adding && (
        <div className="modal-backdrop" onClick={resetForm}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add MCP server</h3>
              <button className="icon-btn" onClick={resetForm} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Name</label>
                <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" autoFocus />
              </div>
              <div className="form-group">
                <label>Transport</label>
                <div className="seg-control">
                  <button className={type === 'stdio' ? 'on' : ''} onClick={() => setType('stdio')}>stdio (command)</button>
                  <button className={type === 'http' ? 'on' : ''} onClick={() => setType('http')}>HTTP / SSE (url)</button>
                </div>
              </div>
              {type === 'stdio' ? (
                <>
                  <div className="form-group">
                    <label>Command</label>
                    <input className="text-input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
                  </div>
                  <div className="form-group">
                    <label>Arguments</label>
                    <input className="text-input mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
                  </div>
                </>
              ) : (
                <div className="form-group">
                  <label>URL</label>
                  <input className="text-input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
                </div>
              )}
              <p className="field-hint">Saved to ~/.claude.json (global scope). A backup is written first.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={resetForm}>Cancel</button>
              <button className="btn-primary" onClick={add} disabled={!name.trim()}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
