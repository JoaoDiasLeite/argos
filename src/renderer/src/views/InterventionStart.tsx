import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { rich } from '../lib/t-rich'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { OpsIntervention, OpsRunbookInfo, OpsRunListItem, OpsScope, SshHostPublic } from '../types'
import {
  allRunbookPaths,
  looseOnly,
  readLastRunbook,
  readRunbookSources,
  writeLastRunbook,
  type RunbookSources
} from '../lib/runbook-library'
import { samePath, useBuiltinRunbook } from '../lib/builtin-runbook'
import OpsReportSheet from '../components/OpsReportSheet'
import { plural, type TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import './InterventionStart.css'

/**
 * Servers → Ops: the start of an intervention (docs/INTERVENTIONS_PLAN.md §4, board C2).
 * One server (or, deliberately, any server the runbook allows), one runbook, one task.
 * The right column says in plain words what the runbook allows before anything runs, and
 * lists the earlier runs on the chosen server.
 *
 * Runbooks are the runbooks folder of Settings (every subfolder that looks like one) and the
 * loose runbooks picked one by one, rescanned and re-read on mount: a runbook is a folder
 * someone edits, and a policy that stopped validating is exactly what must show here.
 *
 * The mode comes first: despiste (the read-only runbook shipped with Argos) is always the
 * default and is not remembered; an intervention with a runbook is chosen on purpose.
 */

const LAST_CLIENT_KEY = 'ops.lastClient'
const HISTORY_LIMIT = 8

type DotState = 'checking' | 'ok' | 'error'
type InfoState = OpsRunbookInfo | 'loading'
/** `null` until chosen; `'open'` is "Any server this runbook allows". */
type ServerChoice = string | 'open' | null
type Mode = 'despiste' | 'runbook'

const OPEN = 'open' as const
const MODES: Mode[] = ['despiste', 'runbook']
/** The built-in runbook's folder name, which is also the name its runs carry in the ledger. */
const BUILTIN_NAME = 'despiste'

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const hostAddress = (h: SshHostPublic) => `${h.username}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`

function readLastClient(): string {
  try {
    return localStorage.getItem(LAST_CLIENT_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeLastClient(client: string) {
  try {
    if (client) localStorage.setItem(LAST_CLIENT_KEY, client)
  } catch {
    /* storage unavailable: the client just isn't remembered */
  }
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: ReactNode[], t: TFunction): ReactNode[] {
  const out: ReactNode[] = []
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? t('ops.start.and') : ', ')
    out.push(item)
  })
  return out
}

function withStop(s: string): string {
  const t = s.trim()
  return /[.!?…:]$/.test(t) ? t : `${t}.`
}

function runWhen(iso: string, t: TFunction, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff === 0) return t('ops.start.today', { time })
  if (diff === 1) return t('ops.start.yesterday')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

function runStatus(r: OpsRunListItem, t: TFunction): { label: string; tone: 'ok' | 'bad' | 'muted' } {
  if (r.aborted) return { label: t('ops.start.status.stopped'), tone: 'bad' }
  if (r.ok === true) return { label: t('ops.start.status.finished'), tone: 'ok' }
  if (r.ok === false) return { label: t('ops.start.status.failed'), tone: 'bad' }
  if (!r.endedAt) return { label: t('ops.start.status.unfinished'), tone: 'muted' }
  return { label: t('ops.start.status.ended'), tone: 'muted' }
}

// ── Icons ────────────────────────────────────────────────────────────────────

const Chevron = () => (
  <svg className="ivs-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
)
const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)
const ShieldIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)
const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)
const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)
const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

// ── Dropdown ─────────────────────────────────────────────────────────────────

type DropItem =
  | { kind: 'option'; key: string; content: ReactNode; selected?: boolean; onSelect: () => void }
  | { kind: 'divider'; key: string }
  | { kind: 'note'; key: string; content: ReactNode }
  /** A group title: not an option, so the arrow keys pass over it. */
  | { kind: 'header'; key: string; content: ReactNode }

/**
 * A field-shaped trigger over a listbox, so options can carry a status dot or a chip that
 * a native select cannot draw. Arrow keys move, Enter picks, Escape or a click outside
 * closes. Headers and notes are not options: the keys skip them.
 */
function IvsDropdown({
  labelledBy,
  trigger,
  items,
  invalid
}: {
  labelledBy: string
  trigger: ReactNode
  items: DropItem[]
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const options = items.flatMap((it, i) => (it.kind === 'option' ? [i] : []))

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  const openList = () => {
    const sel = items.findIndex((it) => it.kind === 'option' && it.selected)
    setActive(sel >= 0 ? sel : (options[0] ?? -1))
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const pick = (i: number) => {
    const it = items[i]
    if (it?.kind !== 'option') return
    close()
    it.onSelect()
  }

  const onListKey = (e: ReactKeyboardEvent) => {
    const pos = options.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(options[Math.min(options.length - 1, pos + 1)] ?? active)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(options[Math.max(0, pos - 1)] ?? active)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(options[0] ?? active)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options[options.length - 1] ?? active)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div className="ivs-dd" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`ivs-control ivs-dd-trigger${open ? ' open' : ''}${invalid ? ' invalid' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openList()
          }
        }}
      >
        {trigger}
        <span className="ivs-flex" />
        <Chevron />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className="ivs-dd-list"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onKeyDown={onListKey}
        >
          {items.map((it, i) =>
            it.kind === 'divider' ? (
              <div key={it.key} className="ivs-dd-divider" role="separator" />
            ) : it.kind === 'note' ? (
              <div key={it.key} className="ivs-dd-note">
                {it.content}
              </div>
            ) : it.kind === 'header' ? (
              <div key={it.key} className="ivs-dd-header" role="presentation">
                {it.content}
              </div>
            ) : (
              <div
                key={it.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={!!it.selected}
                className={`ivs-dd-option${i === active ? ' active' : ''}${it.selected ? ' selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                {it.content}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

// ── Mode ─────────────────────────────────────────────────────────────────────

/** Two radio options side by side; arrow keys move the choice, only the chosen one is a tab stop. */
function ModeControl({ labelledBy, mode, onChange }: { labelledBy: string; mode: Mode; onChange: (m: Mode) => void }) {
  const t = useT()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + MODES.length) % MODES.length
    onChange(MODES[next])
    refs.current[next]?.focus()
  }
  return (
    <div className="ivs-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {MODES.map((m, i) => (
        <button
          key={m}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={mode === m}
          tabIndex={mode === m ? 0 : -1}
          className={mode === m ? 'on' : ''}
          onClick={() => onChange(m)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span className="ivs-seg-title">{m === 'despiste' ? t('ops.start.mode.despiste') : t('ops.start.mode.runbook')}</span>
          <span className="ivs-seg-sub">{m === 'despiste' ? t('ops.start.mode.despisteSub') : t('ops.start.mode.runbookSub')}</span>
        </button>
      ))}
    </div>
  )
}

// ── The screen ───────────────────────────────────────────────────────────────

interface Props {
  /** Preselects this SSH host (the Ops button on a Remote & WSL row). */
  initialHostId?: string
  onStart: (intervention: OpsIntervention) => void
}

export default function InterventionStart({ initialHostId, onStart }: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [hosts, setHosts] = useState<SshHostPublic[] | null>(null)
  const [dots, setDots] = useState<Record<string, DotState>>({})
  const [server, setServer] = useState<ServerChoice>(initialHostId ?? null)

  /** Despiste on every mount, by decision: an intervention with a runbook is picked on purpose. */
  const [mode, setMode] = useState<Mode>('despiste')
  const builtin = useBuiltinRunbook()

  /** The runbooks folder and the loose runbooks; null until the first scan has answered. */
  const [sources, setSources] = useState<RunbookSources | null>(null)
  const [scanning, setScanning] = useState(false)
  /** A refused change to the runbook sources (setOpsPrefs). */
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const listed = useMemo(() => (sources ? allRunbookPaths(sources) : []), [sources])
  const loose = useMemo(() => (sources ? looseOnly(sources) : []), [sources])
  const [infos, setInfos] = useState<Record<string, InfoState>>({})
  /** The runbook-mode choice. It survives a detour through despiste, and never holds the built-in path. */
  const [runbookPath, setRunbookPath] = useState<string | null>(null)
  /** Once the operator picks a runbook, the automatic default stops second-guessing it. */
  const runbookChosen = useRef(false)
  /** What the intervention starts with: the built-in runbook in despiste mode. */
  const activePath = mode === 'despiste' ? builtin : runbookPath

  const [task, setTask] = useState('')
  const [ticket, setTicket] = useState('')
  const [client, setClient] = useState(readLastClient)

  const [runs, setRuns] = useState<{ ok: true; runs: OpsRunListItem[] } | { ok: false; error: string } | 'loading'>('loading')
  const [reportFor, setReportFor] = useState<{ runId: string; runbookPath?: string; appSessionId?: string } | null>(null)

  const serverLabelId = useId()
  const modeLabelId = useId()
  const runbookLabelId = useId()
  const taskId = useId()
  const ticketId = useId()
  const clientId = useId()

  // Hosts, then a connection test of each so the list carries a live dot.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .sshList()
      .then((list) => {
        if (cancelled) return
        setHosts(list)
        setDots(Object.fromEntries(list.map((h) => [h.id, 'checking' as const])))
        for (const h of list) {
          window.electronAPI
            .sshTest(h.id)
            .then((res) => !cancelled && setDots((prev) => ({ ...prev, [h.id]: res.ok ? 'ok' : 'error' })))
            .catch(() => !cancelled && setDots((prev) => ({ ...prev, [h.id]: 'error' })))
        }
      })
      .catch(() => !cancelled && setHosts([]))
    return () => {
      cancelled = true
    }
  }, [])

  const loadRunbook = useCallback((dir: string): Promise<OpsRunbookInfo> => {
    setInfos((prev) => ({ ...prev, [dir]: 'loading' }))
    return window.electronAPI
      .opsLoadRunbook(dir)
      .catch((e): OpsRunbookInfo => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((info) => {
        setInfos((prev) => ({ ...prev, [dir]: info }))
        return info
      })
  }, [])

  /** Rescan the runbooks folder and re-read every runbook listed. */
  const refreshSources = useCallback(async (): Promise<RunbookSources> => {
    setScanning(true)
    let next: RunbookSources
    try {
      next = await readRunbookSources()
    } catch (e) {
      next = { dir: null, library: [], libraryError: e instanceof Error ? e.message : String(e), loose: [] }
    }
    setSources(next)
    setScanning(false)
    for (const dir of allRunbookPaths(next)) void loadRunbook(dir)
    return next
  }, [loadRunbook])

  useEffect(() => {
    void refreshSources()
  }, [refreshSources])

  useEffect(() => {
    if (builtin) void loadRunbook(builtin)
  }, [builtin, loadRunbook])

  // Default runbook (runbook mode only): once every listed runbook has loaded, the last one
  // used if it is still listed and knows the chosen host, else the first usable one that
  // knows it; with no host chosen, or none that knows it, the last used, else the first usable.
  useEffect(() => {
    if (mode !== 'runbook' || runbookChosen.current || runbookPath || listed.length === 0) return
    if (listed.some((d) => !infos[d] || infos[d] === 'loading')) return
    const usable = listed.filter((d) => {
      const i = infos[d]
      return i && i !== 'loading' && i.ok
    })
    const knows = (d: string) => {
      const i = infos[d]
      return typeof server === 'string' && server !== OPEN && i && i !== 'loading' && i.ok && i.hosts.some((h) => h.id === server)
    }
    const lastUsed = readLastRunbook()
    const last = lastUsed ? usable.find((d) => samePath(d, lastUsed)) : undefined
    const pick = (last && knows(last) ? last : undefined) ?? usable.find(knows) ?? last ?? usable[0]
    if (pick) setRunbookPath(pick)
  }, [infos, listed, mode, runbookPath, server])

  const scope: OpsScope | null =
    server === null ? null : server === OPEN ? { kind: 'open' } : { kind: 'host', hostId: server }
  const hostId = scope?.kind === 'host' ? scope.hostId : undefined

  // Earlier runs on the chosen server; every run when the scope is open or not chosen yet.
  useEffect(() => {
    let cancelled = false
    setRuns('loading')
    window.electronAPI
      .opsRuns({ hostId, limit: HISTORY_LIMIT })
      .then((res) => !cancelled && setRuns(res))
      .catch((e) => !cancelled && setRuns({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [hostId])

  const selectedHost = hostId ? hosts?.find((h) => h.id === hostId) : undefined
  const info: InfoState | undefined = activePath ? infos[activePath] : undefined
  const loaded = info && info !== 'loading' ? info : undefined
  const okInfo = loaded?.ok ? loaded : undefined
  const summary = okInfo?.summary

  // ── Validation (inline) ────────────────────────────────────────────────────
  const hostProblem = useMemo(() => {
    if (!okInfo || !scope) return null
    if (scope.kind === 'open') {
      return okInfo.hosts.length === 0 ? t('ops.start.noHosts') : null
    }
    const known = okInfo.hosts.find((h) => h.id === scope.hostId)
    if (known && known.groups.length > 0) return null
    const name = selectedHost?.name ?? known?.name ?? t('ops.start.thisServer')
    return t('ops.start.unknownToRunbook', { name })
  }, [okInfo, scope, selectedHost, t])

  const missing = [
    !scope && t('ops.start.needServer'),
    mode === 'runbook' && !runbookPath && t('ops.start.needRunbook')
  ].filter((m): m is string => !!m)
  // In despiste mode the built-in path arrives on its own; until it has loaded, it is loading.
  const blocked = !!hostProblem || (!!loaded && !loaded.ok) || info === 'loading' || (mode === 'despiste' && !info)
  const canStart = missing.length === 0 && !blocked

  const startHint = canStart
    ? t('ops.start.hintReady')
    : missing.length > 0
      ? t('ops.start.hintNeeded', {
          items: missing.length === 1
            ? missing[0]
            : t('ops.start.listAnd', { head: missing.slice(0, -1).join(', '), last: missing[missing.length - 1] })
        })
      : info === 'loading' || !info
        ? t('ops.start.hintLoading')
        : t('ops.start.hintFix')

  const start = () => {
    if (!canStart || !scope || !activePath) {
      return
    }
    const c = client.trim()
    const tk = ticket.trim()
    writeLastClient(c)
    // The built-in runbook is always one click away as the mode, so it is not remembered.
    if (mode === 'runbook' && !samePath(activePath, builtin)) writeLastRunbook(activePath)
    onStart({ runbookPath: activePath, scope, task: task.trim(), ...(tk ? { ticket: tk } : {}), ...(c ? { client: c } : {}) })
  }

  /** Stores the loose runbooks; the list shown follows what main kept. */
  const saveLoose = async (folders: string[]): Promise<boolean> => {
    setSourcesError(null)
    try {
      const r = await window.electronAPI.setOpsPrefs({ runbookFolders: folders })
      if (!r.ok) {
        setSourcesError(r.error)
        return false
      }
      setSources((prev) => prev && { ...prev, loose: r.ops.runbookFolders ?? [] })
      return true
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  /** "Choose runbooks folder…": every subfolder of it that looks like a runbook is listed. */
  const chooseLibrary = async () => {
    const dir = await window.electronAPI.openFolder(sources?.dir ?? undefined)
    if (!dir) return
    setSourcesError(null)
    try {
      const r = await window.electronAPI.setOpsPrefs({ runbooksDir: dir })
      if (!r.ok) {
        setSourcesError(r.error)
        return
      }
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e))
      return
    }
    // A default picked from the old folder makes way for one from the new.
    if (!runbookChosen.current) setRunbookPath(null)
    await refreshSources()
  }

  /** "Choose a runbook…": one folder, kept as a loose runbook unless the library has it. */
  const chooseOne = async () => {
    const dir = await window.electronAPI.openFolder()
    if (!dir) return
    runbookChosen.current = true
    setRunbookPath(dir)
    const res = await loadRunbook(dir)
    if (!res.ok || samePath(dir, builtin) || !sources) return
    if (sources.loose.some((p) => samePath(p, dir)) || sources.library.some((e) => samePath(e.path, dir))) return
    await saveLoose([...sources.loose, dir])
  }

  const forget = async (dir: string) => {
    if (!sources) return
    if (!(await saveLoose(sources.loose.filter((p) => !samePath(p, dir))))) return
    if (runbookPath === dir) {
      runbookChosen.current = true
      setRunbookPath(null)
    }
  }

  // ── Server field ───────────────────────────────────────────────────────────
  const hostRow = (h: SshHostPublic) => (
    <>
      <span className={`ivs-dot ${dots[h.id] ?? 'checking'}`} aria-hidden="true" />
      <span className="ivs-value">{h.name}</span>
      <span className="ivs-meta">{hostAddress(h)}</span>
    </>
  )
  const serverTrigger =
    server === OPEN ? (
      <span className="ivs-value">{t('ops.start.anyServer')}</span>
    ) : selectedHost ? (
      hostRow(selectedHost)
    ) : server && hosts ? (
      <span className="ivs-value">{t('ops.start.unknownServer')}</span>
    ) : (
      <span className="ivs-placeholder">{t('ops.start.chooseServer')}</span>
    )
  const serverItems: DropItem[] = [
    ...(hosts && hosts.length === 0
      ? [{ kind: 'note' as const, key: 'none', content: t('ops.start.noSshHosts') }]
      : (hosts ?? []).map((h) => ({
          kind: 'option' as const,
          key: h.id,
          selected: server === h.id,
          content: hostRow(h),
          onSelect: () => setServer(h.id)
        }))),
    { kind: 'divider', key: 'div' },
    {
      kind: 'option',
      key: OPEN,
      selected: server === OPEN,
      content: <span className="ivs-value">{t('ops.start.anyServer')}</span>,
      onSelect: () => setServer(OPEN)
    }
  ]
  const serverHelp =
    server === OPEN
      ? t('ops.start.helpOpen')
      : server
        ? t('ops.start.helpLocked')
        : t('ops.start.helpNone')

  // ── Runbook field ──────────────────────────────────────────────────────────
  const runbookRow = (dir: string, withPath: boolean, onForget?: () => void) => {
    const i = infos[dir]
    const name = i && i !== 'loading' && i.ok ? i.name : baseName(dir)
    let chip: ReactNode = null
    if (!i || i === 'loading') chip = <span className="ivs-meta">{t('common.loading')}</span>
    else if (!i.ok) chip = <span className="ivs-chip bad">{t('ops.start.unusable')}</span>
    else {
      const s = i.summary
      if (s) chip = <span className={`ivs-chip${s.mutates > 0 ? ' warn' : ''}`}>{s.mutates === 0 ? t('ops.start.readOnly') : t('ops.start.changesServer')}</span>
    }
    return (
      <>
        <span className="ivs-value">{name}</span>
        {chip}
        {withPath && (
          <span className="ivs-meta ivs-path" title={dir}>
            {dir}
          </span>
        )}
        {onForget && (
          <button
            type="button"
            className="ivs-dd-forget"
            tabIndex={-1}
            title={t('ops.start.forgetRunbook', { name })}
            aria-label={t('ops.start.forgetRunbook', { name })}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onForget()
            }}
          >
            <CloseIcon />
          </button>
        )}
      </>
    )
  }
  const runbookOption = (dir: string, isLoose: boolean): DropItem => ({
    kind: 'option',
    key: dir,
    selected: runbookPath === dir,
    content: runbookRow(dir, isLoose, isLoose ? () => void forget(dir) : undefined),
    onSelect: () => {
      runbookChosen.current = true
      setRunbookPath(dir)
      void loadRunbook(dir)
    }
  })
  const actionOption = (key: string, label: string, meta: string, onSelect: () => void): DropItem => ({
    kind: 'option',
    key,
    content: (
      <>
        <span className="ivs-option-icon">
          <FolderIcon />
        </span>
        <span className="ivs-value">{label}</span>
        <span className="ivs-meta ivs-dd-action-meta">{meta}</span>
      </>
    ),
    onSelect
  })
  const libraryItems: DropItem[] = sources?.dir
    ? [
        {
          kind: 'header',
          key: 'library',
          content: (
            <>
              <span className="ivs-dd-header-label">{t('ops.start.libraryHeader')}</span>
              <span aria-hidden="true">·</span>
              <span className="ivs-mono ivs-dd-header-path" title={sources.dir}>
                {sources.dir}
              </span>
              {!sources.libraryError && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{sources.library.length}</span>
                </>
              )}
              <button
                type="button"
                className="ivs-dd-refresh"
                tabIndex={-1}
                disabled={scanning}
                title={t('ops.start.refreshLibrary')}
                aria-label={t('ops.start.refreshLibrary')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void refreshSources()}
              >
                <RefreshIcon />
              </button>
            </>
          )
        },
        ...(sources.libraryError
          ? [{ kind: 'note' as const, key: 'library-error', content: <span className="ivs-error">{sources.libraryError}</span> }]
          : sources.library.length === 0
            ? [{ kind: 'note' as const, key: 'library-empty', content: t('ops.start.libraryEmpty') }]
            : sources.library.map((e) => runbookOption(e.path, false)))
      ]
    : []
  const looseItems: DropItem[] =
    loose.length > 0
      ? [
          { kind: 'header', key: 'loose', content: <span className="ivs-dd-header-label">{t('ops.start.looseHeader')}</span> },
          ...loose.map((dir) => runbookOption(dir, true))
        ]
      : []
  const runbookItems: DropItem[] = [
    ...libraryItems,
    ...looseItems,
    ...(libraryItems.length + looseItems.length > 0 ? [{ kind: 'divider' as const, key: 'div' }] : []),
    actionOption('choose-library', t('ops.start.chooseLibrary'), t('ops.start.chooseLibraryMeta'), () => void chooseLibrary()),
    actionOption('choose-one', t('ops.start.chooseOne'), t('ops.start.chooseOneMeta'), () => void chooseOne())
  ]

  // ── Right column ───────────────────────────────────────────────────────────
  const openFile = (file: 'RUNBOOK.md' | 'policy.json') => {
    if (activePath) void window.electronAPI.opsOpenRunbookFile(activePath, file)
  }

  /**
   * The folder a past run belongs to, so its report can name the host roles: a listed one,
   * or the built-in runbook. A bare `despiste` name is the built-in one unless a listed
   * folder carries that name too.
   */
  const runbookDirFor = (r: OpsRunListItem): string | undefined => {
    if (/[\\/]/.test(r.runbook)) return builtin && samePath(r.runbook, builtin) ? builtin : r.runbook
    if (r.runbook === BUILTIN_NAME && builtin && !listed.some((d) => baseName(d) === BUILTIN_NAME)) return builtin
    return listed.find((d) => {
      const i = infos[d]
      return i && i !== 'loading' && i.ok && i.name === r.runbook
    })
  }

  const historyTitle = selectedHost ? t('ops.start.earlierOn', { name: selectedHost.name }) : t('ops.start.earlier')

  return (
    <div className="view ivs">
      <div className="ivs-scroll">
        <div className="ivs-grid">
          <div className="ivs-form">
            <div className="ivs-head">
              <h1 className="ivs-title">{t('ops.start.title')}</h1>
              <p className="ivs-sub">{mode === 'despiste' ? t('ops.start.subDespiste') : t('ops.start.sub')}</p>
            </div>

            <div className="ivs-field">
              <span className="ivs-label" id={serverLabelId}>
                {t('ops.start.server')}
              </span>
              <IvsDropdown labelledBy={serverLabelId} trigger={serverTrigger} items={serverItems} invalid={!!hostProblem} />
              {hostProblem ? (
                <span className="ivs-error" role="alert">
                  {hostProblem}
                </span>
              ) : (
                <span className="ivs-help">{serverHelp}</span>
              )}
            </div>

            <div className="ivs-field">
              <span className="ivs-label" id={modeLabelId}>
                {t('ops.start.mode')}
              </span>
              <ModeControl labelledBy={modeLabelId} mode={mode} onChange={setMode} />
              {mode === 'despiste' &&
                (loaded && !loaded.ok ? (
                  <span className="ivs-error" role="alert">
                    <strong>{t('ops.start.despisteUnusable')}</strong> {loaded.error}
                  </span>
                ) : (
                  <span className="ivs-help">{t('ops.start.despisteHelp')}</span>
                ))}
            </div>

            {mode === 'runbook' && (
              <div className="ivs-field">
                <span className="ivs-label" id={runbookLabelId}>
                  {t('ops.start.runbook')}
                </span>
                <IvsDropdown
                  labelledBy={runbookLabelId}
                  trigger={runbookPath ? runbookRow(runbookPath, false) : <span className="ivs-placeholder">{t('ops.start.chooseRunbook')}</span>}
                  items={runbookItems}
                  invalid={!!loaded && !loaded.ok}
                />
                {sourcesError && (
                  <span className="ivs-error" role="alert">
                    {sourcesError}
                  </span>
                )}
                {loaded && !loaded.ok && runbookPath && (
                  <div className="ivs-error-block" role="alert">
                    <div>
                      <strong>{t('ops.start.notUsable')}</strong> {loaded.error}
                    </div>
                    {loaded.errors && loaded.errors.length > 0 && (
                      <ul>
                        {loaded.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    )}
                    <div className="ivs-error-actions">
                      <span className="ivs-mono">{runbookPath}</span>
                      {loose.includes(runbookPath) && (
                        <button type="button" className="ivs-link" onClick={() => void forget(runbookPath)}>
                          {t('ops.start.forget')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {listed.length === 0 && !runbookPath && (
                  <span className="ivs-help">
                    {rich(t('ops.start.runbookExplainer'), {
                      runbook: <span className="ivs-mono">RUNBOOK.md</span>,
                      policy: <span className="ivs-mono">policy.json</span>
                    })}
                  </span>
                )}
              </div>
            )}

            <div className="ivs-field">
              <label className="ivs-label" htmlFor={taskId}>
                {t('ops.start.task')} <span className="ivs-optional">{t('ops.start.optional')}</span>
              </label>
              <textarea
                id={taskId}
                className="ivs-control ivs-textarea"
                value={task}
                placeholder={t('ops.start.taskPlaceholder')}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    start()
                  }
                }}
              />
            </div>

            <div className="ivs-pair">
              <div className="ivs-field">
                <label className="ivs-label" htmlFor={ticketId}>
                  {t('ops.start.ticket')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                </label>
                <input
                  id={ticketId}
                  className="ivs-control ivs-input"
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="ivs-field">
                <label className="ivs-label" htmlFor={clientId}>
                  {t('ops.start.client')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                </label>
                <input
                  id={clientId}
                  className="ivs-control ivs-input"
                  value={client}
                  onChange={(e) => setClient(e.target.value)}
                />
              </div>
            </div>

            <div className="ivs-actions">
              <button type="button" className="ivs-start" disabled={!canStart} onClick={start}>
                <PlayIcon />
                {mode === 'despiste' ? t('ops.start.startDespiste') : t('ops.start.startButton')}
              </button>
              <span className="ivs-help">{startHint}</span>
            </div>
          </div>

          <div className="ivs-side">
            <section className="ivs-panel" aria-labelledby={`${runbookLabelId}-allows`}>
              <h2 className="ivs-eyebrow" id={`${runbookLabelId}-allows`}>
                {mode === 'despiste' ? t('ops.start.despisteAllowsTitle') : t('ops.start.allowsTitle')}
              </h2>
              {!activePath ? (
                <p className="ivs-panel-text">{mode === 'despiste' ? t('common.loading') : t('ops.start.allowsChoose')}</p>
              ) : info === 'loading' || !info ? (
                <p className="ivs-panel-text">{t('common.loading')}</p>
              ) : !okInfo ? (
                <p className="ivs-panel-text">{t('ops.start.allowsFailed')}</p>
              ) : !summary ? (
                <p className="ivs-panel-text">
                  {plural(t, okInfo.strict ? 'ops.start.noSummaryStrict' : 'ops.start.noSummary', okInfo.hosts.length)}
                </p>
              ) : (
                <>
                  <div className="ivs-stats">
                    <div>
                      <div className="ivs-stat-n ok">{summary.autoReads}</div>
                      <div className="ivs-stat-l">
                        {plural(t, 'ops.start.stat.auto', summary.autoReads)}
                      </div>
                    </div>
                    <div>
                      <div className="ivs-stat-n warn">{summary.asks}</div>
                      <div className="ivs-stat-l">{plural(t, 'ops.start.stat.asks', summary.asks)}</div>
                    </div>
                    <div>
                      <div className="ivs-stat-n">{summary.mutates}</div>
                      <div className="ivs-stat-l">{plural(t, 'ops.start.stat.mutates', summary.mutates)}</div>
                    </div>
                  </div>
                  <p className="ivs-panel-text">
                    {summary.guidelinesHead.trim() ? (
                      <>
                        {rich(t('ops.start.guidelines'), {
                          text: withStop(summary.guidelinesHead),
                          file: <span className="ivs-mono">RUNBOOK.md</span>
                        })}
                      </>
                    ) : (
                      <>{rich(t('ops.start.noGuidelines'), { file: <span className="ivs-mono">RUNBOOK.md</span> })}</>
                    )}{' '}
                    {summary.scripts === 0 ? t('ops.start.noScripts') : plural(t, 'ops.start.scripts', summary.scripts)}
                    {mode !== 'despiste' && summary.readPaths.length > 0 && (
                      <>
                        {' '}
                        {rich(t('ops.start.readsAllowed'), {
                          paths: joinAnd(
                            summary.readPaths.map((p) => (
                              <span key={p} className="ivs-mono">
                                {p}
                              </span>
                            )),
                            t
                          )
                        })}
                      </>
                    )}
                  </p>
                </>
              )}
              {mode === 'despiste' && okInfo && <p className="ivs-panel-text">{t('ops.start.despisteLeftOut')}</p>}
              {okInfo && (
                <div className="ivs-file-buttons">
                  <button type="button" className="ivs-btn" onClick={() => openFile('RUNBOOK.md')}>
                    <FileIcon />
                    RUNBOOK.md
                  </button>
                  <button type="button" className="ivs-btn" onClick={() => openFile('policy.json')}>
                    <ShieldIcon />
                    policy.json
                  </button>
                </div>
              )}
            </section>

            <section className="ivs-history" aria-label={historyTitle}>
              <h2 className="ivs-eyebrow">{historyTitle}</h2>
              {runs === 'loading' ? (
                <p className="ivs-help">{t('common.loading')}</p>
              ) : !runs.ok ? (
                <p className="ivs-error">{runs.error}</p>
              ) : runs.runs.length === 0 ? (
                <p className="ivs-help">
                  {selectedHost ? t('ops.start.noneOn', { name: selectedHost.name }) : t('ops.start.none')}
                </p>
              ) : (
                <div className="ivs-runs">
                  {runs.runs.map((r) => {
                    const st = runStatus(r, t)
                    return (
                      <div key={r.runId} className="ivs-run" role="group">
                        <span className="ivs-run-when" title={new Date(r.startedAt).toLocaleString(locale)}>
                          {runWhen(r.startedAt, t, locale)}
                        </span>
                        <span
                          className="ivs-run-what"
                          title={[r.task ?? r.runbook, r.hostNames.join(', ')].filter(Boolean).join(' · ')}
                        >
                          {r.task || r.runbook}
                        </span>
                        <span className={`ivs-run-status ${st.tone}`}>{st.label}</span>
                        <button
                          type="button"
                          className="ivs-btn small"
                          onClick={() => setReportFor({ runId: r.runId, runbookPath: runbookDirFor(r), appSessionId: r.appSessionId })}
                        >
                          {t('ops.start.report')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {reportFor && (
        <OpsReportSheet
          runId={reportFor.runId}
          appSessionId={reportFor.appSessionId}
          runbookPath={reportFor.runbookPath}
          onClose={() => setReportFor(null)}
        />
      )}
    </div>
  )
}
