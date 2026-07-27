# Remote Session ("Connect") — implementation plan

Add a **full remote-session workspace** to each stored SSH host: a dedicated view with an
SFTP file browser (browse + edit + transfer), an interactive SSH terminal, and a history
panel (remote shell history + in-app run log). This extends the existing SSH plumbing —
it does **not** replace "New chat here", which stays for headless Claude-over-SSH chats.

## Decisions (already made)
- **Layout:** dedicated full-screen view. Split: SFTP file browser (left) + interactive
  terminal (right), with a toggleable History panel.
- **File ops:** full — browse, view, edit & save back over SFTP, upload, download, new
  folder, rename, delete, refresh.
- **History:** both — read remote `~/.bash_history` / `~/.zsh_history` via SFTP **and** a
  local per-host run log captured from an in-app quick-run box; clicking any entry sends it
  to the terminal.

## Existing pieces to reuse (do not rebuild)
- `src/main/ssh.ts` — `SshHost`, `buildConnectConfig` (currently private — **export it**),
  `getHost` (**export it**), stored-host CRUD. ssh2 `Client` already used here.
- `src/main/terminal.ts` — PTY layer; `kind: 'ssh'` already spawns the system `ssh` CLI
  via `getSshTerminalCommand`. Interactive shell is the default; `startCliInTerminal`
  launches claude *only when called*. For the remote session we open the shell and **do
  not** call `terminalStartCli` (so it stays a plain shell).
- `src/renderer/src/components/ChatTerminal.tsx` — reuse as the terminal, but it currently
  always auto-launches the provider CLI. Add an `autoLaunchCli?: boolean` prop (default
  true). When false: create the PTY, arm reveal, but never call `terminalStartCli`, and the
  loading label should read "Connecting…" not "Starting Claude…". Terminal id for a session:
  `remoteterm_<hostId>`.
- `src/renderer/src/components/FileTree.tsx` — reference for the tree UX, but the SFTP
  browser is a **new** component (remote paths, lazy load over IPC, mutation actions).
- `RemoteView.tsx` host card — add a **"Connect"** button (primary) next to "New chat here".

## 1. Main process — SFTP session manager (new file `src/main/sftp.ts`)

Maintain one long-lived ssh2 `Client` **per host id** (a `Map<string, Client>` keyed by
hostId), lazily connected, with its `SFTPWrapper` cached. All functions are defensive and
return a `{ ok: false, error }` shape on failure — never throw across IPC.

Export from `ssh.ts`: `export function getHost(...)` and `export function buildConnectConfig(...)`
(remove the `function` privacy) so `sftp.ts` can reuse them. Do not duplicate connect logic.

Path safety: reject any path that is not absolute POSIX (`/`-rooted) or contains `..`
segments after normalization. Remote paths are POSIX — always use `path.posix`.

Functions (all `async`, keyed by `hostId`):
- `sftpConnect(hostId)` → `{ ok, home?, cwd?, error? }`. Connect (reuse existing client if
  live), open SFTP, resolve the home dir via `realpath('.')`. Idempotent.
- `sftpList(hostId, dir)` → `{ ok, entries?, error? }` where each entry is
  `{ name, path, type: 'directory'|'file'|'symlink'|'other', size, mtime }`. Use
  `readdir`; map `attrs`/`longname` to type. Sort dirs first, then name. Skip nothing
  (show dotfiles).
- `sftpRead(hostId, filePath, maxBytes = 1_000_000)` → `{ ok, content?, tooLarge?, binary?, error? }`.
  Stat first; if size > maxBytes return `{ ok:true, tooLarge:true }`. Read into a Buffer;
  if it contains NUL bytes mark `binary:true` and don't return content. Else return UTF-8.
- `sftpWrite(hostId, filePath, content)` → `{ ok, error? }`. `writeFile` UTF-8.
- `sftpMkdir(hostId, dir)` → `{ ok, error? }`.
- `sftpRename(hostId, from, to)` → `{ ok, error? }`.
- `sftpDelete(hostId, targetPath)` → `{ ok, error? }`. Stat; `rmdir` for dirs (recursive:
  walk and unlink, or use `rmdir` and surface "directory not empty"), `unlink` for files.
- `sftpDownload(hostId, remotePath)` → prompt a save dialog in main (`dialog.showSaveDialog`)
  and `fastGet` to the chosen local path. Return `{ ok, savedTo?, canceled?, error? }`.
- `sftpUpload(hostId, remoteDir)` → `dialog.showOpenDialog` (multi), `fastPut` each into
  `remoteDir`. Return `{ ok, uploaded?: string[], error? }`.
- `sftpHistory(hostId)` → `{ ok, commands?: string[], error? }`. Read `~/.bash_history` then
  `~/.zsh_history` (whichever exists), split lines, strip zsh `: <ts>:0;` prefixes,
  de-dupe consecutive, return most-recent-last (cap ~500).
- `sftpDisconnect(hostId)` → end the client, drop from map. Call on view close.

Also add `sftpDisconnectAll()` and call it from the app-quit cleanup path (next to
`killAllTerminals`).

## 2. IPC + preload

In `src/main/index.ts`, register handlers mirroring the existing `ssh:*` block
(around line 928):
```
ipcMain.handle('sftp:connect', (_, hostId) => sftpConnect(hostId))
ipcMain.handle('sftp:list', (_, hostId, dir) => sftpList(hostId, dir))
ipcMain.handle('sftp:read', (_, hostId, p) => sftpRead(hostId, p))
ipcMain.handle('sftp:write', (_, hostId, p, content) => sftpWrite(hostId, p, content))
ipcMain.handle('sftp:mkdir', (_, hostId, dir) => sftpMkdir(hostId, dir))
ipcMain.handle('sftp:rename', (_, hostId, from, to) => sftpRename(hostId, from, to))
ipcMain.handle('sftp:delete', (_, hostId, p) => sftpDelete(hostId, p))
ipcMain.handle('sftp:download', (_, hostId, p) => sftpDownload(hostId, p))
ipcMain.handle('sftp:upload', (_, hostId, dir) => sftpUpload(hostId, dir))
ipcMain.handle('sftp:history', (_, hostId) => sftpHistory(hostId))
ipcMain.handle('sftp:disconnect', (_, hostId) => sftpDisconnect(hostId))
```
Add matching `sftp*` methods to `src/preload/index.ts` (around line 244) and to the
`window.electronAPI` type block in `src/renderer/src/types.ts` (around line 1047). Add a
`RemoteEntry` type to `types.ts` for the list-entry shape above.

## 3. Renderer — new view

- `src/renderer/src/views/RemoteSessionView.tsx` (+ `.css`). Props:
  `{ host: SshHostPublic; onBack: () => void }`.
  - On mount: `sftpConnect(host.id)`; set current dir to `host.remotePath || home`.
  - Header bar: back button, host name + `user@host`, a breadcrumb/path input for the cwd,
    a "Files / History" toggle, and a connection status dot.
  - Split body: left pane = `SftpBrowser`; right pane = `ChatTerminal` with
    `remoteHostId={host.id}` and `autoLaunchCli={false}`, `terminalId={`remoteterm_${host.id}`}`.
    Use a draggable splitter if trivial, else fixed ~320px left pane (match existing view
    CSS conventions — see `views.css`).
- `src/renderer/src/components/SftpBrowser.tsx` (+ `.css`). Lazy-loading remote tree using
  `sftpList`. Toolbar: Refresh, New folder, Upload (into current dir). Per-row context or
  hover actions: Open (files → open in viewer), Download, Rename, Delete. Reuse
  `FileTree.tsx` icon/color styling. Double-click a dir navigates; the view tracks a
  "current directory" that the terminal's `cd` is independent of (they are separate — do not
  try to sync cwd both ways in v1; a "cd terminal here" button that sends
  `cd '<path>'\n` to the terminal is a nice one-way affordance).
- `src/renderer/src/components/RemoteFileEditor.tsx` (or inline modal in the view). Opens
  a file via `sftpRead`. If `tooLarge`/`binary`, show a notice + Download button only.
  Else a `<textarea class="mono">` (no heavy editor dep) with Save (`sftpWrite`) and a
  dirty indicator. Keep it simple — a plain editable text area, monospace, full height.
- History panel (inside `RemoteSessionView`, shown when toggled): two sections —
  **Remote history** (`sftpHistory`) and **Run log** (local, per host). A quick-run input
  at the top: typing a command + Enter appends to the local run log **and** sends
  `<cmd>\n` to the terminal (via `window.electronAPI.terminalWrite(`remoteterm_${host.id}`, cmd + '\n')`).
  Clicking any history/run-log entry sends it to the terminal the same way. Persist the run
  log in `localStorage` under `remote-runlog-<hostId>` (array of `{ cmd, ts }`, cap 200).

## 4. Wiring the view in

- `NavRail.tsx`: add `'remote-session'` to the `View` union. It is **not** a rail entry
  (opened contextually from RemoteView, like `chat`).
- `App.tsx`:
  - Add state `const [remoteSessionHost, setRemoteSessionHost] = useState<SshHostPublic | null>(null)`.
  - New handler `openRemoteSession(host)` → `setRemoteSessionHost(host); setView('remote-session')`.
  - Pass a third prop to `RemoteView`: `onOpenSession={openRemoteSession}`.
  - Render block (near line 1555): `{view === 'remote-session' && remoteSessionHost && (
      <RemoteSessionView host={remoteSessionHost} onBack={() => setView('remote')} /> )}`.
    Lazy-import it like the other views (line ~58).
  - On leaving the session view (back button / unmount), call `sftpDisconnect(host.id)`.
- `RemoteView.tsx`: add the **"Connect"** primary button on each host card
  (before/after "New chat here"): `<button className="btn-primary small" onClick={() => onOpenSession(host)}>Connect</button>`.
  Keep "New chat here" as `btn-ghost`/secondary since Connect is now the headline action.

## 5. Security / robustness notes (must-follow)
- Never send private-key contents or passwords to the renderer (existing invariant — SFTP
  reuses stored hosts by id, secrets stay in main).
- Validate `hostId` against the stored hosts on **every** IPC call (via `getHost`); bail if
  unknown.
- Normalize + reject `..` and non-absolute remote paths in every sftp mutation.
- Wrap every SFTP op so a dropped connection returns `{ ok:false, error }` and the client is
  evicted from the map (so the next call reconnects) rather than leaving a dead client.
- Delete of a non-empty directory: surface the error, do not silently recurse-delete in v1
  unless the row action explicitly says "Delete folder and contents" (a confirm).
- Do not trigger `alert()`/`confirm()` — use in-view confirm UI for destructive actions.

## 6. Changelog
Add a bullet under the unreleased `0.7.0` entry in `ChangelogModal.tsx`:
"Remote hosts: Connect opens a full SFTP file browser, interactive terminal, and command
history for any SSH host."

## ITERATION 2 — fix SSH terminal + add WSL Connect

Two changes. (A) The SSH session terminal fails ("Failed to start terminal") while SFTP
works, because the terminal shells out to the **system `ssh` binary** via node-pty
(`createTerminal` → `getSshTerminalCommand` → `pty.spawn('ssh', …)`) which authenticates
independently and is fragile (host-key/agent/password prompts, PATH), whereas SFTP rides the
proven-good `ssh2` library connection. Fix: run the SSH session terminal over an **ssh2
interactive shell channel on the same connection SFTP already opened**. (B) Add a "Connect"
full session for WSL distros too, reusing the existing (working) node-pty `wsl.exe` terminal.

### A. SSH terminal over ssh2 `conn.shell()`

**main — reuse the SFTP connection.** In `src/main/sftp.ts`, export a client accessor that
returns the live `ssh2` `Client` for a host, connecting via the existing `getSession` if
needed:
```ts
export async function getRemoteClient(hostId: string):
  Promise<{ ok: true; conn: Client } | { ok: false; error: string }> {
  const res = await getSession(hostId)
  return res.ok ? { ok: true, conn: res.session.conn } : { ok: false, error: res.error }
}
```

**main — new `src/main/remote-shell.ts`.** Interactive shell channels keyed by a
renderer-supplied id (validate with the same `SAFE_ID_RE` / `isSafeId` as `terminal.ts` —
copy that guard). Mirror `terminal.ts`'s callback style (main passes `onData`/`onExit` that
the IPC layer wires to `webContents.send`).
```
const shells = new Map<string, import('ssh2').ClientChannel>()
remoteShellCreate(id, hostId, cols, rows, onData, onExit): Promise<{ok, error?}>
  - isSafeId(id) guard; if shells.has(id) return {ok:true} (reuse — StrictMode remount)
  - getRemoteClient(hostId); on !ok return {ok:false,error}
  - conn.shell({ term:'xterm-color', cols, rows }, (err, stream) => …)
    - on err: {ok:false, error}
    - shells.set(id, stream)
    - stream.on('data', d => onData(id, d.toString('utf8')))
    - stream.stderr?.on('data', d => onData(id, d.toString('utf8')))
    - stream.on('close', () => { shells.delete(id); onExit(id, 0) })
    - resolve {ok:true}
remoteShellWrite(id, data)   -> shells.get(id)?.write(data)
remoteShellResize(id, cols, rows) -> shells.get(id)?.setWindow(rows, cols, 0, 0)   // ssh2 order: rows, cols
remoteShellKill(id)          -> try stream.end()/close(); shells.delete(id)
remoteShellKillAll()         -> end all; clear (call from app-quit cleanup next to killAllTerminals + sftpDisconnectAll)
```
All defensive, never throw.

**IPC (`src/main/index.ts`)** — mirror the terminal handlers (find the `terminal:create`
block and copy its `event.sender.send(...)` wiring):
```
ipcMain.handle('remote-shell:create', (e, id, hostId, cols, rows) =>
  remoteShellCreate(id, hostId, cols, rows,
    (id, data) => e.sender.send('remote-shell:data', { id, data }),
    (id, code) => e.sender.send('remote-shell:exit', { id, code })))
ipcMain.handle('remote-shell:write',  (_, id, data)       => remoteShellWrite(id, data))
ipcMain.handle('remote-shell:resize', (_, id, cols, rows) => remoteShellResize(id, cols, rows))
ipcMain.handle('remote-shell:kill',   (_, id)             => remoteShellKill(id))
```
Add `remoteShellKillAll()` to the same quit/`window-all-closed`/`before-quit` cleanup path.

**preload + types** — add `remoteShellCreate/Write/Resize/Kill` and `onRemoteShellData` /
`onRemoteShellExit` subscription helpers (copy the `onTerminalData`/`onTerminalExit` pattern
exactly, new channel names), plus their signatures in `types.ts`.

**renderer — new `src/renderer/src/components/RemoteTerminal.tsx`.** Copy `ChatTerminal.tsx`
and strip it down: same xterm setup (fit addon, copy-on-select, Ctrl/Cmd-C/V, font-size
buttons, resize observer, loading overlay), but talk to the `remote-shell:*` IPC instead of
`terminal:*`, and there is **no CLI-launch logic at all** (no provider/resume/autoLaunch/
startCli — the remote login shell is the whole point). Props: `{ terminalId, hostId, onClose }`.
On mount: `remoteShellCreate(terminalId, hostId, cols, rows)`, subscribe to
`onRemoteShellData`/`onRemoteShellExit`, reveal on first painted content (reuse the existing
`hasVisibleContent` gate + backstop). `onData` → `remoteShellWrite`. Resize → `remoteShellResize`.
Cleanup → `remoteShellKill` (deferred like ChatTerminal to survive StrictMode remounts is a
nice-to-have but a plain kill is acceptable here). Loading label: "Connecting…".

**RemoteSessionView** — for the SSH target, render `RemoteTerminal` (not `ChatTerminal`), and
make `sendToTerminal` call `window.electronAPI.remoteShellWrite(terminalId, cmd + '\n')`.
Leave `ChatTerminal` as-is for the WSL target below.

### B. WSL "Connect" full session

Generalize the session view to a target union instead of an SSH-only `host` prop:
```ts
export type RemoteTarget =
  | { kind: 'ssh'; host: SshHostPublic }
  | { kind: 'wsl'; distro: string }
```
Rename/param `RemoteSessionView` to accept `{ target: RemoteTarget; onBack }` and branch the
three providers by `target.kind`. Keep the exact same header/split/History layout and CSS.

- **Terminal:** `ssh` → `RemoteTerminal` (above). `wsl` → existing `ChatTerminal` with
  `wslDistro={distro}`, `provider="claude"`, `autoLaunchCli={false}`, `terminalId={`wslterm_${distro}`}`.
  This is the already-working node-pty `wsl.exe` bare-shell path — do not change it.
- **Files (wsl):** browse the distro over its Windows share. Root is
  `\\wsl.localhost\<distro>\` (fall back to `\\wsl$\<distro>\`). New component
  `src/renderer/src/components/LocalBrowser.tsx` reusing `FileTree.tsx` styling with the same
  toolbar/actions as `SftpBrowser` (refresh, new folder, open→edit, rename, delete;
  upload/download can be omitted for WSL v1 — note as follow-up). It uses **local-fs IPC**:
  - reuse existing `fs:read-dir` (`window.electronAPI.readDir`) and `fs:read-file`.
  - add guarded IPC: `fs:write-file` (path + content), `fs:mkdir`, `fs:rename`, `fs:delete`.
    Guard: reject empty paths and refuse to delete a filesystem root / the share root; use
    `fs.promises`; return `{ok:false,error}` never throw. Add matching preload + types.
  - Editor: parametrize `RemoteFileEditor` to take a `read`/`write` pair (or add a sibling
    `LocalFileEditor`) so WSL files open in the same modal via `fs:read-file`/`fs:write-file`.
- **History (wsl):** add main IPC `wsl:history` → run `wsl -d <distro> cat ~/.bash_history`
  (spawn argv array, no shell string; reuse `parseHistoryLines` from `sftp-pure.ts`). Preload
  `wslHistory(distro)`. Quick-run/`cd here`/history-click → `terminalWrite(`wslterm_${distro}`, cmd+'\n')`.
- **Path field:** for WSL show the POSIX cwd (start at `/home` or `/`); map to the UNC path
  internally for the LocalBrowser. Keep it simple — a leading-`/` POSIX path shown, converted
  to `\\wsl.localhost\<distro>\<path>` for fs calls.

### C. Wiring

- `RemoteView.tsx`: add a primary **"Connect"** button to each **WSL distro card** (next to
  "New chat here"), calling a new `onOpenWslSession(distro)` prop. Keep the SSH "Connect".
- `App.tsx`: replace `remoteSessionHost` with `remoteTarget: RemoteTarget | null`;
  `openRemoteSession(host)` sets `{kind:'ssh',host}`, new `openWslSession(distro)` sets
  `{kind:'wsl',distro}`; both `setView('remote-session')`. Render
  `<RemoteSessionView target={remoteTarget} onBack={() => setView('remote')} />`. Pass
  `onOpenWslSession` into `RemoteView`.

### D. Changelog
Update the unreleased 0.7.0 bullet (or add a second) to note: SSH session terminal now runs
over the SFTP connection (no separate ssh login), and WSL distros get the same Connect
(terminal + file browser + history).

## ITERATION 3 — Servers default + persistent multi-sessions

Three changes: (A) make Remote & WSL the default Servers tab and MCP secondary; (B) keep
open server sessions alive in the background so switching between Chat ("Claude") and Servers
never tears down a live terminal/SFTP connection; (C) support multiple concurrent server
sessions with a tab strip. Chat agent work already persists (it streams in the main process,
independent of the view) — no change needed there; this is only about the Servers side.

### A. Reorder the Servers group
- `src/renderer/src/components/NavRail.tsx`: change the `servers` group to
  `{ key: 'servers', label: 'Servers', members: ['remote', 'mcp'] }` (was `['mcp','remote']`).
  The group's rail icon comes from `members[0]`; keeping "Servers" as the label is fine, but
  give the group its own icon if `remote`'s glyph reads oddly as the group icon (optional —
  leaving it as the `remote` icon is acceptable). Clicking the group now opens `remote` first,
  and the sub-nav (App renders `activeGroup.members`) shows "Remote & WSL" then "MCP".
- No `MEMBER_LABELS` change needed (both entries already exist).

### B + C. Persistent, multi-session server workspace

**State (App.tsx).** Replace the single `remoteTarget` with a session list:
```ts
interface ServerSession { id: string; target: RemoteTarget; title: string }
const [serverSessions, setServerSessions] = useState<ServerSession[]>([])
const [activeServerSessionId, setActiveServerSessionId] = useState<string | null>(null)
```
- Stable id per target so terminal/SFTP ids stay stable and de-dup is natural:
  `ssh` → `srv:ssh:<host.id>`, `wsl` → `srv:wsl:<distro>`. Title = `host.name` / distro.
- `openRemoteSession(host)` / `openWslSession(distro)`: compute the id; if a session with that
  id already exists, just `setActiveServerSessionId(id)`; else append
  `{ id, target, title }`. Either way `setActiveServerSessionId(id); setView('remote-session')`.
  (One session per target for v1 — Connect on an already-open target re-focuses its tab.
  Multiple *different* hosts/distros = multiple tabs. Multiple sessions to the *same* target
  is a noted follow-up.)
- `closeServerSession(id)`: remove it from `serverSessions`; if it was active, pick an adjacent
  remaining session as active, or if none remain `setActiveServerSessionId(null)` and, when the
  current view is `remote-session`, `setView('remote')`.

**Always-mounted layer (App.tsx render).** Replace the current
`{view === 'remote-session' && remoteTarget && (…)}` block with a layer rendered
**unconditionally** (outside any `view ===` guard) whenever `serverSessions.length > 0`, its
visibility toggled by CSS so it survives view switches:
```tsx
{serverSessions.length > 0 && (
  <div className="server-sessions-layer" style={{ display: view === 'remote-session' ? 'flex' : 'none' }}>
    <div className="server-tabs">
      {serverSessions.map((s) => (
        <div key={s.id} className={`server-tab ${s.id === activeServerSessionId ? 'active' : ''}`}
             onClick={() => setActiveServerSessionId(s.id)}>
          <span className="server-tab-title">{s.title}</span>
          <button className="server-tab-close" onClick={(e) => { e.stopPropagation(); closeServerSession(s.id) }}>×</button>
        </div>
      ))}
    </div>
    <Suspense fallback={<ViewLoading />}>
      {serverSessions.map((s) => (
        <div key={s.id} className="server-session-pane"
             style={{ display: s.id === activeServerSessionId ? 'flex' : 'none' }}>
          <RemoteSessionView
            target={s.target}
            active={view === 'remote-session' && s.id === activeServerSessionId}
            onBack={() => setView('remote')}
          />
        </div>
      ))}
    </Suspense>
  </div>
)}
```
Because this layer is never unmounted on a view change, every `RemoteSessionView` (and its
`RemoteTerminal`/`ChatTerminal` + SFTP connection + xterm scrollback) stays alive in the
background. A session unmounts (and thus disconnects) **only** when removed from
`serverSessions` by `closeServerSession` — so the existing disconnect-on-unmount in
`RemoteSessionView` and `remoteShellKill`-on-unmount in `RemoteTerminal` become correct
"close" semantics with no change to those cleanups.

**CSS (`RemoteSessionView.css` or a new small block).** `.server-sessions-layer` fills the
content region exactly like a `.view` (match how the other view containers size — flex column,
fill the app content area, own its own scroll). `.server-session-pane` is `flex: 1; min-height: 0`.
`.server-tabs` is a thin horizontal strip (reuse the visual language of `.view-subnav`);
`.server-tab` shows title + close, active tab highlighted with `--accent`.

**Re-fit terminals on show (important).** A terminal hidden via `display:none` has zero size;
when its pane becomes visible again the xterm must re-fit or it renders at the stale/zero size.
Thread the new `active` prop through `RemoteSessionView` to the terminal:
- `RemoteTerminal.tsx`: add `active?: boolean` prop; in a `useEffect([active])`, when it flips
  true call `fit.fit()` + `remoteShellResize(id, cols, rows)` (guard for null refs). The
  existing `ResizeObserver` helps but an explicit refit on `active` is the reliable trigger.
- For the WSL branch, `RemoteSessionView` renders `ChatTerminal`; it already has a
  `ResizeObserver` + fit, but also pass/emulate the same "refit when shown" — simplest is to
  key or force a resize. If `ChatTerminal` needs an `active` prop too, add it the same way
  (small `useEffect` that refits). Do NOT remount on show (that would kill persistence).

**Navigation glue.**
- Keep `RemoteView`'s Connect buttons calling `onOpenSession`/`onOpenWslSession` — those now
  route through the add-or-focus logic above.
- The `remote-session` view is entered by those handlers. Ensure `setView('remote-session')`
  with no sessions can't happen (handlers always create/focus one first).
- Back button (`onBack`) returns to the `remote` list but leaves the session open (its tab
  persists) — do NOT close on back. Only the tab's × closes.
- If `view === 'remote-session'` but `activeServerSessionId` is null (all closed), redirect to
  `remote` (guard in an effect or in `closeServerSession`).

### D. Changelog
Add a bullet to the unreleased 0.7.0 entry: "Servers: Remote & WSL is now the default tab;
open remote/WSL sessions stay connected in the background and can be run several at once via
tabs."

## 7. Verification
- `npm run build` must pass (TypeScript strict).
- `npm test` (vitest) — add a small unit test for the path-safety guard and the zsh
  history-line parser in `sftp.ts` (pure functions — factor them out so they're testable).
- Manual: use the `visual-check` / `run` skill to launch the app and confirm the Connect
  flow renders (a live SSH host isn't required to verify the UI shell + IPC wiring).
