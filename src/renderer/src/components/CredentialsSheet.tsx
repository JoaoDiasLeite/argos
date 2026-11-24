import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SshCredentialInput, SshCredentialPublic, SshKeyInfo } from '../types'
import Sheet from './Sheet'
import LoginFields, { AUTH_CHIP, type LoginValue } from './LoginFields'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'

/**
 * Shared credentials: one login kept once and linked by many servers, so changing its
 * password is one edit. The list (name, username, auth, how many servers use it) with add,
 * edit and delete; a credential still used by a server cannot be deleted.
 *
 * Opened from the host form to create or edit one credential, it starts on that form and
 * closes once it is saved.
 */

/** Where the sheet opens: the list, a new credential, or one to edit. */
export type CredentialsStart = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; id: string }

interface Props {
  start: CredentialsStart
  credentials: SshCredentialPublic[]
  keys: SshKeyInfo[]
  secretsEncrypted: boolean
  onClose: () => void
  /** After every write: the new list, and the id of the credential just saved. */
  onChanged: (credentials: SshCredentialPublic[], savedId?: string) => void
}

const emptyCredential = (): SshCredentialInput => ({ name: '', username: '', authType: 'password' })

function toInput(c: SshCredentialPublic): SshCredentialInput {
  return {
    id: c.id,
    name: c.name,
    username: c.username,
    authType: c.authType,
    privateKeyPath: c.privateKeyPath,
    elevation: c.elevation,
    elevateCommand: c.elevateCommand
  }
}

export default function CredentialsSheet({ start, credentials, keys, secretsEncrypted, onClose, onChanged }: Props) {
  const t = useT()
  const initial = (): SshCredentialInput | null => {
    if (start.kind === 'new') return emptyCredential()
    if (start.kind === 'edit') {
      const c = credentials.find((x) => x.id === start.id)
      return c ? toInput(c) : null
    }
    return null
  }
  const [editing, setEditing] = useState<SshCredentialInput | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const openedAt = useRef(Date.now())
  // Opened straight on a form (from the host form): saving or cancelling closes the sheet.
  const formOnly = start.kind !== 'list'

  const saved = editing?.id ? credentials.find((c) => c.id === editing.id) : undefined
  const valid = !!editing && !!editing.name.trim() && !!editing.username.trim()

  const edit = (c: SshCredentialInput) => {
    openedAt.current = Date.now()
    setError(null)
    setConfirmDelete(null)
    setEditing(c)
  }
  const back = () => {
    setError(null)
    if (formOnly) onClose()
    else setEditing(null)
  }

  const save = async () => {
    if (!editing || !valid || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const res = await window.electronAPI.sshCredentialSave(editing)
      if (!res.ok) {
        setError(res.error)
        return
      }
      // A new credential's id is the one main just added.
      const savedId = editing.id ?? res.credentials.find((c) => !credentials.some((p) => p.id === c.id))?.id
      onChanged(res.credentials, savedId)
      if (formOnly) onClose()
      else setEditing(null)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    const res = await window.electronAPI.sshCredentialDelete(id)
    setConfirmDelete(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setError(null)
    onChanged(res.credentials)
  }

  // Enter saves, as in the host form, except on a control with its own Enter, and never in
  // the first 400 ms so the keystroke that opened the form cannot also save it.
  const onFormKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (Date.now() - openedAt.current < 400) return
    e.preventDefault()
    void save()
  }

  const errorLine = error ? (
    <span className="rv-error-text rv-sheet-help" role="alert">
      {error}
    </span>
  ) : null

  if (editing) {
    return (
      <Sheet
        title={editing.id ? t('remote.creds.edit') : t('remote.creds.new')}
        width={520}
        onClose={formOnly ? onClose : back}
        footer={
          <>
            {errorLine ?? <span className="help rv-sheet-help">{t('remote.form.keys')}</span>}
            <button type="button" className="btn-ghost" onClick={back}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={!valid || saving}>
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="rv-form" onKeyDown={onFormKey}>
          <div className="form-group">
            <label>{t('remote.creds.name')}</label>
            <input
              className="text-input"
              value={editing.name}
              placeholder={t('remote.creds.namePlaceholder')}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              autoFocus
            />
          </div>
          <LoginFields
            value={editing}
            onChange={(patch: Partial<LoginValue>) => setEditing({ ...editing, ...patch })}
            saved={saved}
            keys={keys}
            secretsEncrypted={secretsEncrypted}
          />
          {saved && saved.usedBy > 0 && <p className="help">{plural(t, 'remote.creds.editAffects', saved.usedBy)}</p>}
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet
      title={t('remote.creds.title')}
      width={560}
      onClose={onClose}
      footer={
        <>
          {errorLine ?? <span className="help rv-sheet-help">{t('remote.creds.sub')}</span>}
          <button type="button" className="btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => edit(emptyCredential())}>
            {t('remote.creds.new')}
          </button>
        </>
      }
    >
      <div className="rv-form">
        {credentials.length === 0 ? (
          <p className="help">{t('remote.creds.empty')}</p>
        ) : (
          <div className="rv-creds">
            {credentials.map((c) => (
              <div key={c.id} className="rv-cred">
                <div className="rv-cred-text">
                  <span className="rv-cred-name">{c.name}</span>
                  <span className="rv-cred-meta">
                    <span className="rv-cred-user">{c.username}</span> · {t(AUTH_CHIP[c.authType])} · {plural(t, 'remote.creds.usedBy', c.usedBy)}
                    {c.usedByGroups > 0 && <> · {plural(t, 'remote.creds.inGroups', c.usedByGroups)}</>}
                  </span>
                </div>
                <div className="rv-cred-actions">
                  {confirmDelete === c.id ? (
                    <>
                      <button type="button" className="btn-ghost small" onClick={() => setConfirmDelete(null)}>
                        {t('common.cancel')}
                      </button>
                      <button type="button" className="btn-ghost small rv-cred-delete" onClick={() => remove(c.id)}>
                        {t('remote.creds.confirmDelete')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn-ghost small" onClick={() => edit(toInput(c))}>
                        {t('remote.creds.editShort')}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost small"
                        disabled={c.usedBy > 0 || c.usedByGroups > 0}
                        title={c.usedBy > 0 ? t('remote.creds.inUse') : c.usedByGroups > 0 ? t('remote.creds.inUseByGroups') : undefined}
                        onClick={() => setConfirmDelete(c.id)}
                      >
                        {t('remote.creds.delete')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
