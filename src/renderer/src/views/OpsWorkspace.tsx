import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalRequest, OpsIntervention, OpsRunbookInfo } from '../types'
import ChatTerminal from '../components/ChatTerminal'
import ActivityColumn from '../components/ActivityColumn'
import { useOpsEvents } from '../hooks/useOpsEvents'
import { foldOpsEvents, splitRuns, touchedHosts } from '../lib/ops-timeline'
import { opsTerminalIdFor, type OpsTerminalProvider, type OpsTerminalSessionResult } from '../lib/ops-terminal'
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

const GATED_HINT =
  'Every server command goes through the runbook’s gate, and the CLI’s own shell and file tools are switched off.'

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
  | { kind: 'exited'; code: number; launch: Launched; key: number }
  | { kind: 'closed' }

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
  /** The intervention was ended from here (Stop, Deny and stop): its run is stopped and
   *  its CLI closed, so App drops it and leaves the workspace. */
  onEnded?: (terminalId: string) => void
}

export default function OpsWorkspace({ intervention, onBack, onTerminalVisible, onRunning, waiting, onDecide, onStop, onEnded }: Props) {
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
      .then((t) => !cancelled && setHostDot(t.ok ? 'ok' : 'error'))
      .catch(() => !cancelled && setHostDot('error'))
    return () => {
      cancelled = true
    }
  }, [lockedHostId])

  // ── The terminal ──
  /** `fresh`: a new run on purpose (Restart, Launch after close) — the old pty, if any,
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
          const alive = (await window.electronAPI.terminalList()).some((t) => t.id === terminalId)
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

  const closeTerminal = () => {
    startSeqRef.current++
    launches.delete(terminalId)
    void window.electronAPI.terminalKill(terminalId)
    setTerm({ kind: 'closed' })
  }

  /** Stop is the end of the intervention, not just of the run: a CLI left up after its run
   *  is over can only start a run that does nothing, yet it keeps the intervention counted
   *  as running on the rail and in the Servers header. */
  const endIntervention = async (denyFirst?: () => void) => {
    startSeqRef.current++
    launches.delete(terminalId)
    denyFirst?.()
    // Stop first, so the ledger records the run as stopped by the operator rather than as
    // a terminal that went away.
    await window.electronAPI.opsStop(terminalId).catch(() => undefined)
    await window.electronAPI.terminalKill(terminalId).catch(() => undefined)
    onEnded?.(terminalId)
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
    ? `${okInfo.summary.mutates === 0 ? 'read-only runbook' : 'runbook can change hosts'} · ${okInfo.strict ? 'strict' : 'not strict'}`
    : ''

  return (
    <div className="view ops-ws">
      <div className="ops-ws-header">
        <button className="ops-ws-back" onClick={onBack} title="Back to Operations" aria-label="Back to Operations">
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
            {lockedHost?.name ?? (info === null ? '…' : 'unknown host')}
          </span>
        ) : (
          <span className="ops-ws-host" title={touched.length ? `Reached so far: ${touched.join(', ')}` : undefined}>
            <span className="ops-ws-dot open" aria-hidden="true" />
            any server this runbook allows
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
            {okInfo.warnings.length} warning{okInfo.warnings.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="ops-ws-spacer" />
        <span className="ops-ws-meta" title={GATED_HINT}>
          Claude Code · gated
        </span>
        <button
          className="ops-ws-btn"
          onClick={() => void start(true)}
          disabled={term.kind === 'starting'}
          title="End this CLI and its run, and start a new one for the same intervention"
        >
          Restart
        </button>
      </div>

      <div className="ops-ws-body">
        <div className="ops-ws-main">
          {term.kind === 'starting' && <div className="ops-ws-state">Starting the ops session…</div>}
          {term.kind === 'error' && (
            <div className="ops-ws-state bad" role="alert">
              <span>{term.error}</span>
              <button className="ops-ws-btn" onClick={() => void start(false)}>
                Retry
              </button>
            </div>
          )}
          {term.kind === 'closed' && (
            <div className="ops-ws-state">
              <span>Terminal closed; its run is over.</span>
              <button className="ops-ws-btn" onClick={() => void start(true)}>
                Launch
              </button>
            </div>
          )}
          {term.kind === 'exited' && (
            <div className="ops-ws-strip">
              <span>CLI exited{term.code ? ` · code ${term.code}` : ''}</span>
              <button className="ops-ws-btn small" onClick={() => void start(true)}>
                Relaunch
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
              onClose={closeTerminal}
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
          onDenyStop={onStop ? () => void endIntervention(onStop) : undefined}
          onStop={onEnded ? () => void endIntervention() : undefined}
          cliAlive={term.kind === 'ready'}
        />
      </div>
    </div>
  )
}
