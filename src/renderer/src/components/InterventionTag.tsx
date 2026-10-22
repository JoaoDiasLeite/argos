import type { InterventionLabel } from '../lib/intervention-label'
import './InterventionTag.css'

/**
 * The mode beside an intervention's server name: "Diagnosis" for the built-in runbook,
 * otherwise the runbook folder, amber when that runbook changes the server. `text`
 * replaces the tag's own words (the workspace header adds "· read-only").
 */
export default function InterventionTag({ label, text, title }: { label: Pick<InterventionLabel, 'tag' | 'tagTone'>; text?: string; title?: string }) {
  return (
    <span className={`iv-tag${label.tagTone === 'warn' ? ' warn' : ''}`} title={title}>
      {text ?? label.tag}
    </span>
  )
}
