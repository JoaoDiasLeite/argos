import { useEffect, useId, useRef, useState } from 'react'
import { Session, WslDistro, SshHostPublic } from '../types'
import { sessionProvider } from '../lib/account-scope'
import { CLI_PROVIDERS } from '../lib/cli-providers'
import './ChatConfigBar.css'

interface Props {
  session: Session
  /** Patch the draft session with the chosen CLI / environment / folder. */
  onPatch: (patch: Partial<Session>) => void
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

const svgProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

/** The chevron of §5. */
const Chevron = ({ size = 12, right = false }: { size?: number; right?: boolean }) => (
  <svg className="config-caret" width={size} height={size} viewBox="0 0 24 24" {...svgProps}>
    <path d={right ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} />
  </svg>
)
const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" {...svgProps}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)
const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...svgProps}>
    <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="9" r="3" />
    <path d="M18 12a9 9 0 0 1-9 9M6 9v6" />
  </svg>
)

/**
 * Where a terminal runs, and the state that picks it: the environment (Local / WSL distro /
 * SSH host), the project folder and the git branch it is on. Shared by the setup pane's
 * fields and the compact bar, which draw it differently. Every change calls `onPatch`;
 * nothing here can change once the CLI has started.
 *
 * Ops is not on offer here: an ops session needs its gated launch, which only Servers → Ops
 * gives it, and a chat switched to a runbook here used to start an ungated CLI instead.
 */
function useChatConfig(session: Session, onPatch: Props['onPatch']) {
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [envOpen, setEnvOpen] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [git, setGit] = useState<{ branch: string; changed: number } | null>(null)
  const envRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<HTMLDivElement>(null)

  const isRemote = !!session.remoteHostId
  const isWsl = !isRemote && !!session.wslDistro
  const isLocal = !isRemote && !isWsl

  // Only ever mounted next to a launch, so these are loaded lazily.
  useEffect(() => {
    window.electronAPI.wslList().then(setDistros).catch(() => {})
    window.electronAPI.sshList().then(setHosts).catch(() => {})
  }, [])

  // Read the git branch of the chosen local folder.
  useEffect(() => {
    let cancelled = false
    if (!isLocal || !session.projectPath) {
      setGit(null)
      return
    }
    window.electronAPI
      .gitStatus(session.projectPath)
      .then((s) => {
        if (!cancelled) setGit(s.isRepo ? { branch: s.branch, changed: s.files.length } : null)
      })
      .catch(() => {
        if (!cancelled) setGit(null)
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

  const envLabel = isRemote ? session.remoteHostName || 'Remote' : isWsl ? session.wslDistro! : 'Local'

  return {
    distros, hosts, envOpen, setEnvOpen, pathOpen, setPathOpen, pathDraft, setPathDraft, git,
    envRef, pathRef, isRemote, isWsl, isLocal, chooseLocal, chooseWsl, chooseHost, pickFolder,
    openPathEditor, commitPath, envLabel
  }
}

type Config = ReturnType<typeof useChatConfig>

/** The Local / WSL / Remote (SSH) list: a flat 4 px popover with an eyebrow per group. */
function EnvMenu({ cfg, session, up }: { cfg: Config; session: Session; up?: boolean }) {
  return (
    <div className={`config-menu ${up ? 'up' : ''}`} role="menu">
      <div className="eyebrow config-menu-label">Local</div>
      <button className={`config-menu-item ${cfg.isLocal ? 'selected' : ''}`} onClick={cfg.chooseLocal} role="menuitem">
        Local
      </button>
      {cfg.distros.length > 0 && <div className="eyebrow config-menu-label">WSL</div>}
      {cfg.distros.map((d) => (
        <button
          key={d.name}
          className={`config-menu-item ${session.wslDistro === d.name ? 'selected' : ''}`}
          onClick={() => cfg.chooseWsl(d)}
          role="menuitem"
        >
          {d.name}
        </button>
      ))}
      {cfg.hosts.length > 0 && <div className="eyebrow config-menu-label">Remote (SSH)</div>}
      {cfg.hosts.map((h) => (
        <button
          key={h.id}
          className={`config-menu-item ${session.remoteHostId === h.id ? 'selected' : ''}`}
          onClick={() => cfg.chooseHost(h)}
          role="menuitem"
        >
          {h.name}
        </button>
      ))}
    </div>
  )
}

/**
 * The setup pane's two fields: where it runs, and the folder. The CLI is not a field here
 * — the account chosen at the top of the sidebar already fixes it (see Chat.tsx).
 */
export function ChatConfigFields({ session, onPatch }: Props) {
  const cfg = useChatConfig(session, onPatch)
  const envId = useId()
  const folderId = useId()
  const detail = cfg.isWsl ? '· WSL' : cfg.isRemote ? '· SSH' : ''

  return (
    <>
      <div className="form-group">
        <label htmlFor={envId}>Where it runs</label>
        <div className="config-env" ref={cfg.envRef}>
          <button
            id={envId}
            className="config-select"
            onClick={() => cfg.setEnvOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={cfg.envOpen}
          >
            <span className="config-select-value">
              {cfg.envLabel}
              {detail && <span className="config-select-detail"> {detail}</span>}
            </span>
            <Chevron />
          </button>
          {cfg.envOpen && <EnvMenu cfg={cfg} session={session} />}
        </div>
        <span className="help">Local, a WSL distro or an SSH host. The CLI must be installed there.</span>
      </div>

      <div className="form-group">
        <label htmlFor={folderId}>
          Folder<span className="optional">optional</span>
        </label>
        <button
          id={folderId}
          className={`config-select ${session.projectPath ? 'mono' : ''}`}
          onClick={() => (cfg.isRemote ? (cfg.pathOpen ? cfg.setPathOpen(false) : cfg.openPathEditor()) : void cfg.pickFolder())}
          title={session.projectPath || undefined}
          aria-expanded={cfg.isRemote ? cfg.pathOpen : undefined}
        >
          <span className="config-select-value">{session.projectPath || 'Add folder'}</span>
          <Chevron right />
        </button>
        {cfg.isRemote && cfg.pathOpen && (
          <div className="config-path-row" ref={cfg.pathRef}>
            <input
              className="text-input mono"
              type="text"
              value={cfg.pathDraft}
              autoFocus
              spellCheck={false}
              placeholder="/home/user/project"
              aria-label="Folder on the remote host"
              onChange={(e) => cfg.setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') cfg.commitPath()
                else if (e.key === 'Escape') cfg.setPathOpen(false)
              }}
            />
            <button className="btn-ghost small" onClick={cfg.commitPath}>
              Set folder
            </button>
          </div>
        )}
        <span className="help config-branch-help">
          {cfg.git ? (
            <>
              On <span className="mono">{cfg.git.branch}</span> ·{' '}
              {cfg.git.changed === 1 ? '1 file changed' : `${cfg.git.changed} files changed`}
            </>
          ) : !session.projectPath ? (
            'No folder chosen: it starts in your home folder.'
          ) : (
            'The CLI starts in this folder.'
          )}
        </span>
      </div>
    </>
  )
}

/**
 * The compact form: the segmented CLI, the environment pill, the folder pill and the branch.
 * For a terminal bar, where the pills act and the branch only labels.
 */
export default function ChatConfigBar({ session, onPatch }: Props) {
  const cfg = useChatConfig(session, onPatch)
  const provider = sessionProvider(session)

  return (
    <div className="config-bar">
      {/* Which CLI starts. The model inside it is the CLI's own business (/model). */}
      <div className="seg-control" role="group" aria-label="CLI">
        {CLI_PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={provider === p.id ? 'on' : ''}
            aria-pressed={provider === p.id}
            onClick={() => {
              if (provider === p.id) return
              onPatch({ provider: p.id })
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Environment */}
      <div className="config-env" ref={cfg.envRef}>
        <button
          className="config-pill"
          onClick={() => cfg.setEnvOpen((v) => !v)}
          title="Where this terminal runs"
          aria-haspopup="menu"
          aria-expanded={cfg.envOpen}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" {...svgProps}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>{cfg.envLabel}</span>
          <Chevron size={10} />
        </button>
        {cfg.envOpen && <EnvMenu cfg={cfg} session={session} up />}
      </div>

      {/* Folder: local and WSL browse the filesystem with the native picker */}
      {!cfg.isRemote && (
        <button className="config-pill" onClick={() => void cfg.pickFolder()} title={session.projectPath || 'Choose a project folder'}>
          <FolderIcon />
          <span>{session.projectPath ? basename(session.projectPath) : 'Add folder'}</span>
        </button>
      )}

      {/* Folder: remote (typed in; there's no browsable local filesystem over SSH) */}
      {cfg.isRemote && (
        <div className="config-env" ref={cfg.pathRef}>
          <button
            className="config-pill"
            onClick={() => (cfg.pathOpen ? cfg.setPathOpen(false) : cfg.openPathEditor())}
            title={session.projectPath || 'Set the working directory on the remote host'}
            aria-haspopup="dialog"
            aria-expanded={cfg.pathOpen}
          >
            <FolderIcon />
            <span>{session.projectPath ? basename(session.projectPath) : 'Add folder'}</span>
          </button>
          {cfg.pathOpen && (
            <div className="config-menu up config-path" role="dialog" aria-label="Remote working directory">
              <input
                className="text-input mono"
                type="text"
                value={cfg.pathDraft}
                autoFocus
                spellCheck={false}
                placeholder="/home/user/project"
                onChange={(e) => cfg.setPathDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') cfg.commitPath()
                }}
              />
              <button className="btn-ghost small config-path-save" onClick={cfg.commitPath}>
                Set folder
              </button>
            </div>
          )}
        </div>
      )}

      {/* Git branch: a label, not a control */}
      {cfg.isLocal && cfg.git && (
        <span className="chip config-branch" title={`On branch ${cfg.git.branch}`}>
          <BranchIcon />
          <span>{cfg.git.branch}</span>
        </span>
      )}
    </div>
  )
}
