import type { OpsIntervention } from '../types'
import { opsTerminalIdFor } from '../lib/ops-terminal'

export interface OpsTabItem {
  intervention: OpsIntervention
  /** An approval of this intervention's run is waiting on the operator. */
  waiting: boolean
}

interface Props {
  items: OpsTabItem[]
  /** The intervention on screen, if any; its tab is marked as the current one. */
  activeId: string | null
  onSelect: (intervention: OpsIntervention) => void
  /** Inside the workspace: the topmost strip, styled and dragged like the Remote/WSL
   *  session tabs, rather than chips inline in the Servers sub-nav. */
  strip?: boolean
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * The interventions whose CLI is running, one tab each, like the Remote/WSL sessions: the
 * way back to one left running, and the way across between several.
 */
export default function OpsTabs({ items, activeId, onSelect, strip }: Props) {
  if (items.length === 0) return null
  if (strip) {
    return (
      <div className="server-tabs" role="tablist" aria-label="Running interventions">
        {items.map(({ intervention, waiting }) => {
          const id = opsTerminalIdFor(intervention)
          const on = id === activeId
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              className={`server-tab${on ? ' active' : ''}`}
              onClick={() => !on && onSelect(intervention)}
              title={`${baseName(intervention.runbookPath)}${intervention.task ? `: ${intervention.task}` : ''}${waiting ? ' (waiting for you)' : ''}`}
            >
              <span className={`server-tab-dot ${waiting ? 'connecting' : 'connected'}`} aria-hidden="true" />
              <span className="server-tab-title">{baseName(intervention.runbookPath)}</span>
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <div className="ops-tabs" role="tablist" aria-label="Running interventions">
      {items.map(({ intervention, waiting }) => {
        const id = opsTerminalIdFor(intervention)
        const on = id === activeId
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`ops-running-chip${on ? ' on' : ''}`}
            onClick={() => onSelect(intervention)}
            title={`${on ? 'Current intervention' : 'Go to the running intervention'}${intervention.task ? `: ${intervention.task}` : ''}${waiting ? ' (waiting for you)' : ''}`}
          >
            <span className={`ops-running-dot${waiting ? ' warn' : ''}`} aria-hidden="true" />
            <span className="ops-running-chip-name">{baseName(intervention.runbookPath)}</span>
            {intervention.task && <span className="ops-running-chip-task">{intervention.task}</span>}
          </button>
        )
      })}
    </div>
  )
}
