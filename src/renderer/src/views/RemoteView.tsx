import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useLingering } from '../hooks/useLingering'
import {
  SshHostPublic,
  SshHostInput,
  SshAuthType,
  SshKeyInfo,
  WslDistro,
  SourceInfo,
  OpsRunbookInfo,
  OpsRunListItem
} from '../types'
import Menu, { MoreIcon } from '../components/Menu'
import Sheet from '../components/Sheet'
import OpsReportSheet from '../components/OpsReportSheet'
import { readRecentRunbooks } from '../lib/recent-runbooks'
import './views.css'
import './RemoteView.css'
import Select from '../components/Select'
import { plural, type MessageKey, type TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'

interface Props {
  onConnect: (host: SshHostPublic) => void
  /** Opens the Ops start screen for this host. Offered only for a host that one of the
   *  recently opened runbooks (Servers → Ops) knows. */
  onOps?: (host: SshHostPublic) => void
  onConnectWsl: (distro: string, cwd?: string) => void
  /** Opens the full Remote Session workspace (SFTP browser + terminal + history) for a host.
   *  `newSession` forces another session on a target that already has one; without it the
   *  existing session is focused instead. */
  onOpenSession: (host: SshHostPublic, newSession?: boolean) => void
  /** Same, for a WSL distro. */
  onOpenWslSession: (distro: string, newSession?: boolean) => void
  /** Distro names with a session open right now. */
  openWslSessions?: string[]
  /** SSH host ids with a session that has actually CONNECTED. Not merely "a tab is open":
   *  a refused connection leaves a session sitting there, and treating that as proof of
   *  reachability is what used to leave the dot green next to a connection error. */
  openSshSessions?: string[]
  /** SSH host ids whose open sessions have all failed to connect. */
  failedSshSessions?: string[]
}

/** Which screen the view is showing. SSH keys are a sub-screen behind the header's key
 *  button rather than a third section on the list: they're setup, not day-to-day. */
type Screen = 'targets' | 'keys'
/** The type filter above the list. */
type Kind = 'all' | 'wsl' | 'ssh'
/** The target the column describes. Remembered per viewer, so coming back to the screen
 *  shows the same one. */
type Selection = { kind: 'wsl'; name: string } | { kind: 'ssh'; id: string }


/**
 * The live-status dot at the head of every row.
 *
 * `idle` is deliberately NOT an error state: it's "we don't know / it isn't up right now",
 * which for a stopped WSL distro or an untested SSH host is entirely normal. Red is reserved
 * for something that actually failed: a failed Test, or an open session that couldn't connect.
 */
type DotState = 'idle' | 'checking' | 'ok' | 'error' | 'live'

/** The outcome of one Test / Check. Only a CONNECTION probe may move the status dot: a
 *  Claude Code check that fails says nothing about whether the box is reachable. */
interface Probe {
  ok: boolean
  message: string
  /** When it finished. */
  at: number
  /** How long it took, measured here. */
  ms: number
}
interface Probes {
  conn?: Probe
  claude?: Probe
}

/** A translated sentence with `{name}` slots filled by elements (the mono code spans). */
function fill(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>
  })
}

const keyOf = (sel: Selection): string => (sel.kind === 'wsl' ? `wsl:${sel.name}` : `ssh:${sel.id}`)

function emptyHost(): SshHostInput {
  return { name: '', host: '', port: 22, username: '', authType: 'password' }
}

/** `C:\Users\you\.ssh\id_ed25519` → `~/.ssh/id_ed25519`; anything else as written. */
function shortKeyPath(p: string): string {
  const m = /[\\/]\.ssh[\\/](.+)$/.exec(p)
  return m ? `~/.ssh/${m[1].replace(/\\/g, '/')}` : p
}

function relativeTime(at: number, t: TFunction, locale?: string): string {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 45) return t('remote.time.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('remote.time.minAgo', { n: m })
  const d = new Date(at)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return sameDay
    ? t('remote.time.today', { time })
    : t('remote.time.dayTime', { day: d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }), time })
}

function clock(iso: string, locale?: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function runOutcome(r: OpsRunListItem, t: TFunction): string {
  if (r.aborted) return t('remote.run.stopped')
  if (r.ok === true) return t('remote.run.finished')
  if (r.ok === false) return t('remote.run.failed')
  return r.endedAt ? t('remote.run.ended') : t('remote.run.unfinished')
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// ── Icons (24-unit viewBox, 2 px stroke, currentColor; SYSTEM-DESIGN.md §5) ──────────────

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const KeyIcon = () => (
  <Icon>
    <circle cx="8" cy="14" r="4" />
    <path d="M11 11l9-9M16 6l3 3M14 8l2 2" />
  </Icon>
)
const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
)
const XIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)
const ChevronRight = ({ className }: { className?: string }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)
const ChevronLeft = () => (
  <Icon size={16}>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
)
const PlayIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 5l12 7-12 7z" />
  </svg>
)

const DOT_TITLE: Record<DotState, MessageKey> = {
  idle: 'remote.dot.idle',
  checking: 'remote.dot.checking',
  ok: 'remote.dot.ok',
  error: 'remote.dot.error',
  live: 'remote.dot.live'
}
const Dot = ({ state }: { state: DotState }) => {
  const t = useT()
  return <span className={`rv-dot ${state}`} title={t(DOT_TITLE[state])} aria-label={t(DOT_TITLE[state])} role="img" />
}

const AUTH_LABEL: Record<SshAuthType, MessageKey> = { password: 'remote.auth.password', key: 'remote.auth.key', agent: 'remote.auth.agent' }
const AUTH_CHIP: Record<SshAuthType, MessageKey> = { password: 'remote.auth.chipPassword', key: 'remote.auth.chipKey', agent: 'remote.auth.chipAgent' }

export default function RemoteView({
  onConnect,
  onOps,
  onConnectWsl,
  onOpenSession,
  onOpenWslSession,
  openWslSessions = [],
  openSshSessions = [],
  failedSshSessions = []
}: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [wslPaths, setWslPaths] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<SshHostInput | null>(null)
  const editorOpenedAt = useRef(0)
  const [probes, setProbes] = useState<Record<string, Probes>>({})
  const [probing, setProbing] = useState<string | null>(null)
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const [screen, setScreen] = useState<Screen>('targets')
  const [kind, setKind] = useState<Kind>('all')
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelectedState] = useState<Selection | null>(null)
  const colRef = useRef<HTMLElement>(null)
  const [editingCwd, setEditingCwd] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Why the last host save/delete wrote nothing (e.g. an unreadable hosts file). */
  const [writeError, setWriteError] = useState<string | null>(null)

  // Ops: the recently opened runbooks (Servers → Ops) and the selected host's runs.
  const [runbooks, setRunbooks] = useState<Extract<OpsRunbookInfo, { ok: true }>[]>([])
  const [runs, setRuns] = useState<OpsRunListItem[]>([])
  const [reportFor, setReportFor] = useState<{ runId: string; runbookPath?: string; appSessionId?: string } | null>(null)

  const select = (sel: Selection | null) => {
    setSelectedState(sel)
    setEditingCwd(false)
    setConfirmDelete(false)
    setWriteError(null)
  }

  // The column is mounted only while a target is selected (as the Projects column): a
  // mousedown anywhere outside it that is not a target row closes it, and so does Esc when
  // focus is not in a field. Sheets (Add/Edit host, the report) keep it: a click in them
  // is not a click outside the column.
  useEffect(() => {
    if (!selected || editing || reportFor) return
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (colRef.current?.contains(target) || target.closest('[data-rv-row]')) return
      select(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      select(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editing, reportFor])

  const load = async () => {
    setHosts(await window.electronAPI.sshList())
    setDistros(await window.electronAPI.wslList())
    setHidden(await window.electronAPI.wslHidden())
    setSources(await window.electronAPI.ccSources())
    setKeys(await window.electronAPI.sshKeysList())
  }

  useEffect(() => {
    load()
    let cancelled = false
    Promise.all(
      readRecentRunbooks().map((dir) => window.electronAPI.opsLoadRunbook(dir).catch((): OpsRunbookInfo => ({ ok: false, error: '' })))
    ).then((infos) => {
      if (!cancelled) setRunbooks(infos.filter((i): i is Extract<OpsRunbookInfo, { ok: true }> => i.ok))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const generate = async () => {
    const name = newKeyName.trim()
    if (!name || generating) return
    setGenerating(true)
    setGenError(null)
    const res = await window.electronAPI.sshKeysGenerate(name)
    setGenerating(false)
    if (res.ok) {
      setNewKeyName('')
      setKeys(await window.electronAPI.sshKeysList())
    } else {
      setGenError(res.error)
    }
  }

  const keyLabel = (k: SshKeyInfo) =>
    `${k.name}${k.type ? ` · ${k.type.replace(/^ssh-/, '')}` : ''}${k.comment ? ` · ${k.comment}` : ''}`
  const accountFor = (distro: string) => sources.find((s) => s.id === `wsl:${distro}`)?.account
  const setDistroHidden = async (name: string, hide: boolean) => {
    setHidden(await window.electronAPI.wslSetHidden(name, hide))
    setSources(await window.electronAPI.ccSources())
  }

  /** Targets we've held a session on during this app run; see the effect below. */
  const [wasLiveWsl, setWasLiveWsl] = useState<string[]>([])
  const [wasLiveSsh, setWasLiveSsh] = useState<string[]>([])

  // Opening or closing a session invalidates what this screen knows about its targets,
  // and closing one from the inline tab strip doesn't remount the view. So: re-list the
  // distros (`running` was only a snapshot, and connecting boots a stopped distro), and
  // remember the target: a host that was serving a live shell a moment ago is
  // demonstrably reachable, so it stays green after the session closes.
  const openKey = `${openWslSessions.join('|')}#${openSshSessions.join('|')}`
  useEffect(() => {
    if (openWslSessions.length > 0) setWasLiveWsl((prev) => [...new Set([...prev, ...openWslSessions])])
    if (openSshSessions.length > 0) setWasLiveSsh((prev) => [...new Set([...prev, ...openSshSessions])])
    window.electronAPI.wslList().then(setDistros)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey])

  const probe = async (sel: Selection, which: 'conn' | 'claude') => {
    const key = keyOf(sel)
    setProbing(key)
    const started = Date.now()
    const res =
      sel.kind === 'wsl'
        ? which === 'conn'
          ? await window.electronAPI.wslTest(sel.name)
          : await window.electronAPI.wslTestClaude(sel.name)
        : which === 'conn'
          ? await window.electronAPI.sshTest(sel.id)
          : await window.electronAPI.sshTestClaude(sel.id)
    const p: Probe = { ok: res.ok, message: res.message, at: Date.now(), ms: Date.now() - started }
    setProbes((prev) => ({ ...prev, [key]: { ...prev[key], [which]: p } }))
    setProbing(null)
    // Either probe succeeding on a distro means it booted, so its dot goes live without
    // waiting for the next full reload.
    if (res.ok && sel.kind === 'wsl') {
      setDistros((prev) => prev.map((d) => (d.name === sel.name ? { ...d, running: true } : d)))
    }
  }

  const hostValid = !!editing && !!editing.name.trim() && !!editing.host.trim() && !!editing.username.trim()

  const openEditor = (h: SshHostInput) => {
    editorOpenedAt.current = Date.now()
    setWriteError(null)
    setEditing(h)
  }

  const save = async () => {
    if (!editing || !hostValid) return
    const res = await window.electronAPI.sshSave(editing)
    if (!res.ok) {
      // Nothing was written: the sheet stays open with what was typed.
      setWriteError(res.error)
      return
    }
    setHosts(res.hosts)
    setEditing(null)
  }

  // Enter saves (§6), except on a control that has its own Enter (a button, a select), and
  // never in the first 400 ms, so the keystroke that opened the sheet cannot also save it.
  const onFormKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (Date.now() - editorOpenedAt.current < 400) return
    e.preventDefault()
    void save()
  }

  const remove = async (id: string) => {
    const res = await window.electronAPI.sshDelete(id)
    if (!res.ok) {
      setWriteError(res.error)
      return
    }
    setHosts(res.hosts)
    select(null)
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  // Hidden distros are excluded from the counts and the filter entirely: they live in
  // their own collapsed disclosure at the end of the WSL section.
  const visibleDistros = useMemo(() => distros.filter((d) => !hidden.includes(d.name)), [distros, hidden])
  const hiddenDistros = useMemo(() => distros.filter((d) => hidden.includes(d.name)), [distros, hidden])

  const q = query.trim().toLowerCase()
  const matchesDistro = (d: WslDistro) => !q || d.name.toLowerCase().includes(q)
  const matchesHost = (h: SshHostPublic) =>
    !q || h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q) || h.username.toLowerCase().includes(q)

  const shownDistros = kind === 'ssh' ? [] : visibleDistros.filter(matchesDistro)
  const shownHosts = kind === 'wsl' ? [] : hosts.filter(matchesHost)
  const nothingMatches = shownDistros.length === 0 && shownHosts.length === 0

  // ── Status ─────────────────────────────────────────────────────────────────
  // An open session outranks everything else: you cannot hold a live terminal on a
  // target that isn't reachable, and unlike `running` (sampled once by `wsl -l -v`) or a
  // manual Test, it can't go stale.
  const wslDotState = (d: WslDistro): DotState => {
    if (openWslSessions.includes(d.name)) return 'live'
    if (probing === `wsl:${d.name}`) return 'checking'
    const conn = probes[`wsl:${d.name}`]?.conn
    if (conn && !conn.ok) return 'error'
    return d.running || wasLiveWsl.includes(d.name) || conn?.ok ? 'ok' : 'idle'
  }
  const hostDotState = (h: SshHostPublic): DotState => {
    if (openSshSessions.includes(h.id)) return 'live'
    if (probing === `ssh:${h.id}`) return 'checking'
    // A session that's open and failing is present-tense evidence, so it outranks both an
    // older Test result and the "was reachable earlier" memory.
    if (failedSshSessions.includes(h.id)) return 'error'
    const conn = probes[`ssh:${h.id}`]?.conn
    if (conn) return conn.ok ? 'ok' : 'error'
    return wasLiveSsh.includes(h.id) ? 'ok' : 'idle'
  }

  /** The runbooks among the recent ones that place this host in a group. */
  const runbooksFor = (hostId: string) =>
    runbooks.filter((r) => r.hosts.some((h) => h.id === hostId && h.groups.length > 0))

  // The column slides shut: it keeps showing the last target for the closing frames.
  const { shown: shownSel, open: colOpen } = useLingering(selected)
  const selDistro = shownSel?.kind === 'wsl' ? visibleDistros.find((d) => d.name === shownSel.name) : undefined
  const selHost = shownSel?.kind === 'ssh' ? hosts.find((h) => h.id === shownSel.id) : undefined
  const selHostRunbooks = selHost ? runbooksFor(selHost.id) : []

  // Earlier interventions on the selected host, when a runbook reaches it.
  const runsHostId = selHost && selHostRunbooks.length > 0 ? selHost.id : undefined
  useEffect(() => {
    setRuns([])
    if (!runsHostId) return
    let cancelled = false
    window.electronAPI
      .opsRuns({ hostId: runsHostId, limit: 8 })
      .then((res) => !cancelled && res.ok && setRuns(res.runs))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [runsHostId])

  const runbookDirFor = (r: OpsRunListItem): string | undefined =>
    /[\\/]/.test(r.runbook) ? r.runbook : runbooks.find((i) => i.name === r.runbook)?.path

  // ── Keyboard / pointer on a row ────────────────────────────────────────────
  const rowProps = (sel: Selection, connect: () => void, label: string) => {
    const isSel = !!selected && keyOf(selected) === keyOf(sel)
    return {
      role: 'option' as const,
      'aria-selected': isSel,
      tabIndex: 0,
      title: t('remote.row.doubleClick', { label }),
      'data-rv-row': true,
      className: `rv-row ${isSel ? 'sel' : ''}`,
      onClick: () => select(sel),
      onDoubleClick: connect,
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          select(sel)
          connect()
        } else if (e.key === ' ') {
          e.preventDefault()
          select(sel)
        }
      }
    }
  }

  // ── SSH keys screen ────────────────────────────────────────────────────────
  if (screen === 'keys') {
    return (
      <div className="view rv">
        <div className="rv-head">
          <button type="button" className="rv-back" onClick={() => setScreen('targets')} aria-label={t('remote.back')} title={t('remote.back')}>
            <ChevronLeft />
          </button>
          <div className="rv-head-text">
            <h1>{t('remote.keys.title')}</h1>
            <p className="rv-sub">
              {fill(t('remote.keys.sub'), { ssh: <code>~/.ssh</code>, authorized: <code>authorized_keys</code> })}
            </p>
          </div>
        </div>

        <div className="rv-scroll">
          <div className="rv-keys">
            {keys.map((k) => {
              const oneLiner = k.publicKey ? `echo '${k.publicKey}' >> ~/.ssh/authorized_keys` : null
              return (
                <div key={k.privatePath} className="rv-key">
                  <span className="rv-key-icon">
                    <KeyIcon />
                  </span>
                  <span className="rv-name">{k.name}</span>
                  {k.type && <span className="chip">{k.type.replace(/^ssh-/, '')}</span>}
                  <span className="rv-key-comment">{k.comment || (k.publicKey ? '' : t('remote.keys.noPub'))}</span>
                  <span className="rv-key-actions">
                    {k.publicKey && (
                      <button type="button" className="btn-ghost small" onClick={() => copy(k.publicKey!, `pub:${k.privatePath}`)}>
                        {copied === `pub:${k.privatePath}` ? t('remote.copied') : t('remote.keys.copyPublic')}
                      </button>
                    )}
                    <Menu
                      triggerClass="btn-ghost small rv-icon-btn"
                      triggerTitle={t('remote.more')}
                      ariaLabel={t('remote.more')}
                      triggerContent={<MoreIcon />}
                      items={[
                        {
                          label: copied === `cmd:${k.privatePath}` ? t('remote.copied') : t('remote.keys.copyInstall'),
                          disabled: !oneLiner,
                          onClick: () => oneLiner && copy(oneLiner, `cmd:${k.privatePath}`)
                        },
                        {
                          label: copied === `path:${k.privatePath}` ? t('remote.copied') : t('remote.keys.copyPrivatePath'),
                          onClick: () => copy(k.privatePath, `path:${k.privatePath}`)
                        }
                      ]}
                    />
                  </span>
                </div>
              )
            })}

            <div className="eyebrow rv-eyebrow">{t('remote.keys.generateTitle')}</div>
            <div className="rv-gen">
              <input
                className="text-input mono"
                placeholder="id_ed25519_new"
                aria-label={t('remote.keys.newName')}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generate()}
              />
              <button type="button" className="btn-primary small" onClick={generate} disabled={!newKeyName.trim() || generating}>
                {generating ? t('remote.keys.generating') : t('remote.keys.generate')}
              </button>
            </div>
            <p className="help">{t('remote.keys.generateHelp')}</p>
            {genError && <p className="rv-error-text">{genError}</p>}
          </div>
        </div>
      </div>
    )
  }

  // ── The column ─────────────────────────────────────────────────────────────
  const column = (): ReactNode => {
    if (!selDistro && !selHost) {
      return <div className="rv-col-empty">{t('remote.col.empty')}</div>
    }
    const sel: Selection = selDistro ? { kind: 'wsl', name: selDistro.name } : { kind: 'ssh', id: selHost!.id }
    const key = keyOf(sel)
    const p = probes[key] ?? {}
    const busy = probing === key
    const dot = selDistro ? wslDotState(selDistro) : hostDotState(selHost!)
    const name = selDistro ? selDistro.name : selHost!.name

    const state = (() => {
      if (busy) return t('remote.col.state.checking')
      if (dot === 'live') return t('remote.col.state.live')
      if (p.conn) return p.conn.ok ? t('remote.col.state.reachableIn', { seconds: (p.conn.ms / 1000).toFixed(1) }) : t('remote.col.state.failed')
      if (selHost && failedSshSessions.includes(selHost.id)) return t('remote.col.state.failed')
      if (selDistro?.running) return t('remote.col.state.running')
      if (selHost && wasLiveSsh.includes(selHost.id)) return t('remote.col.state.reachable')
      return t('remote.col.state.untested')
    })()

    const meta = selDistro
      ? t(selDistro.isDefault ? 'remote.col.metaWslDefault' : 'remote.col.metaWsl', { name: selDistro.name })
      : t('remote.col.metaSsh', {
          user: selHost!.username,
          host: selHost!.host,
          port: selHost!.port,
          auth:
            selHost!.authType === 'key'
              ? t('remote.col.metaKey', { path: selHost!.privateKeyPath ? shortKeyPath(selHost!.privateKeyPath) : t('remote.col.defaultKey') })
              : t(AUTH_CHIP[selHost!.authType])
        })

    // The one tinted block: the last test or check that failed, or an open session that
    // could not connect.
    const failure: { title: string; reason: string; retry: 'conn' | 'claude' } | null =
      p.conn && !p.conn.ok
        ? { title: t('remote.col.failConnect'), reason: p.conn.message, retry: 'conn' }
        : !p.conn && selHost && failedSshSessions.includes(selHost.id)
          ? { title: t('remote.col.failConnect'), reason: t('remote.col.failSession'), retry: 'conn' }
          : p.claude && !p.claude.ok
            ? { title: t('remote.col.failClaude'), reason: p.claude.message, retry: 'claude' }
            : null

    const lastChecked = Math.max(p.conn?.at ?? 0, p.claude?.at ?? 0)
    const claudeValue = p.claude ? (
      p.claude.ok ? (
        // TODO(port): the logged-in account; the check only returns `claude --version`.
        <span>{p.claude.message}</span>
      ) : (
        <span className="rv-dd-err">{t('remote.col.checkFailed')}</span>
      )
    ) : (
      <span className="rv-dd-muted">{t('remote.col.notChecked')}</span>
    )

    const cwd = selDistro ? wslPaths[selDistro.name] ?? '' : ''
    const acct = selDistro ? accountFor(selDistro.name) : undefined

    const connect = () => (selDistro ? onOpenWslSession(selDistro.name, true) : onOpenSession(selHost!, true))
    const newTerminal = () => (selDistro ? onConnectWsl(selDistro.name, cwd || undefined) : onConnect(selHost!))
    const isOpen = selDistro ? openWslSessions.includes(selDistro.name) : openSshSessions.includes(selHost!.id)

    const todayRuns = runs.filter((r) => new Date(r.startedAt).toDateString() === new Date().toDateString())
    const allReadOnly = selHostRunbooks.every((r) => r.summary.mutates === 0)
    const allStrict = selHostRunbooks.every((r) => r.strict)

    return (
      <>
        <section className="rv-sec">
          <div className="rv-col-title">
            <Dot state={dot} />
            <h2>{name}</h2>
            <span className="rv-col-state">{state}</span>
          </div>
          <div className="rv-col-meta">{meta}</div>
          <div className="rv-col-actions">
            <button type="button" className="btn-primary rv-connect" onClick={connect} title={isOpen ? t('remote.col.openAnother') : t('remote.col.connectTo', { name })}>
              <PlayIcon />
              {t('remote.col.connect')}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={newTerminal}
              title={selHost ? t('remote.col.newTerminalSsh') : t('remote.col.newTerminalWsl')}
            >
              {t('remote.col.newTerminal')}
            </button>
            {selHost && onOps && selHostRunbooks.length > 0 && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onOps(selHost)}
                title={t('remote.col.newInterventionTitle')}
              >
                {t('remote.col.newIntervention')}
              </button>
            )}
          </div>
        </section>

        {failure && (
          <div className="block err rv-fail" role="alert">
            <span className="rv-fail-title">{failure.title}</span>
            <span className="rv-fail-reason">{failure.reason}</span>
            <div>
              <button type="button" className="btn-ghost small" onClick={() => probe(sel, failure.retry)} disabled={busy}>
                {busy ? t('remote.col.testing') : t('remote.col.testAgain')}
              </button>
            </div>
          </div>
        )}

        <section className="rv-sec">
          <div className="eyebrow">{t('remote.col.details')}</div>
          <dl className="rv-dl">
            {selHost ? (
              <>
                <dt>{t('remote.col.authentication')}</dt>
                <dd>
                  {t(AUTH_LABEL[selHost.authType])}
                  {selHost.authType === 'key' && selHost.privateKeyPath && (
                    <span className="rv-dd-mono rv-dd-muted"> {shortKeyPath(selHost.privateKeyPath)}</span>
                  )}
                </dd>
                <dt>{t('remote.col.remotePath')}</dt>
                <dd>{selHost.remotePath ? <span className="rv-dd-mono">{selHost.remotePath}</span> : <span className="rv-dd-muted">{t('remote.col.homeFolder')}</span>}</dd>
              </>
            ) : (
              <>
                <dt>{t('remote.col.workingDir')}</dt>
                <dd>
                  {editingCwd ? (
                    <span className="rv-cwd-edit">
                      <input
                        className="text-input mono"
                        autoFocus
                        placeholder="/home/you/repo"
                        aria-label={t('remote.col.workingDir')}
                        value={cwd}
                        onChange={(e) => setWslPaths((prev) => ({ ...prev, [selDistro!.name]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && setEditingCwd(false)}
                      />
                      <button type="button" className="btn-ghost small" onClick={() => setEditingCwd(false)}>
                        {t('remote.col.done')}
                      </button>
                    </span>
                  ) : cwd ? (
                    <span className="rv-dd-mono">{cwd}</span>
                  ) : (
                    <span className="rv-dd-muted">{t('remote.col.homeFolder')}</span>
                  )}
                </dd>
                <dt>{t('remote.col.account')}</dt>
                <dd>{acct?.email ?? <span className="rv-dd-muted">{t('remote.col.notLoggedIn')}</span>}</dd>
              </>
            )}
            {/* WSL only: a distro runs Claude Code inside it, so whether it is installed there
                matters. SSH hosts are worked through Operations, which runs it on this machine. */}
            {selDistro && (
              <>
                <dt>Claude Code</dt>
                <dd>{claudeValue}</dd>
              </>
            )}
            <dt>{t('remote.col.checked')}</dt>
            <dd>{lastChecked ? relativeTime(lastChecked, t, locale) : <span className="rv-dd-muted">{t('remote.col.never')}</span>}</dd>
          </dl>
          <div className="rv-col-actions">
            <button type="button" className="btn-ghost small" onClick={() => probe(sel, 'conn')} disabled={busy}>
              {busy ? t('remote.col.testing') : t('remote.col.testConnection')}
            </button>
            {selDistro && (
              <button type="button" className="btn-ghost small" onClick={() => probe(sel, 'claude')} disabled={busy}>
                {t('remote.col.checkClaude')}
              </button>
            )}
            {selHost ? (
              <button
                type="button"
                className="btn-ghost small"
                onClick={() =>
                  openEditor({
                    id: selHost.id,
                    name: selHost.name,
                    host: selHost.host,
                    port: selHost.port,
                    username: selHost.username,
                    authType: selHost.authType,
                    privateKeyPath: selHost.privateKeyPath,
                    remotePath: selHost.remotePath,
                    claudePath: selHost.claudePath
                  })
                }
              >
                {t('remote.col.editHost')}
              </button>
            ) : (
              !editingCwd && (
                <button type="button" className="btn-ghost small" onClick={() => setEditingCwd(true)}>
                  {t('remote.col.setWorkingDir')}
                </button>
              )
            )}
          </div>
        </section>

        {selHost && selHostRunbooks.length > 0 && (
          <section className="rv-sec">
            <div className="eyebrow">{t('remote.ops.title')}</div>
            <div className="rv-ops-line">
              <span>
                {plural(t, 'remote.ops.runbooksApply', selHostRunbooks.length)}
              </span>
              <span className="rv-ops-mode">
                {allReadOnly ? t('remote.ops.readOnly') : t('remote.ops.canChange')}
                {allStrict ? ` · ${t('remote.ops.strict')}` : ''}
              </span>
            </div>
            {todayRuns.length > 0 && (
              <>
                <div className="divider-caption rv-divcap">
                  {plural(t, 'remote.ops.earlierToday', todayRuns.length)}
                </div>
                {todayRuns.map((r) => (
                  <div key={r.runId} className="rv-run">
                    <span className="rv-run-what" title={r.task || undefined}>
                      {t('remote.ops.runLine', {
                        time: clock(r.startedAt, locale),
                        name: baseName(r.runbook),
                        outcome: runOutcome(r, t),
                        calls: plural(t, 'remote.ops.calls', r.calls)
                      })}
                    </span>
                    <button
                      type="button"
                      className="rv-run-report"
                      onClick={() => setReportFor({ runId: r.runId, runbookPath: runbookDirFor(r), appSessionId: r.appSessionId })}
                    >
                      {t('remote.ops.report')}
                    </button>
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        <footer className="rv-foot">
          {selHost ? (
            confirmDelete ? (
              <>
                {writeError ? (
                  <span className="rv-error-text">{writeError}</span>
                ) : (
                  <span className="help">{t('remote.foot.confirmDelete', { name: selHost.name })}</span>
                )}
                <button type="button" className="btn-ghost small" onClick={() => {
                    setConfirmDelete(false)
                    setWriteError(null)
                  }}
                  autoFocus
                >
                  {t('remote.foot.keep')}
                </button>
                <button type="button" className="btn-primary small danger" onClick={() => remove(selHost.id)}>
                  {t('common.delete')}
                </button>
              </>
            ) : (
              <>
                <span className="help">{t('remote.foot.removeNote')}</span>
                <button type="button" className="btn-text danger" onClick={() => setConfirmDelete(true)}>
                  {t('remote.foot.deleteHost')}
                </button>
              </>
            )
          ) : (
            <>
              <span className="help">{t('remote.foot.hiddenNote')}</span>
              <button
                type="button"
                className="btn-text"
                onClick={() => {
                  void setDistroHidden(selDistro!.name, true)
                  select(null)
                }}
              >
                {t('remote.foot.hide')}
              </button>
            </>
          )}
        </footer>
      </>
    )
  }

  // ── Targets screen ─────────────────────────────────────────────────────────
  return (
    <div className="view rv">
      <div className="rv-head">
        <div className="rv-head-text">
          <h1>{t('remote.title')}</h1>
          <p className="rv-sub">{t('remote.sub')}</p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => setScreen('keys')}>
          <KeyIcon />
          {t('remote.keys.title')}
        </button>
        <button type="button" className="btn-ghost" onClick={() => openEditor(emptyHost())}>
          <PlusIcon />
          {t('remote.addHost')}
        </button>
      </div>

      <div className="rv-page">
        <div className="rv-list">
          <div className="rv-filter">
            <div className="rv-search">
              <span className="rv-search-icon">
                <SearchIcon />
              </span>
              <input
                className="text-input"
                placeholder={t('remote.filter.placeholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('remote.filter.placeholder')}
              />
              {query && (
                <button type="button" className="rv-search-clear" onClick={() => setQuery('')} aria-label={t('remote.filter.clear')} title={t('remote.filter.clear')}>
                  <XIcon />
                </button>
              )}
            </div>
            <div className="seg-control">
              {(
                [
                  ['all', t('remote.filter.all'), visibleDistros.length + hosts.length],
                  ['wsl', 'WSL', visibleDistros.length],
                  ['ssh', 'SSH', hosts.length]
                ] as [Kind, string, number][]
              ).map(([k, label, n]) => (
                <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {label} <em>{n}</em>
                </button>
              ))}
            </div>
          </div>

          {nothingMatches && <p className="rv-nothing">{q ? t('remote.filter.nothing', { query }) : t('remote.filter.none')}</p>}

          {shownDistros.length > 0 && (
            <>
              <div className="eyebrow rv-eyebrow">{t('remote.list.wsl')}</div>
              <div role="listbox" aria-label={t('remote.list.wsl')} className="rv-rows">
                {shownDistros.map((d) => {
                  const claude = probes[`wsl:${d.name}`]?.claude
                  const conn = probes[`wsl:${d.name}`]?.conn
                  return (
                    <div key={d.name} {...rowProps({ kind: 'wsl', name: d.name }, () => onOpenWslSession(d.name), d.name)}>
                      <Dot state={wslDotState(d)} />
                      <span className="rv-name">{d.name}</span>
                      {d.isDefault && <span className="chip">{t('remote.list.default')}</span>}
                      <span className="rv-row-right">
                        {conn && !conn.ok ? (
                          <span className="rv-row-err">{t('remote.list.couldNotConnect')}</span>
                        ) : (
                          claude && !claude.ok && <span className="rv-row-note">{t('remote.list.noClaude')}</span>
                        )}
                        <span className="rv-row-meta">wsl -d {d.name}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* Hidden distros are noise on the main list: one disclosure line, since the only
              thing you can do with them is show them again. */}
          {kind !== 'ssh' && hiddenDistros.length > 0 && (
            <div className="rv-hidden">
              <button type="button" className="rv-hidden-toggle" onClick={() => setShowHidden((v) => !v)} aria-expanded={showHidden}>
                <ChevronRight className={showHidden ? 'open' : ''} />
                {plural(t, 'remote.list.hidden', hiddenDistros.length)}
              </button>
              {showHidden &&
                hiddenDistros.map((d) => (
                  <div key={d.name} className="rv-row muted">
                    <span className="rv-name">{d.name}</span>
                    <span className="rv-row-right">
                      <span className="rv-row-note">{t('remote.list.outOfUsage')}</span>
                      <button type="button" className="btn-ghost small" onClick={() => setDistroHidden(d.name, false)}>
                        {t('remote.list.show')}
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          )}

          {shownHosts.length > 0 && (
            <>
              <div className="eyebrow rv-eyebrow">{t('remote.list.ssh')}</div>
              <div role="listbox" aria-label={t('remote.list.ssh')} className="rv-rows">
                {shownHosts.map((h) => {
                  const conn = probes[`ssh:${h.id}`]?.conn
                  const failed = (conn && !conn.ok) || (!conn && failedSshSessions.includes(h.id))
                  return (
                    <div key={h.id} {...rowProps({ kind: 'ssh', id: h.id }, () => onOpenSession(h), h.name)}>
                      <Dot state={hostDotState(h)} />
                      <span className="rv-name">{h.name}</span>
                      <span className="chip">{t(AUTH_CHIP[h.authType])}</span>
                      <span className="rv-row-right">
                        {failed && <span className="rv-row-err">{t('remote.list.couldNotConnect')}</span>}
                        <span className="rv-row-meta">
                          {h.username}@{h.host}:{h.port}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className={`slide-col ${colOpen ? 'open' : ''}`}>
          {(selDistro || selHost) && (
            <aside className="rv-col" aria-label={t('remote.col.aria')} ref={colRef}>
              {column()}
            </aside>
          )}
        </div>
      </div>

      {editing && (
        <Sheet
          title={editing.id ? t('remote.col.editHost') : t('remote.addHost')}
          width={520}
          onClose={() => setEditing(null)}
          footer={
            <>
              {writeError ? (
                <span className="rv-error-text rv-sheet-help" role="alert">
                  {writeError}
                </span>
              ) : (
                <span className="help rv-sheet-help">{t('remote.form.keys')}</span>
              )}
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn-primary" onClick={save} disabled={!hostValid}>
                {t('common.save')}
              </button>
            </>
          }
        >
          <div className="rv-form" onKeyDown={onFormKey}>
            <div className="form-group">
              <label>{t('remote.form.name')}</label>
              <input className="text-input" value={editing.name} placeholder={t('remote.form.namePlaceholder')} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
            </div>
            <div className="rv-form-row">
              <div className="form-group grow">
                <label>{t('remote.form.host')}</label>
                <input
                  className="text-input mono"
                  value={editing.host}
                  placeholder={t('remote.form.hostPlaceholder')}
                  onChange={(e) => setEditing({ ...editing, host: e.target.value })}
                />
              </div>
              <div className="form-group rv-port">
                <label>{t('remote.form.port')}</label>
                <input
                  className="text-input mono"
                  type="number"
                  value={editing.port}
                  onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 22 })}
                />
              </div>
            </div>
            <div className="form-group">
              <label>{t('remote.form.username')}</label>
              <input className="text-input mono" value={editing.username} placeholder="ubuntu" onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{t('remote.col.authentication')}</label>
              <div className="seg-control">
                {(['password', 'key', 'agent'] as SshAuthType[]).map((a) => (
                  <button type="button" key={a} className={editing.authType === a ? 'on' : ''} onClick={() => setEditing({ ...editing, authType: a })}>
                    {t(AUTH_LABEL[a])}
                  </button>
                ))}
              </div>
            </div>
            {editing.authType === 'password' && (
              <div className="form-group">
                <label>{t('remote.form.password')}</label>
                <input
                  className="text-input"
                  type="password"
                  placeholder={editing.id ? t('remote.form.unchanged') : ''}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                />
              </div>
            )}
            {editing.authType === 'key' && (
              <>
                {keys.length > 0 && (
                  <div className="form-group">
                    <label>{t('remote.form.discoveredKey')}</label>
                    <Select
                      value={keys.some((k) => k.privatePath === editing.privateKeyPath) ? editing.privateKeyPath : ''}
                      onChange={(e) => setEditing({ ...editing, privateKeyPath: e.target.value })}
                    >
                      <option value="">{t('remote.form.defaultKey')}</option>
                      {keys.map((k) => (
                        <option key={k.privatePath} value={k.privatePath}>
                          {keyLabel(k)}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                <div className="form-group">
                  <label>{t('remote.form.privateKeyPath')}</label>
                  <input
                    className="text-input mono"
                    value={editing.privateKeyPath ?? ''}
                    placeholder="C:\Users\you\.ssh\id_ed25519"
                    onChange={(e) => setEditing({ ...editing, privateKeyPath: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>
                    {t('remote.form.passphrase')}<span className="optional">{t('remote.form.optional')}</span>
                  </label>
                  <input
                    className="text-input"
                    type="password"
                    placeholder={editing.id ? t('remote.form.unchanged') : ''}
                    onChange={(e) => setEditing({ ...editing, passphrase: e.target.value })}
                  />
                </div>
              </>
            )}
            <div className="form-group">
              <label>
                {t('remote.form.remotePath')}<span className="optional">{t('remote.form.optional')}</span>
              </label>
              <input
                className="text-input mono"
                value={editing.remotePath ?? ''}
                placeholder="/home/you/myrepo"
                onChange={(e) => setEditing({ ...editing, remotePath: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>
                {t('remote.form.claudePath')}<span className="optional">{t('remote.form.optional')}</span>
              </label>
              <input
                className="text-input mono"
                value={editing.claudePath ?? ''}
                placeholder="claude"
                onChange={(e) => setEditing({ ...editing, claudePath: e.target.value })}
              />
              <p className="help">{t('remote.form.claudePathHelp')}</p>
            </div>
          </div>
        </Sheet>
      )}

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
