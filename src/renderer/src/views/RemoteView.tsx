import { useEffect, useState } from 'react'
import { SshHostPublic, SshHostInput, SshAuthType, SshKeyInfo, WslDistro, SourceInfo } from '../types'
import './views.css'
import './RemoteView.css'

interface Props {
  onConnect: (host: SshHostPublic) => void
  onConnectWsl: (distro: string, cwd?: string) => void
  /** Opens the full Remote Session workspace (SFTP browser + terminal + history) for a host. */
  onOpenSession: (host: SshHostPublic) => void
  /** Opens the full Remote Session workspace (file browser + terminal + history) for a WSL distro. */
  onOpenWslSession: (distro: string) => void
}

function emptyHost(): SshHostInput {
  return { name: '', host: '', port: 22, username: '', authType: 'password' }
}

export default function RemoteView({ onConnect, onConnectWsl, onOpenSession, onOpenWslSession }: Props) {
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [wslPaths, setWslPaths] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<SshHostInput | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [wslTest, setWslTest] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [wslTesting, setWslTesting] = useState<string | null>(null)
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const load = async () => {
    setHosts(await window.electronAPI.sshList())
    setDistros(await window.electronAPI.wslList())
    setHidden(await window.electronAPI.wslHidden())
    setSources(await window.electronAPI.ccSources())
    setKeys(await window.electronAPI.sshKeysList())
  }

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  const generate = async () => {
    const name = newKeyName.trim()
    if (!name || generating) return
    setGenerating(true)
    setGenError(null)
    const res = await window.electronAPI.sshKeysGenerate(name)
    setGenerating(false)
    if (res.ok) {
      setNewKeyName('')
      setKeys(await window.electronAPI.sshKeysList())
    } else {
      setGenError(res.error)
    }
  }

  const keyLabel = (k: SshKeyInfo) =>
    `${k.name}${k.type ? ` · ${k.type.replace(/^ssh-/, '')}` : ''}${k.comment ? ` · ${k.comment}` : ''}`
  const accountFor = (distro: string) => sources.find((s) => s.id === `wsl:${distro}`)?.account
  const setDistroHidden = async (name: string, hide: boolean) => {
    setHidden(await window.electronAPI.wslSetHidden(name, hide))
    setSources(await window.electronAPI.ccSources())
  }
  useEffect(() => {
    load()
  }, [])

  const testWslDistro = async (name: string) => {
    setWslTesting(name)
    const res = await window.electronAPI.wslTest(name)
    setWslTest((prev) => ({ ...prev, [name]: res }))
    setWslTesting(null)
  }

  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.host.trim()) return
    setHosts(await window.electronAPI.sshSave(editing))
    setEditing(null)
  }

  const remove = async (id: string) => setHosts(await window.electronAPI.sshDelete(id))

  const test = async (id: string) => {
    setTesting(id)
    const res = await window.electronAPI.sshTest(id)
    setTestResult((prev) => ({ ...prev, [id]: res }))
    setTesting(null)
  }

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Remote &amp; WSL</h1>
          <p className="view-sub">Run Claude Code inside a WSL distro or on a remote SSH host. Each target needs Claude Code installed and logged in there.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing(emptyHost())}>+ Add SSH host</button>
      </div>

      <div className="view-scroll">
        <div className="remote-section-title">
          WSL distros
          {distros.length > 0 && <span className="remote-count">{distros.length}</span>}
        </div>
        {distros.length === 0 ? (
          <div className="view-empty small">No WSL distros detected on this machine.</div>
        ) : (
          <div className="ssh-list" style={{ marginBottom: 28 }}>
            {distros.map((d) => {
              const isHidden = hidden.includes(d.name)
              if (isHidden) {
                return (
                  <div key={d.name} className="ssh-card hidden-card">
                    <div className="ssh-icon-chip wsl">{d.name.charAt(0)}</div>
                    <div className="ssh-card-main">
                      <div className="ssh-card-name muted">
                        {d.name}
                        <span className="badge scope">hidden</span>
                      </div>
                      <div className="ssh-card-target muted">Excluded from Usage &amp; Projects</div>
                    </div>
                    <div className="ssh-card-actions">
                      <button className="btn-ghost small" onClick={() => setDistroHidden(d.name, false)}>Show</button>
                    </div>
                  </div>
                )
              }
              return (
                <div key={d.name} className="ssh-card">
                  <div className="ssh-icon-chip wsl">{d.name.charAt(0)}</div>
                  <div className="ssh-card-main">
                    <div className="ssh-card-name">
                      {d.name}
                      {d.isDefault && <span className="badge scope">default</span>}
                    </div>
                    <div className="ssh-card-target">wsl -d {d.name}</div>
                    {accountFor(d.name)?.email && (
                      <div className="ssh-card-acct">
                        {accountFor(d.name)!.email}
                        {accountFor(d.name)!.plan ? ` · ${accountFor(d.name)!.plan}` : ''}
                      </div>
                    )}
                    <input
                      className="text-input mono wsl-path"
                      placeholder="working dir (optional, e.g. /home/you/repo)"
                      value={wslPaths[d.name] ?? ''}
                      onChange={(e) => setWslPaths((prev) => ({ ...prev, [d.name]: e.target.value }))}
                    />
                    {wslTest[d.name] && (
                      <div className={`ssh-test ${wslTest[d.name].ok ? 'ok' : 'err'}`}>{wslTest[d.name].message}</div>
                    )}
                  </div>
                  <div className="ssh-card-actions">
                    <button className="btn-primary small" onClick={() => onOpenWslSession(d.name)}>Connect</button>
                    <button className="btn-ghost small" onClick={() => onConnectWsl(d.name, wslPaths[d.name] || undefined)}>
                      New chat here
                    </button>
                    <button className="btn-ghost small" onClick={() => testWslDistro(d.name)} disabled={wslTesting === d.name}>
                      {wslTesting === d.name ? 'Testing…' : 'Test'}
                    </button>
                    <button className="btn-text" onClick={() => setDistroHidden(d.name, true)} title="Hide from Usage & Projects">Remove</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="remote-section-title">SSH hosts</div>
        {hosts.length === 0 ? (
          <div className="view-empty small">No remote hosts yet.</div>
        ) : (
          <div className="ssh-list">
            {hosts.map((host) => (
              <div key={host.id} className="ssh-card">
                <div className="ssh-icon-chip">{host.name.charAt(0)}</div>
                <div className="ssh-card-main">
                  <div className="ssh-card-name">{host.name}</div>
                  <div className="ssh-card-target">
                    {host.username}@{host.host}:{host.port}
                    <span className="badge scope">{host.authType}</span>
                  </div>
                  {host.remotePath && <div className="ssh-card-path">{host.remotePath}</div>}
                  {host.authType === 'key' && host.privateKeyPath && (
                    <div className="ssh-card-path">
                      key: {host.privateKeyPath.split(/[\\/]/).pop()}
                    </div>
                  )}
                  {testResult[host.id] && (
                    <div className={`ssh-test ${testResult[host.id].ok ? 'ok' : 'err'}`}>
                      {testResult[host.id].message}
                    </div>
                  )}
                </div>
                <div className="ssh-card-actions">
                  <button className="btn-primary small" onClick={() => onOpenSession(host)}>Connect</button>
                  <button className="btn-ghost small" onClick={() => onConnect(host)}>New chat here</button>
                  <button className="btn-ghost small" onClick={() => test(host.id)} disabled={testing === host.id}>
                    {testing === host.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    className="btn-ghost small"
                    onClick={() =>
                      setEditing({
                        id: host.id,
                        name: host.name,
                        host: host.host,
                        port: host.port,
                        username: host.username,
                        authType: host.authType,
                        privateKeyPath: host.privateKeyPath,
                        remotePath: host.remotePath,
                        claudePath: host.claudePath
                      })
                    }
                  >
                    Edit
                  </button>
                  <button className="btn-text danger" onClick={() => remove(host.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="remote-section-title" style={{ marginTop: 28 }}>
          SSH keys
          {keys.length > 0 && <span className="remote-count">{keys.length}</span>}
        </div>
        <p className="view-sub keys-intro">
          Keys found in <code>~/.ssh</code>. Copy a public key into a server&apos;s{' '}
          <code>authorized_keys</code> to enable key auth. Private keys never leave your machine.
        </p>

        <div className="ssh-list">
          {keys.map((k) => {
            const oneLiner = k.publicKey
              ? `echo '${k.publicKey}' >> ~/.ssh/authorized_keys`
              : null
            return (
              <div key={k.privatePath} className="ssh-card">
                <div className="ssh-icon-chip key">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.3-8.3" /><path d="m17 5 3 3" /><path d="m15 7 2 2" />
                  </svg>
                </div>
                <div className="ssh-card-main">
                  <div className="ssh-card-name">
                    {k.name}
                    {k.type && <span className="badge scope">{k.type.replace(/^ssh-/, '')}</span>}
                  </div>
                  {k.comment && <div className="ssh-card-target">{k.comment}</div>}
                  {!k.publicKey && (
                    <div className="ssh-card-path">no public key (.pub) alongside this key</div>
                  )}
                  {oneLiner && (
                    <div className="key-oneliner">
                      <code>{oneLiner}</code>
                      <button
                        className="btn-ghost small"
                        onClick={() => copy(oneLiner, `cmd:${k.privatePath}`)}
                      >
                        {copied === `cmd:${k.privatePath}` ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="ssh-card-actions">
                  {k.publicKey && (
                    <button
                      className="btn-primary small"
                      onClick={() => copy(k.publicKey!, `pub:${k.privatePath}`)}
                    >
                      {copied === `pub:${k.privatePath}` ? '✓ Copied' : 'Copy public key'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          <div className="ssh-card key-generate">
            <div className="ssh-icon-chip key">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div className="ssh-card-main">
              <div className="ssh-card-name">Generate new key</div>
              <div className="ssh-card-target">Creates an ed25519 key pair in ~/.ssh</div>
              {genError && <div className="ssh-test err">{genError}</div>}
            </div>
            <div className="ssh-card-actions">
              <input
                className="text-input mono"
                style={{ width: 180 }}
                placeholder="id_ed25519_new"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generate()}
              />
              <button className="btn-primary small" onClick={generate} disabled={!newKeyName.trim() || generating}>
                {generating ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing.id ? 'Edit host' : 'Add host'}</h3>
              <button className="icon-btn" onClick={() => setEditing(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="agent-edit-row">
                <div className="form-group grow">
                  <label>Name</label>
                  <input className="text-input" value={editing.name} placeholder="dev box" onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
                </div>
                <div className="form-group" style={{ width: 90 }}>
                  <label>Port</label>
                  <input className="text-input" type="number" value={editing.port} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 22 })} />
                </div>
              </div>
              <div className="agent-edit-row">
                <div className="form-group grow">
                  <label>Host</label>
                  <input className="text-input mono" value={editing.host} placeholder="192.168.1.10 or host.example.com" onChange={(e) => setEditing({ ...editing, host: e.target.value })} />
                </div>
                <div className="form-group grow">
                  <label>Username</label>
                  <input className="text-input mono" value={editing.username} placeholder="ubuntu" onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label>Authentication</label>
                <div className="seg-control">
                  {(['password', 'key', 'agent'] as SshAuthType[]).map((a) => (
                    <button key={a} className={editing.authType === a ? 'on' : ''} onClick={() => setEditing({ ...editing, authType: a })}>
                      {a === 'password' ? 'Password' : a === 'key' ? 'Private key' : 'SSH agent'}
                    </button>
                  ))}
                </div>
              </div>
              {editing.authType === 'password' && (
                <div className="form-group">
                  <label>Password</label>
                  <input className="text-input" type="password" placeholder={editing.id ? '•••• (unchanged)' : ''} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                </div>
              )}
              {editing.authType === 'key' && (
                <>
                  {keys.length > 0 && (
                    <div className="form-group">
                      <label>Discovered key</label>
                      <select
                        className="text-input"
                        value={keys.some((k) => k.privatePath === editing.privateKeyPath) ? editing.privateKeyPath : ''}
                        onChange={(e) => setEditing({ ...editing, privateKeyPath: e.target.value })}
                      >
                        <option value="">Default (agent / ssh config) or custom path below</option>
                        {keys.map((k) => (
                          <option key={k.privatePath} value={k.privatePath}>{keyLabel(k)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="form-group">
                    <label>Private key path</label>
                    <input className="text-input mono" value={editing.privateKeyPath ?? ''} placeholder="C:\Users\you\.ssh\id_ed25519" onChange={(e) => setEditing({ ...editing, privateKeyPath: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Passphrase (if any)</label>
                    <input className="text-input" type="password" placeholder={editing.id ? '•••• (unchanged)' : ''} onChange={(e) => setEditing({ ...editing, passphrase: e.target.value })} />
                  </div>
                </>
              )}
              <div className="agent-edit-row">
                <div className="form-group grow">
                  <label>Remote project path</label>
                  <input className="text-input mono" value={editing.remotePath ?? ''} placeholder="/home/you/myrepo" onChange={(e) => setEditing({ ...editing, remotePath: e.target.value })} />
                </div>
                <div className="form-group grow">
                  <label>claude path (optional)</label>
                  <input className="text-input mono" value={editing.claudePath ?? ''} placeholder="claude" onChange={(e) => setEditing({ ...editing, claudePath: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={save} disabled={!editing.name.trim() || !editing.host.trim() || !editing.username.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
