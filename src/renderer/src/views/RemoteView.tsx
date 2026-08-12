import { useEffect, useMemo, useState } from 'react'
import { SshHostPublic, SshHostInput, SshAuthType, SshKeyInfo, WslDistro, SourceInfo } from '../types'
import Menu, { MoreIcon } from '../components/Menu'
import './views.css'
import './RemoteView.css'

interface Props {
  onConnect: (host: SshHostPublic) => void
  onConnectWsl: (distro: string, cwd?: string) => void
  /** Opens the full Remote Session workspace (SFTP browser + terminal + history) for a host.
   *  `newSession` forces another session on a target that already has one; without it the
   *  existing session is focused instead. */
  onOpenSession: (host: SshHostPublic, newSession?: boolean) => void
  /** Same, for a WSL distro. */
  onOpenWslSession: (distro: string, newSession?: boolean) => void
  /** Distro names with a session open right now. */
  openWslSessions?: string[]
  /** SSH host ids with a session that has actually CONNECTED. Not merely "a tab is open":
   *  a refused connection leaves a session sitting there, and treating that as proof of
   *  reachability is what used to leave the dot green next to a connection error. */
  openSshSessions?: string[]
  /** SSH host ids whose open sessions have all failed to connect. */
  failedSshSessions?: string[]
}

/** Which screen the view is showing. SSH keys are a sub-screen behind the header's key
 *  button rather than a third section on the list — they're setup, not day-to-day. */
type Screen = 'targets' | 'keys'
/** The type filter above the list. */
type Kind = 'all' | 'wsl' | 'ssh'

/**
 * The live-status dot at the head of every row.
 *
 * `idle` is deliberately NOT an error state — it's "we don't know / it isn't up right now",
 * which for a stopped WSL distro or an untested SSH host is entirely normal. Red is reserved
 * for something that actually failed: a failed Test, or an open session that couldn't connect.
 */
type DotState = 'idle' | 'checking' | 'ok' | 'error' | 'live'

/**
 * The outcome of a row's Test / Check action. `kind` matters: only a CONNECTION probe may
 * move the status dot. A Claude Code check that fails says nothing about whether the box is
 * reachable — it usually means the CLI isn't installed there — so it prints its message and
 * leaves the dot alone.
 */
interface ProbeResult {
  ok: boolean
  message: string
  kind: 'conn' | 'claude'
}

function emptyHost(): SshHostInput {
  return { name: '', host: '', port: 22, username: '', authType: 'password' }
}

export default function RemoteView({
  onConnect,
  onConnectWsl,
  onOpenSession,
  onOpenWslSession,
  openWslSessions = [],
  openSshSessions = [],
  failedSshSessions = []
}: Props) {
  const [hosts, setHosts] = useState<SshHostPublic[]>([])
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [wslPaths, setWslPaths] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<SshHostInput | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, ProbeResult>>({})
  const [wslTest, setWslTest] = useState<Record<string, ProbeResult>>({})
  const [wslTesting, setWslTesting] = useState<string | null>(null)
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const [screen, setScreen] = useState<Screen>('targets')
  const [kind, setKind] = useState<Kind>('all')
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  /** Names of WSL distros whose working-dir input is expanded under the row. */
  const [editingCwd, setEditingCwd] = useState<string[]>([])

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

  /** Targets we've held a session on during this app run — see the effect below. */
  const [wasLiveWsl, setWasLiveWsl] = useState<string[]>([])
  const [wasLiveSsh, setWasLiveSsh] = useState<string[]>([])

  // Opening or closing a session invalidates what this screen knows about its targets,
  // and closing one from the inline tab strip doesn't remount the view (so the mount
  // load() above never re-runs). Two things happen here:
  //
  //  1. Re-list the distros, because `running` was only ever a snapshot — connecting
  //     boots a stopped distro, and WSL leaves it up after you disconnect.
  //  2. Remember the target. A host that was serving a live shell a moment ago is
  //     demonstrably reachable, so it stays green after the session closes instead of
  //     dropping back to "unknown" — which is the only signal we have for SSH, where
  //     there's nothing cheap to re-probe.
  const openKey = `${openWslSessions.join('|')}#${openSshSessions.join('|')}`
  useEffect(() => {
    if (openWslSessions.length > 0) {
      setWasLiveWsl((prev) => [...new Set([...prev, ...openWslSessions])])
    }
    if (openSshSessions.length > 0) {
      setWasLiveSsh((prev) => [...new Set([...prev, ...openSshSessions])])
    }
    window.electronAPI.wslList().then(setDistros)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey])

  const probeWsl = async (name: string, kind: 'conn' | 'claude') => {
    setWslTesting(name)
    const res = kind === 'conn'
      ? await window.electronAPI.wslTest(name)
      : await window.electronAPI.wslTestClaude(name)
    setWslTest((prev) => ({ ...prev, [name]: { ...res, kind } }))
    setWslTesting(null)
    // Either probe succeeding means the distro booted, so its dot should go live without
    // waiting for the next full reload.
    if (res.ok) setDistros((prev) => prev.map((d) => (d.name === name ? { ...d, running: true } : d)))
  }

  const save = async () => {
    if (!editing || !editing.name.trim() || !editing.host.trim()) return
    setHosts(await window.electronAPI.sshSave(editing))
    setEditing(null)
  }

  const remove = async (id: string) => setHosts(await window.electronAPI.sshDelete(id))

  const probeHost = async (id: string, kind: 'conn' | 'claude') => {
    setTesting(id)
    const res = kind === 'conn'
      ? await window.electronAPI.sshTest(id)
      : await window.electronAPI.sshTestClaude(id)
    setTestResult((prev) => ({ ...prev, [id]: { ...res, kind } }))
    setTesting(null)
  }

  const toggleCwd = (name: string) =>
    setEditingCwd((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))

  // ── Filtering ──────────────────────────────────────────────────────────────
  // Hidden distros are excluded from the counts and the filter entirely — they live in
  // their own collapsed disclosure at the end of the WSL section.
  const visibleDistros = useMemo(() => distros.filter((d) => !hidden.includes(d.name)), [distros, hidden])
  const hiddenDistros = useMemo(() => distros.filter((d) => hidden.includes(d.name)), [distros, hidden])

  const q = query.trim().toLowerCase()
  const matchesDistro = (d: WslDistro) => !q || d.name.toLowerCase().includes(q)
  const matchesHost = (h: SshHostPublic) =>
    !q ||
    h.name.toLowerCase().includes(q) ||
    h.host.toLowerCase().includes(q) ||
    h.username.toLowerCase().includes(q)

  const shownDistros = kind === 'ssh' ? [] : visibleDistros.filter(matchesDistro)
  const shownHosts = kind === 'wsl' ? [] : hosts.filter(matchesHost)
  const nothingMatches = shownDistros.length === 0 && shownHosts.length === 0

  // ── Row pieces shared by both target kinds ─────────────────────────────────
  const dotTitle: Record<DotState, string> = {
    idle: 'Not running — connecting will start it',
    checking: 'Testing…',
    ok: 'Reachable',
    error: 'Last test failed',
    live: 'Session open'
  }
  /** The chip with its status dot riding the corner, avatar-presence style — a dot in
   *  its own left-hand column read as a stray speck floating away from the row. */
  const Avatar = ({ state, kind: k, children }: { state: DotState; kind?: 'wsl'; children: React.ReactNode }) => (
    <span className="rt-avatar">
      <span className={`rt-chip ${k ?? ''}`}>{children}</span>
      <span className={`rt-dot ${state}`} title={dotTitle[state]} aria-label={dotTitle[state]} />
    </span>
  )

  // An open session outranks everything else: you cannot hold a live terminal on a
  // target that isn't reachable, and unlike `running` (sampled once by `wsl -l -v` at
  // mount) or a manual Test, it can't go stale. Without this the screen contradicted
  // itself — three open session tabs above three "not running" dots.
  const wslDotState = (d: WslDistro): DotState => {
    if (openWslSessions.includes(d.name)) return 'live'
    if (wslTesting === d.name) return 'checking'
    const probe = wslTest[d.name]
    if (probe && probe.kind === 'conn' && !probe.ok) return 'error'
    return d.running || wasLiveWsl.includes(d.name) ? 'ok' : 'idle'
  }
  const hostDotState = (h: SshHostPublic): DotState => {
    if (openSshSessions.includes(h.id)) return 'live'
    if (testing === h.id) return 'checking'
    // A session that's open and failing is present-tense evidence, so it outranks both an
    // older Test result and the "was reachable earlier" memory.
    if (failedSshSessions.includes(h.id)) return 'error'
    const res = testResult[h.id]
    if (res && res.kind === 'conn') return res.ok ? 'ok' : 'error'
    return wasLiveSsh.includes(h.id) ? 'ok' : 'idle'
  }

  if (screen === 'keys') {
    return (
      <div className="view">
        <div className="view-header">
          <div className="rt-col rt-head">
            <div className="rt-header-title">
              <button className="icon-btn" onClick={() => setScreen('targets')} title="Back to Remote & WSL" aria-label="Back to Remote & WSL">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
                </svg>
              </button>
              <div>
                <h1>SSH keys</h1>
                <p className="view-sub">
                  Keys found in <code>~/.ssh</code>. Copy a public key into a server&apos;s{' '}
                  <code>authorized_keys</code> to enable key auth. Private keys never leave your machine.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="view-scroll">
          <div className="rt-col">
            <div className="rt-list">
              {keys.map((k) => {
                const oneLiner = k.publicKey ? `echo '${k.publicKey}' >> ~/.ssh/authorized_keys` : null
                return (
                  <div key={k.privatePath} className="rt-row">
                    <span className="rt-avatar">
                      <span className="rt-chip key">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.3-8.3" /><path d="m17 5 3 3" /><path d="m15 7 2 2" />
                        </svg>
                      </span>
                    </span>
                    <span className="rt-name">{k.name}</span>
                    {k.type && <span className="rt-tag">{k.type.replace(/^ssh-/, '')}</span>}
                    <div className="rt-detail">
                      <span className="rt-meta">{k.comment || (k.publicKey ? '' : 'no .pub alongside this key')}</span>
                    </div>
                    <div className="rt-actions">
                      {k.publicKey && (
                        <button className="btn-ghost small" onClick={() => copy(k.publicKey!, `pub:${k.privatePath}`)}>
                          {copied === `pub:${k.privatePath}` ? '✓ Copied' : 'Copy public key'}
                        </button>
                      )}
                      <Menu
                        triggerClass="rt-more"
                        triggerTitle="More"
                        triggerContent={<MoreIcon />}
                        items={[
                          {
                            label: copied === `cmd:${k.privatePath}` ? '✓ Copied' : 'Copy install command',
                            disabled: !oneLiner,
                            onClick: () => oneLiner && copy(oneLiner, `cmd:${k.privatePath}`)
                          },
                          { label: 'Copy private key path', onClick: () => copy(k.privatePath, `path:${k.privatePath}`) }
                        ]}
                      />
                    </div>
                  </div>
                )
              })}

              <div className="rt-row rt-row-generate">
                <span className="rt-avatar">
                  <span className="rt-chip key">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </span>
                <span className="rt-name">Generate new key</span>
                <div className="rt-detail">
                  <span className="rt-meta">ed25519 key pair in ~/.ssh</span>
                </div>
                <div className="rt-actions always">
                  <input
                    className="text-input mono rt-gen-input"
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
              {genError && <div className="rt-note err">{genError}</div>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view-header">
        <div className="rt-col rt-head">
          <div>
            <h1>Remote &amp; WSL</h1>
            <p className="view-sub">Run Claude Code inside a WSL distro or on a remote SSH host. Each target needs Claude Code installed and logged in there.</p>
          </div>
          <div className="header-actions">
            <button className="icon-btn" onClick={() => setScreen('keys')} title="SSH keys" aria-label="SSH keys">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.3-8.3" /><path d="m17 5 3 3" /><path d="m15 7 2 2" />
              </svg>
            </button>
            <button className="btn-primary" onClick={() => setEditing(emptyHost())}>+ Add SSH host</button>
          </div>
        </div>
      </div>

      <div className="view-scroll">
        <div className="rt-col">
          <div className="rt-filter">
            <div className="rt-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
              </svg>
              <input
                className="rt-search-input"
                placeholder="Filter targets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter targets"
              />
              {query && (
                <button className="rt-search-clear" onClick={() => setQuery('')} title="Clear" aria-label="Clear filter">×</button>
              )}
            </div>
            <div className="seg-control small">
              {([
                ['all', 'All', visibleDistros.length + hosts.length],
                ['wsl', 'WSL', visibleDistros.length],
                ['ssh', 'SSH', hosts.length]
              ] as [Kind, string, number][]).map(([k, label, n]) => (
                <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {label} <span className="rt-seg-count">{n}</span>
                </button>
              ))}
            </div>
          </div>

          {nothingMatches && (
            <div className="view-empty small">
              {q ? `Nothing matches “${query}”.` : 'No targets yet.'}
            </div>
          )}

          {shownDistros.length > 0 && (
            <>
              <div className="rt-section">WSL distros</div>
              <div className="rt-list">
                {shownDistros.map((d) => {
                  const acct = accountFor(d.name)
                  const cwd = wslPaths[d.name] ?? ''
                  const res = wslTest[d.name]
                  return (
                    <div key={d.name} className="rt-row-wrap">
                      <div
                        className="rt-row clickable"
                        onClick={() => onOpenWslSession(d.name)}
                        title={openWslSessions.includes(d.name) ? `Go to ${d.name}` : `Connect to ${d.name}`}
                      >
                        <Avatar state={wslDotState(d)} kind="wsl">{d.name.charAt(0)}</Avatar>
                        <span className="rt-name">{d.name}</span>
                        {d.isDefault && <span className="rt-tag">default</span>}
                        <div className="rt-detail">
                          <span className="rt-meta mono">wsl -d {d.name}</span>
                          {acct?.email && <span className="rt-meta acct">{acct.email}</span>}
                        </div>
                        {/* The whole row is a Connect shortcut, so the action cluster must not bubble into it. */}
                        <div className="rt-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="btn-primary small"
                            onClick={() => onOpenWslSession(d.name, true)}
                            title={openWslSessions.includes(d.name) ? 'Open another session' : 'Connect'}
                          >
                            Connect
                          </button>
                          <Menu
                            triggerClass="rt-more"
                            triggerTitle="More"
                            triggerContent={<MoreIcon />}
                            items={[
                              { label: 'New chat here', onClick: () => onConnectWsl(d.name, cwd || undefined) },
                              { label: cwd ? `Working dir · ${cwd}` : 'Set working dir…', onClick: () => toggleCwd(d.name) },
                              { label: wslTesting === d.name ? 'Testing…' : 'Test connection', disabled: wslTesting === d.name, onClick: () => probeWsl(d.name, 'conn') },
                              { label: 'Check Claude Code', disabled: wslTesting === d.name, onClick: () => probeWsl(d.name, 'claude') },
                              { label: 'Hide from Usage & Projects', danger: true, onClick: () => setDistroHidden(d.name, true) }
                            ]}
                          />
                        </div>
                      </div>
                      {editingCwd.includes(d.name) && (
                        <div className="rt-sub">
                          <input
                            className="text-input mono rt-cwd-input"
                            autoFocus
                            placeholder="working dir (optional, e.g. /home/you/repo)"
                            value={cwd}
                            onChange={(e) => setWslPaths((prev) => ({ ...prev, [d.name]: e.target.value }))}
                            onKeyDown={(e) => e.key === 'Enter' && toggleCwd(d.name)}
                          />
                          <button className="btn-ghost small" onClick={() => toggleCwd(d.name)}>Done</button>
                        </div>
                      )}
                      {res && <div className={`rt-note ${res.ok ? 'ok' : 'err'}`}>{res.message}</div>}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* Hidden distros are noise on the main list — one disclosure line instead of a
              card each, since the only thing you can do with them is un-hide them. */}
          {kind !== 'ssh' && hiddenDistros.length > 0 && (
            <div className="rt-hidden">
              <button className="rt-hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showHidden ? 'open' : ''} aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {hiddenDistros.length} hidden {hiddenDistros.length === 1 ? 'distro' : 'distros'}
              </button>
              {showHidden && (
                <div className="rt-list">
                  {hiddenDistros.map((d) => (
                    <div key={d.name} className="rt-row muted">
                      <span className="rt-avatar"><span className="rt-chip wsl">{d.name.charAt(0)}</span></span>
                      <span className="rt-name">{d.name}</span>
                      <div className="rt-detail">
                        <span className="rt-meta">Excluded from Usage &amp; Projects</span>
                      </div>
                      <div className="rt-actions always">
                        <button className="btn-ghost small" onClick={() => setDistroHidden(d.name, false)}>Show</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {shownHosts.length > 0 && (
            <>
              <div className="rt-section">SSH hosts</div>
              <div className="rt-list">
                {shownHosts.map((host) => {
                  const res = testResult[host.id]
                  return (
                    <div key={host.id} className="rt-row-wrap">
                      <div
                        className="rt-row clickable"
                        onClick={() => onOpenSession(host)}
                        title={openSshSessions.includes(host.id) ? `Go to ${host.name}` : `Connect to ${host.name}`}
                      >
                        <Avatar state={hostDotState(host)}>{host.name.charAt(0)}</Avatar>
                        <span className="rt-name">{host.name}</span>
                        <span className="rt-tag">{host.authType}</span>
                        <div className="rt-detail">
                          <span className="rt-meta mono">
                            {host.username}@{host.host}:{host.port}
                          </span>
                          {host.remotePath && <span className="rt-meta mono">{host.remotePath}</span>}
                        </div>
                        {/* The whole row is a Connect shortcut, so the action cluster must not bubble into it. */}
                        <div className="rt-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="btn-primary small"
                            onClick={() => onOpenSession(host, true)}
                            title={openSshSessions.includes(host.id) ? 'Open another session' : 'Connect'}
                          >
                            Connect
                          </button>
                          <Menu
                            triggerClass="rt-more"
                            triggerTitle="More"
                            triggerContent={<MoreIcon />}
                            items={[
                              { label: 'New chat here', onClick: () => onConnect(host) },
                              { label: testing === host.id ? 'Testing…' : 'Test connection', disabled: testing === host.id, onClick: () => probeHost(host.id, 'conn') },
                              { label: 'Check Claude Code', disabled: testing === host.id, onClick: () => probeHost(host.id, 'claude') },
                              {
                                label: 'Edit…',
                                onClick: () =>
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
                              },
                              { label: 'Delete', danger: true, onClick: () => remove(host.id) }
                            ]}
                          />
                        </div>
                      </div>
                      {res && <div className={`rt-note ${res.ok ? 'ok' : 'err'}`}>{res.message}</div>}
                    </div>
                  )
                })}
              </div>
            </>
          )}
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
