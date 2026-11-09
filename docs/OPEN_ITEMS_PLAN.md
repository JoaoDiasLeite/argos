# Open items — the leftovers with margin, closed in 3.5.0

_Planned 2026-11-09 by Fable from the owner's brief "planeia tudo o que tens aqui
[funcionalidades existentes com margem] e mete subagentes opus e sonnet a trabalhar nisso".
Every file:line below was read on 2026-11-09 at `3.1.0` (unreleased) / `6b76e53`, rebased onto 3.4.0 (`bb4b26d`) on the same day. One
batch per commit, each compiling on its own; subagents never commit. Decisions marked
**(Fable)** were taken without the owner, who was not available, and are the first thing
to revisit if any of them reads wrong._

## 1. What this closes

Nine items that were open in `docs/NEXT_FIXES.md` (the port leftovers, the pop-out
follow-ups), in the 2026-10-07 audit backlog (approval queue, SSH trust stores, host
secrets, host sessions, `testClaude` timeout, Linux keyring) and in the 2.8.0 release
notes (what the `.argos` file does not carry). Plus the visual check 3.0.0 and 3.1.0 still
owe. Nothing new is designed here; every item is a gap in something that already shipped.

## 2. Findings that change the brief

- **The Claude Code check is WSL-only** (`RemoteView.tsx:727-746`); SSH hosts are worked
  through Operations. The distro's logged-in e-mail is already on the Account row two
  lines above (`RemoteView.tsx:314`, `:723-724`), read from `\\wsl.localhost\<distro>\…\.claude.json`
  by `claude-data.ts:189`. The "logged in as" fix is one line in the renderer.
- **Argos's approval queue is fed only by ops runs** (`App.tsx:619`, single caller of
  `requestToolApproval` at `index.ts:2204`). A chat's own permission prompts are drawn by
  the CLI inside its terminal. So "answer approvals in the pop-out window" has nothing to
  answer: a popped-out chat is never an ops terminal. **Dropped**, noted in NEXT_FIXES.
- **The `.argos` file does not skip Codex-in-WSL transcripts; the app never reads them.**
  `getSources` adds WSL sources from `getWslClaudeRoots` only (`claude-data.ts:180-192`);
  nothing under `codex-*.ts` or `wsl.ts` knows a `.codex` inside a distro. Closing the gap
  means a new source kind, not an export tweak.
- **`ssh-trust.json` keeps only fingerprints** (`ssh-trust.ts:9-16`), so a `known_hosts`
  file cannot be derived from it today. The store format has to grow (type + full key).
- **`session.preview` already exists** on the Session type (`types.ts:97-98`) and
  HomeView already renders it (`HomeView.tsx:633`); nothing writes it.

## 3. Decisions (Fable)

- **Pending ops prompts are pulled, not pushed.** One IPC `ops:pending` returns
  `{ approvals, secrets, operatorAsks }`; the renderer calls it on mount and merges by id.
  A pull also covers HMR remounts, where no `did-finish-load` fires.
- **"New terminal" trusts what Argos trusts.** `ssh-trust.json` entries become
  `{ fp, type, key }` (old string values still read; they are upgraded the next time the
  ssh2 verifier sees the key). Argos writes `userData/ssh-known-hosts` from the store and
  spawns `ssh -o UserKnownHostsFile=<that> -o StrictHostKeyChecking=yes`. An endpoint with
  no full key yet goes through `testConnection(hostId)` first (dialog prompt, same as every
  other first use), and only then does the terminal open. `~/.ssh/known_hosts` is left
  alone and not consulted (`GlobalKnownHostsFile=/dev/null` is not passed; ssh still reads
  the user file only through `UserKnownHostsFile`, which we override).
- **Clearing a secret is explicit.** `password`/`passphrase` on `SshHostInput` become
  `string | null | undefined`: `undefined` keeps, `null` clears, a string replaces. Saving
  with an `authType` that does not use a secret drops it. The form shows a "Remove saved
  password" / "Remove saved passphrase" button when `editing.id && hasSecret`.
- **Editing connection fields closes the host's pooled connection.** `ssh:save` calls
  `sftpDisconnect(id)` when host, port, username, authType, keyPath or a secret changed;
  `ssh:delete` always does. Open shells on it end (the renderer already handles `onExit`);
  an ops run in flight reconnects on its next call through `getRemoteClient`.
- **Checks are bounded.** `testConnection` and `testClaude` get a 20 s exec timeout
  (same as the WSL probe, `wsl.ts:248`) and settle with a clear message.
- **Plain-text secrets are said, not blocked.** A `ssh:secret-storage` IPC reports
  `{ encrypted, backend }` (`safeStorage.isEncryptionAvailable()`, and on Linux
  `getSelectedStorageBackend()` with `basic_text` counted as not encrypted). The host form
  and Settings → Connection show one line when it is false. Nothing refuses to save.
- **Pop-out: name and status flow to the window; unread follows the window.**
  `popout:update(sessionId, { name })` from the renderer on any rename; main updates the
  spec, the window title and sends `popout:spec-changed`. `Popout.tsx` subscribes to
  `onTerminalBusy`/`onTerminalNotify` and prefixes its title (`● ` busy, `! ` waiting).
  In `App.tsx` a popped-out id counts as visible for the unread rule, so it never sticks.
- **"In view" counts a pop-out only for that chat.** `mainWindowInactive()` stays as is
  for ops approvals (they are answered in the main window). For a chat's own events
  (companion idle line at `index.ts:1082`, hook notification at `:1092`) a new
  `chatInView(terminalId)` is true when the main window is active **or** that chat's
  pop-out window is visible and focused. A chat that finishes in a focused pop-out
  neither barks nor toasts.
- **Home "Earlier today".** A folded section in the side column: chats that have terminal
  activity, are not running, and whose `updatedAt` is today, plus ops runs from
  `opsRuns({ limit: 50 })` with `startedAt` today and `endedAt` set. Header
  `Earlier today · N finished`, closed by default, 8 rows max. A chat row opens the
  session; an ops row opens that server's operations view. No exit codes: the ledger has
  none and the pty's is not stored (left as is).
- **Preview = the last message's text,** 120 chars, one line, written into
  `session.preview` by `syncTerminalChats` for Claude chats. Codex and Gemini chats keep
  an empty preview (the sync does not cover them today).
- **Codex names travel on the project line.** `ProjectLine` gains
  `threadNames?: Record<sessionId, name>` for Codex projects (reduced from
  `session_index.jsonl`, only ids whose rollout is in the line). Import appends to the
  destination home's `session_index.jsonl` the ids the local reduced map does not have.
  Same bundle version: the field is optional and `parseLine` validates per type.
- **Codex in WSL becomes a source.** `getWslCodexHomes()` in `wsl.ts` (next to
  `getWslClaudeRoots`): `<share>\<home>\.codex` when `sessions\` exists. `codexSources`
  takes them as `{ id: 'codex-wsl:<distro>', kind: 'wsl', distro, home, sessionsDir,
  indexPath }`. Export then lists them like any Codex source; import's `planProject`
  resolves a WSL Codex home the way `wslProjectsDir` does. Every consumer of Codex
  sources that assumes `kind === 'local'` is checked and, where launching a Codex chat
  would land in the wrong place, the source is read-only (the Projects browser shows and
  peeks it; "Resume" is hidden for it). **(Fable: read-only is the safe first version.)**

## 4. Batches

Sequential unless marked ∥ (disjoint files, may run alongside the previous one).
Commit messages are final. Every batch: `npm run typecheck` and `npm test` green,
i18n in `en` and `pt-PT` (tu), no `Co-Authored-By`.

| # | Model | Files | Commit |
|---|---|---|---|
| A | Opus | `index.ts` (approvals section 2351-2510: store `{ req, finish }` in `pendingApprovals`, `pendingSecrets`, `pendingOperatorAsks`; `ipcMain.handle('ops:pending')`), `preload/index.ts` (`opsPending`), renderer `types.ts`, `App.tsx` (call on mount in the effects at 408, 419, 620; merge by id), `toast/Toast.tsx` (same on mount) | `fix(ops): keep pending approvals across a renderer reload` |
| B ∥A | Sonnet | `ssh.ts:100-117` (`saveHost` null protocol + drop by authType), `ssh-host-pure.ts` (+test: a pure `mergeSecrets(prev, input)`), renderer `types.ts:732-744`, `RemoteView.tsx` form (carry `hasSecret` into `editing`; remove buttons at the password 1069-1078 and passphrase 1107-1117 inputs), `i18n/{en,pt-PT}/remote.ts` | `fix(ssh): let a host's saved password or passphrase be removed` |
| C | Sonnet | `index.ts:2514-2516` (`ssh:save` → `sftpDisconnect` when connection fields changed, `ssh:delete` → always), `ssh-host-pure.ts` (+test: `connectionFieldsChanged(prev, next)`) | `fix(ssh): close a host's open sessions when it is edited or deleted` |
| D | Sonnet | `ssh.ts:196-274` (`testConnection`, `testClaude`: 20 s exec timeout, `conn.end()` on it, i18n message `main.ssh.timedOut`), `i18n/{en,pt-PT}/main.ts` | `fix(ssh): bound the connection and claude code checks` |
| E | Sonnet | `ssh.ts` (`secretStorageState()`), `index.ts` (`ssh:secret-storage`), `preload`, renderer `types.ts`, `RemoteView.tsx` (one `help` line under the secret inputs when not encrypted), `SettingsView.tsx:817-825` (status row in Connection), `i18n/{en,pt-PT}/{remote,settings}.ts` | `feat(ssh): say when secrets cannot be stored encrypted` |
| F | Opus | `ssh-trust.ts` (entry `{ fp, type, key }`, legacy read, upgrade on verify), new `ssh-trust-pure.ts` (+test: key type from the wire blob, known_hosts line for port 22 and `[host]:port`, parse legacy/new entries), `ssh.ts:174-187` (`getSshTerminalCommand` async: ensure trusted, write `userData/ssh-known-hosts`, `-o UserKnownHostsFile` + `StrictHostKeyChecking=yes`), `terminal.ts:487-503` (await it; surface a refusal as the terminal's error), `profile-transfer-pure.ts:687` (`mergeTrust` with both shapes, +test) | `fix(ssh): open new terminals against the host key argos already trusts` |
| G ∥F | Sonnet | `RemoteView.tsx:614-623` (`version · email` from `accountFor(sel.name)` when present) | `feat(remote): show the logged-in account on the claude code check` |
| H | Opus | `chat-popout.ts` (`updateChatPopout(sessionId, patch)`: spec, `setTitle`, send `popout:spec-changed`), `index.ts` (`popout:update` handler; `chatInView(terminalId)`; use it at 1082 and 1092), `preload` (`popoutUpdate`, `onPopoutSpecChanged`), `Popout.tsx` (subscribe to spec change, busy, notify; title prefix), `App.tsx` (`renameSessionById` 1431 and the sync rename 1284 call `popoutUpdate` when `poppedOutRef` has the id; `seenIds` 463/486 include popped-out ids) | `feat(popout): keep the window's name, status and unread in step` |
| I ∥H | Sonnet | `App.tsx` (`syncTerminalChats` 1278-1290 writes `preview`; `homeRecent` 2015-2032 passes it; new `homeEarlier` from sessions + `opsRuns`), `HomeView.tsx` (replace the TODO at 821-823 with the folded section; new `HomeEarlier` row type), `i18n/{en,pt-PT}/home.ts`, CSS next to the existing side sections | `feat(home): earlier today and a preview under each recent chat` |
| J | Opus | `profile-transfer-pure.ts` (`ProjectLine.threadNames?`, `parseLine`, +test round trip), `profile-transfer.ts` (export: `threadNames(src)` filtered to the line's session ids at 367-380; import: `appendMissingThreadNames(home, names)` after the project's files at 893-913), `codex-data.ts` (export a small `appendThreadNames` or reuse the write at 539-543) | `feat(profile): carry codex chat names in the .argos file` |
| K | Opus | `wsl.ts` (`getWslCodexHomes`), `codex-data.ts:66-116` (WSL sources), `claude-data.ts:143-198` (`getSources` includes them), consumers of Codex sources (grep `kind === 'local'`, `codex:` id parsing, `codexAsSource`), `profile-transfer.ts:555-562` (`planProject` WSL Codex dest, `wslCodexHome(ctx, distro)` modelled on 483-496), Projects browser (read-only rows), tests for the pure parts | `feat(profile): export and import codex chats kept in a wsl distro` |
| L | Sonnet | `docs/NEXT_FIXES.md` (move the items to Done, note the dropped pop-out approval point), `ChangelogModal.tsx` 3.1.0 entry (Fixes + Features) | `docs: close the open items in next fixes and the 3.1.0 notes` |
| V | Sonnet | `visual-check` skill: the companion walk/stand/floor from 3.1.0, the Home side column with "Earlier today", the ops start screen (Ongoing + Recent) and the activity column's refer dropdown at the narrow width | no commit; findings go back to the orchestrator |

The real run of a resumed intervention against a VM needs the owner's VPN and a host; it
stays on the list for the owner.

## 5. Review gates

After every batch the orchestrator reads the diff, fixes small things inline, runs
`npm run typecheck`, `npm test`, and commits. Batches sharing `index.ts`, `preload` or
`types.ts` never run at the same time (A/B, F/G, H/I are the only pairs, and each pair is
disjoint by file). After any parallel pair the typecheck is re-run once more on the merged
tree before either commit.
