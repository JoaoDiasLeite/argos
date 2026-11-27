import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ContainerAction,
  ContainerStatsRow,
  ContainerTabMode,
  RemoteContainerList,
  RemoteContainerRow,
  RemoteContainerTarget
} from '../types'
import { groupContainers, readStatus, statsLine, statsTone } from '../lib/container-groups'
import { useT } from '../i18n'
import { plural } from '../../../shared/i18n'
import { useLabs } from '../hooks/useLabs'
import Menu from './Menu'
import './ContainersPanel.css'

/** Whose containers: a remote host's (over its SSH connection) or this computer's. */
export type ContainerSource = { kind: 'host'; hostId: string } | { kind: 'local' }

interface Props {
  source: ContainerSource
  /** The listing can run: a host's SSH connection is up (always true for this computer). */
  ready: boolean
  /** In a remote session: the pane's Files / History / Containers switch, drawn at the start
   *  of the pane's bar. Without it the panel is a section of the Servers screen, with its
   *  own heading. */
  barSlot?: ReactNode
  /** The Servers screen's filter text. */
  query?: string
  /** Opens a tab on that container: a shell inside it, or its logs. */
  onOpen: (container: RemoteContainerTarget, name: string, mode: ContainerTabMode) => void
  /** After each listing: whether a runtime answered or is installed, and how many
   *  containers it has. The Servers screen hides the section and its filter without one. */
  onState?: (state: { runtime: boolean; count: number }) => void
  /** The host's name, for the confirmation of a stop or restart. Absent for this computer. */
  serverName?: string
  /** The host is marked production: every action asks, in red. */
  production?: boolean
}

/** Compose project names as compose allows them; main checks the same. A project listed
 *  under another name gets no project actions. */
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/
const isComposeProject = (p: string) => p.length <= 64 && COMPOSE_PROJECT_RE.test(p)

/** An action waiting on its confirmation popover: on one container, or a whole project. */
interface PendingConfirm {
  key: string
  kind: 'container' | 'project'
  target: string
  name: string
  action: ContainerAction
  count: number
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`ctr-chevron${open ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

// Two stacked layers: a compose project.
const StackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
)

// `>_`: a shell inside the container.
const ShellIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3" />
    <path d="M13 15h4" />
  </svg>
)

// Play: start.
const StartIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
)

// A square: stop.
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
  </svg>
)

// A circular arrow: restart.
const RestartIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v5h-5" />
  </svg>
)

// Three dots: the project's menu.
const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </svg>
)

const Spinner = ({ title }: { title: string }) => (
  <span className="ctr-busy" role="status" title={title} aria-label={title}>
    <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
    </svg>
  </span>
)

/**
 * The small confirmation by the button that asked for it: what will happen and where, with
 * Cancel and the action. Red, with the PRODUCTION pill, on a production host. Esc or a click
 * outside cancels.
 */
function ConfirmPop({
  text,
  label,
  production,
  onConfirm,
  onCancel
}: {
  text: string
  label: string
  production: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onCancel])
  return (
    <div ref={ref} className={`ctr-confirm${production ? ' prod' : ''}`} role="alertdialog" aria-label={text}>
      {production && (
        <span className="prod-pill" title={t('remote.prod.title')}>
          {t('remote.prod.pill')}
        </span>
      )}
      <p className="ctr-confirm-text">{text}</p>
      <div className="ctr-confirm-btns">
        <button type="button" className="btn-ghost small" onClick={onCancel}>
          {t('remote.containers.cancel')}
        </button>
        <button type="button" className={`btn-primary small${production ? ' danger' : ''}`} autoFocus onClick={onConfirm}>
          {label}
        </button>
      </div>
    </div>
  )
}

// A page with lines: the container's logs.
const LogsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h6" />
  </svg>
)

/**
 * The containers of a remote host (the Remote Session's Containers pane) or of this computer
 * (a section of the Servers screen), laid out like Docker Desktop: one collapsible group per
 * compose project, with its running count, then the containers outside any project. Listed
 * when shown and on Refresh, no polling. Each row ends in a small toolbar of icon buttons:
 * a running one opens a shell in a tab of its own, and (experimental) any one opens its logs.
 * The commands are built in main from the validated id only.
 */
export default function ContainersPanel({ source, ready, barSlot, query, onOpen, onState, serverName, production = false }: Props) {
  const t = useT()
  const labs = useLabs()
  const [result, setResult] = useState<RemoteContainerList | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningOnly, setRunningOnly] = useState(false)
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  // Experimental: the running rows' CPU and memory, by id; the action in flight and the
  // last failure, by `c:<id>` or `p:<project>`, kept apart from the listing so they outlive
  // the refresh that follows an action; and the confirmation that is open, if any.
  const [stats, setStats] = useState<Record<string, ContainerStatsRow>>({})
  const [busy, setBusy] = useState<Record<string, ContainerAction>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const reqRef = useRef(0)
  const sourceKey = source.kind === 'host' ? `host:${source.hostId}` : 'local'
  const sourceArg = source.kind === 'host' ? source.hostId : null
  const isPane = barSlot !== undefined

  const load = useCallback((): Promise<void> => {
    const req = ++reqRef.current
    setLoading(true)
    const call = source.kind === 'host' ? window.electronAPI.remoteContainers(source.hostId) : window.electronAPI.localContainers()
    return call.then(
      (res) => {
        if (req !== reqRef.current) return
        setResult(res)
        setLoading(false)
        // The figures come after the list, which does not wait for them: `stats
        // --no-stream` takes a moment. A failure is quiet, the rows just show none.
        if (labs && res.ok && res.containers?.some((c) => c.running)) {
          window.electronAPI.containerStats(sourceArg).then(
            (st) => {
              if (req === reqRef.current) setStats(st.ok ? st.stats : {})
            },
            () => {
              if (req === reqRef.current) setStats({})
            }
          )
        } else setStats({})
      },
      (e: unknown) => {
        if (req !== reqRef.current) return
        setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
        setLoading(false)
      }
    )
  }, [sourceKey, labs])

  useEffect(() => {
    if (ready) load()
    return () => {
      // A reply for a host or mount we left behind is dropped.
      reqRef.current++
    }
  }, [ready, load])

  const containers = useMemo(() => (result?.ok ? (result.containers ?? []) : []), [result])
  const runningCount = containers.filter((c) => c.running).length
  const stoppedCount = containers.length - runningCount
  const grouped = useMemo(() => groupContainers(containers, { runningOnly, query }), [containers, runningOnly, query])
  const nothingShown = grouped.groups.length === 0 && grouped.loose.length === 0
  const runtime = result?.runtime ?? null

  useEffect(() => {
    if (result) onState?.({ runtime: runtime !== null, count: containers.length })
  }, [result])

  const where = serverName ? t('remote.containers.whereHost', { server: serverName }) : t('remote.containers.whereLocal')
  const actionLabel = (a: ContainerAction) =>
    t(a === 'start' ? 'remote.containers.start' : a === 'stop' ? 'remote.containers.stop' : 'remote.containers.restart')
  const projectLabel = (a: ContainerAction) =>
    t(a === 'start' ? 'remote.containers.startProject' : a === 'stop' ? 'remote.containers.stopProject' : 'remote.containers.restartProject')
  const confirmText = (p: PendingConfirm) =>
    p.kind === 'container'
      ? t(
          p.action === 'start'
            ? 'remote.containers.confirmStart'
            : p.action === 'stop'
              ? 'remote.containers.confirmStop'
              : 'remote.containers.confirmRestart',
          { name: p.name, where }
        )
      : plural(
          t,
          p.action === 'start'
            ? 'remote.containers.confirmProjectStart'
            : p.action === 'stop'
              ? 'remote.containers.confirmProjectStop'
              : 'remote.containers.confirmProjectRestart',
          p.count,
          { name: p.name, where }
        )

  const without = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
    const next = { ...rec }
    delete next[key]
    return next
  }

  const run = (p: PendingConfirm) => {
    setConfirm(null)
    setBusy((b) => ({ ...b, [p.key]: p.action }))
    setNotes((n) => without(n, p.key))
    const call =
      p.kind === 'container'
        ? window.electronAPI.containerAction(sourceArg, p.target, p.action)
        : window.electronAPI.composeAction(sourceArg, p.target, p.action)
    call
      .then(
        (res) => (res.ok ? null : res.error),
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      )
      .then((error) => {
        if (error) setNotes((n) => ({ ...n, [p.key]: error }))
        // The spinner stays until the new listing is in, so the row never shows its old
        // state with live buttons in between.
        return load()
      })
      .finally(() => setBusy((b) => without(b, p.key)))
  }

  /** Stop and restart always ask; start only on a production host. */
  const ask = (p: PendingConfirm) => {
    if (p.action === 'start' && !production) run(p)
    else setConfirm(p)
  }
  const cancelConfirm = useCallback(() => setConfirm(null), [])

  const noteFor = (key: string) =>
    notes[key] ? (
      <div className="ctr-note" role="alert">
        <span className="ctr-note-text">{notes[key]}</span>
        <button
          type="button"
          className="ctr-note-close"
          title={t('remote.containers.dismissNote')}
          aria-label={t('remote.containers.dismissNote')}
          onClick={() => setNotes((n) => without(n, key))}
        >
          ×
        </button>
      </div>
    ) : null

  const toggleGroup = (project: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })

  const row = (c: RemoteContainerRow, inGroup: boolean) => {
    const st = readStatus(c.status)
    const title = inGroup && c.service ? c.service : c.name || c.id
    const key = `c:${c.id}`
    const fig = labs && c.running ? stats[c.id] : undefined
    const line = fig ? statsLine(fig.cpu, fig.mem) : null
    const tone = fig ? statsTone(fig.cpu, fig.memPerc) : ''
    const rowBusy = busy[key] !== undefined || (c.project !== undefined && busy[`p:${c.project}`] !== undefined)
    const lifecycle = (action: ContainerAction, icon: ReactNode) => (
      <button
        type="button"
        className="ctr-action"
        disabled={!ready}
        title={ready ? actionLabel(action) : t('remote.containers.notConnected')}
        aria-label={actionLabel(action)}
        onClick={() => ask({ key, kind: 'container', target: c.id, name: c.name || c.id, action, count: 1 })}
      >
        {icon}
      </button>
    )
    return (
      <div key={c.id} className="ctr-row-wrap">
      <div className={`ctr-row${c.running ? '' : ' stopped'}${inGroup ? ' in-group' : ''}`}>
        <span className={`ctr-dot${c.running ? ' up' : ''}`} aria-hidden="true" />
        <div className="ctr-main">
          <div className="ctr-line">
            <span className="ctr-name" title={c.name}>{title}</span>
            {inGroup && c.service && c.name !== c.service && <span className="ctr-sub" title={c.name}>{c.name}</span>}
          </div>
          <div className="ctr-image mono" title={`${c.image} · ${c.id}`}>{c.image}</div>
          <div className="ctr-line ctr-facts">
            <span className={`ctr-status${st.tone && !st.tag ? ` ${st.tone}` : ''}`}>{st.text}</span>
            {st.tag && <span className={`ctr-tag ${st.tone}`}>{st.tag}</span>}
            {c.ports?.map((p) => (
              <span key={p} className="ctr-port mono">{p}</span>
            ))}
          </div>
          {line && (
            <div className={`ctr-stats mono${tone ? ` ${tone}` : ''}`} title={t('remote.containers.statsTitle')}>
              {line}
            </div>
          )}
        </div>
        {runtime && (c.running || labs) ? (
          <div className="ctr-actions" role="group" aria-label={t('remote.containers.actions', { name: c.name || c.id })}>
            {/* Experimental: start, or restart and stop, before the shell and the logs so
                the logs button keeps its place at the end of every row. */}
            {labs &&
              (rowBusy ? (
                <Spinner title={t('remote.containers.busy')} />
              ) : c.running ? (
                <>
                  {lifecycle('restart', <RestartIcon />)}
                  {lifecycle('stop', <StopIcon />)}
                </>
              ) : (
                lifecycle('start', <StartIcon />)
              ))}
            {c.running && (
              <button
                type="button"
                className="ctr-action"
                disabled={!ready}
                title={ready ? t('remote.containers.openShell') : t('remote.containers.notConnected')}
                aria-label={t('remote.containers.openShell')}
                onClick={() => onOpen({ runtime, sudo: result?.sudo === true, id: c.id }, c.name || c.id, 'shell')}
              >
                <ShellIcon />
              </button>
            )}
            {/* A stopped container's logs matter most (why it stopped), so this one shows
                on every row, last so it lines up down the list; the shell only where
                there is something to enter. */}
            {labs && (
              <button
                type="button"
                className="ctr-action"
                disabled={!ready}
                title={ready ? t('remote.containers.viewLogs') : t('remote.containers.notConnected')}
                aria-label={t('remote.containers.viewLogs')}
                onClick={() => onOpen({ runtime, sudo: result?.sudo === true, id: c.id }, c.name || c.id, 'logs')}
              >
                <LogsIcon />
              </button>
            )}
            {confirm?.key === key && (
              <ConfirmPop
                text={confirmText(confirm)}
                label={actionLabel(confirm.action)}
                production={production}
                onConfirm={() => run(confirm)}
                onCancel={cancelConfirm}
              />
            )}
          </div>
        ) : null}
      </div>
      {labs && noteFor(key)}
      </div>
    )
  }

  const refresh = (
    <button type="button" className="btn-ghost small" onClick={load} disabled={!ready || loading} title={t('remote.containers.refresh')}>
      {t('remote.containers.refresh')}
    </button>
  )
  const runningToggle = stoppedCount > 0 && (
    <button type="button" className={`ctr-toggle${runningOnly ? ' on' : ''}`} aria-pressed={runningOnly} onClick={() => setRunningOnly((v) => !v)}>
      {t('remote.containers.runningOnly')}
    </button>
  )
  const summary = runtime && containers.length > 0 && (
    <span className="ctr-summary">
      {result?.sudo ? `sudo ${runtime}` : runtime} · {t('remote.containers.running', { n: runningCount })}
      {stoppedCount > 0 && ` · ${t('remote.containers.stoppedCount', { n: stoppedCount })}`}
    </span>
  )

  const body = (
    <>
      {!ready && <p className="containers-note">{t('remote.containers.notConnected')}</p>}
      {ready && loading && !result && <p className="containers-note">{t('remote.containers.loading')}</p>}
      {result && !result.ok && result.notRunning && (
        <p className="containers-note">{t('remote.containers.engineDown', { runtime: result.runtime ?? 'docker' })}</p>
      )}
      {result && !result.ok && !result.notRunning && (
        <div className="block err containers-error" role="alert">
          {result.error}
        </div>
      )}
      {result?.ok && runtime === null && (
        <p className="containers-note">{t(isPane ? 'remote.containers.noRuntime' : 'remote.containers.noRuntimeLocal')}</p>
      )}
      {result?.ok && runtime && containers.length === 0 && (
        <p className="containers-note">{t(isPane ? 'remote.containers.none' : 'remote.containers.noneLocal')}</p>
      )}
      {result?.ok && result.sudo && containers.length > 0 && <p className="containers-note">{t('remote.containers.viaSudo')}</p>}
      {containers.length > 0 && nothingShown && (
        <p className="containers-note">{query?.trim() ? t('remote.containers.noMatch') : t('remote.containers.allStopped')}</p>
      )}

      {grouped.groups.map((g) => {
        const open = !folded.has(g.project)
        const total = g.total
        const tone = g.running === 0 ? '' : g.running === total ? ' up' : ' part'
        const key = `p:${g.project}`
        const canAct = labs && runtime !== null && isComposeProject(g.project)
        const projectItem = (action: ContainerAction, icon: JSX.Element, disabled: boolean) => ({
          label: projectLabel(action),
          icon,
          disabled: disabled || !ready,
          onClick: () => ask({ key, kind: 'project', target: g.project, name: g.project, action, count: total })
        })
        return (
          <div key={g.project} className="ctr-group">
            <div className="ctr-group-headrow">
            <button type="button" className="ctr-group-head" aria-expanded={open} onClick={() => toggleGroup(g.project)}>
              <Chevron open={open} />
              <span className="ctr-group-icon">
                <StackIcon />
              </span>
              <span className="ctr-group-name" title={g.project}>{g.project}</span>
              <span className={`ctr-group-count${tone}`}>
                <span className="ctr-group-dot" aria-hidden="true" />
                {t('remote.containers.groupCount', { running: g.running, total })}
              </span>
            </button>
            {canAct && (
              <div className="ctr-actions ctr-group-actions">
                {busy[key] !== undefined ? (
                  <Spinner title={t('remote.containers.busy')} />
                ) : (
                  <Menu
                    triggerClass="ctr-action"
                    triggerContent={<MoreIcon />}
                    triggerTitle={t('remote.containers.projectActions', { name: g.project })}
                    ariaLabel={t('remote.containers.projectActions', { name: g.project })}
                    items={[
                      projectItem('restart', <RestartIcon />, g.running === 0),
                      projectItem('stop', <StopIcon />, g.running === 0),
                      projectItem('start', <StartIcon />, g.running === total)
                    ]}
                  />
                )}
                {confirm?.key === key && (
                  <ConfirmPop
                    text={confirmText(confirm)}
                    label={projectLabel(confirm.action)}
                    production={production}
                    onConfirm={() => run(confirm)}
                    onCancel={cancelConfirm}
                  />
                )}
              </div>
            )}
            </div>
            {canAct && noteFor(key)}
            {open && <div className="ctr-group-rows">{g.containers.map((c) => row(c, true))}</div>}
          </div>
        )
      })}
      {grouped.loose.length > 0 && (
        <>
          {grouped.groups.length > 0 && <div className="eyebrow containers-eyebrow">{t('remote.containers.loose')}</div>}
          <div className="ctr-loose">{grouped.loose.map((c) => row(c, false))}</div>
        </>
      )}
    </>
  )

  if (isPane) {
    return (
      <>
        <div className="remote-session-pane-bar">
          {barSlot}
          <span className="containers-bar-spacer" />
          {refresh}
        </div>
        <div className="containers-panel">
          {(summary || runningToggle) && (
            <div className="ctr-head">
              {summary}
              <span className="containers-bar-spacer" />
              {runningToggle}
            </div>
          )}
          {body}
        </div>
      </>
    )
  }

  return (
    <section className="ctr-section" aria-label={t('remote.list.local')}>
      <div className="ctr-section-head">
        <span className="eyebrow">{t('remote.list.local')}</span>
        {summary}
        <span className="containers-bar-spacer" />
        {runningToggle}
        {refresh}
      </div>
      {body}
    </section>
  )
}
