import { useEffect, useRef, useState } from 'react'
import { CcSessionTarget, CCProject, CCSessionMeta, SearchHit, SearchSnippet } from '../types'
import { TagChips, TagEditor, useLabelColors } from '../components/SessionTags'
import LabelManager from '../components/LabelManager'
import SessionPeek from '../components/SessionPeek'
import ProjectActions from '../components/ProjectActions'
import { tagsSatisfy } from '../lib/tags'
import { groupByAge, sortSessions, SORT_LABELS, SortMode } from '../lib/session-groups'
import './views.css'
import './ProjectsView.css'

interface Props {
  onResume: (session: CCSessionMeta) => void
  /**
   * A conversation named from outside the app — a notification click arriving over
   * `argos://session`. Opening it means selecting its project and putting it in the
   * reading panel, not resuming it: a click that lands you in a running session is
   * a decision taken with the same gesture as the action.
   */
  target?: CcSessionTarget | null
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
    previewRedundant: false,
    // Search covers active sessions only, so a hit is never an archived one.
    archived: false
  }
}


/**
 * A hit with what surrounds it, and the kind of text it sits in.
 *
 * The kind is on the snippet because the two depths deliberately look at different
 * things: across projects a match can come from a command or a tool's output, and
 * saying so is what stops "found in this conversation" from implying someone said it.
 */
function Snippet({ snippet }: { snippet: SearchSnippet }) {
  const labelled = snippet.kind === 'tool_use' || snippet.kind === 'tool_result' || snippet.kind === 'system'
  return (
    <div className="search-hit-snippet">
      {labelled && <span className={`snippet-kind ${snippet.kind}`}>{SNIPPET_KIND[snippet.kind]}</span>}
      {snippet.before}
      <mark>{snippet.match}</mark>
      {snippet.after}
    </div>
  )
}

const SNIPPET_KIND: Record<string, string> = {
  tool_use: 'in a tool call',
  tool_result: 'in tool output',
  system: 'injected'
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

export default function ProjectsView({ onResume, target }: Props) {
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
  const [showArchived, setShowArchived] = useState(false)
  // Active/Archived for the *project* column — orthogonal to `showArchived` above,
  // which scopes the sessions inside whichever project is selected.
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  // Which project's actions popover is open, and where its trigger sits. One at a
  // time, like the tag popover. The rect travels with it because the panel is
  // positioned `fixed` — see ProjectActions.
  const [projectMenu, setProjectMenu] = useState<{ key: string; top: number; left: number } | null>(
    null
  )
  // A conversation to put in the reading panel as soon as a listing containing it
  // arrives. Held by id rather than applied directly because switching the archived
  // toggle re-reads the list, and whichever read finishes last would otherwise win.
  const [pendingPeek, setPendingPeek] = useState<string | null>(null)
  // A project to re-select once the reloaded list contains it, keyed the same way —
  // a folder move changes `encodedDir`, the id this whole view addresses a project
  // by, so the selection has to follow it to the NEW key rather than the old one
  // `load()` is about to make stale. Same "apply once the listing arrives" shape as
  // `pendingPeek` above, for the same reason: `load()` is async.
  const [pendingSelect, setPendingSelect] = useState<{ sourceId: string; encodedDir: string } | null>(
    null
  )
  // Searching inside the selected project. A separate box from the one above, and a
  // narrower read: in here you are looking for a conversation you had, and matching
  // every file path the assistant touched buries it.
  const [projectQuery, setProjectQuery] = useState('')
  const [projectHits, setProjectHits] = useState<Map<string, SearchHit>>(new Map())
  const [projectSearching, setProjectSearching] = useState(false)
  /**
   * Which listing request is the current one.
   *
   * Opening the view auto-selects the first project, and reading a large one takes
   * seconds — long enough for a notification click to arrive and pick a different
   * one. Without this the slow read lands last and replaces the conversation the
   * user was sent to with a list they never asked for.
   */
  const listingSeq = useRef(0)
  // Read inside `load`, which captured its closure at mount — by the time the
  // project list arrives, a deep link may have chosen for us.
  const targetRef = useRef(target)
  targetRef.current = target
  const { colorFor, vocabulary, reload: reloadLabels } = useLabelColors()

  const load = async () => {
    setLoading(true)
    const list = await window.electronAPI.ccListProjects()
    setProjects(list)
    setLoading(false)
    // Opening on the first project is a default, not a decision — and a deep link is
    // a decision, so it wins even when it arrived while this listing was in flight.
    if (list.length && !selected && !targetRef.current) selectProject(list[0])
  }

  useEffect(() => {
    load()
    window.electronAPI.ccFavorites().then(setFavorites)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A project just archived (or unarchived past the other scope) drops out of the
  // visible list on the next `load()`. Leaving the reading panel pointed at a row
  // nobody can see is worse than clearing it — the sessions pane falls back to its
  // "select a project" empty state.
  useEffect(() => {
    if (!selected) return
    const stillListed = projects.find(
      (p) => p.sourceId === selected.sourceId && p.encodedDir === selected.encodedDir
    )
    if (!stillListed || stillListed.archived !== showArchivedProjects) {
      setSelected(null)
      setSessions([])
      setPeeked(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, showArchivedProjects])

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
    const seq = ++listingSeq.current
    setSelected(p)
    setLoadingSessions(true)
    setEditingTags(null)
    setPeeked(null)
    const s = await window.electronAPI.ccListSessions(p.sourceId, p.encodedDir, showArchived)
    if (seq !== listingSeq.current) return
    setSessions(s)
    setLoadingSessions(false)
    // Listing folds newly-seen tags into the registry, so the colours may have grown.
    reloadLabels()
  }

  const refreshSessions = async () => {
    if (!selected) return
    const seq = ++listingSeq.current
    const s = await window.electronAPI.ccListSessions(
      selected.sourceId,
      selected.encodedDir,
      showArchived
    )
    if (seq !== listingSeq.current) return
    setSessions(s)
    reloadLabels()
  }

  // Switching between active and archived re-reads: they are two directories, not a
  // flag to filter on.
  useEffect(() => {
    refreshSessions()
    setPeeked(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived])

  // Open what a deep link named. The conversation can have been archived since the
  // notification fired, so both directories are tried before giving up — a click
  // that silently does nothing is worse than one that lands on the wrong list.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    // Claimed before the first read: whatever listing is in flight is now stale.
    const seq = ++listingSeq.current
    ;(async () => {
      const list = projects.length ? projects : await window.electronAPI.ccListProjects()
      const proj = list.find(
        (p) =>
          p.encodedDir === target.encodedDir && (!target.sourceId || p.sourceId === target.sourceId)
      )
      if (!proj || cancelled) return
      let found = await window.electronAPI.ccListSessions(proj.sourceId, proj.encodedDir, false)
      let archived = false
      if (!found.some((s) => s.sessionId === target.sessionId)) {
        const inArchive = await window.electronAPI.ccListSessions(
          proj.sourceId,
          proj.encodedDir,
          true
        )
        if (inArchive.some((s) => s.sessionId === target.sessionId)) {
          found = inArchive
          archived = true
        }
      }
      if (cancelled || seq !== listingSeq.current) return
      setSelected(proj)
      setSessions(found)
      setLoadingSessions(false)
      setShowArchived(archived)
      setPendingPeek(target.sessionId)
      reloadLabels()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // The in-project search. Debounced like the global one, and reset by moving to
  // another project — a query typed for one project means nothing in the next.
  useEffect(() => {
    setProjectQuery('')
    setProjectHits(new Map())
  }, [selected?.sourceId, selected?.encodedDir])

  useEffect(() => {
    const q = projectQuery.trim()
    if (!selected || q.length < 2) {
      setProjectHits(new Map())
      setProjectSearching(false)
      return
    }
    setProjectSearching(true)
    let cancelled = false
    const t = setTimeout(async () => {
      const hits = await window.electronAPI.ccSearch(q, {
        sourceId: selected.sourceId,
        encodedDir: selected.encodedDir
      })
      if (cancelled) return
      setProjectHits(new Map(hits.map((h) => [h.sessionId, h])))
      setProjectSearching(false)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [projectQuery, selected])

  // Applied here rather than at the fetch site so it survives the re-read that
  // flipping the archived toggle triggers.
  useEffect(() => {
    if (!pendingPeek) return
    const match = sessions.find((s) => s.sessionId === pendingPeek)
    if (match) {
      setPeeked(match)
      setPendingPeek(null)
    }
  }, [sessions, pendingPeek])

  // Same shape, for a project that just moved: `load()` (called via `onChanged` right
  // before this fires) is async, so the match has to be looked up against the
  // reloaded `projects` this effect depends on, not the stale list from the moment
  // of the click. `selectProject` also pulls in that project's sessions, which a
  // bare `setSelected` would not.
  useEffect(() => {
    if (!pendingSelect) return
    const match = projects.find(
      (p) => p.sourceId === pendingSelect.sourceId && p.encodedDir === pendingSelect.encodedDir
    )
    if (match) {
      selectProject(match)
      setPendingSelect(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, pendingSelect])

  // The tag vocabulary offered here is the registry plus whatever is applied in this
  // project — a tag can exist on a conversation before the registry has caught up.
  const localVocab = Array.from(new Set([...vocabulary, ...sessions.flatMap((s) => s.tags)])).sort(
    (a, b) => a.localeCompare(b)
  )

  const searchingHere = projectQuery.trim().length >= 2
  const visibleSessions = sortSessions(
    sessions.filter(
      (s) =>
        tagsSatisfy(s.tags, filterTags, filterMode) &&
        (!searchingHere || projectHits.has(s.sessionId))
    ),
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
  const hasArchivedProjects = projects.some((p) => p.archived)
  // `hasArchivedProjects &&` is what stops the column stranding itself: unarchive the
  // last archived project while looking at them and the toggle disappears, leaving a
  // scope nothing can ever match.
  const archivedScope = hasArchivedProjects && showArchivedProjects
  const shown = projects.filter((p) => matchesFilter(p) && p.archived === archivedScope)
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
      if (editingTags || showLabels || projectMenu || query.trim().length >= 2) return
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
              {h.snippets[0] ? (
                <Snippet snippet={h.snippets[0]} />
              ) : (
                h.snippet && <div className="search-hit-snippet">{h.snippet}</div>
              )}
              {h.matchCount > 1 && (
                <div className="search-hit-count">{h.matchCount} matches in this conversation</div>
              )}
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
          {/* Scrolling the column moves the row out from under a `fixed` panel, so the
              panel goes rather than drifting away from what it acts on. */}
          <div className="projects-list" onScroll={() => setProjectMenu(null)}>
            <input
              className="projects-filter"
              placeholder="Filter projects…"
              aria-label="Filter projects"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            />
            {/* Only earns its place once something is archived — an "Active/Archived"
                toggle over a column that has never had anything filed away is a
                control for a state that cannot occur. */}
            {hasArchivedProjects && (
              <span className="projects-scope" role="group" aria-label="Which projects">
                <button
                  className={showArchivedProjects ? '' : 'on'}
                  aria-pressed={!showArchivedProjects}
                  onClick={() => setShowArchivedProjects(false)}
                >
                  Active
                </button>
                <button
                  className={showArchivedProjects ? 'on' : ''}
                  aria-pressed={showArchivedProjects}
                  onClick={() => setShowArchivedProjects(true)}
                >
                  Archived
                </button>
              </span>
            )}
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
                        {/* A bare 0 reads as a loading state; say what it means instead. */}
                        <span>
                          {p.sessionCount + p.archivedCount === 0
                            ? 'Empty'
                            : p.archivedCount
                              ? `${p.sessionCount} · ${p.archivedCount} archived`
                              : p.sessionCount}
                        </span>
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
                      <button
                        className="project-menu-btn"
                        title="Actions"
                        aria-label={`Actions for ${p.name}`}
                        aria-expanded={projectMenu?.key === key}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (projectMenu?.key === key) {
                            setProjectMenu(null)
                            return
                          }
                          const r = e.currentTarget.getBoundingClientRect()
                          setProjectMenu({ key, top: r.bottom + 4, left: r.left })
                        }}
                      >
                        ⋯
                      </button>
                      {projectMenu?.key === key && (
                        <ProjectActions
                          project={p}
                          anchor={projectMenu}
                          onClose={() => setProjectMenu(null)}
                          onChanged={load}
                          onMoved={setPendingSelect}
                        />
                      )}
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
                <span className="view-empty-msg">
                  {showArchived
                    ? 'Nothing archived in this project.'
                    : 'No sessions in this project.'}
                </span>
                {showArchived && (
                  <button className="btn-ghost small" onClick={() => setShowArchived(false)}>
                    Back to active
                  </button>
                )}
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
                    <span className="sessions-scope" role="group" aria-label="Which sessions">
                      <button
                        className={showArchived ? '' : 'on'}
                        aria-pressed={!showArchived}
                        onClick={() => setShowArchived(false)}
                      >
                        Active
                      </button>
                      <button
                        className={showArchived ? 'on' : ''}
                        aria-pressed={showArchived}
                        onClick={() => setShowArchived(true)}
                      >
                        Archived
                      </button>
                    </span>
                    <input
                      className="sessions-search"
                      placeholder={`Search in ${selected.name}…`}
                      aria-label={`Search in ${selected.name}`}
                      value={projectQuery}
                      onChange={(e) => setProjectQuery(e.target.value)}
                      spellCheck={false}
                    />
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
                  <div className="view-empty small">
                    {searchingHere
                      ? projectSearching
                        ? 'Searching…'
                        : `Nothing in this project says “${projectQuery.trim()}”. The search above looks everywhere, and inside tool calls too.`
                      : `No sessions carry ${filterMode === 'all' ? 'all' : 'any'} of those tags.`}
                  </div>
                ) : (
                  <div className="cc-rows">
                    {groups.map((group) => (
                      <div key={group.label} className="cc-group">
                        {/* Only the date ordering has bands worth naming; a date header
                            over a title-sorted list describes nothing. */}
                        {sort === 'date' && <div className="cc-group-head">{group.label}</div>}
                        {group.sessions.map((s) => (
                          <div
                            key={s.sessionId}
                            className={`cc-row ${editingTags === s.sessionId ? 'tagging' : ''} ${peeked?.sessionId === s.sessionId ? 'peeked' : ''}`}
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
                            <span className="cc-row-main">
                              <span className="cc-row-title" title={s.title}>
                                {s.title}
                              </span>
                              <TagChips tags={s.tags} colorFor={colorFor} />
                              {searchingHere && projectHits.get(s.sessionId)?.snippets[0] && (
                                <Snippet snippet={projectHits.get(s.sessionId)!.snippets[0]} />
                              )}
                            </span>
                            <span className="cc-row-model">{s.model ?? '—'}</span>
                            <span className="cc-row-meta">{s.messageCount} msgs</span>
                            <span className="cc-row-meta">{timeAgo(s.updatedAt)}</span>
                            <span className="cc-row-actions">
                              <button
                                className={`cc-row-tag-btn ${editingTags === s.sessionId ? 'open' : ''}`}
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
                              <span className="cc-row-resume" aria-hidden="true">
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
              projects={projects}
              onClose={() => setPeeked(null)}
              onChanged={() => {
                setPeeked(null)
                refreshSessions()
              }}
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
