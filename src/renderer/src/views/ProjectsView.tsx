import { useEffect, useState } from 'react'
import { CCProject, CCSessionMeta, SearchHit } from '../types'
import { TagChips, TagEditor, useLabelColors } from '../components/SessionTags'
import LabelManager from '../components/LabelManager'
import SessionPeek from '../components/SessionPeek'
import { tagsSatisfy } from '../lib/tags'
import { groupByAge, sortSessions, SORT_LABELS, SortMode } from '../lib/session-groups'
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
  // Remembered across visits: re-picking the ordering every time you open Projects is
  // the kind of small tax that makes a view feel unfinished.
  const [sort, setSort] = useState<SortMode>(
    () => (localStorage.getItem('projects.sort') as SortMode) || 'date'
  )
  const [projectFilter, setProjectFilter] = useState('')
  const [favorites, setFavorites] = useState<string[]>([])
  const [peeked, setPeeked] = useState<CCSessionMeta | null>(null)
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
    window.electronAPI.ccFavorites().then(setFavorites)
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

  const toggleFavorite = async (p: CCProject) => {
    const key = `${p.sourceId}:${p.encodedDir}`
    setFavorites(await window.electronAPI.ccSetFavorite(p.sourceId, p.encodedDir, !favorites.includes(key)))
  }

  const selectProject = async (p: CCProject) => {
    setSelected(p)
    setLoadingSessions(true)
    setEditingTags(null)
    setPeeked(null)
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

  const visibleSessions = sortSessions(
    sessions.filter((s) => tagsSatisfy(s.tags, filterTags, filterMode)),
    sort
  )
  const groups = sort === 'date' ? groupByAge(visibleSessions) : [{ label: '', sessions: visibleSessions }]

  const changeSort = (mode: SortMode) => {
    setSort(mode)
    localStorage.setItem('projects.sort', mode)
  }

  const toggleFilter = (tag: string) =>
    setFilterTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))

  // Pinned first, then the rest by recency. Sections are only worth labelling when
  // both exist — see the render.
  const matchesFilter = (p: CCProject) => {
    const q = projectFilter.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.realPath.toLowerCase().includes(q)
  }
  const shown = projects.filter(matchesFilter)
  const pinned = shown.filter((p) => favorites.includes(`${p.sourceId}:${p.encodedDir}`))
  const rest = shown.filter((p) => !favorites.includes(`${p.sourceId}:${p.encodedDir}`))
  const projectSections = [
    ...(pinned.length ? [{ label: 'Pinned', projects: pinned }] : []),
    ...(rest.length ? [{ label: 'Recent', projects: rest }] : [])
  ]

  /**
   * Arrowing through the list moves the selection and the preview follows; Enter
   * resumes. A long list is walked, not clicked through, and the preview only earns
   * its place if reaching the next conversation costs one key.
   */
  const step = (delta: number) => {
    if (!visibleSessions.length) return
    const i = peeked ? visibleSessions.findIndex((s) => s.sessionId === peeked.sessionId) : -1
    const next = visibleSessions[Math.max(0, Math.min(visibleSessions.length - 1, i + delta))]
    if (next) setPeeked(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal a key from a field, and never from the tag popover.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if (editingTags || showLabels || query.trim().length >= 2) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'Enter' && peeked) {
        e.preventDefault()
        onResume(peeked)
      } else if (e.key === 'Escape' && peeked) {
        setPeeked(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
            <input
              className="projects-filter"
              placeholder="Filter projects…"
              aria-label="Filter projects"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            />
            {projectSections.map((section) => (
              <div key={section.label} className="project-section">
                {/* Only labelled when there is something to tell apart — a lone
                    "Recent" header over the whole list says nothing. */}
                {projectSections.length > 1 && (
                  <div className="project-section-head">{section.label}</div>
                )}
                {section.projects.map((p) => {
                  const key = `${p.sourceId}:${p.encodedDir}`
                  const fav = favorites.includes(key)
                  return (
                    <div
                      key={key}
                      className={`project-row ${selected?.encodedDir === p.encodedDir && selected?.sourceId === p.sourceId ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      /* The path and the account moved into the tooltip: repeated on
                         every row they were noise, and dropping them is what lets the
                         column be narrow. Two projects can share a name, so the path
                         still has to be reachable. */
                      title={`${p.realPath}${p.account?.email ? `\n${p.account.email}` : ''}`}
                      onClick={() => selectProject(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectProject(p)
                        }
                      }}
                    >
                      <div className="project-row-name">
                        {fav && <span className="project-star-on" aria-hidden="true">★</span>}
                        <span className="project-row-label">{p.name}</span>
                        {p.kind === 'wsl' && <span className="src-badge wsl">{p.distro}</span>}
                      </div>
                      <div className="project-row-meta">
                        <span>{p.sessionCount}</span>
                        <span>·</span>
                        <span>{timeAgo(p.lastActive)}</span>
                      </div>
                      <button
                        className={`project-star ${fav ? 'on' : ''}`}
                        title={fav ? 'Unpin' : 'Pin to top'}
                        aria-label={fav ? `Unpin ${p.name}` : `Pin ${p.name} to top`}
                        aria-pressed={fav}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFavorite(p)
                        }}
                      >
                        ★
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
            {projectSections.length === 0 && (
              <div className="projects-filter-empty">No project matches.</div>
            )}
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
                  <div className="sessions-head-left">
                    <span className="sessions-count">
                      {filterTags.length > 0
                        ? `${visibleSessions.length} of ${sessions.length} sessions`
                        : `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
                    </span>
                    <span className="sessions-sort">
                      <select
                        aria-label="Sort sessions"
                        value={sort}
                        onChange={(e) => changeSort(e.target.value as SortMode)}
                      >
                        {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                          <option key={m} value={m}>
                            {SORT_LABELS[m]}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
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
                  <div className="sessions-rows">
                    {groups.map((group) => (
                      <div key={group.label} className="session-group">
                        {/* Only the date ordering has bands worth naming; a date header
                            over a title-sorted list describes nothing. */}
                        {sort === 'date' && <div className="session-group-head">{group.label}</div>}
                        {group.sessions.map((s) => (
                          <div
                            key={s.sessionId}
                            className={`session-row ${editingTags === s.sessionId ? 'tagging' : ''} ${peeked?.sessionId === s.sessionId ? 'peeked' : ''}`}
                            /* A click selects and shows; resuming is the panel's
                               button, Enter, or a double click. The panel exists to
                               make the decision possible, and a decision taken with
                               the same gesture as the action is not a decision. */
                            onClick={() => setPeeked(s)}
                            onDoubleClick={() => onResume(s)}
                            role="button"
                            tabIndex={0}
                            aria-current={peeked?.sessionId === s.sessionId}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') onResume(s)
                            }}
                          >
                            <span className="session-row-main">
                              <span className="session-row-title" title={s.title}>
                                {s.title}
                              </span>
                              <TagChips tags={s.tags} colorFor={colorFor} />
                            </span>
                            <span className="session-row-model">{s.model ?? '—'}</span>
                            <span className="session-row-meta">{s.messageCount} msgs</span>
                            <span className="session-row-meta">{timeAgo(s.updatedAt)}</span>
                            <span className="session-row-actions">
                              <button
                                className={`session-row-tag-btn ${editingTags === s.sessionId ? 'open' : ''}`}
                                title="Tags"
                                aria-label={`Tags for ${s.title}`}
                                aria-expanded={editingTags === s.sessionId}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingTags(editingTags === s.sessionId ? null : s.sessionId)
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
                                  <line x1="7" y1="7" x2="7.01" y2="7" />
                                </svg>
                              </button>
                              <span className="session-row-resume" aria-hidden="true">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polygon points="5 3 19 12 5 21 5 3" />
                                </svg>
                              </span>
                            </span>
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
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {peeked && (
            <SessionPeek
              session={peeked}
              colorFor={colorFor}
              vocabulary={localVocab}
              onResume={() => onResume(peeked)}
              onClose={() => setPeeked(null)}
              onTagsSaved={(tags) => {
                setSessions((cur) =>
                  cur.map((x) => (x.sessionId === peeked.sessionId ? { ...x, tags } : x))
                )
                setPeeked({ ...peeked, tags })
                reloadLabels()
              }}
            />
          )}
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
