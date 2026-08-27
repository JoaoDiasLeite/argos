import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Notifications
  notify: (title: string, body: string) => ipcRenderer.invoke('app:notify', { title, body }),
  setZoom: (factor: number) => ipcRenderer.invoke('app:set-zoom', factor),

  // Auto-update
  updaterState: () => ipcRenderer.invoke('updater:state'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterEvent: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('updater:event', fn)
    return () => ipcRenderer.removeListener('updater:event', fn)
  },

  // Tray / quick-launcher overlay — events received by the MAIN window
  onNewChat: (cb: (folderPath?: string) => void) => {
    const fn = (_: unknown, folderPath?: string) => cb(folderPath)
    ipcRenderer.on('app:new-chat', fn)
    return () => ipcRenderer.removeListener('app:new-chat', fn)
  },
  onOverlayPrompt: (cb: (payload: { prompt: string; quick?: boolean }) => void) => {
    const fn = (_: unknown, payload: { prompt: string; quick?: boolean }) => cb(payload)
    ipcRenderer.on('app:overlay-prompt', fn)
    return () => ipcRenderer.removeListener('app:overlay-prompt', fn)
  },
  onOpenSession: (cb: (sessionId: string) => void) => {
    const fn = (_: unknown, sessionId: string) => cb(sessionId)
    ipcRenderer.on('app:open-session', fn)
    return () => ipcRenderer.removeListener('app:open-session', fn)
  },

  // Quick-launcher overlay — calls made by the OVERLAY window
  overlaySubmit: (payload: { prompt: string; quick?: boolean }) =>
    ipcRenderer.send('overlay:submit', payload),
  overlayOpenSession: (sessionId: string) => ipcRenderer.send('overlay:open-session', sessionId),
  overlayOpenMain: () => ipcRenderer.send('overlay:open-main'),
  overlayHide: () => ipcRenderer.send('overlay:hide'),
  overlayShortcut: () => ipcRenderer.invoke('overlay:shortcut'),
  onOverlayShown: (cb: () => void) => {
    const fn = () => cb()
    ipcRenderer.on('overlay:shown', fn)
    return () => ipcRenderer.removeListener('overlay:shown', fn)
  },

  // Window controls (custom frameless title bar)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowGetBounds: () => ipcRenderer.invoke('window:get-bounds'),
  windowSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('window:set-bounds', bounds),
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const fn = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximized', fn)
    return () => ipcRenderer.removeListener('window:maximized', fn)
  },

  // Auth
  authStatus: () => ipcRenderer.invoke('auth:status'),
  setAuthMode: (mode: string) => ipcRenderer.invoke('auth:set-mode', mode),
  setApiKey: (key: string) => ipcRenderer.invoke('auth:set-api-key', key),
  clearApiKey: () => ipcRenderer.invoke('auth:clear-api-key'),
  hasApiKey: () => ipcRenderer.invoke('auth:has-api-key'),

  // Accounts (multiple Claude Code logins)
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsAdd: (name: string) => ipcRenderer.invoke('accounts:add', name),
  accountsRename: (id: string, name: string) => ipcRenderer.invoke('accounts:rename', id, name),
  accountsRemove: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  accountsSetDefault: (id: string) => ipcRenderer.invoke('accounts:set-default', id),
  accountsLogin: (id: string) => ipcRenderer.invoke('accounts:login', id),

  // Agent CLI login status (Codex / Gemini) — machine-default login only
  agentCliStatus: (id: string) => ipcRenderer.invoke('agentcli:status', id),
  agentCliLogin: (id: string) => ipcRenderer.invoke('agentcli:login', id),

  // Provider accounts (multiple Codex / Gemini logins)
  providerAccountsList: (provider: string) => ipcRenderer.invoke('provider-accounts:list', provider),
  providerAccountsAdd: (provider: string, name: string) =>
    ipcRenderer.invoke('provider-accounts:add', provider, name),
  providerAccountsRename: (provider: string, id: string, name: string) =>
    ipcRenderer.invoke('provider-accounts:rename', provider, id, name),
  providerAccountsRemove: (provider: string, id: string) =>
    ipcRenderer.invoke('provider-accounts:remove', provider, id),
  providerAccountsSetDefault: (provider: string, id: string) =>
    ipcRenderer.invoke('provider-accounts:set-default', provider, id),
  providerAccountsLogin: (provider: string, id: string) =>
    ipcRenderer.invoke('provider-accounts:login', provider, id),

  // Codex plan-usage badge (the Codex analog of ccPlanUsage below)
  codexUsage: (force?: boolean) => ipcRenderer.invoke('codex-usage:get', force),

  // Agent
  sendAgent: (payload: unknown) => ipcRenderer.send('agent:send', payload),
  stopAgent: (appSessionId: string) => ipcRenderer.invoke('agent:stop', appSessionId),
  onAgentEvent: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('agent:event', fn)
    return () => ipcRenderer.removeListener('agent:event', fn)
  },
  onAgentDone: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('agent:done', fn)
    return () => ipcRenderer.removeListener('agent:done', fn)
  },
  onAgentError: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('agent:error', fn)
    return () => ipcRenderer.removeListener('agent:error', fn)
  },
  onApprovalRequest: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('agent:approval-request', fn)
    return () => ipcRenderer.removeListener('agent:approval-request', fn)
  },
  // A git worktree was created for a `useWorktree` chat — carries the resolved cwd so the
  // renderer can persist it on the session and reuse it on later turns.
  onAgentWorktree: (cb: (data: { appSessionId: string; path: string; branch?: string }) => void) => {
    const fn = (_: unknown, data: { appSessionId: string; path: string; branch?: string }) => cb(data)
    ipcRenderer.on('agent:worktree', fn)
    return () => ipcRenderer.removeListener('agent:worktree', fn)
  },
  respondApproval: (payload: unknown) => ipcRenderer.invoke('agent:approval-response', payload),
  // An approval was answered (by the toast or the main modal): drop it in the other UI.
  onApprovalResolved: (cb: (approvalId: string) => void) => {
    const fn = (_: unknown, approvalId: string) => cb(approvalId)
    ipcRenderer.on('approval:resolved', fn)
    return () => ipcRenderer.removeListener('approval:resolved', fn)
  },

  // Approval toast window (calls made by / events received in the TOAST window)
  onToastApproval: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('toast:approval', fn)
    return () => ipcRenderer.removeListener('toast:approval', fn)
  },
  toastOpenMain: () => ipcRenderer.send('toast:open-main'),

  // Agent status pill window (events received in / calls made by the PILL window)
  onPillUpdate: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('pill:update', fn)
    return () => ipcRenderer.removeListener('pill:update', fn)
  },
  pillOpenMain: () => ipcRenderer.send('pill:open-main'),

  // Config / models
  getConfig: () => ipcRenderer.invoke('config:get'),
  getModels: () => ipcRenderer.invoke('config:models'),
  setDefaultModel: (modelId: string) => ipcRenderer.invoke('config:set-default-model', modelId),
  setLimits: (limits: unknown) => ipcRenderer.invoke('config:set-limits', limits),
  setUiPrefs: (prefs: unknown) => ipcRenderer.invoke('config:set-ui', prefs),
  setSystemPrefs: (prefs: unknown) => ipcRenderer.invoke('config:set-system', prefs),

  // Claude Code data
  ccSources: () => ipcRenderer.invoke('cc:sources'),
  ccListProjects: () => ipcRenderer.invoke('cc:list-projects'),
  ccListSessions: (sourceId: string, encodedDir: string) =>
    ipcRenderer.invoke('cc:list-sessions', sourceId, encodedDir),
  ccReadSession: (sourceId: string, encodedDir: string, sessionId: string) =>
    ipcRenderer.invoke('cc:read-session', sourceId, encodedDir, sessionId),
  ccUsage: (force?: boolean) => ipcRenderer.invoke('cc:usage', force),
  ccPlanUsage: (force?: boolean) => ipcRenderer.invoke('cc:plan-usage', force),
  // Live plan-usage updates pushed from the main-process watcher.
  onPlanUsage: (cb: (report: unknown) => void) => {
    const fn = (_: unknown, report: unknown) => cb(report)
    ipcRenderer.on('plan:update', fn)
    return () => ipcRenderer.removeListener('plan:update', fn)
  },
  // Main process asks the renderer to switch to a view (e.g. from a notification click).
  onOpenView: (cb: (view: string) => void) => {
    const fn = (_: unknown, view: string) => cb(view)
    ipcRenderer.on('app:open-view', fn)
    return () => ipcRenderer.removeListener('app:open-view', fn)
  },
  ccSearch: (query: string) => ipcRenderer.invoke('cc:search', query),

  // Session tags + label vocabulary
  ccSetSessionTags: (sourceId: string, encodedDir: string, sessionId: string, tags: string[]) =>
    ipcRenderer.invoke('cc:set-session-tags', sourceId, encodedDir, sessionId, tags),
  ccLabels: () => ipcRenderer.invoke('cc:labels'),
  ccLabelSetColor: (name: string, color?: string) =>
    ipcRenderer.invoke('cc:label-set-color', name, color),
  ccLabelUsage: (name: string) => ipcRenderer.invoke('cc:label-usage', name),
  ccLabelRename: (from: string, to: string) => ipcRenderer.invoke('cc:label-rename', from, to),
  ccLabelMerge: (from: string, into: string) => ipcRenderer.invoke('cc:label-merge', from, into),
  ccLabelDelete: (name: string) => ipcRenderer.invoke('cc:label-delete', name),

  // MCP
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpUpsert: (name: string, cfg: unknown) => ipcRenderer.invoke('mcp:upsert', name, cfg),
  mcpRemove: (name: string) => ipcRenderer.invoke('mcp:remove', name),

  // Agents
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsSave: (agent: unknown) => ipcRenderer.invoke('agents:save', agent),
  agentsDelete: (id: string) => ipcRenderer.invoke('agents:delete', id),
  agentsSuggest: (accountId?: string) => ipcRenderer.invoke('agents:suggest', { accountId }),

  // Chat compaction
  summarizeChat: (payload: unknown) => ipcRenderer.invoke('chat:summarize', payload),

  // Planner
  plannerList: () => ipcRenderer.invoke('planner:list'),
  plannerGet: (weekStart: string) => ipcRenderer.invoke('planner:get', weekStart),
  plannerSave: (week: unknown) => ipcRenderer.invoke('planner:save', week),
  plannerDelete: (weekStart: string) => ipcRenderer.invoke('planner:delete', weekStart),
  plannerAssist: (payload: unknown) => ipcRenderer.invoke('planner:assist', payload),

  // Sprints (Scrum board / standups / burndown)
  sprintList: () => ipcRenderer.invoke('sprint:list'),
  sprintGet: (id: string) => ipcRenderer.invoke('sprint:get', id),
  sprintSave: (sprint: unknown) => ipcRenderer.invoke('sprint:save', sprint),
  sprintDelete: (id: string) => ipcRenderer.invoke('sprint:delete', id),
  standupGenerate: (payload: unknown) => ipcRenderer.invoke('standup:generate', payload),
  sprintBackfill: (payload: unknown) => ipcRenderer.invoke('sprint:backfill', payload),

  // Claude permissions & hooks (edit ~/.claude/settings.json)
  getClaudePermissions: () => ipcRenderer.invoke('config:get-permissions'),
  setClaudePermissions: (perms: unknown) => ipcRenderer.invoke('config:set-permissions', perms),
  getClaudeHooks: () => ipcRenderer.invoke('config:get-hooks'),
  setClaudeHooks: (hooks: unknown) => ipcRenderer.invoke('config:set-hooks', hooks),

  // CLAUDE.md
  claudeMdRead: (projectPath?: string, provider?: string) =>
    ipcRenderer.invoke('claudemd:read', projectPath, provider),
  claudeMdWrite: (filePath: string, content: string) =>
    ipcRenderer.invoke('claudemd:write', filePath, content),

  // Checkpoints
  checkpointCreate: (sessionId: string, label: string, files: string[], messageCount: number) =>
    ipcRenderer.invoke('checkpoint:create', sessionId, label, files, messageCount),
  checkpointList: (sessionId: string) => ipcRenderer.invoke('checkpoint:list', sessionId),
  checkpointRestore: (sessionId: string, id: string) =>
    ipcRenderer.invoke('checkpoint:restore', sessionId, id),
  checkpointDelete: (sessionId: string, id: string) =>
    ipcRenderer.invoke('checkpoint:delete', sessionId, id),
  checkpointCompare: (sessionId: string, idA: string, idB: string) =>
    ipcRenderer.invoke('checkpoint:compare', sessionId, idA, idB),
  checkpointSavePatch: (sessionId: string, idA: string, idB: string) =>
    ipcRenderer.invoke('checkpoint:save-patch', sessionId, idA, idB),

  // SSH
  sshList: () => ipcRenderer.invoke('ssh:list'),
  sshSave: (host: unknown) => ipcRenderer.invoke('ssh:save', host),
  sshDelete: (id: string) => ipcRenderer.invoke('ssh:delete', id),
  sshTest: (id: string) => ipcRenderer.invoke('ssh:test', id),
  sshTestClaude: (id: string) => ipcRenderer.invoke('ssh:test-claude', id),
  sshKeysList: () => ipcRenderer.invoke('ssh:keys-list'),
  sshKeysGenerate: (name: string, comment?: string) =>
    ipcRenderer.invoke('ssh:keys-generate', name, comment),
  sshKeysPublic: (privatePath: string) => ipcRenderer.invoke('ssh:keys-public', privatePath),

  // SFTP (Remote Session file browser)
  sftpConnect: (hostId: string) => ipcRenderer.invoke('sftp:connect', hostId),
  sftpList: (hostId: string, dir: string) => ipcRenderer.invoke('sftp:list', hostId, dir),
  sftpRead: (hostId: string, p: string) => ipcRenderer.invoke('sftp:read', hostId, p),
  sftpWrite: (hostId: string, p: string, content: string) =>
    ipcRenderer.invoke('sftp:write', hostId, p, content),
  sftpMkdir: (hostId: string, dir: string) => ipcRenderer.invoke('sftp:mkdir', hostId, dir),
  sftpRename: (hostId: string, from: string, to: string) =>
    ipcRenderer.invoke('sftp:rename', hostId, from, to),
  sftpDelete: (hostId: string, p: string) => ipcRenderer.invoke('sftp:delete', hostId, p),
  sftpDownload: (hostId: string, p: string) => ipcRenderer.invoke('sftp:download', hostId, p),
  sftpUpload: (hostId: string, dir: string) => ipcRenderer.invoke('sftp:upload', hostId, dir),
  sftpHistory: (hostId: string) => ipcRenderer.invoke('sftp:history', hostId),
  sftpDisconnect: (hostId: string) => ipcRenderer.invoke('sftp:disconnect', hostId),

  // WSL
  wslList: () => ipcRenderer.invoke('wsl:list'),
  wslTest: (distro: string) => ipcRenderer.invoke('wsl:test', distro),
  wslTestClaude: (distro: string) => ipcRenderer.invoke('wsl:test-claude', distro),
  wslHidden: () => ipcRenderer.invoke('wsl:hidden'),
  wslSetHidden: (distro: string, hidden: boolean) => ipcRenderer.invoke('wsl:set-hidden', distro, hidden),
  wslHistory: (distro: string) => ipcRenderer.invoke('wsl:history', distro),

  // Rooms (persisted board layout: room order + custom names)
  roomsGetLayout: () => ipcRenderer.invoke('rooms:get-layout'),
  roomsSetLayout: (layout: unknown) => ipcRenderer.invoke('rooms:set-layout', layout),

  // Git
  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitDiff: (cwd: string, filePath: string, staged: boolean) =>
    ipcRenderer.invoke('git:diff', cwd, filePath, staged),
  gitStage: (cwd: string, filePath: string) => ipcRenderer.invoke('git:stage', cwd, filePath),
  gitUnstage: (cwd: string, filePath: string) => ipcRenderer.invoke('git:unstage', cwd, filePath),
  gitStageAll: (cwd: string) => ipcRenderer.invoke('git:stage-all', cwd),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),

  // File system
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
  openFolder: (defaultPath?: string) => ipcRenderer.invoke('fs:open-folder', defaultPath),
  fsReadText: (filePath: string) => ipcRenderer.invoke('fs:read-text', filePath),
  fsWriteFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:write-file', filePath, content),
  fsMkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath),
  fsRename: (from: string, to: string) => ipcRenderer.invoke('fs:rename', from, to),
  fsDelete: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),

  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list'),
  saveSession: (session: unknown) => ipcRenderer.invoke('session:save', session),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  exportSession: (session: unknown, format: 'md' | 'html') =>
    ipcRenderer.invoke('session:export', session, format),
  exportMarkdown: (defaultFileName: string, content: string) =>
    ipcRenderer.invoke('app:export-markdown', defaultFileName, content),

  // Commands & skills
  commandsList: (projectPath?: string) => ipcRenderer.invoke('commands:list', projectPath),

  // Scheduler / Routines
  schedulerList: () => ipcRenderer.invoke('scheduler:list'),
  schedulerUpsert: (run: unknown) => ipcRenderer.invoke('scheduler:upsert', run),
  schedulerDelete: (id: string) => ipcRenderer.invoke('scheduler:delete', id),
  schedulerSetEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('scheduler:set-enabled', id, enabled),
  schedulerRunNow: (id: string) => ipcRenderer.invoke('scheduler:run-now', id),

  // Terminal (embedded PTY)
  terminalCreate: (id: string, opts: unknown) => ipcRenderer.invoke('terminal:create', id, opts),
  terminalWrite: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  terminalKillDeferred: (id: string) => ipcRenderer.send('terminal:kill-deferred', id),
  terminalStartCli: (id: string, provider: string, resumeSessionId?: string) =>
    ipcRenderer.invoke('terminal:start-cli', id, provider, resumeSessionId),
  onTerminalData: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('terminal:data', fn)
    return () => ipcRenderer.removeListener('terminal:data', fn)
  },
  onTerminalExit: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('terminal:exit', fn)
    return () => ipcRenderer.removeListener('terminal:exit', fn)
  },

  // Remote shell (Remote Session SSH terminal, over the SFTP connection)
  remoteShellCreate: (id: string, hostId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('remote-shell:create', id, hostId, cols, rows),
  remoteShellWrite: (id: string, data: string) => ipcRenderer.send('remote-shell:write', id, data),
  remoteShellResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('remote-shell:resize', id, cols, rows),
  remoteShellKill: (id: string) => ipcRenderer.invoke('remote-shell:kill', id),
  onRemoteShellData: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('remote-shell:data', fn)
    return () => ipcRenderer.removeListener('remote-shell:data', fn)
  },
  onRemoteShellExit: (cb: (data: unknown) => void) => {
    const fn = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('remote-shell:exit', fn)
    return () => ipcRenderer.removeListener('remote-shell:exit', fn)
  }
})
