import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SshCredentialPublic, SshGroupInput, SshGroupPublic, SshHostPublic } from '../types'
import Sheet from './Sheet'
import Select from './Select'
import { plural } from '../../../shared/i18n'
import { useT } from '../i18n'
import { NO_VPN, VpnNeededField } from './GatewayVpns'

/**
 * Server groups: one per client, as RDM folders. The list (name, credential, how many
 * servers) with add, edit and delete. A group may carry a shared credential, which its
 * servers use only when they choose "Inherit from group". Deleting a group moves its servers
 * to "No group" after a confirm that says which of them lose their login.
 *
 * Opened from a group header or the host form, it starts on that group's form (or its
 * delete confirm) and closes when done.
 */

export type GroupsStart = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'delete'; id: string }

interface Props {
  start: GroupsStart
  groups: SshGroupPublic[]
  credentials: SshCredentialPublic[]
  /** The saved hosts, for the gateway select. */
  hosts: SshHostPublic[]
  onClose: () => void
  /** After every write: the new list, and the id of the group just saved. */
  onChanged: (groups: SshGroupPublic[], savedId?: string) => void
  /** After a delete: the hosts as they are now (moved to no group). */
  onHostsChanged: (hosts: SshHostPublic[]) => void
}

const emptyGroup = (): SshGroupInput => ({ name: '' })

const toInput = (g: SshGroupPublic): SshGroupInput => ({
  id: g.id,
  name: g.name,
  credentialId: g.credentialId,
  jumpHostId: g.jumpHostId,
  vpnId: g.vpnId,
  vpnAutoUp: g.vpnAutoUp
})

export default function GroupsSheet({ start, groups, credentials, hosts, onClose, onChanged, onHostsChanged }: Props) {
  const t = useT()
  const initial = (): SshGroupInput | null => {
    if (start.kind === 'new') return emptyGroup()
    if (start.kind === 'edit') {
      const g = groups.find((x) => x.id === start.id)
      return g ? toInput(g) : null
    }
    return null
  }
  const [editing, setEditing] = useState<SshGroupInput | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(start.kind === 'delete' ? start.id : null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const openedAt = useRef(Date.now())
  // Opened straight on one group (from a header menu or the host form): done closes the sheet.
  const formOnly = start.kind !== 'list'

  const saved = editing?.id ? groups.find((g) => g.id === editing.id) : undefined
  const valid = !!editing && !!editing.name.trim()
  const credentialChanged = !!saved && (saved.credentialId ?? '') !== (editing?.credentialId ?? '')
  // A gateway connects directly: hosts going through one (their own or a group's) are left out.
  const jumpChoices = hosts.filter((h) => !h.jumpViaId && !h.jumpMissing)

  const edit = (g: SshGroupInput) => {
    openedAt.current = Date.now()
    setError(null)
    setConfirmDelete(null)
    setEditing(g)
  }
  const back = () => {
    setError(null)
    if (formOnly) onClose()
    else setEditing(null)
  }

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      if (!editing || !valid) return
      const res = await window.electronAPI.sshGroupSave({
        ...editing,
        credentialId: editing.credentialId || undefined,
        jumpHostId: editing.jumpHostId || undefined,
        // A VPN belongs to the gateway: none without one.
        vpnId: (editing.jumpHostId && editing.vpnId) || undefined,
        vpnAutoUp: (editing.jumpHostId && editing.vpnId && editing.vpnAutoUp) || undefined
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      const savedId = editing.id ?? res.groups.find((g) => !groups.some((p) => p.id === g.id))?.id
      onChanged(res.groups, savedId)
      if (formOnly) onClose()
      else setEditing(null)
    })

  const remove = (id: string) =>
    run(async () => {
      const res = await window.electronAPI.sshGroupDelete(id)
      setConfirmDelete(null)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      onChanged(res.groups)
      onHostsChanged(res.hosts)
      if (formOnly) onClose()
    })

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
        title={editing.id ? t('remote.groups.edit') : t('remote.groups.new')}
        width={480}
        onClose={formOnly ? onClose : back}
        footer={
          <>
            {errorLine ?? <span className="help rv-sheet-help">{t('remote.groups.sub')}</span>}
            <button type="button" className="btn-ghost" onClick={back}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={!valid || busy}>
              {t('common.save')}
            </button>
          </>
        }
      >
        <div className="rv-form" onKeyDown={onFormKey}>
          <div className="form-group">
            <label>{t('remote.groups.name')}</label>
            <input
              className="text-input"
              value={editing.name}
              maxLength={80}
              placeholder={t('remote.groups.namePlaceholder')}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>
              {t('remote.groups.credential')}
              <span className="optional">{t('remote.form.optional')}</span>
            </label>
            <Select value={editing.credentialId ?? ''} onChange={(e) => setEditing({ ...editing, credentialId: e.target.value || undefined })}>
              <option value="">{t('remote.groups.credentialNone')}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <p className="help">{t('remote.groups.credentialHelp')}</p>
            {credentialChanged && saved && saved.inheriting > 0 && (
              <p className="help">
                {editing.credentialId
                  ? plural(t, 'remote.groups.credentialAffects', saved.inheriting)
                  : plural(t, 'remote.groups.credentialClears', saved.inheriting)}
              </p>
            )}
          </div>
          <div className="form-group">
            <label>
              {t('remote.form.jump')}
              <span className="optional">{t('remote.form.optional')}</span>
            </label>
            <Select value={editing.jumpHostId ?? ''} onChange={(e) => setEditing({ ...editing, jumpHostId: e.target.value || undefined })}>
              <option value="">{t('remote.form.jumpDirect')}</option>
              {editing.jumpHostId && !jumpChoices.some((h) => h.id === editing.jumpHostId) && (
                <option value={editing.jumpHostId}>{t('remote.form.jumpMissing')}</option>
              )}
              {jumpChoices.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
            <p className="help">{t('remote.groups.jumpHelp')}</p>
          </div>
          {editing.jumpHostId && (
            <VpnNeededField
              gateway={hosts.find((h) => h.id === editing.jumpHostId)}
              value={editing.vpnId || NO_VPN}
              autoUp={!!editing.vpnAutoUp}
              help={t('remote.vpn.groupHelp')}
              onChange={(value, autoUp) => {
                const vpnId = value === NO_VPN ? undefined : value
                setEditing({ ...editing, vpnId, vpnAutoUp: vpnId ? autoUp : undefined })
              }}
            />
          )}
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet
      title={t('remote.groups.title')}
      width={560}
      onClose={onClose}
      footer={
        <>
          {errorLine ?? <span className="help rv-sheet-help">{t('remote.groups.sub')}</span>}
          <button type="button" className="btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => edit(emptyGroup())}>
            {t('remote.groups.new')}
          </button>
        </>
      }
    >
      <div className="rv-form">
        {groups.length === 0 ? (
          <p className="help">{t('remote.groups.empty')}</p>
        ) : (
          <div className="rv-creds">
            {groups.map((g) => (
              <div key={g.id} className="rv-cred">
                <div className="rv-cred-text">
                  <span className="rv-cred-name">{g.name}</span>
                  {confirmDelete === g.id ? (
                    <span className="rv-cred-meta rv-group-confirm" role="alert">
                      {t('remote.groups.confirmDelete', { name: g.name })}
                      {g.inheriting > 0 && <> {plural(t, 'remote.groups.deleteOrphans', g.inheriting)}</>}
                    </span>
                  ) : (
                    <span className="rv-cred-meta">
                      {plural(t, 'remote.groups.hosts', g.hosts)}
                      {g.credentialName && (
                        <>
                          {' · '}
                          <span className="rv-cred-user">{g.credentialName}</span>
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className="rv-cred-actions">
                  {confirmDelete === g.id ? (
                    <>
                      <button type="button" className="btn-ghost small" onClick={() => (start.kind === 'delete' ? onClose() : setConfirmDelete(null))} autoFocus>
                        {t('common.cancel')}
                      </button>
                      <button type="button" className="btn-ghost small rv-cred-delete" onClick={() => remove(g.id)} disabled={busy}>
                        {t('remote.groups.deleteGroup')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn-ghost small" onClick={() => edit(toInput(g))}>
                        {t('remote.groups.editShort')}
                      </button>
                      <button type="button" className="btn-ghost small" onClick={() => setConfirmDelete(g.id)}>
                        {t('remote.groups.delete')}
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
