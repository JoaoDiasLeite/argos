import type { OpsIntervention } from '../types'
import { opsTerminalIdFor } from '../lib/ops-terminal'
import { useT } from '../i18n'

export interface OpsTabItem {
  intervention: OpsIntervention
  /** An approval of this intervention's run is waiting on the operator. */
  waiting: boolean
  /** Stopped, but still on screen: its tab stays, greyed, until the operator leaves. */
  ended?: boolean
}

interface Props {
  items: OpsTabItem[]
  /** The intervention on screen, if any; its tab is marked as the current one. */
  activeId: string | null
  onSelect: (intervention: OpsIntervention) => void
  /** End the intervention, as its Stop does: the run is stopped and its CLI closed. */
  onClose: (intervention: OpsIntervention) => void
  /** Inside the workspace: the topmost strip, styled and dragged like the Remote/WSL
   *  session tabs, rather than chips inline in the Servers sub-nav. */
  strip?: boolean
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const CloseIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

/**
 * The interventions whose CLI is running, one tab each, like the Remote/WSL sessions: the
 * way back to one left running, the way across between several, and an × that ends one.
 */
export default function OpsTabs({ items, activeId, onSelect, onClose, strip }: Props) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className={strip ? 'server-tabs' : 'ops-tabs'} role="tablist" aria-label={t('ops.tabs.aria')}>
      {items.map(({ intervention, waiting, ended }) => {
        const id = opsTerminalIdFor(intervention)
        const on = id === activeId
        const name = baseName(intervention.runbookPath)
        const select = () => {
          if (!on) onSelect(intervention)
        }
        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            className={strip ? `server-tab${on ? ' active' : ''}` : `ops-running-chip${on ? ' on' : ''}`}
            onClick={select}
            onKeyDown={(e) => e.key === 'Enter' && select()}
            title={`${name}${intervention.task ? `: ${intervention.task}` : ''}${ended ? t('ops.tabs.stopped') : waiting ? t('ops.tabs.waiting') : ''}`}
          >
            {strip ? (
              <span className={`server-tab-dot${ended ? '' : waiting ? ' connecting' : ' connected'}`} aria-hidden="true" />
            ) : (
              <span className={`ops-running-dot${waiting ? ' warn' : ''}`} aria-hidden="true" />
            )}
            <span className={strip ? 'server-tab-title' : 'ops-running-chip-name'}>{name}</span>
            {!strip && intervention.task && <span className="ops-running-chip-task">{intervention.task}</span>}
            <button
              type="button"
              className={strip ? 'server-tab-close' : 'ops-running-chip-close'}
              onClick={(e) => {
                e.stopPropagation()
                onClose(intervention)
              }}
              title={t('ops.tabs.close')}
              aria-label={t('ops.tabs.closeAria', { name })}
            >
              <CloseIcon size={strip ? 14 : 12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
