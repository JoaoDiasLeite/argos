import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { OpsRunbookInfo, OpsScope } from '../types'
import {
  allRunbookPaths,
  looseOnly,
  readLastRunbook,
  readRunbookSources,
  type RunbookSources
} from '../lib/runbook-library'
import { samePath } from '../lib/builtin-runbook'
import { rich } from '../lib/t-rich'
import type { TFunction } from '../../../shared/i18n'
import { useT } from '../i18n'
// The fields and the dropdown are the start screen's (`ivs-`), so a runbook is picked the
// same way wherever it is picked.
import '../views/InterventionStart.css'

/**
 * The runbook field of the intervention start screen, shared with the workspace's "Hand
 * over to a runbook" dialog: the runbooks folder of Settings and the loose runbooks,
 * rescanned and re-read on mount, in one dropdown with "Choose runbooks folder…" and
 * "Choose a runbook…" under them. `useRunbookPicker` holds the state, `RunbookField`
 * draws it.
 */

export type InfoState = OpsRunbookInfo | 'loading'

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// ── Icons ────────────────────────────────────────────────────────────────────

const Chevron = () => (
  <svg className="ivs-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)
const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)
const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

// ── Dropdown ─────────────────────────────────────────────────────────────────

export type DropItem =
  | { kind: 'option'; key: string; content: ReactNode; selected?: boolean; onSelect: () => void }
  | { kind: 'divider'; key: string }
  | { kind: 'note'; key: string; content: ReactNode }
  /** A group title: not an option, so the arrow keys pass over it. */
  | { kind: 'header'; key: string; content: ReactNode }

/**
 * A field-shaped trigger over a listbox, so options can carry a status dot or a chip that
 * a native select cannot draw. Arrow keys move, Enter picks, Escape or a click outside
 * closes. Headers and notes are not options: the keys skip them.
 */
export function IvsDropdown({
  labelledBy,
  trigger,
  items,
  invalid
}: {
  labelledBy: string
  trigger: ReactNode
  items: DropItem[]
  invalid?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const options = items.flatMap((it, i) => (it.kind === 'option' ? [i] : []))

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  const openList = () => {
    const sel = items.findIndex((it) => it.kind === 'option' && it.selected)
    setActive(sel >= 0 ? sel : (options[0] ?? -1))
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const pick = (i: number) => {
    const it = items[i]
    if (it?.kind !== 'option') return
    close()
    it.onSelect()
  }

  const onListKey = (e: ReactKeyboardEvent) => {
    const pos = options.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(options[Math.min(options.length - 1, pos + 1)] ?? active)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(options[Math.max(0, pos - 1)] ?? active)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(options[0] ?? active)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options[options.length - 1] ?? active)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      // Escape closes the list, not the dialog the field may sit in.
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className="ivs-dd" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`ivs-control ivs-dd-trigger${open ? ' open' : ''}${invalid ? ' invalid' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openList()
          }
        }}
      >
        {trigger}
        <span className="ivs-flex" />
        <Chevron />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className="ivs-dd-list"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onKeyDown={onListKey}
        >
          {items.map((it, i) =>
            it.kind === 'divider' ? (
              <div key={it.key} className="ivs-dd-divider" role="separator" />
            ) : it.kind === 'note' ? (
              <div key={it.key} className="ivs-dd-note">
                {it.content}
              </div>
            ) : it.kind === 'header' ? (
              <div key={it.key} className="ivs-dd-header" role="presentation">
                {it.content}
              </div>
            ) : (
              <div
                key={it.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={!!it.selected}
                className={`ivs-dd-option${i === active ? ' active' : ''}${it.selected ? ' selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                {it.content}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

// ── Host check ───────────────────────────────────────────────────────────────

/**
 * Why `info` cannot run `scope`, or null when it can (or there is nothing to say yet): an
 * open scope needs a runbook naming some host, a locked one a runbook that has that host
 * in a group. `hostName`: the stored host's name, for the message.
 */
export function runbookHostProblem(
  info: OpsRunbookInfo | undefined,
  scope: OpsScope | null,
  hostName: string | undefined,
  t: TFunction
): string | null {
  if (!info?.ok || !scope) return null
  if (scope.kind === 'open') return info.hosts.length === 0 ? t('ops.start.noHosts') : null
  const known = info.hosts.find((h) => h.id === scope.hostId)
  if (known && known.groups.length > 0) return null
  return t('ops.start.unknownToRunbook', { name: hostName ?? known?.name ?? t('ops.start.thisServer') })
}

// ── State ────────────────────────────────────────────────────────────────────

export interface RunbookPickerState {
  /** The runbooks folder and the loose runbooks; null until the first scan has answered. */
  sources: RunbookSources | null
  scanning: boolean
  /** A refused change to the runbook sources (setOpsPrefs). */
  sourcesError: string | null
  /** Every listed runbook folder, the library first. */
  listed: string[]
  /** The loose runbooks not also in the library. */
  loose: string[]
  infos: Record<string, InfoState>
  /** The choice. Never the built-in runbook through a list, though "Choose a runbook…" can pick any folder. */
  runbookPath: string | null
  /** The built-in runbook's folder, left out of the lists. */
  builtin: string | null
  loadRunbook: (dir: string) => Promise<OpsRunbookInfo>
  refreshSources: () => Promise<RunbookSources>
  pick: (dir: string) => void
  chooseLibrary: () => Promise<void>
  chooseOne: () => Promise<void>
  forget: (dir: string) => Promise<void>
}

/**
 * The runbook sources, their loaded infos and the choice. While `active`, once every
 * listed runbook has loaded, the default is the last one used if it is still listed and
 * knows `hostId`, else the first usable one that knows it; with no host, or none that
 * knows it, the last used, else the first usable. A pick by the operator ends the defaulting.
 */
export function useRunbookPicker({
  active,
  hostId,
  builtin
}: {
  active: boolean
  hostId?: string
  builtin: string | null
}): RunbookPickerState {
  const [sources, setSources] = useState<RunbookSources | null>(null)
  const [scanning, setScanning] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const listed = useMemo(
    () => (sources ? allRunbookPaths(sources).filter((d) => !samePath(d, builtin)) : []),
    [sources, builtin]
  )
  const loose = useMemo(() => (sources ? looseOnly(sources).filter((d) => !samePath(d, builtin)) : []), [sources, builtin])
  const [infos, setInfos] = useState<Record<string, InfoState>>({})
  const [runbookPath, setRunbookPath] = useState<string | null>(null)
  /** Once the operator picks a runbook, the automatic default stops second-guessing it. */
  const chosen = useRef(false)

  const loadRunbook = useCallback((dir: string): Promise<OpsRunbookInfo> => {
    setInfos((prev) => ({ ...prev, [dir]: 'loading' }))
    return window.electronAPI
      .opsLoadRunbook(dir)
      .catch((e): OpsRunbookInfo => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((info) => {
        setInfos((prev) => ({ ...prev, [dir]: info }))
        return info
      })
  }, [])

  /** Rescan the runbooks folder and re-read every runbook listed. */
  const refreshSources = useCallback(async (): Promise<RunbookSources> => {
    setScanning(true)
    let next: RunbookSources
    try {
      next = await readRunbookSources()
    } catch (e) {
      next = { dir: null, library: [], libraryError: e instanceof Error ? e.message : String(e), loose: [] }
    }
    setSources(next)
    setScanning(false)
    for (const dir of allRunbookPaths(next)) void loadRunbook(dir)
    return next
  }, [loadRunbook])

  useEffect(() => {
    void refreshSources()
  }, [refreshSources])

  useEffect(() => {
    if (!active || chosen.current || runbookPath || listed.length === 0) return
    if (listed.some((d) => !infos[d] || infos[d] === 'loading')) return
    const usable = listed.filter((d) => {
      const i = infos[d]
      return i && i !== 'loading' && i.ok
    })
    const knows = (d: string) => {
      const i = infos[d]
      return !!hostId && !!i && i !== 'loading' && i.ok && i.hosts.some((h) => h.id === hostId)
    }
    const lastUsed = readLastRunbook()
    const last = lastUsed ? usable.find((d) => samePath(d, lastUsed)) : undefined
    const pick = (last && knows(last) ? last : undefined) ?? usable.find(knows) ?? last ?? usable[0]
    if (pick) setRunbookPath(pick)
  }, [active, hostId, infos, listed, runbookPath])

  /** Stores the loose runbooks; the list shown follows what main kept. */
  const saveLoose = async (folders: string[]): Promise<boolean> => {
    setSourcesError(null)
    try {
      const r = await window.electronAPI.setOpsPrefs({ runbookFolders: folders })
      if (!r.ok) {
        setSourcesError(r.error)
        return false
      }
      setSources((prev) => prev && { ...prev, loose: r.ops.runbookFolders ?? [] })
      return true
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  const pick = (dir: string) => {
    chosen.current = true
    setRunbookPath(dir)
    void loadRunbook(dir)
  }

  /** "Choose runbooks folder…": every subfolder of it that looks like a runbook is listed. */
  const chooseLibrary = async () => {
    const dir = await window.electronAPI.openFolder(sources?.dir ?? undefined)
    if (!dir) return
    setSourcesError(null)
    try {
      const r = await window.electronAPI.setOpsPrefs({ runbooksDir: dir })
      if (!r.ok) {
        setSourcesError(r.error)
        return
      }
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e))
      return
    }
    // A default picked from the old folder makes way for one from the new.
    if (!chosen.current) setRunbookPath(null)
    await refreshSources()
  }

  /** "Choose a runbook…": one folder, kept as a loose runbook unless the library has it. */
  const chooseOne = async () => {
    const dir = await window.electronAPI.openFolder()
    if (!dir) return
    chosen.current = true
    setRunbookPath(dir)
    const res = await loadRunbook(dir)
    if (!res.ok || samePath(dir, builtin) || !sources) return
    if (sources.loose.some((p) => samePath(p, dir)) || sources.library.some((e) => samePath(e.path, dir))) return
    await saveLoose([...sources.loose, dir])
  }

  const forget = async (dir: string) => {
    if (!sources) return
    if (!(await saveLoose(sources.loose.filter((p) => !samePath(p, dir))))) return
    if (runbookPath === dir) {
      chosen.current = true
      setRunbookPath(null)
    }
  }

  return {
    sources,
    scanning,
    sourcesError,
    listed,
    loose,
    infos,
    runbookPath,
    builtin,
    loadRunbook,
    refreshSources,
    pick,
    chooseLibrary,
    chooseOne,
    forget
  }
}

// ── The field ────────────────────────────────────────────────────────────────

/**
 * The runbook dropdown with its errors under it: a refused change to the sources, the
 * chosen folder not being a usable runbook (with Forget for a loose one), and what a
 * runbook is when there are none yet.
 */
export function RunbookField({ picker, labelledBy }: { picker: RunbookPickerState; labelledBy: string }) {
  const t = useT()
  const { sources, scanning, sourcesError, listed, loose, infos, runbookPath, refreshSources, pick, chooseLibrary, chooseOne, forget } = picker
  const chosenInfo = runbookPath ? infos[runbookPath] : undefined
  const loaded = chosenInfo && chosenInfo !== 'loading' ? chosenInfo : undefined

  const runbookRow = (dir: string, withPath: boolean, onForget?: () => void) => {
    const i = infos[dir]
    const name = i && i !== 'loading' && i.ok ? i.name : baseName(dir)
    let chip: ReactNode = null
    if (!i || i === 'loading') chip = <span className="ivs-meta">{t('common.loading')}</span>
    else if (!i.ok) chip = <span className="ivs-chip bad">{t('ops.start.unusable')}</span>
    else {
      const s = i.summary
      if (s) chip = <span className={`ivs-chip${s.mutates > 0 ? ' warn' : ''}`}>{s.mutates === 0 ? t('ops.start.readOnly') : t('ops.start.changesServer')}</span>
    }
    return (
      <>
        <span className="ivs-value">{name}</span>
        {chip}
        {withPath && (
          <span className="ivs-meta ivs-path" title={dir}>
            {dir}
          </span>
        )}
        {onForget && (
          <button
            type="button"
            className="ivs-dd-forget"
            tabIndex={-1}
            title={t('ops.start.forgetRunbook', { name })}
            aria-label={t('ops.start.forgetRunbook', { name })}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onForget()
            }}
          >
            <CloseIcon />
          </button>
        )}
      </>
    )
  }
  const runbookOption = (dir: string, isLoose: boolean): DropItem => ({
    kind: 'option',
    key: dir,
    selected: runbookPath === dir,
    content: runbookRow(dir, isLoose, isLoose ? () => void forget(dir) : undefined),
    onSelect: () => pick(dir)
  })
  const actionOption = (key: string, label: string, meta: string, onSelect: () => void): DropItem => ({
    kind: 'option',
    key,
    content: (
      <>
        <span className="ivs-option-icon">
          <FolderIcon />
        </span>
        <span className="ivs-value">{label}</span>
        <span className="ivs-meta ivs-dd-action-meta">{meta}</span>
      </>
    ),
    onSelect
  })
  const library = sources ? sources.library.filter((e) => listed.some((d) => samePath(d, e.path))) : []
  const libraryItems: DropItem[] = sources?.dir
    ? [
        {
          kind: 'header',
          key: 'library',
          content: (
            <>
              <span className="ivs-dd-header-label">{t('ops.start.libraryHeader')}</span>
              <span aria-hidden="true">·</span>
              <span className="ivs-mono ivs-dd-header-path" title={sources.dir}>
                {sources.dir}
              </span>
              {!sources.libraryError && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{library.length}</span>
                </>
              )}
              <button
                type="button"
                className="ivs-dd-refresh"
                tabIndex={-1}
                disabled={scanning}
                title={t('ops.start.refreshLibrary')}
                aria-label={t('ops.start.refreshLibrary')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void refreshSources()}
              >
                <RefreshIcon />
              </button>
            </>
          )
        },
        ...(sources.libraryError
          ? [{ kind: 'note' as const, key: 'library-error', content: <span className="ivs-error">{sources.libraryError}</span> }]
          : library.length === 0
            ? [{ kind: 'note' as const, key: 'library-empty', content: t('ops.start.libraryEmpty') }]
            : library.map((e) => runbookOption(e.path, false)))
      ]
    : []
  const looseItems: DropItem[] =
    loose.length > 0
      ? [
          { kind: 'header', key: 'loose', content: <span className="ivs-dd-header-label">{t('ops.start.looseHeader')}</span> },
          ...loose.map((dir) => runbookOption(dir, true))
        ]
      : []
  const items: DropItem[] = [
    ...libraryItems,
    ...looseItems,
    ...(libraryItems.length + looseItems.length > 0 ? [{ kind: 'divider' as const, key: 'div' }] : []),
    actionOption('choose-library', t('ops.start.chooseLibrary'), t('ops.start.chooseLibraryMeta'), () => void chooseLibrary()),
    actionOption('choose-one', t('ops.start.chooseOne'), t('ops.start.chooseOneMeta'), () => void chooseOne())
  ]

  return (
    <>
      <IvsDropdown
        labelledBy={labelledBy}
        trigger={runbookPath ? runbookRow(runbookPath, false) : <span className="ivs-placeholder">{t('ops.start.chooseRunbook')}</span>}
        items={items}
        invalid={!!loaded && !loaded.ok}
      />
      {sourcesError && (
        <span className="ivs-error" role="alert">
          {sourcesError}
        </span>
      )}
      {loaded && !loaded.ok && runbookPath && (
        <div className="ivs-error-block" role="alert">
          <div>
            <strong>{t('ops.start.notUsable')}</strong> {loaded.error}
          </div>
          {loaded.errors && loaded.errors.length > 0 && (
            <ul>
              {loaded.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <div className="ivs-error-actions">
            <span className="ivs-mono">{runbookPath}</span>
            {loose.includes(runbookPath) && (
              <button type="button" className="ivs-link" onClick={() => void forget(runbookPath)}>
                {t('ops.start.forget')}
              </button>
            )}
          </div>
        </div>
      )}
      {listed.length === 0 && !runbookPath && (
        <span className="ivs-help">
          {rich(t('ops.start.runbookExplainer'), {
            runbook: <span className="ivs-mono">RUNBOOK.md</span>,
            policy: <span className="ivs-mono">policy.json</span>
          })}
        </span>
      )}
    </>
  )
}
