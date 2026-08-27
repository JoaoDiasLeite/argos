import { useEffect, useState } from 'react'
import { CCProject, CCSessionMeta, SearchHit } from '../types'
import { TagChips, TagEditor, useLabelColors } from '../components/SessionTags'
import LabelManager from '../components/LabelManager'
import { tagsSatisfy } from '../lib/tags'
import './views.css'
import './ProjectsView.css'

interface Props {
  onResume: (session: CCSessionMeta) => void
}

function hitToSession(h: SearchHit): CCSessionMeta {
  return {
    sessionId: h.sessionId,
    encodedDir: h.encodedDir,
    realPath: h.realPath,
    title: h.title,
    preview: h.snippet,
    messageCount: 0,
    model: h.model,
    createdAt: h.updatedAt,
    updatedAt: h.updatedAt,
    sourceId: h.sourceId,
    kind: h.kind,
    distro: h.distro,
    // A search hit carries no tags: the search pass doesn't read them, and this
    // shape only exists to hand a hit to the resume path.
    tags: [],
    // The snippet is the matched text, which is the whole point of showing it.
    previewRedundant: false
  }
}

function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function ProjectsView({ onResume }: Props) {
  const [projects, setProjects] = useState<CCProject[]>([])
  const [selected, setSelected] = useState<CCProject | null>(null)
  const [sessions, setSessions] = useState<CCSessionMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [editingTags, setEditingTags] = useState<string | null>(null)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterMode, setFilterMode] = useState<'all' | 'any'>('any')
  const [showLabels, setShowLabels] = useState(false)
  const { colorFor, vocabulary, reload: reloadLabels } = useLabelColors()

  const load = async () => {
    setLoading(true)
    const list = await window.electronAPI.ccListProjects()
    setProjects(list)
    setLoading(false)
    if (list.length && !selected) selectProject(list[0])
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced full-text search across all sources.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      const hits = await window.electronAPI.ccSearch(q)
      setResults(hits)
      setSearching(false)
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const selectProject = async (p: CCProject) => {
    setSelected(p)
    setLoadingSessions(true)
    setEditingTags(null)
    const s = await window.electronAPI.ccListSessions(p.sourceId, p.encodedDir)
    setSessions(s)
    setLoadingSessions(false)
    // Listing folds newly-seen tags into the registry, so the colours may have grown.
    reloadLabels()
  }

  const refreshSessions = async () => {
    if (!selected) return
    setSessions(await window.electronAPI.ccListSessions(selected.sourceId, selected.encodedDir))
    reloadLabels()
  }

  // The tag vocabulary offered here is the registry plus whatever is applied in this
  // project — a tag can exist on a conversation before the registry has caught up.
  const localVocab = Array.from(new Set([...vocabulary, ...sessions.flatMap((s) => s.tags)])).sort(
    (a, b) => a.localeCompare(b)
  )

  const visibleSessions = sessions.filter((s) => tagsSatisfy(s.tags, filterTags, filterMode))

  const toggleFilter = (tag: string) =>
    setFilterTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Projects</h1>
          <p className="view-sub">Real Claude Code sessions from local and connected WSL distros — open to resume.</p>
        </div>
        <div className="header-actions">
          <div className="proj-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="proj-search-input"
              placeholder="Search all sessions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="proj-search-clear" onClick={() => setQuery('')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <button className="btn-ghost" onClick={() => setShowLabels(true)} title="Labels">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
            Labels
          </button>
          <button className="btn-ghost" onClick={load} title="Refresh">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {query.trim().length >= 2 ? (
        <div className="search-results">
          <div className="search-results-head">
            {searching ? 'Searching…' : `${results.length} result${results.length !== 1 ? 's' : ''} for “${query.trim()}”`}
          </div>
          {results.map((h) => (
            <div key={h.sourceId + h.sessionId} className="search-hit" onClick={() => onResume(hitToSession(h))}>
              <div className="search-hit-top">
                <span className="search-hit-title">{h.title}</span>
                <span className="search-hit-project">{h.projectName}</span>
                {h.kind === 'wsl' && <span className="src-badge wsl">⊞ {h.distro}</span>}
                <span className="search-hit-date">{timeAgo(h.updatedAt)}</span>
              </div>
              {h.snippet && <div className="search-hit-snippet">…{h.snippet}…</div>}
              {h.account?.email && <div className="search-hit-acct">{h.account.email}</div>}
            </div>
          ))}
          {!searching && results.length === 0 && <div className="view-empty small">No sessions match.</div>}
        </div>
      ) : loading ? (
        <div className="view-loading">
          <div className="view-spinner" />
          <span className="view-loading-text">Loading projects…</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="view-empty">
          <span className="view-empty-icon">📁</span>
          <span className="view-empty-msg">No Claude Code projects found yet. Open a project in Claude Code to see it here.</span>
        </div>
      ) : (
        <div className="projects-split">
          <div className="projects-list">
            {projects.map((p) => (
              <button
                key={p.encodedDir}
                className={`project-row ${selected?.encodedDir === p.encodedDir ? 'active' : ''}`}
                onClick={() => selectProject(p)}
              >
                <div className="project-row-name" title={p.realPath}>
                  {p.name}
                  {p.kind === 'wsl' && <span className="src-badge wsl">⊞ {p.distro}</span>}
                </div>
                <div className="project-row-meta">
                  <span>{p.sessionCount} session{p.sessionCount !== 1 ? 's' : ''}</span>
                  <span>·</span>
                  <span>{timeAgo(p.lastActive)}</span>
                </div>
                <div className="project-row-path" title={p.realPath}>{p.realPath}</div>
                {p.account?.email && (
                  <div className="project-row-acct" title={`${p.account.email}${p.account.plan ? ` · ${p.account.plan}` : ''}`}>
                    {p.account.email}{p.account.plan ? ` · ${p.account.plan}` : ''}
                  </div>
                )}
              </button>
            ))}
          </div>

          <div className="sessions-pane">
            {!selected ? (
              <div className="view-empty">
                <span className="view-empty-msg">Select a project to view its sessions.</span>
              </div>
            ) : loadingSessions ? (
              <div className="view-loading">
                <div className="view-spinner" />
                <span className="view-loading-text">Loading sessions…</span>
              </div>
            ) : sessions.length === 0 ? (
              <div className="view-empty">
                <span className="view-empty-msg">No sessions in this project.</span>
              </div>
            ) : (
              <>
                <div className="sessions-head">
                  <span className="sessions-count">
                    {filterTags.length > 0
                      ? `${visibleSessions.length} of ${sessions.length} sessions`
                      : `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
                  </span>
                  {localVocab.length > 0 && (
                    <div className="tag-filter">
                      <TagChips
                        tags={localVocab}
                        colorFor={colorFor}
                        onClick={toggleFilter}
                        active={filterTags}
                      />
                      {filterTags.length > 1 && (
                        <div className="tag-filter-mode" role="group" aria-label="Match mode">
                          <button
                            className={filterMode === 'any' ? 'on' : ''}
                            onClick={() => setFilterMode('any')}
                            aria-pressed={filterMode === 'any'}
                          >
                            ANY
                          </button>
                          <button
                            className={filterMode === 'all' ? 'on' : ''}
                            onClick={() => setFilterMode('all')}
                            aria-pressed={filterMode === 'all'}
                          >
                            ALL
                          </button>
                        </div>
                      )}
                      {filterTags.length > 0 && (
                        <button className="tag-filter-clear" onClick={() => setFilterTags([])}>
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {visibleSessions.length === 0 ? (
                  <div className="view-empty small">No sessions carry {filterMode === 'all' ? 'all' : 'any'} of those tags.</div>
                ) : (
                  <div className="sessions-grid">
                    {visibleSessions.map((s) => (
                      <div
                        key={s.sessionId}
                        className={`session-card ${editingTags === s.sessionId ? 'tagging' : ''}`}
                        onClick={() => onResume(s)}
                      >
                        <div className="session-card-title">{s.title}</div>
                        {s.preview && !s.previewRedundant && (
                          <div className="session-card-preview">{s.preview}</div>
                        )}
                        <TagChips tags={s.tags} colorFor={colorFor} />
                        <div className="session-card-footer">
                          <span className="session-card-model">{s.model ?? '—'}</span>
                          <span className="session-card-meta">{s.messageCount} msgs</span>
                          <span className="session-card-meta">{timeAgo(s.updatedAt)}</span>
                        </div>

                        {/* One corner cluster: what you can DO to this card. The
                            metadata run above says what it IS. */}
                        <div className="session-card-actions">
                          <span className="session-card-resume">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            Resume
                          </span>
                          <button
                            className={`session-card-tag-btn ${editingTags === s.sessionId ? 'open' : ''}`}
                            title="Tags"
                            aria-label={`Tags for ${s.title}`}
                            aria-expanded={editingTags === s.sessionId}
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingTags(editingTags === s.sessionId ? null : s.sessionId)
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
                              <line x1="7" y1="7" x2="7.01" y2="7" />
                            </svg>
                          </button>
                        </div>

                        {editingTags === s.sessionId && (
                          <TagEditor
                            session={s}
                            vocabulary={localVocab}
                            colorFor={colorFor}
                            onSaved={(tags) => {
                              setSessions((cur) =>
                                cur.map((x) => (x.sessionId === s.sessionId ? { ...x, tags } : x))
                              )
                              reloadLabels()
                            }}
                            onClose={() => setEditingTags(null)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showLabels && (
        <LabelManager
          onClose={() => setShowLabels(false)}
          onChanged={() => {
            // A vocabulary verb rewrites tags across conversations, so the open
            // project's list is stale the moment one runs.
            refreshSessions()
          }}
        />
      )}
    </div>
  )
}
