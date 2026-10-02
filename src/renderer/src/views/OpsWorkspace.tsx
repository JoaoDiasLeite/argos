import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, OpsRunbookInfo } from '../types'
import ChatTerminal from '../components/ChatTerminal'
import OpsTimeline from '../components/OpsTimeline'
import PlanReviewSheet from '../components/PlanReviewSheet'
import type { OpsTerminalProvider, OpsTerminalSessionResult } from '../lib/ops-terminal'
import './OpsWorkspace.css'

/**
 * One runbook's workspace (Servers → Ops → a runbook).
 *
 * The embedded terminal, where the CLI runs with the ops MCP relay in its config, beside
 * the run's timeline. Always Claude Code: it is the only CLI that takes --disallowedTools,
 * so the only one whose own shell and file tools Argos can switch off. Codex and Gemini ops
 * were never verified and are not offered.
 *
 * A terminal ops session is one run per CLI launch (OPS_AGENT_PLAN §9 Phase 5). The pty
 * outlives this component like every embedded terminal does, so coming back to the
 * workspace reattaches to the CLI that is still running instead of starting a second run;
 * only a pty that is gone gets a fresh `opsTerminalSession`.
 */

type Launched = Extract<OpsTerminalSessionResult, { ok: true }>

const PROVIDER: OpsTerminalProvider = 'claude'

const GUARANTEE_LABEL = 'Tools and local shell gated'
const GUARANTEE_HINT =
  'Every server command goes through the runbook’s gate, and the CLI’s own shell and file tools are switched off.'

/** A short, stable, alphanumeric id for a string (cyrb53, base 36). Terminal ids must match
 *  `^[A-Za-z0-9_-]+$`, which a path never does. */
export function hashId(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const opsTerminalId = (runbookPath: string, provider: OpsTerminalProvider) =>
  `opsterm_${hashId(`${runbookPath}\n${provider}`)}`

// What main issued for each live ops terminal, kept for this app run so a remount reattaches
// with the same launch instead of asking for a new run. Dropped when the pty ends.
const launches = new Map<string, Launched>()

// STATUS_CONTROL_C_EXIT, as signed and unsigned: a pty we killed ourselves. Same filter as
// ChatTerminal's exit handler.
const KILLED_EXIT_CODES = new Set([-1073741510, 3221225786])

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

type TermState =
  | { kind: 'starting' }
  | { kind: 'ready'; launch: Launched; key: number }
  | { kind: 'error'; error: string }
  // The exited terminal stays on screen (its scrollback is the record of what happened)
  // with the launch it had, so ChatTerminal's own Restart can never bring the CLI back
  // without the relay config. Its token belongs to a run that is over; main drops it.
  | { kind: 'exited'; code: number; launch: Launched; key: number }
  | { kind: 'closed' }

type HostDot = 'checking' | 'ok' | 'error'

interface Props {
  runbookPath: string
  onBack: () => void
  /** Which ops terminal the workspace has on screen, so App can route that run's plan
   *  here instead of covering the terminal with its drawer. */
  onTerminalVisible?: (terminalId: string | null) => void
  /** The plan waiting on the visible terminal's run, if any (App owns the queue). */
  pendingPlan?: ApprovalRequest
  onPlanDecide?: (allow: boolean) => void
  onPlanStop?: () => void
}

export default function OpsWorkspace({
  runbookPath,
  onBack,
  onTerminalVisible,
  pendingPlan,
  onPlanDecide,
  onPlanStop
}: Props) {
  const [info, setInfo] = useState<OpsRunbookInfo | null>(null)
  const [hostDots, setHostDots] = useState<Record<string, HostDot>>({})
  const [term, setTerm] = useState<TermState>({ kind: 'starting' })
  const [timelineOpen, setTimelineOpen] = useState(true)

  const terminalId = opsTerminalId(runbookPath, PROVIDER)
  const keyRef = useRef(0)
  // Bumped by every start, so an answer to a superseded one (runbook switched, Relaunch
  // pressed twice) is dropped instead of overwriting the newer state.
  const startSeqRef = useRef(0)

  // ── The runbook and its hosts ──
  useEffect(() => {
    let cancelled = false
    setInfo(null)
    window.electronAPI
      .opsLoadRunbook(runbookPath)
      .then((r) => {
        if (cancelled) return
        setInfo(r)
        if (!r.ok) return
        setHostDots(Object.fromEntries(r.hosts.map((h) => [h.id, 'checking' as HostDot])))
        for (const h of r.hosts) {
          window.electronAPI
            .sshTest(h.id)
            .then((t) => !cancelled && setHostDots((prev) => ({ ...prev, [h.id]: t.ok ? 'ok' : 'error' })))
            .catch(() => !cancelled && setHostDots((prev) => ({ ...prev, [h.id]: 'error' })))
        }
      })
      .catch((e) => !cancelled && setInfo({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [runbookPath])

  // ── The terminal ──
  /** `fresh`: a new run on purpose (Relaunch, Launch after close) — the old pty, if any,
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
        const res = await window.electronAPI.opsTerminalSession(terminalId, runbookPath, PROVIDER)
        if (seq !== startSeqRef.current) return
        if (!res.ok) {
          setTerm({ kind: 'error', error: res.error })
          return
        }
        launches.set(terminalId, res)
        setTerm({ kind: 'ready', launch: res, key: ++keyRef.current })
      } catch (e) {
        if (seq === startSeqRef.current) setTerm({ kind: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    },
    [terminalId, runbookPath]
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

  const closeTerminal = () => {
    startSeqRef.current++
    launches.delete(terminalId)
    void window.electronAPI.terminalKill(terminalId)
    setTerm({ kind: 'closed' })
  }

  // A plan for this terminal's run is reviewed in the side column, beside the terminal.
  useEffect(() => {
    if (!onTerminalVisible) return
    onTerminalVisible(terminalId)
    return () => onTerminalVisible(null)
  }, [terminalId, onTerminalVisible])
  const plan = pendingPlan?.appSessionId === terminalId && onPlanDecide ? pendingPlan : undefined

  // ── Render ──
  const name = info?.ok ? info.name : baseName(runbookPath)

  return (
    <div className="view ops-ws">
      <div className="ops-ws-header">
        <button className="icon-btn" onClick={onBack} title="Back to Ops" aria-label="Back to Ops">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="ops-ws-title">
          <span className="ops-ws-name">{name}</span>
          {info?.ok && info.platform && <span className="ops-ws-tag">{info.platform}</span>}
          {info?.ok && <span className={`ops-ws-tag${info.strict ? ' strict' : ''}`}>{info.strict ? 'strict' : 'not strict'}</span>}
        </div>
        <span className="ops-ws-guarantee tools-and-local-shell" title={GUARANTEE_HINT}>
          {GUARANTEE_LABEL}
        </span>
        <div className="ops-ws-spacer" />
        {!timelineOpen && (
          <button className="btn-ghost small" onClick={() => setTimelineOpen(true)}>
            Timeline
          </button>
        )}
      </div>

      <div className="ops-ws-hosts">
        {info === null && <span className="ops-ws-muted">Loading runbook…</span>}
        {info && !info.ok && (
          <span className="ops-ws-bad" title={(info.errors ?? []).join('\n')}>
            {info.error}
            {info.errors && info.errors.length > 0 ? ` (${info.errors.length} error${info.errors.length === 1 ? '' : 's'})` : ''}
          </span>
        )}
        {info?.ok && info.hosts.length === 0 && <span className="ops-ws-muted">The policy names no hosts.</span>}
        {info?.ok &&
          info.hosts.map((h) => (
            <span key={h.id} className="ops-ws-host" title={h.host}>
              <span className={`ops-ws-dot ${hostDots[h.id] ?? 'checking'}`} />
              <span className="ops-ws-host-name">{h.name}</span>
              {h.groups.map((g) => (
                <span key={g} className="ops-ws-pill">
                  {g}
                </span>
              ))}
            </span>
          ))}
        {info?.ok && info.warnings.length > 0 && (
          <span className="ops-ws-warn" title={info.warnings.join('\n')}>
            {info.warnings.length} warning{info.warnings.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="ops-ws-body">
        <div className="ops-ws-main">
          {term.kind === 'starting' && <div className="ops-ws-state">Starting the ops session…</div>}
          {term.kind === 'error' && (
            <div className="ops-ws-state bad" role="alert">
              <span>{term.error}</span>
              <button className="btn-ghost small" onClick={() => void start(false)}>
                Retry
              </button>
            </div>
          )}
          {term.kind === 'closed' && (
            <div className="ops-ws-state">
              <span>Terminal closed; its run is over.</span>
              <button className="btn-ghost small" onClick={() => void start(true)}>
                Launch
              </button>
            </div>
          )}
          {term.kind === 'exited' && (
            <div className="ops-ws-strip">
              <span>CLI exited{term.code ? ` · code ${term.code}` : ''}</span>
              <button className="btn-ghost small" onClick={() => void start(true)}>
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
              onClose={closeTerminal}
            />
          )}
        </div>
        {plan && onPlanDecide ? (
          <div className="ops-ws-plan">
            <PlanReviewSheet key={plan.approvalId} request={plan} onDecide={onPlanDecide} onStop={onPlanStop} embedded />
          </div>
        ) : timelineOpen && (
          <OpsTimeline appSessionId={terminalId} runbookPath={runbookPath} onClose={() => setTimelineOpen(false)} />
        )}
      </div>
    </div>
  )
}
