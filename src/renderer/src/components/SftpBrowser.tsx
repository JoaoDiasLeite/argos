import { useEffect, useState, type ReactNode } from 'react'
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

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** dataTransfer type carrying the remote path of a row being dragged within the browser. */
const ROW_DRAG_TYPE = 'application/x-argos-sftp-path'

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

// ── Icons (24-unit viewBox, 2 px stroke, currentColor; SYSTEM-DESIGN.md §5). Shared with
// LocalBrowser, which draws the same toolbar and rows over a WSL share. ─────────────────

function FbSvg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const FbIcon = {
  up: () => <FbSvg><path d="M12 19V5M5 12l7-7 7 7" /></FbSvg>,
  refresh: () => <FbSvg><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5" /></FbSvg>,
  newFolder: () => <FbSvg><path d="M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5" /></FbSvg>,
  newFile: () => <FbSvg><path d="M6 3h8l4 4v14H6zM12 11v6M9 14h6" /></FbSvg>,
  upload: () => <FbSvg><path d="M4 16v4h16v-4M12 4v12M7 9l5-5 5 5" /></FbSvg>,
  download: () => <FbSvg><path d="M4 16v4h16v-4M12 4v12M7 11l5 5 5-5" /></FbSvg>,
  rename: () => <FbSvg><path d="M4 20l4-1 11-11-3-3L5 16z" /></FbSvg>,
  trash: () => <FbSvg><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></FbSvg>,
  /** "cd the terminal here". */
  terminal: () => <FbSvg><path d="M4 17l6-5-6-5M12 19h8" /></FbSvg>,
  folder: () => <FbSvg><path d="M3 6h6l2 2h10v11H3z" /></FbSvg>,
  file: () => <FbSvg><path d="M6 3h8l4 4v14H6z" /></FbSvg>
}

/** A symlink (or anything else) draws as a file, in the same --text-2 as every icon: no colour. */
const entryIcon = (type: RemoteEntry['type']) => (type === 'directory' ? <FbIcon.folder /> : <FbIcon.file />)

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
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  /** Directory a drag is currently hovering — the list itself (cwd), a folder row, or the parent. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const parent = cwd === '/' ? null : posixDirname(cwd)

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
    setCreatingFile(false)
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

  const doTouch = async () => {
    const name = newFileName.trim()
    if (!name) {
      setCreatingFile(false)
      return
    }
    // sftpWrite happily overwrites whatever's already there, and it doesn't know the
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
    const path = posixJoin(cwd, name)
    const res = await window.electronAPI.sftpWrite(hostId, path, '')
    setCreatingFile(false)
    setNewFileName('')
    if (res.ok) {
      await load()
      onOpenFile({ name, path, type: 'file', size: 0, mtime: Date.now() })
    } else {
      setError(res.error || 'Could not create file')
    }
  }

  const doUpload = async () => {
    const res = await window.electronAPI.sftpUpload(hostId, cwd)
    if (res.ok) {
      if (res.uploaded && res.uploaded.length > 0) load()
    } else {
      setError(res.error || 'Upload failed')
    }
  }

  // Files from the OS are uploaded into `dir`; a row dragged from this list is moved there.
  const dropInto = async (e: React.DragEvent, dir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const moved = e.dataTransfer.getData(ROW_DRAG_TYPE)
    if (moved) {
      // Dropping onto its own folder, onto itself, or into its own subtree is a no-op.
      if (posixDirname(moved) === dir || dir === moved || dir.startsWith(`${moved}/`)) return
      setBusyPath(moved)
      const res = await window.electronAPI.sftpRename(hostId, moved, posixJoin(dir, posixBasename(moved)))
      setBusyPath(null)
      if (res.ok) load()
      else setError(res.error || 'Move failed')
      return
    }
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.electronAPI.pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    setUploading(true)
    setError(null)
    const res = await window.electronAPI.sftpUpload(hostId, dir, paths)
    setUploading(false)
    if (!res.ok) setError(res.error || 'Upload failed')
    if (dir === cwd && res.uploaded && res.uploaded.length > 0) load()
  }

  const dragOver = (e: React.DragEvent, dir: string) => {
    const types = e.dataTransfer.types
    if (!types.includes('Files') && !types.includes(ROW_DRAG_TYPE)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = types.includes(ROW_DRAG_TYPE) ? 'move' : 'copy'
    if (dropTarget !== dir) setDropTarget(dir)
  }

  return (
    <div className="fb">
      <div className="fb-toolbar">
        <button
          type="button"
          className={`btn-ghost small fb-icon-btn ${parent && dropTarget === parent ? 'drop-target' : ''}`}
          onClick={() => parent && onNavigate(parent)}
          onDragOver={(e) => parent && dragOver(e, parent)}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => parent && dropInto(e, parent)}
          title="Up to parent"
          aria-label="Up to parent"
          disabled={!parent}
        >
          <FbIcon.up />
        </button>
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
        <button type="button" className="btn-ghost small fb-icon-btn" onClick={doUpload} title="Upload files into this folder" aria-label="Upload">
          <FbIcon.upload />
        </button>
        <span className="fb-path" title={cwd}>{cwd}</span>
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
      {uploading && <p className="fb-status">Uploading…</p>}

      <div
        className={`fb-list ${dropTarget === cwd ? 'drop-target' : ''}`}
        onDragOver={(e) => dragOver(e, cwd)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(e) => dropInto(e, cwd)}
      >
        {loading && entries.length === 0 && <p className="fb-empty">Loading…</p>}
        {!loading && entries.length === 0 && !error && <p className="fb-empty">Empty directory.</p>}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`fb-row ${busyPath === entry.path ? 'busy' : ''} ${dropTarget === entry.path ? 'drop-target' : ''} ${
              confirmDelete?.path === entry.path ? 'confirming' : ''
            }`}
            draggable={renaming?.path !== entry.path}
            onDragStart={(e) => {
              e.dataTransfer.setData(ROW_DRAG_TYPE, entry.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={entry.type === 'directory' ? (e) => dragOver(e, entry.path) : undefined}
            onDrop={entry.type === 'directory' ? (e) => dropInto(e, entry.path) : undefined}
          >
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
                  <span className="fb-row-icon">{entryIcon(entry.type)}</span>
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
                  <>
                    <span className="fb-row-meta">
                      {[entry.type === 'file' ? formatSize(entry.size) : '', formatDate(entry.mtime)].filter(Boolean).join(' · ')}
                    </span>
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
                      {entry.type === 'file' && (
                        <button
                          type="button"
                          className="fb-row-btn"
                          title="Download"
                          aria-label={`Download ${entry.name}`}
                          onClick={() => window.electronAPI.sftpDownload(hostId, entry.path)}
                        >
                          <FbIcon.download />
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
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
