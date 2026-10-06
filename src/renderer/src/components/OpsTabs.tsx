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
  /** Inside the workspace: its own strip under the header, rather than inline in the
   *  Servers sub-nav. */
  strip?: boolean
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * The interventions whose CLI is running, one tab each, like the Remote/WSL sessions: the
 * way back to one left running, and the way across between several.
 */
export default function OpsTabs({ items, activeId, onSelect, strip }: Props) {
  if (items.length === 0) return null
  return (
    <div className={`ops-tabs${strip ? ' strip' : ''}`} role="tablist" aria-label="Running interventions">
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
