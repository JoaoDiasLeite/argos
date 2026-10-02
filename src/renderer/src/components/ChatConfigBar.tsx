import { useEffect, useRef, useState } from 'react'
import { Session, WslDistro, SshHostPublic, ModelInfo } from '../types'
import { provOf } from '../lib/account-scope'
import { CLI_PROVIDERS, modelForProvider } from '../lib/cli-providers'
import './ChatConfigBar.css'

interface Props {
  session: Session
  /** Patch the draft session with the chosen CLI / environment / folder. */
  onPatch: (patch: Partial<Session>) => void
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/**
 * The terminal setup pane's pre-launch choices: which CLI, the environment (Local / WSL
 * distro / SSH host), the project folder, and the git branch it is on. Every change calls
 * `onPatch`; nothing here can change once the CLI has started.
 *
 * Ops is not on offer here: an ops session needs its gated launch, which only Servers → Ops
 * gives it, and a chat switched to a runbook here used to start an ungated CLI instead.
 */
export default function ChatConfigBar({ session, onPatch }: Props) {
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [envOpen, setEnvOpen] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [branch, setBranch] = useState<string | null>(null)
  const envRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<HTMLDivElement>(null)

  const isRemote = !!session.remoteHostId
  const isWsl = !isRemote && !!session.wslDistro
  const isLocal = !isRemote && !isWsl
  // TODO(B4): `session.provider`.
  const provider = provOf(models, session.model)

  // Only ever mounted on the setup pane, so these are loaded lazily.
  useEffect(() => {
    window.electronAPI.wslList().then(setDistros).catch(() => {})
    window.electronAPI.sshList().then(setHosts).catch(() => {})
    window.electronAPI.getModels().then(setModels).catch(() => {})
  }, [])

  // Read the git branch of the chosen local folder (drives the branch pill).
  useEffect(() => {
    let cancelled = false
    if (!isLocal || !session.projectPath) {
      setBranch(null)
      return
    }
    window.electronAPI
      .gitStatus(session.projectPath)
      .then((s) => {
        if (!cancelled) setBranch(s.isRepo ? s.branch : null)
      })
      .catch(() => {
        if (!cancelled) setBranch(null)
      })
    return () => {
      cancelled = true
    }
  }, [session.projectPath, isLocal])

  // Close a popover on outside click / Escape.
  useEffect(() => {
    if (!envOpen && !pathOpen) return
    const onDoc = (e: MouseEvent) => {
      if (envOpen && !envRef.current?.contains(e.target as Node)) setEnvOpen(false)
      if (pathOpen && !pathRef.current?.contains(e.target as Node)) setPathOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setEnvOpen(false)
      setPathOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [envOpen, pathOpen])

  const chooseLocal = () => {
    onPatch({
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
      wslDistro: d.name,
      remoteHostId: undefined,
      remoteHostName: `WSL · ${d.name}`,
      // WSL folders live in the distro, not the Windows FS — clear a Windows path.
      projectPath: undefined
    })
    setEnvOpen(false)
  }
  const chooseHost = (h: SshHostPublic) => {
    onPatch({
      remoteHostId: h.id,
      remoteHostName: h.name,
      wslDistro: undefined,
      projectPath: h.remotePath ?? undefined
    })
    setEnvOpen(false)
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

  const envLabel = isRemote ? session.remoteHostName || 'Remote' : isWsl ? session.wslDistro : 'Local'

  return (
    <>
      {/* Which CLI starts. The model inside it is the CLI's own business (/model). */}
      <div className="seg-control config-cli" role="group" aria-label="CLI">
        {CLI_PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={provider === p.id ? 'on' : ''}
            aria-pressed={provider === p.id}
            onClick={() => {
              if (provider === p.id) return
              const model = modelForProvider(models, p.id, session.model)
              if (model) onPatch({ model })
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="config-bar">
        {/* Environment */}
        <div className="config-env" ref={envRef}>
          <button
            className="config-pill"
            onClick={() => setEnvOpen((v) => !v)}
            title="Where this terminal runs"
            aria-haspopup="menu"
            aria-expanded={envOpen}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>{envLabel}</span>
            <svg className="config-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
            </div>
          )}
        </div>

        {/* Folder — local + WSL browse the filesystem with the native picker */}
        {(isLocal || isWsl) && (
          <button className="config-pill" onClick={pickFolder} title={session.projectPath || 'Choose a project folder'}>
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
      </div>
    </>
  )
}
