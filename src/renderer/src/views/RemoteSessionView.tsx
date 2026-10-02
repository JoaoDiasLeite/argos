import { useEffect, useRef, useState } from 'react'
import { RemoteTarget } from '../types'
import ChatTerminal from '../components/ChatTerminal'
import RemoteTerminal from '../components/RemoteTerminal'
import SftpBrowser from '../components/SftpBrowser'
import LocalBrowser from '../components/LocalBrowser'
import FileEditor from '../components/FileEditor'
import { readLocalFile, writeLocalFile } from '../lib/local-file-io'
import './views.css'
import './RemoteSessionView.css'

interface Props {
  target: RemoteTarget
  /** This session's 1-based number within its target's group. A target can have several
   *  sessions open at once, and each needs its OWN shell — so it has to reach the terminal
   *  id, or two sessions on one host would share (and fight over) a single channel. */
  seq: number
  /** True while this session's tab is the one currently shown (view is 'remote-session' AND
   *  it's the active tab). The session itself stays mounted regardless — this only drives
   *  the terminal refit-on-show (see RemoteTerminal/ChatTerminal `active` prop). */
  active?: boolean
  onBack: () => void
  /** Reports this session's connection state upward. App.tsx keeps it per session so the
   *  Remote & WSL list's status dots reflect what actually happened — an open tab is not
   *  evidence a host is reachable, since the connection may have been refused. */
  onStatusChange?: (status: 'connecting' | 'connected' | 'error') => void
}

interface RunLogEntry {
  cmd: string
  ts: number
}

const RUNLOG_CAP = 200

function runLogKey(targetId: string): string {
  return `remote-runlog-${targetId}`
}

function loadRunLog(targetId: string): RunLogEntry[] {
  try {
    const raw = localStorage.getItem(runLogKey(targetId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRunLog(targetId: string, log: RunLogEntry[]): void {
  try {
    localStorage.setItem(runLogKey(targetId), JSON.stringify(log.slice(-RUNLOG_CAP)))
  } catch {
    // storage unavailable or over quota — the run log is a convenience, not load-bearing.
  }
}

// Quote a command for a POSIX shell — same escaping ssh.ts's shQuote uses.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ─── WSL POSIX <-> UNC path mapping (for LocalBrowser, which speaks Windows paths) ──────

function wslUncRoot(distro: string): string {
  return `\\\\wsl.localhost\\${distro}`
}

function wslUncPath(distro: string, posixPath: string): string {
  const clean = posixPath.startsWith('/') ? posixPath : `/${posixPath}`
  return `${wslUncRoot(distro)}${clean.replace(/\//g, '\\')}`
}

function uncToPosixPath(distro: string, uncPath: string): string {
  const root = wslUncRoot(distro)
  if (!uncPath.toLowerCase().startsWith(root.toLowerCase())) return '/'
  const rest = uncPath.slice(root.length).replace(/\\/g, '/')
  return rest.startsWith('/') ? rest : `/${rest}`
}

export default function RemoteSessionView({ target, seq, active, onBack, onStatusChange }: Props) {
  const isSsh = target.kind === 'ssh'
  // targetId is per TARGET (the run log is shared by every session on the same box, which
  // is what you want — it's that machine's command history). terminalId is per SESSION.
  const targetId = isSsh ? target.host.id : `wsl_${target.distro}`
  const terminalId = isSsh ? `remoteterm_${target.host.id}_${seq}` : `wslterm_${target.distro}_${seq}`

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>(
    isSsh ? 'connecting' : 'connected'
  )
  const [statusError, setStatusError] = useState<string | null>(null)
  const [cwd, setCwd] = useState(isSsh ? target.host.remotePath || '/' : '/home')
  const [pathInput, setPathInput] = useState(cwd)
  const [panel, setPanel] = useState<'files' | 'history'>('files')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [remoteHistory, setRemoteHistory] = useState<string[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [runLog, setRunLog] = useState<RunLogEntry[]>(() => loadRunLog(targetId))
  const [quickRun, setQuickRun] = useState('')
  const historyLoadedRef = useRef(false)

  // Connect on mount. SSH only — the connection is per-host, cached in main. WSL has
  // nothing to "connect": the terminal (ChatTerminal, wsl.exe) and the file browser
  // (LocalBrowser, over the distro's share) are ready as soon as the distro itself is.
  //
  // Note there's deliberately no disconnect in the cleanup: that ssh2 client is shared by
  // every session on the host, so tearing it down here would kill a sibling session's
  // terminal. App.tsx's closeServerSession drops it once the last one is gone.
  useEffect(() => {
    if (!isSsh) {
      setStatus('connected')
      setStatusError(null)
      setCwd('/home')
      return
    }
    let cancelled = false
    const hostId = target.host.id
    setStatus('connecting')
    setStatusError(null)
    window.electronAPI.sftpConnect(hostId).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setStatus('connected')
        setCwd(target.host.remotePath || res.home || '/')
      } else {
        setStatus('error')
        setStatusError(res.error || 'Could not connect')
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSsh, isSsh ? target.host.id : target.distro])

  useEffect(() => {
    onStatusChange?.(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  useEffect(() => {
    setPathInput(cwd)
  }, [cwd])

  const loadHistory = async () => {
    setHistoryLoading(true)
    const res = isSsh
      ? await window.electronAPI.sftpHistory(target.host.id)
      : await window.electronAPI.wslHistory(target.distro)
    setHistoryLoading(false)
    if (res.ok) setRemoteHistory(res.commands ?? [])
  }

  const openHistoryPanel = () => {
    setPanel('history')
    if (!historyLoadedRef.current) {
      historyLoadedRef.current = true
      loadHistory()
    }
  }

  const sendToTerminal = (cmd: string) => {
    if (isSsh) window.electronAPI.remoteShellWrite(terminalId, `${cmd}\n`)
    else window.electronAPI.terminalWrite(terminalId, `${cmd}\n`)
  }

  const runQuickCommand = () => {
    const cmd = quickRun.trim()
    if (!cmd) return
    const entry: RunLogEntry = { cmd, ts: Date.now() }
    setRunLog((prev) => {
      const next = [...prev, entry].slice(-RUNLOG_CAP)
      saveRunLog(targetId, next)
      return next
    })
    sendToTerminal(cmd)
    setQuickRun('')
  }

  const navigatePath = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/')) return
    setCwd(trimmed.replace(/\/+$/, '') || '/')
  }

  const retryConnect = () => {
    if (!isSsh) return
    setStatus('connecting')
    setStatusError(null)
    window.electronAPI.sftpConnect(target.host.id).then((res) => {
      if (res.ok) {
        setStatus('connected')
        setCwd(target.host.remotePath || res.home || '/')
      } else {
        setStatus('error')
        setStatusError(res.error || 'Could not connect')
      }
    })
  }

  return (
    <div className="view remote-session-view">
      <div className="remote-session-header">
        <button type="button" className="remote-session-back" onClick={onBack} title="Back to targets" aria-label="Back to targets">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <div className="remote-session-title">
          <span className={`remote-session-dot ${status}`} title={status === 'error' ? statusError || 'Could not connect' : status} />
          <span className="remote-session-name">{isSsh ? target.host.name : target.distro}</span>
          <span className="remote-session-target">
            {isSsh ? `${target.host.username}@${target.host.host}` : `wsl -d ${target.distro}`}
          </span>
        </div>
        <input
          className="text-input mono remote-session-path"
          value={pathInput}
          aria-label="Folder"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigatePath(pathInput)
            if (e.key === 'Escape') setPathInput(cwd)
          }}
          onBlur={() => setPathInput(cwd)}
          spellCheck={false}
        />
        <div className="seg-control remote-session-toggle">
          <button type="button" className={panel === 'files' ? 'on' : ''} onClick={() => setPanel('files')}>Files</button>
          <button type="button" className={panel === 'history' ? 'on' : ''} onClick={openHistoryPanel}>History</button>
        </div>
        <span className="remote-session-spacer" />
      </div>

      <div className="remote-session-body">
        <div className="remote-session-left">
          {/* The connection's failure lives in the pane it is about. The terminal rides the
              same SSH connection as the file browser (sftp.ts getRemoteClient), so when this
              fails neither has anything to show. */}
          {status === 'error' && (
            <div className="block err remote-session-error" role="alert">
              <div className="remote-session-error-head">
                <span className="remote-session-error-title">Could not connect</span>
                {statusError && <span className="remote-session-error-why">{statusError}</span>}
              </div>
              <span className="remote-session-error-text">
                The terminal uses the same connection, so it has no shell either.
              </span>
              <div>
                <button type="button" className="btn-ghost small" onClick={retryConnect}>
                  Retry
                </button>
              </div>
            </div>
          )}
          {panel === 'files' ? (
            isSsh ? (
              <SftpBrowser
                hostId={target.host.id}
                cwd={cwd}
                onNavigate={setCwd}
                onOpenFile={(entry) => setOpenFile(entry.path)}
                onCdTerminal={(dir) => sendToTerminal(`cd ${shQuote(dir)}`)}
              />
            ) : (
              <LocalBrowser
                dir={wslUncPath(target.distro, cwd)}
                onNavigate={(dir) => setCwd(uncToPosixPath(target.distro, dir))}
                onOpenFile={(entry) => setOpenFile(entry.path)}
                onCdTerminal={(dir) => sendToTerminal(`cd ${shQuote(uncToPosixPath(target.distro, dir))}`)}
              />
            )
          ) : (
            <div className="remote-history-panel">
              <div className="remote-history-quickrun">
                <input
                  className="text-input mono"
                  placeholder="Run a command"
                  aria-label="Run a command in the terminal"
                  value={quickRun}
                  onChange={(e) => setQuickRun(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runQuickCommand()}
                />
                <button type="button" className="btn-primary small" onClick={runQuickCommand} disabled={!quickRun.trim()}>Run</button>
              </div>

              <div className="eyebrow remote-history-eyebrow">
                Remote history
                {historyLoading && <span className="remote-history-loading">loading</span>}
              </div>
              <div className="remote-history-list">
                {remoteHistory.length === 0 && !historyLoading && (
                  <p className="remote-history-empty">No shell history found.</p>
                )}
                {[...remoteHistory].reverse().map((cmd, i) => (
                  <button type="button" key={`${i}-${cmd}`} className="remote-history-item" onClick={() => sendToTerminal(cmd)} title="Send to terminal">
                    {cmd}
                  </button>
                ))}
              </div>

              {/* Only what was typed in the quick-run box, kept in this browser's
                  localStorage. It is not a record of what ran on the host. */}
              <div className="eyebrow remote-history-eyebrow">Typed here</div>
              <div className="remote-history-list">
                {runLog.length === 0 && <p className="remote-history-empty">Nothing typed yet.</p>}
                {[...runLog].reverse().map((entry) => (
                  <button type="button" key={entry.ts} className="remote-history-item" onClick={() => sendToTerminal(entry.cmd)} title="Send to terminal">
                    {entry.cmd}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="remote-session-right">
          {isSsh ? (
            <RemoteTerminal terminalId={terminalId} hostId={target.host.id} active={active} onClose={onBack} />
          ) : (
            <ChatTerminal
              terminalId={terminalId}
              wslDistro={target.distro}
              provider="claude"
              autoLaunchCli={false}
              active={active}
              onClose={onBack}
            />
          )}
        </div>
      </div>

      {openFile && isSsh && (
        <FileEditor
          filePath={openFile}
          onClose={() => setOpenFile(null)}
          read={(p) => window.electronAPI.sftpRead(target.host.id, p)}
          write={(p, content) => window.electronAPI.sftpWrite(target.host.id, p, content)}
          onDownload={() => window.electronAPI.sftpDownload(target.host.id, openFile)}
        />
      )}
      {openFile && !isSsh && (
        <FileEditor
          filePath={openFile}
          onClose={() => setOpenFile(null)}
          read={readLocalFile}
          write={writeLocalFile}
        />
      )}
    </div>
  )
}
