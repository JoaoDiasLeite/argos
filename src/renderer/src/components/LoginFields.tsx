import type { ElevateCommand, ElevationMode, SshAuthType, SshKeyInfo } from '../types'
import Select from './Select'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../i18n'

/**
 * The login part of a form: username, auth type with its password or key, and elevation.
 * Shared by the host form (a host with its own login) and the shared-credentials form, so a
 * credential is edited with exactly the fields a host has. Secrets only ever travel from
 * here to main: a saved one shows as "unchanged", never as its value.
 */

export interface LoginValue {
  username: string
  authType: SshAuthType
  /** undefined keeps the stored secret, null clears it, a non-empty string replaces it. */
  password?: string | null
  privateKeyPath?: string
  passphrase?: string | null
  elevation?: ElevationMode
  elevationPassword?: string | null
  elevateCommand?: ElevateCommand
}

/** What is saved for the edited host or credential: which secrets exist, never their value. */
export interface SavedLogin {
  authType: SshAuthType
  elevation?: ElevationMode
  hasPassword: boolean
  hasPassphrase: boolean
  hasElevation: boolean
}

export const AUTH_LABEL: Record<SshAuthType, MessageKey> = { password: 'remote.auth.password', key: 'remote.auth.key', agent: 'remote.auth.agent' }
export const AUTH_CHIP: Record<SshAuthType, MessageKey> = { password: 'remote.auth.chipPassword', key: 'remote.auth.chipKey', agent: 'remote.auth.chipAgent' }

const ELEVATION_LABEL: Record<ElevationMode, MessageKey> = {
  login: 'remote.form.elevation.login',
  other: 'remote.form.elevation.other',
  none: 'remote.form.elevation.none'
}
const ELEVATE_COMMANDS: ElevateCommand[] = ['sudo -i', 'sudo su -', 'su -']

/** The elevation mode the form shows. Mirrors main's effectiveElevation: unset is `login` on
 *  a password login and `none` otherwise, and `login` without a login password is `none`. */
export function shownElevation(h: { authType: SshAuthType; elevation?: ElevationMode }): ElevationMode {
  const mode = h.elevation ?? (h.authType === 'password' ? 'login' : 'none')
  return mode === 'login' && h.authType !== 'password' ? 'none' : mode
}

const keyLabel = (k: SshKeyInfo) => `${k.name}${k.type ? ` · ${k.type.replace(/^ssh-/, '')}` : ''}${k.comment ? ` · ${k.comment}` : ''}`

interface Props {
  value: LoginValue
  onChange: (patch: Partial<LoginValue>) => void
  /** The saved record being edited, when there is one with secrets of its own. */
  saved?: SavedLogin
  keys: SshKeyInfo[]
  /** False when this machine has no keyring: the secrets would be stored in the clear. */
  secretsEncrypted: boolean
}

export default function LoginFields({ value, onChange, saved, keys, secretsEncrypted }: Props) {
  const t = useT()
  // The login password and passphrase count only for the auth type being edited (main drops
  // the other), the elevation password only while it was saved in `other` mode (otherwise
  // hasElevation comes from the login password).
  const canRemovePassword = !!saved?.hasPassword && value.authType === 'password'
  const canRemovePassphrase = !!saved?.hasPassphrase && value.authType === 'key'
  const canRemoveElevation = !!saved?.hasElevation && shownElevation(saved) === 'other'
  const keptPlaceholder = (v: string | null | undefined): string => (v === null ? t('remote.form.removed') : saved ? t('remote.form.unchanged') : '')

  return (
    <>
      <div className="form-group">
        <label>{t('remote.form.username')}</label>
        <input className="text-input mono" value={value.username} placeholder="ubuntu" onChange={(e) => onChange({ username: e.target.value })} />
      </div>
      <div className="form-group">
        <label>{t('remote.col.authentication')}</label>
        <div className="seg-control">
          {(['password', 'key', 'agent'] as SshAuthType[]).map((a) => (
            <button type="button" key={a} className={value.authType === a ? 'on' : ''} onClick={() => onChange({ authType: a })}>
              {t(AUTH_LABEL[a])}
            </button>
          ))}
        </div>
      </div>
      {value.authType === 'password' && (
        <div className="form-group">
          <label>{t('remote.form.password')}</label>
          <input
            className="text-input"
            type="password"
            placeholder={keptPlaceholder(value.password)}
            onChange={(e) => onChange({ password: e.target.value })}
          />
          <p className="help">{t('remote.form.passwordAskHelp')}</p>
          {!secretsEncrypted && <p className="help">{t('remote.form.passwordPlain')}</p>}
          {canRemovePassword && value.password === undefined && (
            <button type="button" className="btn-ghost small rv-remove-secret" onClick={() => onChange({ password: null })}>
              {t('remote.form.removePassword')}
            </button>
          )}
        </div>
      )}
      {value.authType === 'key' && (
        <>
          {keys.length > 0 && (
            <div className="form-group">
              <label>{t('remote.form.discoveredKey')}</label>
              <Select
                value={keys.some((k) => k.privatePath === value.privateKeyPath) ? value.privateKeyPath : ''}
                onChange={(e) => onChange({ privateKeyPath: e.target.value })}
              >
                <option value="">{t('remote.form.defaultKey')}</option>
                {keys.map((k) => (
                  <option key={k.privatePath} value={k.privatePath}>
                    {keyLabel(k)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="form-group">
            <label>{t('remote.form.privateKeyPath')}</label>
            <input
              className="text-input mono"
              value={value.privateKeyPath ?? ''}
              placeholder="C:\Users\you\.ssh\id_ed25519"
              onChange={(e) => onChange({ privateKeyPath: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>
              {t('remote.form.passphrase')}
              <span className="optional">{t('remote.form.optional')}</span>
            </label>
            <input
              className="text-input"
              type="password"
              placeholder={keptPlaceholder(value.passphrase)}
              onChange={(e) => onChange({ passphrase: e.target.value })}
            />
            {!secretsEncrypted && <p className="help">{t('remote.form.passphrasePlain')}</p>}
            {canRemovePassphrase && value.passphrase === undefined && (
              <button type="button" className="btn-ghost small rv-remove-secret" onClick={() => onChange({ passphrase: null })}>
                {t('remote.form.removePassphrase')}
              </button>
            )}
          </div>
        </>
      )}
      <div className="form-group">
        <label>{t('remote.form.elevation')}</label>
        <div className="seg-control">
          {(['login', 'other', 'none'] as ElevationMode[])
            // Reusing the login password only makes sense when there is one.
            .filter((m) => m !== 'login' || value.authType === 'password')
            .map((m) => (
              <button
                type="button"
                key={m}
                className={shownElevation(value) === m ? 'on' : ''}
                // A password typed for `other` is not carried into another mode (main
                // would drop it anyway); a requested removal still applies on save.
                onClick={() => {
                  // Re-clicking the current mode must not forget what the (still
                  // mounted) password field holds.
                  if (shownElevation(value) === m) return
                  onChange({ elevation: m, elevationPassword: value.elevationPassword === null ? null : undefined })
                }}
              >
                {t(ELEVATION_LABEL[m])}
              </button>
            ))}
        </div>
        <p className="help">{t('remote.form.elevationHelp')}</p>
      </div>
      {shownElevation(value) === 'other' && (
        <div className="form-group">
          <label>{t('remote.form.elevationPassword')}</label>
          <input
            className="text-input"
            type="password"
            aria-label={t('remote.form.elevationPassword')}
            placeholder={value.elevationPassword === null ? t('remote.form.removed') : canRemoveElevation ? t('remote.form.unchanged') : ''}
            onChange={(e) => onChange({ elevationPassword: e.target.value })}
          />
          {!secretsEncrypted && <p className="help">{t('remote.form.elevationPlain')}</p>}
          {canRemoveElevation && value.elevationPassword === undefined && (
            <button type="button" className="btn-ghost small rv-remove-secret" onClick={() => onChange({ elevationPassword: null })}>
              {t('remote.form.removeElevationPassword')}
            </button>
          )}
        </div>
      )}
      <div className="form-group">
        <label>{t('remote.form.elevateCommand')}</label>
        <Select value={value.elevateCommand ?? 'sudo -i'} onChange={(e) => onChange({ elevateCommand: e.target.value as ElevateCommand })}>
          {ELEVATE_COMMANDS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
    </>
  )
}
