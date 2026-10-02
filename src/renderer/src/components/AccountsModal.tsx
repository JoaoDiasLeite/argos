import { useEffect, useState } from 'react'
import { AgentProvider, CCAccountStatus, ProviderAccountStatus } from '../types'
import Sheet from './Sheet'
import './AccountsModal.css'

interface Props {
  onClose: () => void
  /** Called whenever the account list changes so the rest of the app can refresh. */
  onChanged: () => void
}

const PROVIDER_LABEL: Record<AgentProvider, string> = { codex: 'Codex', gemini: 'Gemini' }

interface ProviderUiState {
  accounts: ProviderAccountStatus[]
  defaultId: string
  newName: string
  editingId: string | null
  editName: string
  loginCmd: { id: string; command: string } | null
}

const emptyProviderState: ProviderUiState = {
  accounts: [],
  defaultId: 'default',
  newName: '',
  editingId: null,
  editName: '',
  loginCmd: null
}

/** What one account row needs beyond the account itself. */
interface RowOps {
  defaultId: string
  meta: string
  editing: boolean
  editName: string
  onEditName: (v: string) => void
  onSaveRename: () => void
  onCancelRename: () => void
  onStartRename: () => void
  onLogin: () => void
  onMakeDefault: () => void
  onRemove: () => void
}

export default function AccountsModal({ onClose, onChanged }: Props) {
  const [accounts, setAccounts] = useState<CCAccountStatus[]>([])
  const [defaultId, setDefaultId] = useState('default')
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [loginCmd, setLoginCmd] = useState<{ id: string; command: string } | null>(null)
  const [providerUi, setProviderUi] = useState<Record<AgentProvider, ProviderUiState>>({
    codex: emptyProviderState,
    gemini: emptyProviderState
  })

  const refresh = async () => {
    const list = await window.electronAPI.accountsList()
    setAccounts(list.accounts)
    setDefaultId(list.defaultAccountId)
    onChanged()
  }

  const updateProvider = (p: AgentProvider, patch: Partial<ProviderUiState>) =>
    setProviderUi((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }))

  const refreshProvider = async (p: AgentProvider) => {
    const list = await window.electronAPI.providerAccountsList(p)
    updateProvider(p, { accounts: list.accounts, defaultId: list.defaultAccountId })
    onChanged()
  }

  useEffect(() => {
    refresh()
    refreshProvider('codex')
    refreshProvider('gemini')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addAccount = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    const acc = await window.electronAPI.accountsAdd(name)
    setNewName('')
    await refresh()
    setBusy(false)
    // Immediately kick off login for the freshly created account.
    login(acc.id)
  }

  const login = async (id: string) => {
    const res = await window.electronAPI.accountsLogin(id)
    setLoginCmd({ id, command: res.command })
  }

  const startRename = (a: CCAccountStatus) => {
    setEditingId(a.id)
    setEditName(a.name)
  }

  const saveRename = async () => {
    if (!editingId) return
    setBusy(true)
    await window.electronAPI.accountsRename(editingId, editName)
    setEditingId(null)
    await refresh()
    setBusy(false)
  }

  const remove = async (id: string) => {
    setBusy(true)
    await window.electronAPI.accountsRemove(id)
    if (loginCmd?.id === id) setLoginCmd(null)
    await refresh()
    setBusy(false)
  }

  const makeDefault = async (id: string) => {
    setBusy(true)
    await window.electronAPI.accountsSetDefault(id)
    await refresh()
    setBusy(false)
  }

  // ─── Codex / Gemini account actions — same shape as the Claude ones above,
  // parameterized by provider so both sections share one implementation. ────

  const addProviderAccount = async (p: AgentProvider) => {
    const name = providerUi[p].newName.trim()
    if (!name) return
    setBusy(true)
    const acc = await window.electronAPI.providerAccountsAdd(p, name)
    updateProvider(p, { newName: '' })
    await refreshProvider(p)
    setBusy(false)
    loginProviderAccount(p, acc.id)
  }

  const loginProviderAccount = async (p: AgentProvider, id: string) => {
    const res = await window.electronAPI.providerAccountsLogin(p, id)
    updateProvider(p, { loginCmd: { id, command: res.command } })
  }

  const startRenameProvider = (p: AgentProvider, a: ProviderAccountStatus) => {
    updateProvider(p, { editingId: a.id, editName: a.name })
  }

  const saveRenameProvider = async (p: AgentProvider) => {
    const editingId = providerUi[p].editingId
    if (!editingId) return
    setBusy(true)
    await window.electronAPI.providerAccountsRename(p, editingId, providerUi[p].editName)
    updateProvider(p, { editingId: null })
    await refreshProvider(p)
    setBusy(false)
  }

  const removeProviderAccount = async (p: AgentProvider, id: string) => {
    setBusy(true)
    await window.electronAPI.providerAccountsRemove(p, id)
    if (providerUi[p].loginCmd?.id === id) updateProvider(p, { loginCmd: null })
    await refreshProvider(p)
    setBusy(false)
  }

  const makeDefaultProvider = async (p: AgentProvider, id: string) => {
    setBusy(true)
    await window.electronAPI.providerAccountsSetDefault(p, id)
    await refreshProvider(p)
    setBusy(false)
  }

  // One row per account, whichever provider it belongs to: a dot for logged in or not,
  // the name, a "Default" chip and a muted line, with the actions on the right.
  const accountRow = (a: Pick<CCAccountStatus, 'id' | 'name' | 'isDefault' | 'loggedIn'>, o: RowOps) => (
    <div className="acct-row" key={a.id}>
      <i className={`acct-dot ${a.loggedIn ? 'ok' : ''}`} />
      <div className="acct-body">
        {o.editing ? (
          <input
            className="text-input acct-rename"
            value={o.editName}
            autoFocus
            onChange={(e) => o.onEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') o.onSaveRename()
              if (e.key === 'Escape') o.onCancelRename()
            }}
            onBlur={o.onSaveRename}
            aria-label="Account name"
          />
        ) : (
          <div className="acct-name">
            {a.name}
            {a.id === o.defaultId && <span className="chip">Default</span>}
          </div>
        )}
        <div className="acct-meta">{o.meta}</div>
      </div>
      <div className="acct-actions">
        {(!a.loggedIn || !a.isDefault) && (
          <button type="button" className="btn-ghost small" onClick={o.onLogin} disabled={busy}>
            {a.loggedIn ? 'Re-login' : 'Log in'}
          </button>
        )}
        {a.id !== o.defaultId && (
          <button type="button" className="btn-ghost small" onClick={o.onMakeDefault} disabled={busy}>
            Set default
          </button>
        )}
        <button type="button" className="btn-ghost small" onClick={o.onStartRename} disabled={busy}>
          Rename
        </button>
        {!a.isDefault && (
          <button type="button" className="btn-text danger" onClick={o.onRemove} disabled={busy}>
            Remove
          </button>
        )}
      </div>
    </div>
  )

  const loginBlock = (command: string, onRefresh: () => void, onDismiss: () => void) => (
    <div className="block warn acct-login">
      <div className="acct-login-title">Finish logging in</div>
      <p className="help">
        A terminal should have opened. Complete the login in your browser, then refresh. If no terminal opened,
        run this command yourself:
      </p>
      <code className="acct-cmd">{command}</code>
      <div className="acct-login-actions">
        <button type="button" className="btn-ghost small" onClick={onRefresh} disabled={busy}>
          Refresh status
        </button>
        <button type="button" className="btn-ghost small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )

  const addRow = (placeholder: string, value: string, onChange: (v: string) => void, onAdd: () => void) => (
    <div className="acct-add">
      <input
        className="text-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        spellCheck={false}
        aria-label={placeholder}
      />
      <button type="button" className="btn-ghost small" onClick={onAdd} disabled={!value.trim() || busy}>
        Add &amp; log in
      </button>
    </div>
  )

  const renderProviderSection = (p: AgentProvider) => {
    const ui = providerUi[p]
    return (
      <section className="acct-section" key={p}>
        <div className="eyebrow">{PROVIDER_LABEL[p]}</div>
        <p className="help">
          Each account is a separate {PROVIDER_LABEL[p]} login. Switch the active account from the sidebar
          account picker when a {PROVIDER_LABEL[p]} model is selected.
        </p>

        <div className="acct-rows">
          {ui.accounts.map((a) =>
            accountRow(a, {
              defaultId: ui.defaultId,
              meta: a.loggedIn
                ? [a.email, a.plan].filter(Boolean).join(' · ') || 'Logged in'
                : a.isDefault
                  ? `Uses this machine’s ${PROVIDER_LABEL[p]} CLI login`
                  : 'Run the login to authenticate this account',
              editing: ui.editingId === a.id,
              editName: ui.editName,
              onEditName: (v) => updateProvider(p, { editName: v }),
              onSaveRename: () => saveRenameProvider(p),
              onCancelRename: () => updateProvider(p, { editingId: null }),
              onStartRename: () => startRenameProvider(p, a),
              onLogin: () => loginProviderAccount(p, a.id),
              onMakeDefault: () => makeDefaultProvider(p, a.id),
              onRemove: () => removeProviderAccount(p, a.id)
            })
          )}
        </div>

        {ui.loginCmd &&
          loginBlock(
            ui.loginCmd.command,
            () => refreshProvider(p),
            () => updateProvider(p, { loginCmd: null })
          )}

        {addRow(
          `New ${PROVIDER_LABEL[p]} account name (e.g. Work, Personal)`,
          ui.newName,
          (v) => updateProvider(p, { newName: v }),
          () => addProviderAccount(p)
        )}
      </section>
    )
  }

  const renderAntigravitySection = () => (
    <section className="acct-section">
      <div className="eyebrow">Antigravity</div>
      <p className="help">
        Gemini models run through Antigravity, Google&rsquo;s agentic CLI, launched with <code>agy</code>. It uses a
        single machine-wide login stored in your OS keyring, so there is just one account.
      </p>

      <div className="acct-rows">
        <div className="acct-row">
          <i className="acct-dot ok" />
          <div className="acct-body">
            <div className="acct-name">Antigravity</div>
            <div className="acct-meta">Machine-wide login via agy, stored in your OS keyring</div>
          </div>
          <div className="acct-actions">
            <button type="button" className="btn-ghost small" onClick={() => loginProviderAccount('gemini', 'default')} disabled={busy}>
              Log in
            </button>
          </div>
        </div>
      </div>
      <p className="help">Log in opens Antigravity in a terminal. Complete the Google sign-in there.</p>
    </section>
  )

  return (
    <Sheet
      title="Accounts"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <span className="help">Esc closes</span>
        </>
      }
    >
      <div className="acct-page">
        <section className="acct-section">
          <div className="eyebrow">Claude</div>
          <p className="help">
            Each account is a separate Claude Code login. Switch the active account from the account picker in
            the sidebar; new chats use the selected account.
          </p>

          <div className="acct-rows">
            {accounts.map((a) =>
              accountRow(a, {
                defaultId,
                meta: a.loggedIn
                  ? [a.email, a.org, a.plan].filter(Boolean).join(' · ') || 'Logged in'
                  : a.isDefault
                    ? 'Uses this machine’s Claude Code login'
                    : 'Run the login to authenticate this account',
                editing: editingId === a.id,
                editName,
                onEditName: setEditName,
                onSaveRename: saveRename,
                onCancelRename: () => setEditingId(null),
                onStartRename: () => startRename(a),
                onLogin: () => login(a.id),
                onMakeDefault: () => makeDefault(a.id),
                onRemove: () => remove(a.id)
              })
            )}
          </div>

          {loginCmd && loginBlock(loginCmd.command, refresh, () => setLoginCmd(null))}

          {addRow('New account name (e.g. Work, Personal)', newName, setNewName, addAccount)}
        </section>

        {renderProviderSection('codex')}
        {renderAntigravitySection()}
      </div>
    </Sheet>
  )
}
