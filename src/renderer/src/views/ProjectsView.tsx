import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CcSessionTarget,
  CCProject,
  CCSessionMeta,
  RepoName,
  SearchHit,
  SearchSnippet,
  SourceProvider
} from '../types'
import { TagChips, TagEditor, useLabelColors } from '../components/SessionTags'
import LabelManager from '../components/LabelManager'
import SessionPeek from '../components/SessionPeek'
import ProjectActions from '../components/ProjectActions'
import { tagsSatisfy } from '../lib/tags'
import {
  canonicalProjectPath,
  projectKey,
  buildPosixDistroMap,
  ProjectKeyContext
} from '../lib/project-key'
import { projectDisplayName } from '../lib/project-name'
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
  /**
   * A project named from the Home view, as the normalised key Home groups its repo
   * rows by. Carries an `at` stamp so asking for the same project twice — leave for
   * another one, come back, click the same row — still counts as a new request; the
   * key alone would compare equal and the second click would do nothing.
   */
  focus?: { key: string; at: number } | null
}

// Project list column resize — same shape as Sidebar.tsx's own resize handle
// (MIN_WIDTH/MAX_WIDTH/STORAGE_KEY, drag handlers, cleanup on unmount).
const LIST_MIN_WIDTH = 160
const LIST_MAX_WIDTH = 400
const LIST_DEFAULT_WIDTH = 210
const LIST_WIDTH_STORAGE_KEY = 'projects.listWidth'

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

/**
 * The same folder can show up as several `CCProject` rows — different casing,
 * different WSL addressing (see project-key.ts). A group is one folder, holding
 * every spelling that reached the app as a member: the row shown to the user sums
 * their counts and acts on all of them where an action can sensibly mean "this
 * folder", and falls back to one representative member where it can't (see
 * `primaryMember` below).
 */
interface ProjectGroup {
  key: string
  members: CCProject[]
  sessionCount: number
  archivedCount: number
  lastActive: number
  // True if ANY member is archived/favorited — those preferences are stored per
  // member (`sourceId:encodedDir`), and a folder that reached the sidebar from two
  // addresses only needs one of them filed away to read as "archived" here.
  archived: boolean
  distros: string[]
}

function groupProjects(list: CCProject[], ctx: ProjectKeyContext): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>()
  for (const p of list) {
    const key = projectKey(p.realPath, p.distro, ctx)
    let g = map.get(key)
    if (!g) {
      g = { key, members: [], sessionCount: 0, archivedCount: 0, lastActive: 0, archived: false, distros: [] }
      map.set(key, g)
    }
    g.members.push(p)
    g.sessionCount += p.sessionCount
    g.archivedCount += p.archivedCount
    g.lastActive = Math.max(g.lastActive, p.lastActive)
    g.archived = g.archived || p.archived
    if (p.kind === 'wsl' && p.distro && !g.distros.includes(p.distro)) g.distros.push(p.distro)
  }
  return Array.from(map.values())
}

/**
 * The member to act on when an action needs exactly one `CCProject` (rename target
 * aside, which acts on the whole group by key). Most-recently-active is the member
 * most likely to be the one the user means "the project" by right now.
 */
function primaryOfMembers(members: CCProject[]): CCProject {
  return members.reduce((best, m) => (m.lastActive > best.lastActive ? m : best), members[0])
}

function primaryMember(g: ProjectGroup): CCProject {
  return primaryOfMembers(g.members)
}

function groupFavoriteKeys(members: CCProject[]): string[] {
  return members.map((m) => `${m.sourceId}:${m.encodedDir}`)
}

/**
 * Codex email lookups, keyed the two ways a Codex `CCProject.sourceId` names an
 * account: `byId` for `'codex:<accountId>'`, `defaultEmail` for the bare `'codex'`
 * source (the default CODEX_HOME, i.e. whichever account is marked `isDefault`).
 * A Codex project's own `account` field is always empty — the main process would
 * need to spawn the CLI per account to fill it in — so this is built in the
 * renderer from `providerAccountsList('codex')`, which already has the answer.
 */
interface CodexAccountEmails {
  byId: Map<string, string>
  defaultEmail?: string
}

const NO_CODEX_ACCOUNTS: CodexAccountEmails = { byId: new Map() }

/** The source id of the default CODEX_HOME; a per-account home is `codex:<accountId>`. */
const CODEX_SOURCE_ID = 'codex'

/**
 * A source's account identity: two sources are "the same account" iff they report
 * the same (normalised) email — a local install and two WSL distros logged into the
 * same Claude account are one identity, even though they're three distinct
 * `sourceId`s. A source with no email can't be merged with anything, so it is its
 * own identity, keyed by its `sourceId`.
 *
 * Codex is the one provider whose `CCProject` never carries `account` itself (see
 * `CodexAccountEmails` above), so its identity is resolved from the passed-in map
 * instead — falling back to the raw `sourceId`, same as any other emailless source,
 * until that map has loaded.
 */
function identityOf(p: CCProject, codex: CodexAccountEmails): string {
  const email = p.account?.email?.trim().toLowerCase()
  if (email) return email
  if (p.sourceId === 'codex') return codex.defaultEmail ?? p.sourceId
  if (p.sourceId.startsWith('codex:')) {
    return codex.byId.get(p.sourceId.slice('codex:'.length)) ?? p.sourceId
  }
  return p.sourceId
}

/**
 * An account option offered by the filter above the project list — one per identity
 * (see `identityOf`) actually present among the loaded projects, never from a fixed
 * roster: a Gemini or other-provider account will show up here the day one exists,
 * with no code here needing to know its name in advance.
 */
interface AccountOption {
  identity: string
  label: string
  /** The account email, shown as a legend — only when it adds information the label
   *  doesn't already carry (an identity with no email has nothing more to show). */
  sub?: string
}

/**
 * Narrows a group down to the members that belong to the given account identity,
 * recomputing every count from just those members — a group's session total,
 * last-active date and WSL badges all have to describe what is actually about to be
 * listed under this filter, not the whole folder. `archived` is the one field left
 * alone: filing away is a preference about the folder itself, not about one
 * account's view of it, so a group archived under a member the filter currently
 * hides must still read as archived rather than silently reappearing as active.
 *
 * Returns null when no member of the group matches — the caller drops the group
 * entirely rather than show an empty row.
 */
function scopeGroup(g: ProjectGroup, identity: string, codex: CodexAccountEmails): ProjectGroup | null {
  if (identity === 'all') return g
  const members = g.members.filter((m) => identityOf(m, codex) === identity)
  if (!members.length) return null
  return {
    key: g.key,
    members,
    sessionCount: members.reduce((n, m) => n + m.sessionCount, 0),
    archivedCount: members.reduce((n, m) => n + m.archivedCount, 0),
    lastActive: members.reduce((n, m) => Math.max(n, m.lastActive), 0),
    archived: g.archived,
    distros: Array.from(
      new Set(members.filter((m) => m.kind === 'wsl' && m.distro).map((m) => m.distro as string))
    )
  }
}

function scopeGroups(
  list: CCProject[],
  identity: string,
  codex: CodexAccountEmails,
  ctx: ProjectKeyContext
): ProjectGroup[] {
  return groupProjects(list, ctx)
    .map((g) => scopeGroup(g, identity, codex))
    .filter((g): g is ProjectGroup => g !== null)
}

export default function ProjectsView({ onResume, target, focus }: Props) {
  // Only Claude Code transcripts can be resumed: `claude --resume` is handed the session
  // id verbatim, and a Codex uuid means nothing to it. The main process already refuses
  // to rename, archive, move or delete one; this is the reading side of the same rule.
  // Opening the peek instead is not a consolation prize — reading is what is actually
  // available, and doing nothing on a double-click would just look broken.
  const canResume = (s: CCSessionMeta): boolean => s.provider !== 'codex'
  const resumeOrPeek = (s: CCSessionMeta): void => {
    if (canResume(s)) onResume(s)
    else setPeeked(s)
  }
  const [projects, setProjects] = useState<CCProject[]>([])
  // Drive-letter → distro map, so `X:\home\me\proj` and
  // `\wsl.localhost\Ubuntu\home\me\proj` group as the one folder they are — the same
  // context the Sidebar and Home already build (see project-key.ts). Without it a
  // mapped WSL drive shows up as a second project next to the UNC spelling of itself.
  const [wslDriveMap, setWslDriveMap] = useState<Record<string, string>>({})
  useEffect(() => {
    window.electronAPI.wslDriveMap?.().then(setWslDriveMap).catch(() => {})
  }, [])
  const keyCtx = useMemo<ProjectKeyContext>(
    () => ({
      driveMap: wslDriveMap,
      posixDistros: buildPosixDistroMap(
        projects.map((p) => ({ projectPath: p.realPath, wslDistro: p.distro }))
      )
    }),
    [wslDriveMap, projects]
  )
  // The same context for the callbacks that run outside a render's closure (`load`,
  // the deep-link effects, the repo-name fetch): they must key by what the list is
  // grouped by now, not by whatever the map held when the callback was created.
  const keyCtxRef = useRef(keyCtx)
  keyCtxRef.current = keyCtx
  // The project list column's width. An invalid or out-of-range stored value falls
  // back to the default rather than applying a bogus width — see Sidebar.tsx.
  const [listWidth, setListWidth] = useState<number>(() => {
    const stored = localStorage.getItem(LIST_WIDTH_STORAGE_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed)) return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, parsed))
    }
    return LIST_DEFAULT_WIDTH
  })
  const listDraggingRef = useRef(false)
  const listStartXRef = useRef(0)
  const listStartWidthRef = useRef(0)

  const handleListResizeMouseMove = useCallback((e: MouseEvent) => {
    if (!listDraggingRef.current) return
    const delta = e.clientX - listStartXRef.current
    const next = Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, listStartWidthRef.current + delta))
    setListWidth(next)
  }, [])

  const handleListResizeMouseUp = useCallback(() => {
    if (!listDraggingRef.current) return
    listDraggingRef.current = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setListWidth((w) => {
      localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(w))
      return w
    })
    window.removeEventListener('mousemove', handleListResizeMouseMove)
    window.removeEventListener('mouseup', handleListResizeMouseUp)
  }, [handleListResizeMouseMove])

  const handleListResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    listDraggingRef.current = true
    listStartXRef.current = e.clientX
    listStartWidthRef.current = listWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', handleListResizeMouseMove)
    window.addEventListener('mouseup', handleListResizeMouseUp)
  }, [listWidth, handleListResizeMouseMove, handleListResizeMouseUp])

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleListResizeMouseMove)
      window.removeEventListener('mouseup', handleListResizeMouseUp)
    }
  }, [handleListResizeMouseMove, handleListResizeMouseUp])

  const [selected, setSelected] = useState<ProjectGroup | null>(null)
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
  // Which account identity (see `identityOf`) the project column is scoped to —
  // persisted like `sort` above: it's the same kind of small per-visit tax to keep
  // re-picking it. 'all' is the initial state and needs no storage entry of its own.
  const [accountFilter, setAccountFilterState] = useState<string>(
    () => localStorage.getItem('projects.accountFilter') || 'all'
  )
  const setAccountFilter = (identity: string) => {
    setAccountFilterState(identity)
    localStorage.setItem('projects.accountFilter', identity)
  }
  const [favorites, setFavorites] = useState<string[]>([])
  // Rename precedence (custom name > repo name > basename) is shared with the
  // Sidebar via project-name.ts; `custom` is keyed by the same projectKey the
  // Sidebar renames under, so a rename made in either place shows in both.
  const [customNames, setCustomNames] = useState<Record<string, string>>({})
  // Filled in lazily, one gitRepoName call per VISIBLE group (see the effect below) —
  // a folder with no repo answer yet just shows its basename until it resolves.
  const [repoNames, setRepoNames] = useState<Record<string, RepoName>>({})
  const fetchedRepoKeys = useRef<Set<string>>(new Set())
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

  // The names the user gave their accounts, by email. Argos stores these itself (see
  // accounts.ts and provider-accounts.ts) and the account switcher shows them — "Work",
  // "Personal". A transcript source cannot supply them: the default account has no
  // `account:*` source of its own, so deriving a label from the source alone left the
  // filter saying "joao.leite" for the account this app calls Work.
  const [accountNames, setAccountNames] = useState<Record<string, string>>({})
  // Filled in from the same fetch as `accountNames` below — see `CodexAccountEmails`
  // and `identityOf`. Starts empty, so until this lands every Codex project's
  // identity is just its `sourceId`, same as before this feature existed.
  const [codexAccounts, setCodexAccounts] = useState<CodexAccountEmails>(NO_CODEX_ACCOUNTS)
  // The name of the Codex account behind each Codex source id, taken straight from the
  // stored account rather than by way of its email. A Codex account record holds only
  // { id, name, configDir } — the email comes from a live `codex login status` spawn,
  // so an identity resolved through the email reads "Codex" whenever that spawn is slow,
  // fails, or the CLI is signed out. The name is on disk and always there.
  const [codexSourceNames, setCodexSourceNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const collect = async () => {
      const out: Record<string, string> = {}
      const add = (list: { name: string; email?: string }[]) => {
        for (const a of list) {
          const email = a.email?.trim().toLowerCase()
          // First writer wins: Claude is read before the other providers, and an email
          // shared across providers is one identity here either way.
          if (email && a.name && !out[email]) out[email] = a.name
        }
      }
      const claude = await window.electronAPI.accountsList().catch(() => null)
      if (claude) add(claude.accounts)
      let codex: CodexAccountEmails = NO_CODEX_ACCOUNTS
      let codexNames: Record<string, string> = {}
      for (const provider of ['codex', 'gemini'] as const) {
        const res = await window.electronAPI.providerAccountsList(provider).catch(() => null)
        if (!res) continue
        add(res.accounts)
        if (provider === 'codex') {
          const byId = new Map<string, string>()
          let defaultEmail: string | undefined
          for (const a of res.accounts) {
            const email = a.email?.trim().toLowerCase()
            if (!email) continue
            byId.set(a.id, email)
            if (a.isDefault) defaultEmail = email
          }
          codex = { byId, defaultEmail }
          const names: Record<string, string> = {}
          for (const a of res.accounts) {
            if (!a.name) continue
            // `codex` is the default CODEX_HOME; a non-default account keeps its own.
            names[a.isDefault ? CODEX_SOURCE_ID : `${CODEX_SOURCE_ID}:${a.id}`] = a.name
          }
          codexNames = names
        }
      }
      if (!cancelled) {
        setAccountNames(out)
        setCodexAccounts(codex)
        setCodexSourceNames(codexNames)
      }
    }
    collect()
    return () => {
      cancelled = true
    }
  }, [])

  // `codexAccounts` arrives async, well after the account filter may already be set
  // to a Codex project's raw `sourceId` (either persisted from a previous visit, or
  // picked by the user before this fetch resolved). The moment the map lands,
  // `identityOf` starts resolving that same project to an email instead — and
  // `effectiveAccountFilter` below would then silently widen to "All" because the
  // old sourceId-shaped value stopped matching any option. Migrate the filter
  // forward to the newly-resolved identity instead, so the selection still means
  // the same account rather than quietly reverting.
  useEffect(() => {
    const match = projects.find(
      (p) => p.sourceId === accountFilter && identityOf(p, codexAccounts) !== accountFilter
    )
    if (match) setAccountFilter(identityOf(match, codexAccounts))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexAccounts, projects])

  // The options the filter offers: one per account identity actually present (see
  // `identityOf`), not one per source — a folder reached from Local and two WSL
  // distros under the same login is one account, not three. Grouped by identity
  // first so a label can be picked from whichever `account:*` source names it,
  // wherever in the list that source happens to appear.
  const accountOptions = useMemo<AccountOption[]>(() => {
    const byIdentity = new Map<string, CCProject[]>()
    for (const p of projects) {
      const id = identityOf(p, codexAccounts)
      const members = byIdentity.get(id)
      if (members) members.push(p)
      else byIdentity.set(id, [p])
    }
    const options: AccountOption[] = []
    for (const [identity, members] of byIdentity) {
      const email = members.find((m) => m.account?.email)?.account?.email
      // Prefer the label an `account:*` source gives this identity — the name the
      // user themselves picked for the account — over a WSL/local source's own
      // label, which just names the machine. If more than one `account:*` source
      // somehow disagrees on the label for one identity, pick deterministically by
      // `sourceId` so the option's wording never flickers between renders.
      const named = members
        .filter((m) => m.sourceId.startsWith('account:') && m.sourceLabel)
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      // The account's own name first — it is what the switcher shows and what the user
      // typed. Then a source that names the account, then the email, then the source.
      const label =
        (email ? accountNames[email] : undefined) ||
        codexSourceNames[identity] ||
        named[0]?.sourceLabel ||
        (email ? email.split('@')[0] : members[0].sourceLabel)
      options.push({ identity, label, sub: email && email !== label ? email : undefined })
    }
    return options.sort((a, b) => a.label.localeCompare(b.label))
  }, [projects, accountNames, codexAccounts, codexSourceNames])
  // A filter persisted from a previous run can name an identity that no longer
  // exists (an account removed, a distro unregistered) — fall back to 'all' rather
  // than scope every group down to zero members.
  const effectiveAccountFilter =
    accountFilter === 'all' || accountOptions.some((o) => o.identity === accountFilter)
      ? accountFilter
      : 'all'
  // `CCSessionMeta` (unlike `CCProject`) carries only `sourceId`, not the account
  // object identity is derived from — so a session's identity has to be looked up
  // via the source it came from, resolved once per `projects` list.
  const identityBySource = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects) map.set(p.sourceId, identityOf(p, codexAccounts))
    return map
  }, [projects, codexAccounts])
  const labelByIdentity = useMemo(
    () => new Map(accountOptions.map((o) => [o.identity, o.label])),
    [accountOptions]
  )
  // The provider(s) seen under each identity, used only to disambiguate the BADGE
  // (see `badgeLabelByIdentity`) — the select doesn't need it, since its option
  // already shows the email alongside the name.
  const providersByIdentity = useMemo(() => {
    const map = new Map<string, Set<SourceProvider>>()
    for (const p of projects) {
      const id = identityOf(p, codexAccounts)
      let set = map.get(id)
      if (!set) {
        set = new Set()
        map.set(id, set)
      }
      set.add(p.provider ?? 'claude')
    }
    return map
  }, [projects, codexAccounts])
  const PROVIDER_NAME: Record<SourceProvider, string> = { claude: 'Claude', codex: 'Codex' }
  // A badge shows only the account name (no email, unlike the select), so two
  // DIFFERENT accounts named the same thing ("Work" on both Claude and Codex) would
  // otherwise be indistinguishable there. Append the owning provider only to the
  // identities actually colliding on label — and only if that still tells them
  // apart; if two colliding identities also share a provider, leave the plain label
  // rather than invent a third disambiguator (see the module docstring rules).
  const badgeLabelByIdentity = useMemo(() => {
    const byLabel = new Map<string, AccountOption[]>()
    for (const o of accountOptions) {
      const list = byLabel.get(o.label)
      if (list) list.push(o)
      else byLabel.set(o.label, [o])
    }
    const map = new Map<string, string>()
    for (const [label, opts] of byLabel) {
      if (opts.length === 1) {
        map.set(opts[0].identity, label)
        continue
      }
      const candidates = opts.map((o) => {
        const providers = Array.from(providersByIdentity.get(o.identity) ?? [])
        const provider = providers.sort()[0]
        return { identity: o.identity, text: provider ? `${label} · ${PROVIDER_NAME[provider]}` : label }
      })
      const counts = new Map<string, number>()
      for (const c of candidates) counts.set(c.text, (counts.get(c.text) ?? 0) + 1)
      for (const c of candidates) {
        map.set(c.identity, (counts.get(c.text) ?? 0) > 1 ? label : c.text)
      }
    }
    return map
  }, [accountOptions, providersByIdentity])
  const sessionIdentity = (s: CCSessionMeta): string => identityBySource.get(s.sourceId) ?? s.sourceId
  const sessionAccountLabel = (s: CCSessionMeta): string => {
    const identity = sessionIdentity(s)
    return badgeLabelByIdentity.get(identity) ?? labelByIdentity.get(identity) ?? identity
  }

  // One row per real folder, not per spelling — see `groupProjects`. Grouped from
  // every project regardless of the account filter: favorites and ProjectActions (see
  // `fullMembersByKey` below) act on the whole folder, not on whichever slice of it
  // the filter currently shows.
  const allGroups = useMemo(() => groupProjects(projects, keyCtx), [projects, keyCtx])
  // The list actually rendered — each group narrowed to the current account filter
  // (see `scopeGroup`), and dropped entirely once nothing in it matches.
  const projectGroups = useMemo(
    () =>
      allGroups
        .map((g) => scopeGroup(g, effectiveAccountFilter, codexAccounts))
        .filter((g): g is ProjectGroup => g !== null),
    [allGroups, effectiveAccountFilter, codexAccounts]
  )
  // Every member of a group, ignoring the account filter. Used ONLY where a whole-folder
  // reading is the right one; the destructive actions deliberately do not use it.
  const fullMembersByKey = useMemo(
    () => new Map(allGroups.map((g) => [g.key, g.members])),
    [allGroups]
  )
  const membersOf = (g: ProjectGroup): CCProject[] => fullMembersByKey.get(g.key) ?? g.members
  // Name precedence (custom > repo > basename) and nothing more: no parent-folder prefix
  // on homonyms. `Ubuntu/jdl` and `X:/infra-automations` read as noise here, and the row
  // already carries a distro badge and a path tooltip that tell homonyms apart.
  const displayNames = useMemo(
    () =>
      new Map(
        projectGroups.map((g) => {
          const p = primaryMember(g)
          const path = canonicalProjectPath(p.realPath, p.distro, keyCtx)
          return [g.key, projectDisplayName(g.key, path, { custom: customNames, repos: repoNames })]
        })
      ),
    [projectGroups, customNames, repoNames, keyCtx]
  )
  const nameOf = (g: ProjectGroup): string => displayNames.get(g.key) ?? primaryMember(g).name

  const load = async () => {
    setLoading(true)
    const list = await window.electronAPI.ccListProjects()
    setProjects(list)
    setLoading(false)
    // Opening on the first project is a default, not a decision — and a deep link is
    // a decision, so it wins even when it arrived while this listing was in flight.
    // Grouped fresh from `list` rather than read off the `projectGroups` memo: that
    // memo reflects the *previous* render's `projects` state until this update lands.
    // Scoped by the current filter too — auto-selecting a project the filter would
    // immediately hide defeats the point of picking one. Normalised against THIS
    // fresh list rather than trusting `accountOptions` (computed off the `projects`
    // state, which is still one render behind): a filter persisted from a previous
    // run that named a since-removed identity must fall back to 'all' here too, or
    // this would silently pick nothing at all.
    const knownIdentities = new Set(list.map((p) => identityOf(p, codexAccounts)))
    const effectiveFilter =
      accountFilter === 'all' || knownIdentities.has(accountFilter) ? accountFilter : 'all'
    const firstGroup = scopeGroups(list, effectiveFilter, codexAccounts, keyCtxRef.current)[0]
    if (firstGroup && !selected && !targetRef.current) selectProject(firstGroup)
  }

  useEffect(() => {
    load()
    window.electronAPI.ccFavorites().then(setFavorites)
    window.electronAPI.ccProjectNames().then(setCustomNames).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A project just archived (or unarchived past the other scope) drops out of the
  // visible list on the next `load()`. Leaving the reading panel pointed at a row
  // nobody can see is worse than clearing it — the sessions pane falls back to its
  // "select a project" empty state.
  useEffect(() => {
    if (!selected) return
    const stillListed = projectGroups.find((g) => g.key === selected.key)
    if (!stillListed || stillListed.archived !== showArchivedProjects) {
      setSelected(null)
      setSessions([])
      setPeeked(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectGroups, showArchivedProjects])

  // The filter above can narrow (or restore) which members belong to the selected
  // group without making it disappear outright — that case is the effect above's job.
  // Here, re-list so the sessions pane (and the header's own count) follow the new
  // scope instead of quietly continuing to show a stale, wider set of sessions.
  useEffect(() => {
    if (!selected) return
    const match = projectGroups.find((g) => g.key === selected.key)
    if (match) selectProject(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountFilter])

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

  // Favorites, like archiving, are a preference about the folder — not about
  // whichever slice of its members the account filter currently shows — so both read
  // from `membersOf`, the FULL member list, rather than the (possibly scoped) `g`.
  const isGroupFavorite = (g: ProjectGroup) =>
    groupFavoriteKeys(membersOf(g)).some((k) => favorites.includes(k))

  const toggleFavorite = async (g: ProjectGroup) => {
    const next = !isGroupFavorite(g)
    // The pin is stored per member (`sourceId:encodedDir`), so pinning the group means
    // writing it for every member — done one at a time (not Promise.all) so each
    // write's returned list already includes the ones before it, and the state we end
    // on reflects all of them rather than whichever call happened to finish last.
    let result = favorites
    for (const m of membersOf(g)) {
      result = await window.electronAPI.ccSetFavorite(m.sourceId, m.encodedDir, next)
    }
    setFavorites(result)
  }

  // A group can be several spellings of one folder — list every member's sessions and
  // concatenate, then sort the merged list the way a single project's list always was.
  const listGroupSessions = (g: ProjectGroup, archived: boolean): Promise<CCSessionMeta[]> =>
    Promise.all(
      g.members.map((m) => window.electronAPI.ccListSessions(m.sourceId, m.encodedDir, archived))
    ).then((lists) => lists.flat().sort((a, b) => b.updatedAt - a.updatedAt))

  const selectProject = async (g: ProjectGroup) => {
    const seq = ++listingSeq.current
    setSelected(g)
    setLoadingSessions(true)
    setEditingTags(null)
    setPeeked(null)
    const s = await listGroupSessions(g, showArchived)
    if (seq !== listingSeq.current) return
    setSessions(s)
    setLoadingSessions(false)
    // Listing folds newly-seen tags into the registry, so the colours may have grown.
    reloadLabels()
  }

  const refreshSessions = async () => {
    if (!selected) return
    const seq = ++listingSeq.current
    const s = await listGroupSessions(selected, showArchived)
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
      const ctx = keyCtxRef.current
      const group = groupProjects(list, ctx).find(
        (g) => g.key === projectKey(proj.realPath, proj.distro, ctx)
      )
      if (!group || cancelled) return
      // A notification click is a decision, not a default — the account filter must
      // not be able to silently swallow it. Widen back to All when the filtered view
      // would otherwise hide every member of the project it points at.
      const scoped = scopeGroup(group, accountFilter, codexAccounts)
      if (!scoped) setAccountFilter('all')
      const useGroup = scoped ?? group
      let found = await listGroupSessions(useGroup, false)
      let archived = false
      if (!found.some((s) => s.sessionId === target.sessionId)) {
        const inArchive = await listGroupSessions(useGroup, true)
        if (inArchive.some((s) => s.sessionId === target.sessionId)) {
          found = inArchive
          archived = true
        }
      }
      if (cancelled || seq !== listingSeq.current) return
      setSelected(useGroup)
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

  // Select the project Home pointed at. Matching is by projectKey, not by raw path:
  // the same folder reaches this list spelled differently depending on which source
  // recorded it, which is the whole reason that key exists.
  useEffect(() => {
    if (!focus) return
    let cancelled = false
    ;(async () => {
      const list = projects.length ? projects : await window.electronAPI.ccListProjects()
      if (cancelled) return
      const group = groupProjects(list, keyCtxRef.current).find((g) => g.key === focus.key)
      if (!group || cancelled) return
      // Same reasoning as the deep-link effect above: a click from Home must not be
      // hidden by a filter that happens to exclude every member of that project.
      const scoped = scopeGroup(group, accountFilter, codexAccounts)
      if (!scoped) setAccountFilter('all')
      selectProject(scoped ?? group)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // The in-project search. Debounced like the global one, and reset by moving to
  // another project — a query typed for one project means nothing in the next.
  useEffect(() => {
    setProjectQuery('')
    setProjectHits(new Map())
  }, [selected?.key])

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
      // One search per member, merged — a hit filed under a sibling spelling of this
      // same folder still has to surface here.
      const results = await Promise.all(
        selected.members.map((m) =>
          window.electronAPI.ccSearch(q, { sourceId: m.sourceId, encodedDir: m.encodedDir })
        )
      )
      if (cancelled) return
      setProjectHits(new Map(results.flat().map((h) => [h.sessionId, h])))
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
    if (!match) return
    // A move usually changes the moved member's projectKey (it is a genuinely
    // different real path now), so look its GROUP up fresh rather than assume it is
    // still the one `selected` pointed at.
    const group = projectGroups.find(
      (g) => g.key === projectKey(match.realPath, match.distro, keyCtx)
    )
    if (group) {
      selectProject(group)
      setPendingSelect(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectGroups, pendingSelect])

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
  // A per-row account badge only earns its place when it disambiguates something —
  // if every visible session belongs to the same account, tagging each one is pure
  // noise. Same condition Sidebar.tsx applies to its own session badges (model/
  // account only render when a session diverges from what the rest of the list
  // already implies).
  const showSessionAccounts = new Set(visibleSessions.map(sessionIdentity)).size > 1

  const changeSort = (mode: SortMode) => {
    setSort(mode)
    localStorage.setItem('projects.sort', mode)
  }

  const toggleFilter = (tag: string) =>
    setFilterTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))

  // Pinned first, then the rest by recency. Sections are only worth labelling when
  // both exist — see the render.
  const matchesFilter = (g: ProjectGroup) => {
    const q = projectFilter.trim().toLowerCase()
    if (!q) return true
    return (
      nameOf(g).toLowerCase().includes(q) ||
      g.members.some((m) => m.realPath.toLowerCase().includes(q))
    )
  }
  const hasArchivedProjects = projectGroups.some((g) => g.archived)
  // `hasArchivedProjects &&` is what stops the column stranding itself: unarchive the
  // last archived project while looking at them and the toggle disappears, leaving a
  // scope nothing can ever match.
  const archivedScope = hasArchivedProjects && showArchivedProjects
  const shown = projectGroups.filter((g) => matchesFilter(g) && g.archived === archivedScope)
  const pinned = shown.filter(isGroupFavorite)
  const rest = shown.filter((g) => !isGroupFavorite(g))
  const projectSections = [
    ...(pinned.length ? [{ label: 'Pinned', projects: pinned }] : []),
    ...(rest.length ? [{ label: 'Recent', projects: rest }] : [])
  ]

  // Ask git for a repo name — one call per group, not per member — but only for the
  // groups actually on screen right now: walking every WSL distro's git binary for
  // rows nobody is looking at would make Refresh (and the archived toggle) noticeably
  // slower for no visible gain. The list paints immediately with whatever name it
  // already has and quietly upgrades to the repo name once this resolves.
  const shownKey = shown.map((g) => g.key).join('|')
  useEffect(() => {
    const targets = shown.filter((g) => !fetchedRepoKeys.current.has(g.key))
    if (!targets.length) return
    for (const g of targets) fetchedRepoKeys.current.add(g.key)
    for (const g of targets) {
      const primary = primaryMember(g)
      const cwd = canonicalProjectPath(primary.realPath, primary.distro, keyCtxRef.current)
      window.electronAPI
        .gitRepoName(cwd)
        .then((repo) => setRepoNames((prev) => ({ ...prev, [g.key]: repo })))
        // A folder with no repo (or a git call that failed) just keeps showing its
        // basename — one miss here must never take the others down with it.
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])

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
        resumeOrPeek(peeked)
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
          {/* The width and the drag handle belong to this wrapper, not to the scrolling
             column inside it: a handle positioned against a scroll container rides the
             content and is gone as soon as the list is scrolled. Sidebar.tsx gets away
             with the handle inside because there the scroll lives in a child. */}
          <div className="projects-list-wrap" style={{ width: listWidth }}>
          <div className="projects-list" onScroll={() => setProjectMenu(null)}>
            {/* Only earns its place once there is a choice to make — a lone "Local"
                setup has nothing for this control to do. */}
            {accountOptions.length > 1 && (
              <select
                className="projects-source-filter"
                aria-label="Filter projects by account"
                value={effectiveAccountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
              >
                <option value="all">All accounts</option>
                {accountOptions.map((o) => (
                  <option key={o.identity} value={o.identity}>
                    {o.sub ? `${o.label} — ${o.sub}` : o.label}
                  </option>
                ))}
              </select>
            )}
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
                {section.projects.map((g) => {
                  const key = g.key
                  const fav = isGroupFavorite(g)
                  const name = nameOf(g)
                  // Actions that need one concrete CCProject (rename via the menu's
                  // archive/move/delete, see ProjectActions) act on whichever member
                  // was active most recently across the WHOLE folder, not just the
                  // members the account filter currently shows — archiving, moving and
                  // deleting are folder-wide operations, and the "most recent" member
                  // to default to shouldn't change just because the filter narrowed.
                  // What the actions act on is what the row is showing. With an account
                  // filter on, `g.members` is that account's slice — deleting or moving
                  // the directories of an account the filter has hidden would be acting
                  // outside what the screen says is there. With no filter, this is every
                  // member, which is the same list as before.
                  const actionMembers = g.members
                  const primary = primaryOfMembers(actionMembers)
                  const accountEmails = Array.from(
                    new Set(g.members.map((m) => m.account?.email).filter((e): e is string => !!e))
                  )
                  return (
                    <div
                      key={key}
                      className={`project-row ${selected?.key === g.key ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      /* The path and the account moved into the tooltip: repeated on
                         every row they were noise, and dropping them is what lets the
                         column be narrow. Two projects can share a name, so the path
                         still has to be reachable. A group can hold more than one real
                         path spelling, so every member's is listed. */
                      title={`${g.members.map((m) => m.realPath).join('\n')}${
                        accountEmails.length ? `\n${accountEmails.join(', ')}` : ''
                      }`}
                      onClick={() => selectProject(g)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectProject(g)
                        }
                      }}
                    >
                      <div className="project-row-name">
                        {fav && <span className="project-star-on" aria-hidden="true">★</span>}
                        <span className="project-row-label">{name}</span>
                        {/* One badge per distro seen among the members, never repeated. */}
                        {g.distros.map((d) => (
                          <span key={d} className="src-badge wsl">{d}</span>
                        ))}
                      </div>
                      <div className="project-row-meta">
                        {/* A bare 0 reads as a loading state; say what it means instead. */}
                        <span>
                          {g.sessionCount + g.archivedCount === 0
                            ? 'Empty'
                            : g.archivedCount
                              ? `${g.sessionCount} · ${g.archivedCount} archived`
                              : g.sessionCount}
                        </span>
                        <span>·</span>
                        <span>{timeAgo(g.lastActive)}</span>
                      </div>
                      <button
                        className={`project-star ${fav ? 'on' : ''}`}
                        title={fav ? 'Unpin' : 'Pin to top'}
                        aria-label={fav ? `Unpin ${name}` : `Pin ${name} to top`}
                        aria-pressed={fav}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFavorite(g)
                        }}
                      >
                        ★
                      </button>
                      <button
                        className="project-menu-btn"
                        title="Actions"
                        aria-label={`Actions for ${name}`}
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
                          project={primary}
                          // Every member of the folder, not just the ones the account
                          // filter shows — see the comment on `primary` above.
                          siblings={actionMembers.map((m) => ({ sourceId: m.sourceId, encodedDir: m.encodedDir }))}
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
            {/* Not a keyboard control — aria-hidden, like Sidebar.tsx's own handle. */}
            <div
              className="projects-list-resize-handle"
              onMouseDown={handleListResizeMouseDown}
              aria-hidden="true"
            />
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
                      placeholder={`Search in ${nameOf(selected)}…`}
                      aria-label={`Search in ${nameOf(selected)}`}
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
                            onDoubleClick={() => resumeOrPeek(s)}
                            role="button"
                            tabIndex={0}
                            aria-current={peeked?.sessionId === s.sessionId}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') resumeOrPeek(s)
                            }}
                          >
                            <span className="cc-row-main">
                              <span className="cc-row-title" title={s.title}>
                                {s.title}
                              </span>
                              {/* Only earns its place when the visible list actually
                                  mixes accounts — see `showSessionAccounts` above. */}
                              {showSessionAccounts && (
                                <span className="src-badge acct" title={sessionAccountLabel(s)}>
                                  {sessionAccountLabel(s)}
                                </span>
                              )}
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
              resumable={canResume(peeked)}
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
