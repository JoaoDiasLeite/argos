import { useEffect, useState } from 'react'
import { LabelRegistry } from '../types'
import Sheet from './Sheet'
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

  const open = (next: Pending, value = '') => {
    setPending(next)
    setDraft(value)
    setNote('')
  }

  /** The inline form for the label it acts on, under that label's row. */
  const form = (name: string) => {
    if (!pending || pending.name !== name) return null
    if (pending.kind === 'rename') {
      return (
        <div className="lm-form">
          <input
            className="text-input"
            aria-label={`New name for ${name}`}
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) doRename(name, draft.trim())
            }}
          />
          <div className="lm-form-actions">
            <button type="button" className="btn-ghost small" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary small"
              disabled={busy || !draft.trim()}
              onClick={() => doRename(name, draft.trim())}
            >
              Rename
            </button>
          </div>
        </div>
      )
    }
    if (pending.kind === 'merge') {
      const into = (draft || pending.suggested || '').trim()
      return (
        <div className="lm-form">
          <input
            className="text-input"
            aria-label={`Merge ${name} into`}
            placeholder="Merge into"
            autoFocus
            list="lm-merge-options"
            value={draft || pending.suggested || ''}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && into) doMerge(name, into)
            }}
          />
          <datalist id="lm-merge-options">
            {names
              .filter((n) => n !== name)
              .map((n) => (
                <option key={n} value={n} />
              ))}
          </datalist>
          <p className="help">“{name}” disappears; the conversations carrying it keep the other label.</p>
          <div className="lm-form-actions">
            <button type="button" className="btn-ghost small" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary small" disabled={busy || !into} onClick={() => doMerge(name, into)}>
              Merge
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="lm-form">
        <p className="lm-confirm">
          Remove “{name}” from {pending.count} conversation{pending.count !== 1 ? 's' : ''}?
        </p>
        <p className="help">The conversations themselves are untouched; only the tag goes.</p>
        <div className="lm-form-actions">
          <button type="button" className="btn-ghost small" onClick={() => setPending(null)}>
            Keep
          </button>
          <button type="button" className="btn-primary small danger" disabled={busy} onClick={() => doDelete(name)}>
            Remove everywhere
          </button>
        </div>
      </div>
    )
  }

  return (
    <Sheet
      title="Labels"
      width={520}
      onClose={onClose}
      footer={
        <button type="button" className="btn-ghost" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="lm-body">
        <p className="help">
          A tag lives inside the conversation, so the CLI sees it too. Only the colour is stored here: losing it
          costs colours, not tags.
        </p>

        {note && <p className="lm-note">{note}</p>}

        {names.length === 0 && <p className="lm-empty">No labels yet. Tag a conversation to start one.</p>}

        <ul className="lm-list">
          {names.map((name) => (
            <li key={name} className="lm-item">
              <div className={`lm-row ${pending?.name === name || swatchFor === name ? 'open' : ''}`}>
                <button
                  type="button"
                  className="lm-dot"
                  style={{ background: reg.labels[name] }}
                  aria-label={`Change colour of ${name}`}
                  aria-expanded={swatchFor === name}
                  onClick={() => setSwatchFor(swatchFor === name ? null : name)}
                />
                <span className="lm-name">{name}</span>
                <span className="lm-count">
                  {counts[name] ?? '…'} conversation{counts[name] === 1 ? '' : 's'}
                </span>
                <span className="lm-actions">
                  <button
                    type="button"
                    className="lm-icon"
                    title="Rename"
                    aria-label={`Rename ${name}`}
                    onClick={() => open({ kind: 'rename', name }, name)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="lm-icon"
                    title="Merge into another label"
                    aria-label={`Merge ${name} into another label`}
                    onClick={() => open({ kind: 'merge', name })}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 3v6a6 6 0 0 0 6 6h6" />
                      <path d="M15 12l3 3-3 3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="lm-icon danger"
                    title="Remove from every conversation"
                    aria-label={`Remove ${name} everywhere`}
                    onClick={() => open({ kind: 'delete', name, count: counts[name] ?? 0 })}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </span>
              </div>

              {swatchFor === name && (
                <div className="lm-palette">
                  {reg.palette.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`lm-swatch ${reg.labels[name] === c ? 'on' : ''}`}
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

              {form(name)}
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  )
}
