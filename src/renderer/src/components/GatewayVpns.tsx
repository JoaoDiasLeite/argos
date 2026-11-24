import { useEffect, useRef, useState } from 'react'
import type { SshHostPublic, VpnKind, VpnProfile, VpnStatusEvent } from '../types'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import { vpnKey } from '../hooks/useVpnStates'
import Select from './Select'
import './GatewayVpns.css'

/**
 * VPNs on a gateway host: the form's section to add, edit and remove profiles, the detail
 * column's list with a status dot and Connect/Disconnect, and the small dot the server rows and
 * the session header show. Main builds and runs the commands (vpn-gateway.ts) and checks the
 * profiles again on save; the hints here only help while typing.
 */

/** Kept in step with MAX_VPNS and the target pattern in src/main/vpn-pure.ts, which enforce them. */
const MAX_VPNS = 20
const TARGET = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}$/
const KINDS: VpnKind[] = ['openvpn', 'wireguard', 'nmcli', 'openfortivpn', 'custom']
const KIND_LABEL: Record<VpnKind, MessageKey> = {
  openvpn: 'remote.vpn.kind.openvpn',
  wireguard: 'remote.vpn.kind.wireguard',
  nmcli: 'remote.vpn.kind.nmcli',
  openfortivpn: 'remote.vpn.kind.openfortivpn',
  custom: 'remote.vpn.kind.custom'
}
const TARGET_HELP: Record<Exclude<VpnKind, 'custom'>, MessageKey> = {
  openvpn: 'remote.vpn.target.openvpn',
  wireguard: 'remote.vpn.target.wireguard',
  nmcli: 'remote.vpn.target.nmcli',
  openfortivpn: 'remote.vpn.target.openfortivpn'
}

/** Whether a profile runs through sudo, as main decides it (unset: presets yes, custom no). */
const usesSudo = (v: VpnProfile): boolean => v.sudo ?? v.kind !== 'custom'

// ─── The dot ────────────────────────────────────────────────────────────────

type DotLook = 'ok' | 'idle' | 'checking' | 'error' | 'none'

function dotLook(ev: VpnStatusEvent | undefined, checking = false): DotLook {
  if (checking || ev?.state === 'busy') return 'checking'
  if (!ev) return 'none'
  if (ev.state === 'up') return 'ok'
  if (ev.state === 'down') return 'idle'
  return ev.error ? 'error' : 'none'
}

const DOT_LABEL: Record<DotLook, MessageKey> = {
  ok: 'remote.vpn.state.up',
  idle: 'remote.vpn.state.down',
  checking: 'remote.vpn.state.busy',
  error: 'remote.vpn.state.error',
  none: 'remote.vpn.state.unknown'
}

/** A VPN's status dot. Nothing at all when the VPN was never checked and `always` is off. */
export function VpnDot({ ev, checking, always }: { ev: VpnStatusEvent | undefined; checking?: boolean; always?: boolean }) {
  const t = useT()
  const look = dotLook(ev, checking)
  if (look === 'none' && !always) return null
  return <span className={`rv-dot vpn-dot ${look}`} title={t(DOT_LABEL[look])} aria-label={t(DOT_LABEL[look])} role="img" />
}

// ─── The gateway's list, in the detail column ──────────────────────────────

const POLL_MS = 60_000

/**
 * The gateway's VPNs with their state, refreshed when the detail opens and every 60 s while it
 * is shown (not while the window is hidden). The poll stops once sudo refused a password or
 * the gateway could not be reached: trying the same thing every minute can lock the account.
 * "Check again" still works.
 */
export function GatewayVpnsSection({ host, states }: { host: SshHostPublic; states: Record<string, VpnStatusEvent> }) {
  const t = useT()
  const vpns = host.vpns ?? []
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const statesRef = useRef(states)
  statesRef.current = states

  const refresh = (auto: boolean): void => {
    if (auto) {
      if (document.visibilityState === 'hidden') return
      const blocked = vpns.some((v) => {
        const r = statesRef.current[vpnKey(host.id, v.id)]?.reason
        // A gateway that cannot be connected without its password typed would be a failed
        // login every minute; a user's click that lands during one would join it and fail.
        return r === 'wrong-password' || r === 'needs-password' || r === 'connect'
      })
      if (blocked) return
    }
    setChecking(true)
    window.electronAPI
      .vpnStatus(host.id)
      .catch(() => undefined)
      .finally(() => setChecking(false))
  }

  // The ids, not the array, so an unrelated list refresh does not re-run the check.
  const ids = vpns.map((v) => v.id).join(',')
  useEffect(() => {
    if (!ids) return
    refresh(false)
    const timer = setInterval(() => refresh(true), POLL_MS)
    return () => clearInterval(timer)
  }, [host.id, ids])

  if (vpns.length === 0) return null

  const run = (vpn: VpnProfile, up: boolean): void => {
    setOpen((o) => ({ ...o, [vpn.id]: false }))
    void (up ? window.electronAPI.vpnUp(host.id, vpn.id) : window.electronAPI.vpnDown(host.id, vpn.id)).catch(() => undefined)
  }

  return (
    <section className="rv-sec">
      <div className="eyebrow vpn-list-head">
        <span>{t('remote.vpn.list')}</span>
        <button type="button" className="btn-ghost small" onClick={() => refresh(false)} disabled={checking}>
          {t('remote.vpn.refresh')}
        </button>
      </div>
      <div className="vpn-list">
        {vpns.map((v) => {
          const ev = states[vpnKey(host.id, v.id)]
          const busy = ev?.state === 'busy'
          const up = ev?.state === 'up'
          const failed = ev?.state === 'unknown' && !!ev.error
          return (
            <div key={v.id} className="vpn-item">
              <div className="vpn-item-line">
                <VpnDot ev={ev} checking={checking && !ev} always />
                <span className="vpn-item-name">{v.name}</span>
                <span className="chip">{t(KIND_LABEL[v.kind])}</span>
                <span className="vpn-item-state">{t(DOT_LABEL[dotLook(ev, checking && !ev)])}</span>
                <span className="vpn-item-spacer" />
                {busy ? (
                  <svg className="spin vpn-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
                  </svg>
                ) : null}
                {up ? (
                  <button type="button" className="btn-ghost small" disabled={busy} onClick={() => run(v, false)}>
                    {t('remote.vpn.disconnect')}
                  </button>
                ) : (
                  <button type="button" className="btn-ghost small" disabled={busy} onClick={() => run(v, true)}>
                    {t('remote.vpn.connect')}
                  </button>
                )}
              </div>
              {failed && (
                <div className="vpn-item-err" role="alert">
                  <span>{ev.error}</span>
                  {ev.output && (
                    <details open={!!open[v.id]} onToggle={(e) => setOpen((o) => ({ ...o, [v.id]: (e.target as HTMLDetailsElement).open }))}>
                      <summary>{t('remote.vpn.output')}</summary>
                      <pre className="vpn-output">{ev.output}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── The form's section ─────────────────────────────────────────────────────

function newVpn(): VpnProfile {
  return { id: crypto.randomUUID(), name: '', kind: 'openvpn', target: '' }
}

/** The host form's VPNs section: the profiles a gateway carries. */
export function VpnProfilesEditor({ value, onChange }: { value: VpnProfile[] | undefined; onChange: (next: VpnProfile[]) => void }) {
  const t = useT()
  const list = value ?? []
  const set = (i: number, patch: Partial<VpnProfile>) => onChange(list.map((v, j) => (j === i ? { ...v, ...patch } : v)))
  const remove = (i: number) => onChange(list.filter((_, j) => j !== i))

  return (
    <div className="form-group pf-editor vpn-editor">
      <label>
        {t('remote.vpn.title')}
        <span className="optional">{t('remote.form.optional')}</span>
      </label>
      <p className="help">{t('remote.vpn.help')}</p>
      {list.map((v, i) => {
        const custom = v.kind === 'custom'
        const badTarget = !custom && !!v.target && !TARGET.test(v.target)
        return (
          <div className="pf-row" key={v.id}>
            <div className="pf-row-head">
              <input
                className="text-input pf-label"
                value={v.name}
                maxLength={80}
                placeholder={t('remote.vpn.namePlaceholder')}
                aria-label={t('remote.vpn.name')}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              <Select
                value={v.kind}
                aria-label={t('remote.vpn.kind')}
                onChange={(e) => set(i, { kind: e.target.value as VpnKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="btn-ghost small pf-remove"
                onClick={() => remove(i)}
                title={t('remote.vpn.remove')}
                aria-label={t('remote.vpn.remove')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {custom ? (
              <>
                {(['up', 'down', 'status'] as const).map((k) => (
                  <label key={k} className="pf-field">
                    <span>{t(`remote.vpn.${k}`)}</span>
                    <input
                      className="text-input mono"
                      value={v[k] ?? ''}
                      maxLength={500}
                      spellCheck={false}
                      onChange={(e) => set(i, { [k]: e.target.value })}
                    />
                  </label>
                ))}
                <span className="help">{t('remote.vpn.customHelp')}</span>
              </>
            ) : (
              <>
                <label className="pf-field">
                  <span>{t('remote.vpn.target')}</span>
                  <input
                    className="text-input mono"
                    value={v.target ?? ''}
                    maxLength={64}
                    spellCheck={false}
                    placeholder={v.kind === 'wireguard' ? 'wg0' : 'cliente-x'}
                    aria-invalid={badTarget || undefined}
                    onChange={(e) => set(i, { target: e.target.value })}
                  />
                </label>
                {badTarget ? (
                  <span className="pf-error" role="alert">
                    {t('remote.vpn.targetBad')}
                  </span>
                ) : (
                  <span className="help">{t(TARGET_HELP[v.kind])}</span>
                )}
              </>
            )}
            <label className="pf-auto" title={t('remote.vpn.sudoHelp')}>
              <input type="checkbox" checked={usesSudo(v)} onChange={(e) => set(i, { sudo: e.target.checked })} />
              {t('remote.vpn.sudo')}
            </label>
          </div>
        )
      })}
      <div className="pf-add-row">
        <button type="button" className="btn-ghost small" disabled={list.length >= MAX_VPNS} onClick={() => onChange([...list, newVpn()])}>
          {t('remote.vpn.add')}
        </button>
        {list.length >= MAX_VPNS && <span className="help">{t('remote.vpn.max', { n: MAX_VPNS })}</span>}
      </div>
      {list.length > 0 && <span className="help">{t('remote.vpn.sudoHelp')}</span>}
    </div>
  )
}

// ─── "VPN needed": the server form and the group editor ─────────────────────

export const INHERIT_VPN = '__inherit_vpn__'
export const NO_VPN = '__no_vpn__'

/**
 * The select of the VPN a server (or a group) needs, from the VPNs of the gateway in force,
 * plus "inherit from the group" when the group names one, and the auto-up checkbox for an
 * explicit choice.
 */
export function VpnNeededField({
  gateway,
  value,
  autoUp,
  inherit,
  help,
  onChange
}: {
  gateway: SshHostPublic | undefined
  /** INHERIT_VPN, NO_VPN or a profile id. */
  value: string
  autoUp: boolean
  /** The group's choice, offered as "inherit". */
  inherit?: { group: string; name: string; autoUp: boolean }
  help: string
  onChange: (value: string, autoUp: boolean) => void
}) {
  const t = useT()
  const vpns = gateway?.vpns ?? []
  const explicit = value !== INHERIT_VPN && value !== NO_VPN
  const missing = explicit && !vpns.some((v) => v.id === value)
  if (vpns.length === 0 && !inherit && !explicit) return null
  return (
    <div className="form-group">
      <label>{t('remote.vpn.needed')}</label>
      <Select value={value} onChange={(e) => onChange(e.target.value, autoUp)}>
        {inherit && <option value={INHERIT_VPN}>{t('remote.vpn.neededInherit', { group: inherit.group, name: inherit.name })}</option>}
        <option value={NO_VPN}>{t('remote.vpn.neededNone')}</option>
        {missing && <option value={value}>{t('remote.vpn.neededMissing')}</option>}
        {vpns.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
      {missing ? <p className="help rv-error-text">{t('remote.vpn.neededMissing')}</p> : <p className="help">{help}</p>}
      {explicit && !missing && (
        <label className="pf-auto vpn-auto">
          <input type="checkbox" checked={autoUp} onChange={(e) => onChange(value, e.target.checked)} />
          {t('remote.vpn.autoUp')}
        </label>
      )}
      {explicit && !missing && <p className="help">{t('remote.vpn.autoUpHelp')}</p>}
      {value === INHERIT_VPN && inherit && <p className="help">{t(inherit.autoUp ? 'remote.vpn.inheritAuto' : 'remote.vpn.inheritAsk')}</p>}
    </div>
  )
}
