import type { PortForward } from '../types'
import { useT } from '../i18n'
import './PortForwards.css'

/** Kept in step with MAX_FORWARDS in src/main/port-forwards-pure.ts, which enforces it. */
const MAX_FORWARDS = 20

interface Props {
  value: PortForward[] | undefined
  onChange: (next: PortForward[]) => void
}

/** A port box's text: 0 (automatic, or not filled in yet) shows empty. */
const portText = (n: number): string => (Number.isFinite(n) && n !== 0 ? String(n) : '')

/** What a port box holds: its digits only (a pasted `5432/tcp` is 5432), empty is 0. Out of
 *  range is kept as typed, so the hint below the row (and main's check on save) says so. */
const parsePort = (text: string): number => {
  const digits = text.replace(/\D/g, '').slice(0, 6)
  return digits ? Number(digits) : 0
}

const okPort = (n: number, allowZero: boolean): boolean =>
  Number.isInteger(n) && n <= 65535 && (n >= 1 || (allowZero && n === 0))

function newForward(): PortForward {
  return { id: crypto.randomUUID(), label: '', localPort: 0, remoteHost: '', remotePort: 0 }
}

/**
 * The host form's Tunnels section: local port forwards kept with the host. Main validates
 * them again on save (the remote host goes through the same check as the server's address)
 * and refuses the save with a message naming the tunnel; the hints here only catch ports.
 */
export default function PortForwardsEditor({ value, onChange }: Props) {
  const t = useT()
  const list = value ?? []
  const set = (i: number, patch: Partial<PortForward>) => onChange(list.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const remove = (i: number) => onChange(list.filter((_, j) => j !== i))

  return (
    <div className="form-group pf-editor">
      <label>
        {t('remote.forwards.title')}
        <span className="optional">{t('remote.form.optional')}</span>
      </label>
      <p className="help">{t('remote.forwards.help')}</p>
      {list.map((f, i) => {
        const badLocal = !okPort(f.localPort, true)
        // A new row's empty remote port is not flagged until something else is typed in it.
        const touched = !!(f.label || f.remoteHost || f.localPort)
        const badRemote = !okPort(f.remotePort, false) && (touched || f.remotePort !== 0)
        return (
          <div className="pf-row" key={f.id}>
            <div className="pf-row-head">
              <input
                className="text-input pf-label"
                value={f.label}
                maxLength={64}
                placeholder={t('remote.forwards.labelPlaceholder')}
                aria-label={t('remote.forwards.label')}
                onChange={(e) => set(i, { label: e.target.value })}
              />
              <button
                type="button"
                className="btn-ghost small pf-remove"
                onClick={() => remove(i)}
                title={t('remote.forwards.remove')}
                aria-label={t('remote.forwards.remove')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="pf-fields">
              <label className="pf-field pf-port">
                <span>{t('remote.forwards.localPort')}</span>
                <input
                  className="text-input mono"
                  inputMode="numeric"
                  value={portText(f.localPort)}
                  placeholder={t('remote.forwards.localPortPlaceholder')}
                  aria-invalid={badLocal || undefined}
                  onChange={(e) => set(i, { localPort: parsePort(e.target.value) })}
                />
              </label>
              <span className="pf-arrow" aria-hidden="true">→</span>
              <label className="pf-field pf-host">
                <span>{t('remote.forwards.remoteHost')}</span>
                <input
                  className="text-input mono"
                  value={f.remoteHost}
                  placeholder="localhost"
                  spellCheck={false}
                  onChange={(e) => set(i, { remoteHost: e.target.value })}
                />
              </label>
              <label className="pf-field pf-port">
                <span>{t('remote.forwards.remotePort')}</span>
                <input
                  className="text-input mono"
                  inputMode="numeric"
                  value={portText(f.remotePort)}
                  placeholder="5432"
                  aria-invalid={badRemote || undefined}
                  onChange={(e) => set(i, { remotePort: parsePort(e.target.value) })}
                />
              </label>
            </div>
            <label className="pf-auto">
              <input type="checkbox" checked={!!f.autoStart} onChange={(e) => set(i, { autoStart: e.target.checked || undefined })} />
              {t('remote.forwards.autoStart')}
            </label>
            {(badLocal || badRemote) && (
              <span className="pf-error" role="alert">
                {badLocal ? t('remote.forwards.badLocalPort') : t('remote.forwards.badRemotePort')}
              </span>
            )}
          </div>
        )
      })}
      <div className="pf-add-row">
        <button
          type="button"
          className="btn-ghost small"
          disabled={list.length >= MAX_FORWARDS}
          onClick={() => onChange([...list, newForward()])}
        >
          {t('remote.forwards.add')}
        </button>
        {list.length >= MAX_FORWARDS && <span className="help">{t('remote.forwards.max', { n: MAX_FORWARDS })}</span>}
      </div>
    </div>
  )
}
