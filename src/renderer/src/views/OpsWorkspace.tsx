import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest, OpsIntervention, OpsRunbookInfo } from '../types'
import ChatTerminal from '../components/ChatTerminal'
import ActivityColumn from '../components/ActivityColumn'
import { useOpsEvents } from '../hooks/useOpsEvents'
import { foldOpsEvents, splitRuns, touchedHosts } from '../lib/ops-timeline'
import { opsTerminalIdFor, type OpsTerminalProvider, type OpsTerminalSessionResult } from '../lib/ops-terminal'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'
import './OpsWorkspace.css'

/**
 * One intervention's workspace (Servers → Ops → Start intervention; board D2 of
 * docs/INTERVENTIONS_PLAN.md): the embedded terminal, where the CLI runs with the ops MCP
 * relay in its config, beside the activity column. Always Claude Code: it is the only CLI
 * that takes --disallowedTools, so the only one whose own shell and file tools Argos can
 * switch off.
 *
 * A terminal ops session is one run per CLI launch. The pty outlives this component like
 * every embedded terminal does, so coming back to the workspace reattaches to the CLI that
 * is still running instead of starting a second run; only a pty that is gone gets a fresh
 * `opsTerminalSession`.
 */

type Launched = Extract<OpsTerminalSessionResult, { ok: true }>

const PROVIDER: OpsTerminalProvider = 'claude'


// What main issued for each live ops terminal, kept for this app run so a remount reattaches
// with the same launch instead of asking for a new run. Dropped when the pty ends.
const launches = new Map<string, Launched>()

// STATUS_CONTROL_C_EXIT, as signed and unsigned: a pty we killed ourselves. Same filter as
// ChatTerminal's exit handler.
const KILLED_EXIT_CODES = new Set([-1073741510, 3221225786])

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

type TermState =
  | { kind: 'starting' }
  // `prompt`: the task, typed into a CLI this mount launched; a reattached CLI already has it.
  | { kind: 'ready'; launch: Launched; key: number; prompt?: string }
  | { kind: 'error'; error: string }
  // The exited terminal stays on screen (its scrollback is the record of what happened)
  // with the launch it had, so ChatTerminal's own Restart can never bring the CLI back
  // without the relay config. Its token belongs to a run that is over; main drops it.
  // `stopped`: ended from here (Stop), not by the CLI exiting on its own.
  | { kind: 'exited'; code: number; launch: Launched; key: number; stopped?: boolean }

type HostDot = 'checking' | 'ok' | 'error'

interface Props {
  intervention: OpsIntervention
  onBack: () => void
  /** Which ops terminal the workspace has on screen, so App can route that run's
   *  approvals here. */
  onTerminalVisible?: (terminalId: string | null) => void
  /** This terminal's CLI is up. Its end is not reported here: the workspace may be gone by
   *  then, so App listens for the exit itself. */
  onRunning?: (terminalId: string) => void
  /** The approval waiting on this terminal's run, if any (App owns the queue). */
  waiting?: ApprovalRequest
  onDecide?: (allow: boolean, skipSteps?: number[]) => void
  /** Deny the waiting approval and stop the run. */
  onStop?: () => void
  /** The intervention was ended from here: its run is stopped and its CLI closed, so App
   *  stops counting it. `leave`: the terminal's ×, which also closes the workspace; Stop
   *  and Deny and stop keep it on screen until the operator leaves. */
  onEnded?: (terminalId: string, leave: boolean) => void
  /** The tabs of the running interventions, at the top like the Remote/WSL sessions'. */
  tabs?: ReactNode
}

export default function OpsWorkspace({ intervention, onBack, onTerminalVisible, onRunning, waiting, onDecide, onStop, onEnded, tabs }: Props) {
  const t = useT()
  const { runbookPath, scope } = intervention
  const [info, setInfo] = useState<OpsRunbookInfo | null>(null)
  const [hostDot, setHostDot] = useState<HostDot>('checking')
  const [term, setTerm] = useState<TermState>({ kind: 'starting' })

  const terminalId = opsTerminalIdFor(intervention)
  const keyRef = useRef(0)
  // Bumped by every start, so an answer to a superseded one (Restart pressed twice) is
  // dropped instead of overwriting the newer state.
  const startSeqRef = useRef(0)
  // The latest intervention, for `start` without making it a dependency (a new object
  // with the same fields is the same terminal).
  const interventionRef = useRef(intervention)
  interventionRef.current = intervention

  // ── The runbook, and the locked host's connection ──
  const lockedHostId = scope.kind === 'host' ? scope.hostId : undefined
  useEffect(() => {
    let cancelled = false
    setInfo(null)
    window.electronAPI
      .opsLoadRunbook(runbookPath)
      .then((r) => !cancelled && setInfo(r))
      .catch((e) => !cancelled && setInfo({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [runbookPath])

  useEffect(() => {
    if (!lockedHostId) return
    let cancelled = false
    setHostDot('checking')
    window.electronAPI
      .sshTest(lockedHostId)
      .then((r) => !cancelled && setHostDot(r.ok ? 'ok' : 'error'))
      .catch(() => !cancelled && setHostDot('error'))
    return () => {
      cancelled = true
    }
  }, [lockedHostId])

  // ── The terminal ──
  /** `fresh`: a new run on purpose (Restart, Relaunch after an exit) — the old pty, if any,
   *  is ended first. Otherwise a live pty is reattached to as it is. */
  const start = useCallback(
    async (fresh: boolean) => {
      const seq = ++startSeqRef.current
      setTerm({ kind: 'starting' })
      try {
        if (fresh) {
          launches.delete(terminalId)
          await window.electronAPI.terminalKill(terminalId)
        } else {
          const alive = (await window.electronAPI.terminalList()).some((x) => x.id === terminalId)
          if (seq !== startSeqRef.current) return
          const known = launches.get(terminalId)
          if (alive && known) {
            setTerm({ kind: 'ready', launch: known, key: ++keyRef.current })
            return
          }
          // Alive but nothing remembered (the renderer reloaded): end it and start a new
          // run, rather than hold a terminal whose Restart would come back ungated.
          launches.delete(terminalId)
          if (alive) await window.electronAPI.terminalKill(terminalId)
        }
        const res = await window.electronAPI.opsTerminalSession(terminalId, interventionRef.current)
        if (seq !== startSeqRef.current) return
        if (!res.ok) {
          setTerm({ kind: 'error', error: res.error })
          return
        }
        launches.set(terminalId, res)
        setTerm({ kind: 'ready', launch: res, key: ++keyRef.current, prompt: res.initialPrompt })
      } catch (e) {
        if (seq === startSeqRef.current) setTerm({ kind: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    },
    [terminalId]
  )

  useEffect(() => {
    void start(false)
  }, [start])

  useEffect(() => {
    return window.electronAPI.onTerminalExit((e) => {
      if (e.id !== terminalId || KILLED_EXIT_CODES.has(e.exitCode)) return
      launches.delete(terminalId)
      setTerm((prev) =>
        prev.kind === 'ready' ? { kind: 'exited', code: e.exitCode, launch: prev.launch, key: prev.key } : prev
      )
    })
  }, [terminalId])

  useEffect(() => {
    if (term.kind === 'ready') onRunning?.(terminalId)
  }, [term.kind, terminalId, onRunning])


  /** Stop and the terminal's × end the intervention, not just the run: a CLI left up after
   *  its run is over can only start a run that does nothing, yet it keeps the intervention
   *  counted as running on the rail and in the tabs. Stop leaves the terminal's scrollback
   *  and the activity on screen; the × also leaves the workspace. */
  const endIntervention = async (leave: boolean, denyFirst?: () => void) => {
    startSeqRef.current++
    launches.delete(terminalId)
    denyFirst?.()
    // Stop first, so the ledger records the run as stopped by the operator rather than as
    // a terminal that went away.
    await window.electronAPI.opsStop(terminalId).catch(() => undefined)
    await window.electronAPI.terminalKill(terminalId).catch(() => undefined)
    if (!leave) {
      setTerm((prev) =>
        prev.kind === 'ready' ? { kind: 'exited', code: 0, launch: prev.launch, key: prev.key, stopped: true } : prev
      )
    }
    onEnded?.(terminalId, leave)
  }

  // Approvals for this terminal's run are answered in the activity column.
  useEffect(() => {
    if (!onTerminalVisible) return
    onTerminalVisible(terminalId)
    return () => onTerminalVisible(null)
  }, [terminalId, onTerminalVisible])
  const mine = waiting?.appSessionId === terminalId && waiting.ops && onDecide ? waiting : undefined

  // ── The runs of this terminal ──
  const { events, loading } = useOpsEvents(terminalId)
  const launch = term.kind === 'ready' || term.kind === 'exited' ? term.launch : undefined
  const { current, earlier } = useMemo(
    // Until a launch is known there is no current run, only earlier ones.
    () => splitRuns(foldOpsEvents(events), launch?.runId ?? ''),
    [events, launch?.runId]
  )

  // ── Header ──
  const okInfo = info?.ok ? info : undefined
  const name = okInfo?.name ?? baseName(runbookPath)
  const lockedHost = lockedHostId ? okInfo?.hosts.find((h) => h.id === lockedHostId) : undefined
  const touched = current ? touchedHosts(current) : []
  const policyLine = okInfo
    ? t('ops.workspace.policyLine', {
        access: okInfo.summary.mutates === 0 ? t('ops.workspace.readOnly') : t('ops.workspace.canChange'),
        strict: okInfo.strict ? t('ops.workspace.strict') : t('ops.workspace.notStrict')
      })
    : ''

  return (
    <div className="view ops-ws">
      {tabs}
      <div className="ops-ws-header">
        <button className="ops-ws-back" onClick={onBack} title={t('ops.workspace.back')} aria-label={t('ops.workspace.back')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="ops-ws-name" title={runbookPath}>
          {name}
        </span>
        {scope.kind === 'host' ? (
          <span className="ops-ws-host" title={lockedHost?.host}>
            <span className={`ops-ws-dot ${hostDot}`} aria-hidden="true" />
            {lockedHost?.name ?? (info === null ? '…' : t('ops.workspace.unknownHost'))}
          </span>
        ) : (
          <span className="ops-ws-host" title={touched.length ? t('ops.workspace.reached', { hosts: touched.join(', ') }) : undefined}>
            <span className="ops-ws-dot open" aria-hidden="true" />
            {t('ops.report.anyServer')}
            {touched.length > 0 && <span className="ops-ws-touched"> · {touched.join(', ')}</span>}
          </span>
        )}
        {policyLine && <span className="ops-ws-meta">{policyLine}</span>}
        {info && !info.ok && (
          <span className="ops-ws-bad" title={(info.errors ?? []).join('\n')}>
            {info.error}
          </span>
        )}
        {okInfo && okInfo.warnings.length > 0 && (
          <span className="ops-ws-warn" title={okInfo.warnings.join('\n')}>
            {plural(t, 'ops.workspace.warnings', okInfo.warnings.length)}
          </span>
        )}
        <div className="ops-ws-spacer" />
        <span className="ops-ws-meta" title={t('ops.workspace.gatedHint')}>
          {t('ops.workspace.gated')}
        </span>
        <button
          className="ops-ws-btn"
          onClick={() => void start(true)}
          disabled={term.kind === 'starting'}
          title={t('ops.workspace.restartTitle')}
        >
          {t('ops.workspace.restart')}
        </button>
      </div>

      <div className="ops-ws-body">
        <div className="ops-ws-main">
          {term.kind === 'starting' && <div className="ops-ws-state">{t('ops.workspace.starting')}</div>}
          {term.kind === 'error' && (
            <div className="ops-ws-state bad" role="alert">
              <span>{term.error}</span>
              <button className="ops-ws-btn" onClick={() => void start(false)}>
                {t('common.retry')}
              </button>
            </div>
          )}
          {term.kind === 'exited' && (
            <div className="ops-ws-strip">
              <span>{term.stopped ? t('ops.workspace.stopped') : term.code ? t('ops.workspace.exitedCode', { code: term.code }) : t('ops.workspace.exited')}</span>
              <button className="ops-ws-btn small" onClick={() => void start(true)}>
                {t('ops.workspace.relaunch')}
              </button>
            </div>
          )}
          {(term.kind === 'ready' || term.kind === 'exited') && (
            <ChatTerminal
              key={`${terminalId}:${term.key}`}
              terminalId={terminalId}
              cwd={runbookPath}
              provider={PROVIDER}
              autoLaunchCli
              active
              ops={{ env: term.launch.env, mcpConfigPath: term.launch.mcpConfigPath }}
              initialPrompt={term.kind === 'ready' ? term.prompt : undefined}
              onClose={() => void endIntervention(true)}
            />
          )}
        </div>
        <ActivityColumn
          terminalId={terminalId}
          runbookPath={runbookPath}
          current={current}
          earlier={earlier}
          loading={loading}
          waiting={mine}
          onDecide={onDecide}
          onDenyStop={onStop ? () => void endIntervention(false, onStop) : undefined}
          onStop={onEnded ? () => void endIntervention(false) : undefined}
          cliAlive={term.kind === 'ready'}
        />
      </div>
    </div>
  )
}
