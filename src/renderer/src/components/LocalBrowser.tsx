import { useEffect, useState } from 'react'
import { FileNode } from '../types'
import './LocalBrowser.css'

interface Props {
  /** Directory being browsed, as a real Windows path (a WSL distro's UNC share,
   *  \\wsl.localhost\<distro>\…, for the WSL "Connect" view). Owned by the parent view. */
  dir: string
  onNavigate: (dir: string) => void
  onOpenFile: (entry: FileNode) => void
  /** "cd terminal here" — a one-way affordance, not a two-way sync with the terminal. */
  onCdTerminal: (dir: string) => void
}

function winJoin(dir: string, name: string): string {
  return dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`
}

const DIR_ICON = (
  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
)
const FILE_ICON = (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
)

/** Local/WSL-share file browser used by the WSL "Connect" session view — mirrors
 *  SftpBrowser's toolbar/actions (refresh, new folder, open→edit, rename, delete) over
 *  the local-fs IPC instead of SFTP. Upload/download are omitted for v1 (see plan notes) —
 *  a WSL share is already a plain Windows folder, reachable from Explorer directly. */
export default function LocalBrowser({ dir, onNavigate, onOpenFile, onCdTerminal }: Props) {
  const [entries, setEntries] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<FileNode | null>(null)
  const [renaming, setRenaming] = useState<FileNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    const res = await window.electronAPI.readDir(dir)
    setLoading(false)
    if ('error' in res) setError(res.error || 'Failed to list directory')
    else setEntries(res)
  }

  useEffect(() => {
    load()
    setConfirmDelete(null)
    setRenaming(null)
    setCreatingFolder(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  const openEntry = (entry: FileNode) => {
    if (entry.type === 'directory') onNavigate(entry.path)
    else onOpenFile(entry)
  }

  const doDelete = async (entry: FileNode) => {
    setBusyPath(entry.path)
    const res = await window.electronAPI.fsDelete(entry.path)
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
    const to = winJoin(dir, name)
    setBusyPath(renaming.path)
    const res = await window.electronAPI.fsRename(renaming.path, to)
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
    const res = await window.electronAPI.fsMkdir(winJoin(dir, name))
    setCreatingFolder(false)
    setNewFolderName('')
    if (res.ok) load()
    else setError(res.error || 'Could not create folder')
  }

  return (
    <div className="local-browser">
      <div className="local-toolbar">
        <button className="local-toolbar-btn" onClick={load} title="Refresh" disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <button className="local-toolbar-btn" onClick={() => setCreatingFolder(true)} title="New folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <span className="local-toolbar-path" title={dir}>{dir}</span>
      </div>

      {creatingFolder && (
        <div className="local-inline-form">
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

      {error && <div className="local-error">{error}</div>}

      <div className="local-list">
        {loading && entries.length === 0 && <div className="view-empty small">Loading…</div>}
        {!loading && entries.length === 0 && !error && <div className="view-empty small">Empty directory.</div>}
        {entries.map((entry) => (
          <div key={entry.path} className={`local-row ${busyPath === entry.path ? 'busy' : ''}`}>
            {renaming?.path === entry.path ? (
              <input
                className="text-input mono local-rename-input"
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
                <div className="local-row-main" onDoubleClick={() => openEntry(entry)} title={entry.path}>
                  <span className={`local-row-icon ${entry.type}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {entry.type === 'directory' ? DIR_ICON : FILE_ICON}
                    </svg>
                  </span>
                  <span className="local-row-name">{entry.name}</span>
                </div>
                {confirmDelete?.path === entry.path ? (
                  <div className="local-row-confirm">
                    <span>Delete?</span>
                    <button className="btn-text danger" onClick={() => doDelete(entry)}>Yes</button>
                    <button className="btn-text" onClick={() => setConfirmDelete(null)}>No</button>
                  </div>
                ) : (
                  <div className="local-row-actions">
                    {entry.type === 'directory' && (
                      <button
                        className="local-row-btn"
                        title="cd terminal here"
                        onClick={() => onCdTerminal(entry.path)}
                      >
                        cd
                      </button>
                    )}
                    <button
                      className="local-row-btn"
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
                      className="local-row-btn danger"
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
