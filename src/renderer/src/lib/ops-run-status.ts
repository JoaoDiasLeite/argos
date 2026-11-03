import type { OpsRunListItem } from '../types'
import { plural, type TFunction } from '../../../shared/i18n'

/** How a listed run ended, as a short word and a tone (the start screen and the Refer picker). */
export function runStatus(r: OpsRunListItem, t: TFunction): { label: string; tone: 'ok' | 'bad' | 'muted' } {
  // Stopping is how most diagnoses end: grey, not red. Red is kept for a run that failed.
  if (r.aborted) return { label: t('ops.start.status.stopped'), tone: 'muted' }
  if (r.ok === true) return { label: t('ops.start.status.finished'), tone: 'ok' }
  if (r.ok === false) return { label: t('ops.start.status.failed'), tone: 'bad' }
  if (!r.endedAt) return { label: t('ops.start.status.unfinished'), tone: 'muted' }
  return { label: t('ops.start.status.ended'), tone: 'muted' }
}

/** "2 findings", "1 hypothesis": what the run's notes hold, only the counts that are not zero. */
export function runNotes(r: OpsRunListItem, t: TFunction): string[] {
  return [
    r.findings ? plural(t, 'ops.start.findings', r.findings) : '',
    r.hypotheses ? plural(t, 'ops.start.hypotheses', r.hypotheses) : ''
  ].filter(Boolean)
}
