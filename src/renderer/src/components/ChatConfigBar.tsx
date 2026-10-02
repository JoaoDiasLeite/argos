import { useEffect, useRef, useState } from 'react'
import { Session, WslDistro, SshHostPublic, OpsRunbookInfo, ModelInfo } from '../types'
import './ChatConfigBar.css'

interface Props {
  session: Session
  /** Patch the active (draft) session with the chosen folder / environment / dirs. */
  onPatch: (patch: Partial<Session>) => void
  disabled?: boolean
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** How many chips the row shows inline before the rest collapse behind "+N more". */
const CHIP_BUDGET = 5

/** Recently picked runbook folders (absolute paths, most recent first). Shared with the
 *  Remote view's "Ops chat" button and App's host-to-runbook lookup. */
export const RECENT_RUNBOOKS_KEY = 'ops.recentRunbooks'
const RECENT_RUNBOOKS_MAX = 8

export function readRecentRunbooks(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_RUNBOOKS_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list)
      ? list.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, RECENT_RUNBOOKS_MAX)
      : []
  } catch {
    return []
  }
}

function pushRecentRunbook(dir: string): string[] {
  const next = [dir, ...readRecentRunbooks().filter((p) => p !== dir)].slice(0, RECENT_RUNBOOKS_MAX)
  try {
    localStorage.setItem(RECENT_RUNBOOKS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: the list just isn't remembered */
  }
  return next
}

type OpsLoadFailure = Extract<OpsRunbookInfo, { ok: false }>
type HostDot = 'checking' | 'ok' | 'error'

/**
 * The configuration row under the composer: pick the environment (Local / WSL distro /
 * SSH host), the project folder, see the git branch, toggle a worktree, and add extra
 * working directories. Every change calls `onPatch` to update the active session.
 */
export default function ChatConfigBar({ session, onPatch, disabled }: Props) {
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [envOpen, setEnvOpen] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [branch, setBranch] = useState<string | null>(null)
  const [isRepo, setIsRepo] = useState(false)
  const [recentRunbooks, setRecentRunbooks] = useState<string[]>(() => readRecentRunbooks())
  /** A failed runbook pick, shown inside the open menu; nothing was patched. */
  const [pickError, setPickError] = useState<OpsLoadFailure | null>(null)
  const [picking, setPicking] = useState(false)
  /** The current runbook as main loaded it (fresh on mount and whenever it changes). */
  const [runbookInfo, setRunbookInfo] = useState<OpsRunbookInfo | null>(null)
  const [hostDots, setHostDots] = useState<Record<string, HostDot>>({})
  const [models, setModels] = useState<ModelInfo[]>([])
  const envRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)

  const isOps = !!session.runbookPath
  const isRemote = !isOps && !!session.remoteHostId
  const isWsl = !isOps && !!session.wslDistro
  // An ops chat runs locally, but its cwd is the runbook: none of the folder / branch /
  // worktree / extra-dir controls apply, so "local" here means the plain local env only.
  const isLocal = !isOps && !isRemote && !isWsl
  const dirs = session.additionalDirs ?? []

  // Load environments lazily — only ever mounted on the empty-state screen.
  useEffect(() => {
    window.electronAPI.wslList().then(setDistros).catch(() => {})
    window.electronAPI.sshList().then(setHosts).catch(() => {})
    window.electronAPI.getModels().then(setModels).catch(() => {})
  }, [])

  // Re-load the chosen runbook on mount and whenever it changes, so a deleted or
  // now-invalid runbook is visible before the user sends, and the hosts line is current.
  // Each host the runbook names gets a connection probe for its dot.
  useEffect(() => {
    const dir = session.runbookPath
    setRunbookInfo(null)
    setHostDots({})
    if (!dir) return
    let cancelled = false
    window.electronAPI
      .opsLoadRunbook(dir)
      .then((info) => {
        if (cancelled) return
        setRunbookInfo(info)
        if (!info.ok) return
        setHostDots(Object.fromEntries(info.hosts.map((h) => [h.id, 'checking' as HostDot])))
        for (const h of info.hosts) {
          window.electronAPI
            .sshTest(h.id)
            .then((r) => {
              if (!cancelled) setHostDots((prev) => ({ ...prev, [h.id]: r.ok ? 'ok' : 'error' }))
            })
            .catch(() => {
              if (!cancelled) setHostDots((prev) => ({ ...prev, [h.id]: 'error' }))
            })
        }
      })
      .catch((e) => {
        if (!cancelled) setRunbookInfo({ ok: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [session.runbookPath])

  // Read the git branch of the chosen local folder (drives the branch pill + worktree toggle).
  useEffect(() => {
    let cancelled = false
    if (!isLocal || !session.projectPath) {
      setBranch(null)
      setIsRepo(false)
      return
    }
    window.electronAPI
      .gitStatus(session.projectPath)
      .then((s) => {
        if (cancelled) return
        setIsRepo(s.isRepo)
        setBranch(s.isRepo ? s.branch : null)
      })
      .catch(() => {
        if (cancelled) return
        setIsRepo(false)
        setBranch(null)
      })
    return () => {
      cancelled = true
    }
  }, [session.projectPath, isLocal])

  // Close the environment menu on outside click / Escape.
  useEffect(() => {
    if (!envOpen) return
    // Recents can change elsewhere (another chat's bar, the Remote view); refresh per open.
    setRecentRunbooks(readRecentRunbooks())
    setPickError(null)
    const onDoc = (e: MouseEvent) => {
      if (!envRef.current?.contains(e.target as Node)) setEnvOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnvOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [envOpen])

  // Close the remote-path popover on outside click / Escape.
  useEffect(() => {
    if (!pathOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!pathRef.current?.contains(e.target as Node)) setPathOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPathOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [pathOpen])

  // Close the "+N more" popover on outside click / Escape (same pattern as above).
  useEffect(() => {
    if (!overflowOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [overflowOpen])

  const chooseLocal = () => {
    onPatch({
      runbookPath: undefined,
      wslDistro: undefined,
      remoteHostId: undefined,
      remoteHostName: undefined,
      // Drop any WSL/remote folder — it isn't a valid path on the Windows filesystem.
      projectPath: undefined
    })
    setEnvOpen(false)
  }
  const chooseWsl = (d: WslDistro) => {
    onPatch({
      runbookPath: undefined,
      wslDistro: d.name,
      remoteHostId: undefined,
      remoteHostName: `WSL · ${d.name}`,
      // WSL folders live in the distro, not the Windows FS — clear a Windows path.
      projectPath: undefined,
      useWorktree: false
    })
    setEnvOpen(false)
  }
  const chooseHost = (h: SshHostPublic) => {
    onPatch({
      runbookPath: undefined,
      remoteHostId: h.id,
      remoteHostName: h.name,
      wslDistro: undefined,
      projectPath: h.remotePath ?? undefined,
      useWorktree: false
    })
    setEnvOpen(false)
  }

  // Load the folder as a runbook first; only a valid one switches the chat to ops.
  // An invalid one shows its errors in the menu and patches nothing.
  const applyRunbook = async (dir: string) => {
    setPicking(true)
    setPickError(null)
    try {
      const info = await window.electronAPI.opsLoadRunbook(dir)
      if (!info.ok) {
        setPickError(info)
        return
      }
      onPatch({
        runbookPath: dir,
        remoteHostId: undefined,
        remoteHostName: undefined,
        wslDistro: undefined,
        projectPath: undefined,
        useWorktree: false,
        useMcp: false,
        lightMode: false
      })
      setRecentRunbooks(pushRecentRunbook(dir))
      setEnvOpen(false)
    } catch (e) {
      setPickError({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setPicking(false)
    }
  }
  const chooseRunbookFolder = async () => {
    const dir = await window.electronAPI.openFolder(session.runbookPath)
    if (dir) await applyRunbook(dir)
  }

  const pickFolder = async () => {
    // A WSL folder lives in the distro; open the native picker at its \\wsl.localhost share
    // so the user browses the distro's Linux filesystem rather than the Windows drive.
    const defaultPath = isWsl ? `\\\\wsl.localhost\\${session.wslDistro}` : undefined
    const path = await window.electronAPI.openFolder(defaultPath)
    if (path) onPatch({ projectPath: path })
  }

  // Remote hosts have no browsable local FS, so the folder is typed in as a remote path.
  const openPathEditor = () => {
    setPathDraft(session.projectPath ?? '')
    setPathOpen(true)
  }
  const commitPath = () => {
    const trimmed = pathDraft.trim()
    onPatch({ projectPath: trimmed || undefined })
    setPathOpen(false)
  }

  const addDir = async () => {
    const path = await window.electronAPI.openFolder()
    if (!path) return
    if (path === session.projectPath || dirs.includes(path)) return
    onPatch({ additionalDirs: [...dirs, path] })
  }
  const removeDir = (path: string) => {
    onPatch({ additionalDirs: dirs.filter((d) => d !== path) })
  }

  const envLabel = isOps
    ? runbookInfo?.ok
      ? runbookInfo.name
      : basename(session.runbookPath!)
    : isRemote
      ? session.remoteHostName || 'Remote'
      : isWsl
        ? session.wslDistro
        : 'Local'
  // The Ops group (choose a runbook folder) is always on offer, so the menu always opens.
  const hasEnvOptions = true
  const runbookBad = isOps && runbookInfo !== null && !runbookInfo.ok
  // The ops profile exists only on the Claude engine (plan §1.9). The model picker lives
  // in Chat and already filters to the chat's provider, so here we only warn.
  const selectedProvider = models.find((m) => (session.model ?? '').startsWith(m.id))?.provider ?? 'claude'
  const opsWrongModel = isOps && selectedProvider !== 'claude'

  // The row must stay on one line, so only CHIP_BUDGET chips render inline. Env + folder
  // (+ branch + worktree when they apply) are always worth seeing; the additional-directory
  // chips take whatever slots are left and the rest collapse behind "+N more".
  const fixedChips = 2 + (isLocal && branch ? 1 : 0) + (isLocal && isRepo ? 1 : 0)
  const dirSlots = Math.max(0, CHIP_BUDGET - fixedChips)
  const visibleDirs = isLocal ? dirs.slice(0, dirSlots) : []
  const overflowDirs = isLocal ? dirs.slice(dirSlots) : []

  return (
    <div className="config-bar">
      {/* Environment */}
      <div className="config-env" ref={envRef}>
        <button
          className={`config-pill${isOps ? ' config-ops-pill' : ''}${runbookBad ? ' config-ops-pill-bad' : ''}`}
          onClick={() => hasEnvOptions && setEnvOpen((v) => !v)}
          disabled={disabled}
          title={isOps ? `Ops chat under the runbook ${session.runbookPath}` : 'Where this chat runs'}
          aria-haspopup={hasEnvOptions ? 'menu' : undefined}
          aria-expanded={hasEnvOptions ? envOpen : undefined}
        >
          {isOps ? (
            /* A clipboard with a check: a runbook, not a machine. */
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="4" width="14" height="18" rx="2" />
              <path d="M9 4V2h6v2" /><polyline points="9 13 11 15 15 11" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          )}
          <span>{envLabel}</span>
          {hasEnvOptions && (
            <svg className="config-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </button>
        {envOpen && (
          <div className="config-menu" role="menu">
            <button className={`config-menu-item ${isLocal ? 'selected' : ''}`} onClick={chooseLocal} role="menuitem">
              Local
            </button>
            {distros.length > 0 && <div className="config-menu-label">WSL</div>}
            {distros.map((d) => (
              <button
                key={d.name}
                className={`config-menu-item ${session.wslDistro === d.name ? 'selected' : ''}`}
                onClick={() => chooseWsl(d)}
                role="menuitem"
              >
                {d.name}
              </button>
            ))}
            {hosts.length > 0 && <div className="config-menu-label">Remote (SSH)</div>}
            {hosts.map((h) => (
              <button
                key={h.id}
                className={`config-menu-item ${session.remoteHostId === h.id ? 'selected' : ''}`}
                onClick={() => chooseHost(h)}
                role="menuitem"
              >
                {h.name}
              </button>
            ))}
            <div className="config-menu-label">Ops (runbook)</div>
            {recentRunbooks.map((p) => (
              <button
                key={p}
                className={`config-menu-item ${session.runbookPath === p ? 'selected' : ''}`}
                onClick={() => applyRunbook(p)}
                disabled={picking}
                title={p}
                role="menuitem"
              >
                {basename(p)}
              </button>
            ))}
            <button className="config-menu-item" onClick={chooseRunbookFolder} disabled={picking} role="menuitem">
              {picking ? 'Loading runbook…' : 'Choose runbook folder…'}
            </button>
            {pickError && (
              <div className="config-ops-error" role="alert">
                <div>{pickError.error}</div>
                {pickError.errors && pickError.errors.length > 0 && (
                  <ul>
                    {pickError.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ops chat: what the runbook reaches (hosts + their connection dots) and how it
          treats an unmatched command, or why the runbook can't be used right now. */}
      {isOps && (
        <div className="config-ops-line" title={session.runbookPath}>
          {runbookInfo === null && <span className="config-ops-meta">Loading runbook…</span>}
          {runbookInfo && !runbookInfo.ok && (
            <span
              className="config-ops-bad"
              role="alert"
              title={[runbookInfo.error, ...(runbookInfo.errors ?? [])].join('\n')}
            >
              Runbook unusable: {runbookInfo.error}
              {runbookInfo.errors && runbookInfo.errors.length > 0 ? ` (+${runbookInfo.errors.length})` : ''}
            </span>
          )}
          {runbookInfo?.ok && (
            <>
              {runbookInfo.hosts.length === 0 && <span className="config-ops-meta">No hosts match</span>}
              {runbookInfo.hosts.map((h) => (
                <span
                  key={h.id}
                  className="config-ops-host"
                  title={`${h.host}${h.groups.length ? ` · ${h.groups.join(', ')}` : ''}${
                    hostDots[h.id] === 'error' ? ' · not reachable' : hostDots[h.id] === 'ok' ? ' · reachable' : ''
                  }`}
                >
                  <span className={`config-ops-dot ${hostDots[h.id] ?? 'checking'}`} aria-hidden="true" />
                  {h.name}
                </span>
              ))}
              <span
                className={`config-ops-mode ${runbookInfo.strict ? 'strict' : ''}`}
                title={runbookInfo.strict ? 'Unmatched commands are denied' : 'Unmatched commands ask first'}
              >
                {runbookInfo.strict ? 'strict' : 'ask'}
              </span>
              {runbookInfo.warnings.length > 0 && (
                <span className="config-ops-warn" title={runbookInfo.warnings.join('\n')}>
                  {runbookInfo.warnings.length} warning{runbookInfo.warnings.length > 1 ? 's' : ''}
                </span>
              )}
            </>
          )}
          {opsWrongModel && <span className="config-ops-warn">Ops chats run on Claude only</span>}
        </div>
      )}

      {/* Folder — local + WSL browse the filesystem with the native picker */}
      {(isLocal || isWsl) && (
        <button className="config-pill" onClick={pickFolder} disabled={disabled} title={session.projectPath || 'Choose a project folder'}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>{session.projectPath ? basename(session.projectPath) : 'Add folder'}</span>
        </button>
      )}

      {/* Folder — remote (typed in; there's no browsable local filesystem over SSH) */}
      {isRemote && (
        <div className="config-env" ref={pathRef}>
          <button
            className="config-pill"
            onClick={() => (pathOpen ? setPathOpen(false) : openPathEditor())}
            disabled={disabled}
            title={session.projectPath || 'Set the working directory on the remote host'}
            aria-haspopup="dialog"
            aria-expanded={pathOpen}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{session.projectPath ? basename(session.projectPath) : 'Add folder'}</span>
          </button>
          {pathOpen && (
            <div className="config-menu config-path" role="dialog" aria-label="Remote working directory">
              <input
                className="config-path-input"
                type="text"
                value={pathDraft}
                autoFocus
                spellCheck={false}
                placeholder="/home/user/project"
                onChange={(e) => setPathDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPath()
                }}
              />
              <button className="config-path-save" onClick={commitPath}>
                Set folder
              </button>
            </div>
          )}
        </div>
      )}

      {/* Git branch — read-only */}
      {isLocal && branch && (
        <span className="config-pill static" title={`On branch ${branch}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="9" r="3" />
            <path d="M18 12a9 9 0 0 1-9 9M6 9v6" />
          </svg>
          <span>{branch}</span>
        </span>
      )}

      {/* Worktree toggle — only meaningful for a local git repo */}
      {isLocal && isRepo && (
        <button
          className={`config-pill toggle ${session.useWorktree ? 'on' : ''}`}
          onClick={() => onPatch({ useWorktree: !session.useWorktree })}
          disabled={disabled}
          title="Run in a fresh git worktree so changes stay off your current branch"
          aria-pressed={!!session.useWorktree}
        >
          <span className={`config-check ${session.useWorktree ? 'on' : ''}`} aria-hidden="true">
            {session.useWorktree && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
          <span>Worktree</span>
        </button>
      )}

      {/* Additional directories (only the ones that fit the one-line budget) */}
      {visibleDirs.map((d) => (
        <span className="config-pill static dir-chip" key={d} title={d}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>{basename(d)}</span>
          <button className="dir-chip-remove" onClick={() => removeDir(d)} title="Remove directory" aria-label={`Remove ${basename(d)}`}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      ))}

      {/* Overflowed directories */}
      {overflowDirs.length > 0 && (
        <div className="config-env" ref={overflowRef}>
          <button
            className="config-pill config-more"
            onClick={() => setOverflowOpen((v) => !v)}
            title={overflowDirs.join('\n')}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            +{overflowDirs.length} more
          </button>
          {overflowOpen && (
            <div className="config-menu config-overflow" role="menu">
              {overflowDirs.map((d) => (
                <div className="config-overflow-row" key={d} title={d}>
                  <span className="config-overflow-name">{basename(d)}</span>
                  <button
                    className="dir-chip-remove"
                    onClick={() => removeDir(d)}
                    title="Remove directory"
                    aria-label={`Remove ${basename(d)}`}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isLocal && (
        <button className="config-pill add-dir" onClick={addDir} disabled={disabled} title="Add another working directory">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
    </div>
  )
}
