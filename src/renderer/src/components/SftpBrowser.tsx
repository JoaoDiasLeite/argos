import { useEffect, useState } from 'react'
import { RemoteEntry } from '../types'
import './SftpBrowser.css'

interface Props {
  hostId: string
  /** Current remote directory being browsed (POSIX, absolute). Owned by the parent view so
   *  its breadcrumb/path input stays in sync — this component only ever reports navigation
   *  intents up via `onNavigate`, it never holds its own notion of "current dir". */
  cwd: string
  onNavigate: (dir: string) => void
  onOpenFile: (entry: RemoteEntry) => void
  /** "cd terminal here" — a one-way affordance, not a two-way sync with the terminal. */
  onCdTerminal: (dir: string) => void
}

function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

function formatDate(ms: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

const ICONS: Record<RemoteEntry['type'], JSX.Element> = {
  directory: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  symlink: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M9 15l6-6M9 9h6v6" />
    </>
  ),
  other: <circle cx="12" cy="12" r="8" />
}

export default function SftpBrowser({ hostId, cwd, onNavigate, onOpenFile, onCdTerminal }: Props) {
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<RemoteEntry | null>(null)
  const [renaming, setRenaming] = useState<RemoteEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    const res = await window.electronAPI.sftpList(hostId, cwd)
    setLoading(false)
    if (res.ok) setEntries(res.entries ?? [])
    else setError(res.error || 'Failed to list directory')
  }

  useEffect(() => {
    load()
    // Directory navigation resets any in-flight row actions from the previous listing.
    setConfirmDelete(null)
    setRenaming(null)
    setCreatingFolder(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, cwd])

  const openEntry = (entry: RemoteEntry) => {
    if (entry.type === 'directory') onNavigate(entry.path)
    else onOpenFile(entry)
  }

  const doDelete = async (entry: RemoteEntry) => {
    setBusyPath(entry.path)
    const res = await window.electronAPI.sftpDelete(hostId, entry.path)
    setBusyPath(null)
    setConfirmDelete(null)
    if (res.ok) load()
    else setError(res.error || 'Delete failed')
  }

  const doRename = async () => {
    if (!renaming) return
    const name = renameValue.trim()
    if (!name || name === renaming.name) {
      setRenaming(null)
      return
    }
    const dir = cwd
    const to = posixJoin(dir, name)
    setBusyPath(renaming.path)
    const res = await window.electronAPI.sftpRename(hostId, renaming.path, to)
    setBusyPath(null)
    setRenaming(null)
    if (res.ok) load()
    else setError(res.error || 'Rename failed')
  }

  const doMkdir = async () => {
    const name = newFolderName.trim()
    if (!name) {
      setCreatingFolder(false)
      return
    }
    const res = await window.electronAPI.sftpMkdir(hostId, posixJoin(cwd, name))
    setCreatingFolder(false)
    setNewFolderName('')
    if (res.ok) load()
    else setError(res.error || 'Could not create folder')
  }

  const doUpload = async () => {
    const res = await window.electronAPI.sftpUpload(hostId, cwd)
    if (res.ok) {
      if (res.uploaded && res.uploaded.length > 0) load()
    } else {
      setError(res.error || 'Upload failed')
    }
  }

  return (
    <div className="sftp-browser">
      <div className="sftp-toolbar">
        <button className="sftp-toolbar-btn" onClick={load} title="Refresh" disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={() => setCreatingFolder(true)} title="New folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={doUpload} title="Upload files into this folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <span className="sftp-toolbar-path" title={cwd}>{cwd}</span>
      </div>

      {creatingFolder && (
        <div className="sftp-inline-form">
          <input
            className="text-input mono"
            autoFocus
            placeholder="new-folder"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doMkdir()
              if (e.key === 'Escape') setCreatingFolder(false)
            }}
          />
          <button className="btn-primary small" onClick={doMkdir}>Create</button>
          <button className="btn-ghost small" onClick={() => setCreatingFolder(false)}>Cancel</button>
        </div>
      )}

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-list">
        {loading && entries.length === 0 && <div className="view-empty small">Loading…</div>}
        {!loading && entries.length === 0 && !error && <div className="view-empty small">Empty directory.</div>}
        {entries.map((entry) => (
          <div key={entry.path} className={`sftp-row ${busyPath === entry.path ? 'busy' : ''}`}>
            {renaming?.path === entry.path ? (
              <input
                className="text-input mono sftp-rename-input"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={doRename}
              />
            ) : (
              <>
                <div className="sftp-row-main" onDoubleClick={() => openEntry(entry)} title={entry.path}>
                  <span className={`sftp-row-icon ${entry.type}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {ICONS[entry.type]}
                    </svg>
                  </span>
                  <span className="sftp-row-name">{entry.name}</span>
                  {entry.type === 'file' && <span className="sftp-row-size">{formatSize(entry.size)}</span>}
                  <span className="sftp-row-mtime">{formatDate(entry.mtime)}</span>
                </div>
                {confirmDelete?.path === entry.path ? (
                  <div className="sftp-row-confirm">
                    <span>Delete?</span>
                    <button className="btn-text danger" onClick={() => doDelete(entry)}>Yes</button>
                    <button className="btn-text" onClick={() => setConfirmDelete(null)}>No</button>
                  </div>
                ) : (
                  <div className="sftp-row-actions">
                    {entry.type === 'directory' && (
                      <button
                        className="sftp-row-btn"
                        title="cd terminal here"
                        onClick={() => onCdTerminal(entry.path)}
                      >
                        cd
                      </button>
                    )}
                    {entry.type === 'file' && (
                      <button
                        className="sftp-row-btn"
                        title="Download"
                        onClick={() => window.electronAPI.sftpDownload(hostId, entry.path)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </button>
                    )}
                    <button
                      className="sftp-row-btn"
                      title="Rename"
                      onClick={() => {
                        setRenaming(entry)
                        setRenameValue(entry.name)
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
                      </svg>
                    </button>
                    <button
                      className="sftp-row-btn danger"
                      title="Delete"
                      onClick={() => setConfirmDelete(entry)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
