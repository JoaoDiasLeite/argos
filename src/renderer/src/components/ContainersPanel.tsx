import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteContainerList, RemoteContainerRow, RemoteContainerTarget } from '../types'
import { groupContainers, readStatus } from '../lib/container-groups'
import { useT } from '../i18n'
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
  /** Opens a tab with a shell inside that container. */
  onOpen: (container: RemoteContainerTarget, name: string) => void
  /** After each listing: whether a runtime answered or is installed, and how many
   *  containers it has. The Servers screen hides the section and its filter without one. */
  onState?: (state: { runtime: boolean; count: number }) => void
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

/**
 * The containers of a remote host (the Remote Session's Containers pane) or of this computer
 * (a section of the Servers screen), laid out like Docker Desktop: one collapsible group per
 * compose project, with its running count, then the containers outside any project. Listed
 * when shown and on Refresh, no polling. A running one has a Shell button that opens it in a
 * tab of its own; the command is built in main from the validated id only.
 */
export default function ContainersPanel({ source, ready, barSlot, query, onOpen, onState }: Props) {
  const t = useT()
  const [result, setResult] = useState<RemoteContainerList | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningOnly, setRunningOnly] = useState(false)
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const reqRef = useRef(0)
  const sourceKey = source.kind === 'host' ? `host:${source.hostId}` : 'local'
  const isPane = barSlot !== undefined

  const load = useCallback(() => {
    const req = ++reqRef.current
    setLoading(true)
    const call = source.kind === 'host' ? window.electronAPI.remoteContainers(source.hostId) : window.electronAPI.localContainers()
    call.then(
      (res) => {
        if (req !== reqRef.current) return
        setResult(res)
        setLoading(false)
      },
      (e: unknown) => {
        if (req !== reqRef.current) return
        setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
        setLoading(false)
      }
    )
  }, [sourceKey])

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
    return (
      <div key={c.id} className={`ctr-row${c.running ? '' : ' stopped'}${inGroup ? ' in-group' : ''}`}>
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
        </div>
        {c.running && runtime ? (
          <button
            type="button"
            className="btn-ghost small containers-shell"
            disabled={!ready}
            title={ready ? t('remote.containers.shellTitle', { name: c.name || c.id }) : t('remote.containers.notConnected')}
            onClick={() => onOpen({ runtime, sudo: result?.sudo === true, id: c.id }, c.name || c.id)}
          >
            {t('remote.containers.shell')}
          </button>
        ) : null}
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
        return (
          <div key={g.project} className="ctr-group">
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
