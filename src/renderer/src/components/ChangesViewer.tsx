import { useEffect, useRef, useState } from 'react'
import type { GitFile, GitFileDiff } from '../types'
import type { HomeRepo } from '../views/HomeView'
import DiffView from './DiffView'
import { useModalA11y } from '../hooks/useModalA11y'
import { backdropClose } from '../lib/backdrop-close'
import { useT } from '../i18n'
import { plural } from '../../../shared/i18n'
import './ChangesViewer.css'

/** The one letter a changed file is summed up by. Untracked reads as "?", and the index
 *  side wins over the worktree side since a staged add/delete/rename says more than the
 *  "M" an unstaged edit on top of it would. */
export function statusLetter(f: GitFile): 'M' | 'A' | 'D' | 'R' | '?' {
  if (f.untracked) return '?'
  for (const c of [f.index, f.worktree]) {
    if (c === 'A') return 'A'
    if (c === 'D') return 'D'
    if (c === 'R' || c === 'C') return 'R'
  }
  return 'M'
}

const LETTER_CLASS: Record<ReturnType<typeof statusLetter>, string> = {
  M: 'mod',
  A: 'add',
  D: 'del',
  R: 'ren',
  '?': 'new'
}

/** One file as Home's expanded row and the viewer's list both show it. */
export function ChangeFileRow({
  file,
  selected,
  onSelect
}: {
  file: GitFile
  selected?: boolean
  onSelect?: () => void
}) {
  const t = useT()
  const letter = statusLetter(file)
  const body = (
    <>
      <span className={`changes-letter ${LETTER_CLASS[letter]}`} aria-hidden="true">
        {letter}
      </span>
      <span className="changes-path" title={file.path}>
        {file.path}
      </span>
      {file.binary ? (
        <span className="changes-count">{t('home.repos.binary')}</span>
      ) : (
        file.added !== undefined && (
          <span className="changes-count">
            <span className="plus">+{file.added}</span> <span className="minus">−{file.deleted ?? 0}</span>
          </span>
        )
      )}
    </>
  )
  if (!onSelect) return <div className="changes-file">{body}</div>
  return (
    <button
      type="button"
      className={`changes-file selectable${selected ? ' selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      {body}
    </button>
  )
}

export function changeTotals(files: GitFile[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const f of files) {
    added += f.added ?? 0
    deleted += f.deleted ?? 0
  }
  return { added, deleted }
}

type DiffEntry = { diff?: GitFileDiff; error?: boolean }

interface Props {
  mode: 'modal' | 'panel'
  repo: HomeRepo
  cwd: string
  onClose: () => void
  onOpenRepo: (key: string) => void
}

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

/**
 * A repo's uncommitted changes, file by file, as a modal (comfortable density) or as a
 * panel over Home's main column (compact). The two share the list and the diff pane and
 * differ only in their frame. Each file's diff is fetched the first time it is selected
 * and kept for as long as the viewer is open: a repo with many changes should not pay
 * for every file up front.
 */
export default function ChangesViewer({ mode, repo, cwd, onClose, onOpenRepo }: Props) {
  const t = useT()
  const files = repo.files ?? []
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null)
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({})
  const [copied, setCopied] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useModalA11y(dialogRef, onClose, { enabled: mode === 'modal' })

  // The panel is not a modal (Home stays usable beside it), so it gets Escape without
  // the focus trap.
  useEffect(() => {
    if (mode !== 'panel') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, onClose])

  useEffect(() => {
    if (!selected || diffs[selected]) return
    let cancelled = false
    window.electronAPI
      .gitFileDiff(cwd, selected)
      .then((diff) => {
        if (!cancelled) setDiffs((prev) => ({ ...prev, [selected]: { diff } }))
      })
      .catch(() => {
        if (!cancelled) setDiffs((prev) => ({ ...prev, [selected]: { error: true } }))
      })
    return () => {
      cancelled = true
    }
  }, [cwd, selected, diffs])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  const totals = changeTotals(files)
  const entry = selected ? diffs[selected] : undefined
  const patch = entry?.diff?.patch ?? ''

  const copyDiff = () => {
    if (!patch) return
    navigator.clipboard.writeText(patch).then(
      () => setCopied(true),
      () => {}
    )
  }

  const totalsEl = (
    <span className="changes-totals">
      <span className="plus">+{totals.added}</span> <span className="minus">−{totals.deleted}</span>
    </span>
  )

  const closeBtn = (
    <button className="icon-btn changes-close" onClick={onClose} aria-label={t('home.changes.close')}>
      <CloseIcon />
    </button>
  )

  const list = (
    <div className="changes-list">
      {files.map((f) => (
        <ChangeFileRow key={f.path} file={f} selected={f.path === selected} onSelect={() => setSelected(f.path)} />
      ))}
    </div>
  )

  let diffBody
  if (!selected) diffBody = null
  else if (!entry) diffBody = <div className="changes-note">{t('home.changes.loading')}</div>
  else if (entry.error || !entry.diff)
    diffBody = (
      <div className="changes-note error" role="alert">
        {t('home.changes.loadError')}
      </div>
    )
  else if (entry.diff.tooLarge) diffBody = <div className="changes-note">{t('home.changes.tooLarge')}</div>
  else if (entry.diff.binary) diffBody = <div className="changes-note">{t('home.changes.binaryFile')}</div>
  else diffBody = <DiffView oldText={entry.diff.oldText} newText={entry.diff.newText} filePath={selected} fill />

  const diffPane = (
    <div className="changes-diff-pane">
      {selected && <div className="changes-strip">{selected}</div>}
      <div className="changes-diff">{diffBody}</div>
    </div>
  )

  const openTerminal = (label: string) => (
    <button className="btn-ghost small" onClick={() => onOpenRepo(repo.key)}>
      {label}
    </button>
  )

  if (mode === 'panel') {
    return (
      <aside className="changes-panel" aria-label={`${t('home.changes.title')} · ${repo.name}`}>
        <header className="changes-panel-head">
          <div className="changes-panel-id">
            <span className="changes-repo">{repo.name}</span>
            {repo.branch && <span className="changes-branch">{repo.branch}</span>}
            <span className="changes-sub">{plural(t, 'home.repos.files', files.length)}</span>
            {totalsEl}
          </div>
          {closeBtn}
        </header>
        <div className="changes-panel-list">{list}</div>
        {diffPane}
        <footer className="changes-foot">{openTerminal(t('home.repos.openTerminal'))}</footer>
      </aside>
    )
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('home.changes.title')} · ${repo.name}`}
      {...backdropClose(onClose)}
    >
      <div className="modal changes-modal" ref={dialogRef}>
        <div className="modal-header changes-modal-head">
          <h3>
            {t('home.changes.title')} · {repo.name}
            {repo.branch && <span className="changes-branch">{repo.branch}</span>}
          </h3>
          <span className="changes-grow" />
          {totalsEl}
          {closeBtn}
        </div>
        <div className="changes-modal-body">
          <div className="changes-modal-side">
            <div className="eyebrow changes-eyebrow">{t('home.changes.files', { n: files.length })}</div>
            {list}
          </div>
          {diffPane}
        </div>
        <div className="changes-foot">
          {openTerminal(t('home.changes.openTerminal'))}
          <button className="btn-ghost small" onClick={copyDiff} disabled={!patch}>
            {copied ? t('home.changes.copied') : t('home.changes.copyDiff')}
          </button>
        </div>
      </div>
    </div>
  )
}
