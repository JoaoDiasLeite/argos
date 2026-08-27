import { useEffect, useRef, useState } from 'react'
import { LabelRegistry } from '../types'
import { useModalA11y } from '../hooks/useModalA11y'
import './LabelManager.css'

interface Props {
  onClose: () => void
  /** Called after any change that could have rewritten tags on disk. */
  onChanged: () => void
}

type Pending =
  | { kind: 'rename'; name: string }
  | { kind: 'merge'; name: string; suggested?: string; count?: number }
  | { kind: 'delete'; name: string; count: number }
  | null

export default function LabelManager({ onClose, onChanged }: Props) {
  const [reg, setReg] = useState<LabelRegistry>({ palette: [], labels: {} })
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<Pending>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [swatchFor, setSwatchFor] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  const names = Object.keys(reg.labels).sort((a, b) => a.localeCompare(b))

  const load = async () => {
    const r = await window.electronAPI.ccLabels()
    setReg(r)
    // Counts drive every destructive confirmation, so they are read from the same
    // sweep the verbs use rather than guessed from the loaded session list.
    const entries = await Promise.all(
      Object.keys(r.labels ?? {}).map(async (n) => [n, (await window.electronAPI.ccLabelUsage(n)).count] as const)
    )
    setCounts(Object.fromEntries(entries))
  }

  useEffect(() => {
    load()
  }, [])

  const after = async (msg: string) => {
    setNote(msg)
    setPending(null)
    setDraft('')
    await load()
    onChanged()
  }

  /** A partial sweep leaves the registry alone — say so instead of implying success. */
  const partial = (failed: number) =>
    `${failed} conversation${failed !== 1 ? 's' : ''} could not be read, so the label was kept.`

  const doRename = async (from: string, to: string) => {
    setBusy(true)
    const res = await window.electronAPI.ccLabelRename(from, to)
    setBusy(false)
    if (!res.ok) {
      // Renaming onto an existing name is a merge. Offer it rather than doing it:
      // merging silently loses a label nobody asked to lose.
      setPending({ kind: 'merge', name: from, suggested: res.target, count: res.count })
      setNote(`“${res.target}” already exists on ${res.count} conversation${res.count !== 1 ? 's' : ''}.`)
      return
    }
    await after(
      res.failed > 0
        ? partial(res.failed)
        : `Renamed on ${res.renamed} conversation${res.renamed !== 1 ? 's' : ''}.`
    )
  }

  const doMerge = async (from: string, into: string) => {
    setBusy(true)
    const res = await window.electronAPI.ccLabelMerge(from, into)
    setBusy(false)
    await after(
      res.failed > 0
        ? partial(res.failed)
        : `Merged into “${into}” on ${res.merged} conversation${res.merged !== 1 ? 's' : ''}.`
    )
  }

  const doDelete = async (name: string) => {
    setBusy(true)
    const res = await window.electronAPI.ccLabelDelete(name)
    setBusy(false)
    await after(
      res.failed > 0
        ? partial(res.failed)
        : `Removed from ${res.cleared} conversation${res.cleared !== 1 ? 's' : ''}.`
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal wide label-manager"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="label-manager-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="label-manager-title">Labels</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <p className="label-intro">
            A tag lives inside the conversation, so it stays there for the CLI too. Only the
            colour is stored here — losing it costs colours, not tags.
          </p>

          {names.length === 0 && (
            <div className="label-empty">No labels yet. Tag a conversation to start one.</div>
          )}

          <ul className="label-list">
            {names.map((name) => (
              <li key={name} className="label-row">
                <button
                  className="label-swatch"
                  style={{ background: reg.labels[name] }}
                  aria-label={`Change colour of ${name}`}
                  onClick={() => setSwatchFor(swatchFor === name ? null : name)}
                />
                <span className="label-name">{name}</span>
                <span className="label-count">
                  {counts[name] ?? '—'} conversation{counts[name] === 1 ? '' : 's'}
                </span>
                <span className="label-actions">
                  <button
                    className="icon-btn"
                    title="Rename"
                    aria-label={`Rename ${name}`}
                    onClick={() => {
                      setPending({ kind: 'rename', name })
                      setDraft(name)
                      setNote('')
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn"
                    title="Merge into another label"
                    aria-label={`Merge ${name}`}
                    onClick={() => {
                      setPending({ kind: 'merge', name })
                      setDraft('')
                      setNote('')
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 3v6a6 6 0 0 0 6 6h6" />
                      <polyline points="15 12 18 15 15 18" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Remove from every conversation"
                    aria-label={`Remove ${name} everywhere`}
                    onClick={() => {
                      setPending({ kind: 'delete', name, count: counts[name] ?? 0 })
                      setNote('')
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </span>

                {swatchFor === name && (
                  <div className="label-palette">
                    {reg.palette.map((c) => (
                      <button
                        key={c}
                        className="label-palette-dot"
                        style={{ background: c }}
                        aria-label={`Use ${c}`}
                        onClick={async () => {
                          await window.electronAPI.ccLabelSetColor(name, c)
                          setSwatchFor(null)
                          await load()
                          onChanged()
                        }}
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {pending?.kind === 'rename' && (
            <div className="label-prompt">
              <label htmlFor="label-rename-input">Rename “{pending.name}” to</label>
              <input
                id="label-rename-input"
                autoFocus
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim()) doRename(pending.name, draft.trim())
                }}
              />
              <div className="label-prompt-actions">
                <button className="btn-ghost" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  disabled={busy || !draft.trim()}
                  onClick={() => doRename(pending.name, draft.trim())}
                >
                  Rename
                </button>
              </div>
            </div>
          )}

          {pending?.kind === 'merge' && (
            <div className="label-prompt">
              <label htmlFor="label-merge-input">Merge “{pending.name}” into</label>
              <input
                id="label-merge-input"
                autoFocus
                list="label-merge-options"
                value={draft || pending.suggested || ''}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
              />
              <datalist id="label-merge-options">
                {names.filter((n) => n !== pending.name).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <p className="label-prompt-warn">
                “{pending.name}” disappears; the conversations carrying it keep the other label.
              </p>
              <div className="label-prompt-actions">
                <button className="btn-ghost" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  disabled={busy || !(draft || pending.suggested)}
                  onClick={() => doMerge(pending.name, (draft || pending.suggested || '').trim())}
                >
                  Merge
                </button>
              </div>
            </div>
          )}

          {pending?.kind === 'delete' && (
            <div className="label-prompt danger">
              <p>
                Remove “{pending.name}” from <b>{pending.count}</b> conversation
                {pending.count !== 1 ? 's' : ''}?
              </p>
              <p className="label-prompt-warn">
                The conversations themselves are untouched — only the tag goes.
              </p>
              <div className="label-prompt-actions">
                <button className="btn-ghost" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button className="btn-primary danger" disabled={busy} onClick={() => doDelete(pending.name)}>
                  Remove everywhere
                </button>
              </div>
            </div>
          )}

          {note && <div className="label-note">{note}</div>}
        </div>
      </div>
    </div>
  )
}
