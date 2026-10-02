import { useEffect, useState } from 'react'
import { FileNode } from '../types'
import { FbIcon } from './SftpBrowser'
import './SftpBrowser.css'

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
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')

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
    setCreatingFile(false)
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

  const doTouch = async () => {
    const name = newFileName.trim()
    if (!name) {
      setCreatingFile(false)
      return
    }
    // fsWriteFile happily overwrites whatever's already there, and it doesn't know the
    // difference between "create empty file" and "truncate this one to empty" — so we
    // have to check the already-loaded listing ourselves before calling it.
    if (name.includes('/') || name.includes('\\')) {
      setError('File name cannot contain a slash.')
      return
    }
    if (entries.some((e) => e.name === name)) {
      setError('A file with that name already exists.')
      return
    }
    const path = winJoin(dir, name)
    const res = await window.electronAPI.fsWriteFile(path, '')
    setCreatingFile(false)
    setNewFileName('')
    if (res.ok) {
      await load()
      onOpenFile({ name, path, type: 'file' })
    } else {
      setError(res.error || 'Could not create file')
    }
  }

  return (
    <div className="fb">
      <div className="fb-toolbar">
        <button type="button" className="btn-ghost small fb-icon-btn" onClick={load} title="Refresh" aria-label="Refresh" disabled={loading}>
          <FbIcon.refresh />
        </button>
        <button
          type="button"
          className="btn-ghost small fb-icon-btn"
          onClick={() => {
            setCreatingFolder(true)
            setCreatingFile(false)
          }}
          title="New folder"
          aria-label="New folder"
        >
          <FbIcon.newFolder />
        </button>
        <button
          type="button"
          className="btn-ghost small fb-icon-btn"
          onClick={() => {
            setCreatingFile(true)
            setCreatingFolder(false)
          }}
          title="New file"
          aria-label="New file"
        >
          <FbIcon.newFile />
        </button>
        <span className="fb-path" title={dir}>{dir}</span>
      </div>

      {creatingFolder && (
        <div className="fb-form">
          <input
            className="text-input mono"
            autoFocus
            placeholder="new-folder"
            aria-label="New folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doMkdir()
              if (e.key === 'Escape') setCreatingFolder(false)
            }}
          />
          <button type="button" className="btn-primary small" onClick={doMkdir}>Create</button>
          <button type="button" className="btn-ghost small" onClick={() => setCreatingFolder(false)}>Cancel</button>
        </div>
      )}

      {creatingFile && (
        <div className="fb-form">
          <input
            className="text-input mono"
            autoFocus
            placeholder="new-file.txt"
            aria-label="New file name"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doTouch()
              if (e.key === 'Escape') setCreatingFile(false)
            }}
          />
          <button type="button" className="btn-primary small" onClick={doTouch}>Create</button>
          <button type="button" className="btn-ghost small" onClick={() => setCreatingFile(false)}>Cancel</button>
        </div>
      )}

      {error && <p className="fb-error">{error}</p>}

      <div className="fb-list">
        {loading && entries.length === 0 && <p className="fb-empty">Loading…</p>}
        {!loading && entries.length === 0 && !error && <p className="fb-empty">Empty directory.</p>}
        {entries.map((entry) => (
          <div key={entry.path} className={`fb-row ${busyPath === entry.path ? 'busy' : ''}`}>
            {renaming?.path === entry.path ? (
              <input
                className="text-input mono fb-rename"
                autoFocus
                aria-label={`Rename ${entry.name}`}
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
                <div className="fb-row-main" onDoubleClick={() => openEntry(entry)} title={entry.path}>
                  <span className="fb-row-icon">{entry.type === 'directory' ? <FbIcon.folder /> : <FbIcon.file />}</span>
                  <span className="fb-row-name">{entry.name}</span>
                </div>
                {confirmDelete?.path === entry.path ? (
                  <div className="fb-row-confirm">
                    <button type="button" className="btn-ghost small" onClick={() => setConfirmDelete(null)} autoFocus>
                      Keep
                    </button>
                    <button type="button" className="btn-primary small danger" onClick={() => doDelete(entry)}>
                      Delete
                    </button>
                  </div>
                ) : (
                  <div className="fb-row-actions">
                    {entry.type === 'directory' && (
                      <button
                        type="button"
                        className="fb-row-btn"
                        title="cd the terminal here"
                        aria-label={`cd the terminal to ${entry.name}`}
                        onClick={() => onCdTerminal(entry.path)}
                      >
                        <FbIcon.terminal />
                      </button>
                    )}
                    <button
                      type="button"
                      className="fb-row-btn"
                      title="Rename"
                      aria-label={`Rename ${entry.name}`}
                      onClick={() => {
                        setRenaming(entry)
                        setRenameValue(entry.name)
                      }}
                    >
                      <FbIcon.rename />
                    </button>
                    <button
                      type="button"
                      className="fb-row-btn danger"
                      title="Delete"
                      aria-label={`Delete ${entry.name}`}
                      onClick={() => setConfirmDelete(entry)}
                    >
                      <FbIcon.trash />
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
