import { useEffect, useState } from 'react'
import './FileEditor.css'

interface ReadResult {
  ok: boolean
  content?: string
  tooLarge?: boolean
  binary?: boolean
  error?: string
}

interface WriteResult {
  ok: boolean
  error?: string
}

interface Props {
  filePath: string
  onClose: () => void
  /** Read the file's content. Parametrized so this editor can open a file over SFTP
   *  (Remote Session) or local fs (WSL "Connect" LocalBrowser) — same modal either way. */
  read: (filePath: string) => Promise<ReadResult>
  write: (filePath: string, content: string) => Promise<WriteResult>
  /** Fallback for files too large/binary to edit in-app. Omitted where download isn't
   *  wired up yet (WSL v1 — see plan notes). */
  onDownload?: () => void
}

/** Simple modal editor for a remote/local file. Intentionally minimal — a plain monospace
 *  textarea, no syntax highlighting or heavy editor dependency. */
export default function FileEditor({ filePath, onClose, read, write, onDownload }: Props) {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  const [binary, setBinary] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setTooLarge(false)
    setBinary(false)
    read(filePath).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error || 'Failed to read file')
        return
      }
      if (res.tooLarge) {
        setTooLarge(true)
        return
      }
      if (res.binary) {
        setBinary(true)
        return
      }
      setContent(res.content ?? '')
      setOriginal(res.content ?? '')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  const dirty = content !== original
  const editable = !loading && !error && !tooLarge && !binary

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    const res = await write(filePath, content)
    setSaving(false)
    if (res.ok) setOriginal(content)
    else setError(res.error || 'Failed to save file')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide file-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="mono file-editor-title" title={filePath}>
            {filePath}
            {dirty && <span className="file-editor-dirty">•</span>}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body file-editor-body">
          {loading && <div className="view-empty small">Loading…</div>}
          {!loading && error && <div className="ssh-test err">{error}</div>}
          {!loading && !error && tooLarge && (
            <div className="file-editor-notice">
              <p>This file is too large to edit in-app.</p>
              {onDownload && (
                <button className="btn-ghost small" onClick={onDownload}>
                  Download instead
                </button>
              )}
            </div>
          )}
          {!loading && !error && binary && (
            <div className="file-editor-notice">
              <p>This looks like a binary file — it can&apos;t be shown as text.</p>
              {onDownload && (
                <button className="btn-ghost small" onClick={onDownload}>
                  Download instead
                </button>
              )}
            </div>
          )}
          {editable && (
            <textarea
              className="mono file-editor-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          {editable && (
            <button className="btn-primary" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
