# Terminal-only — removing the SDK chat (2.0.0, step 8 of the audit)

_Planned with Fable; implemented by Opus subagents in the batches of §8, one commit each,
each compiling on its own. Prerequisite: steps 1–7 of `docs/FEATURE_AUDIT.md` §7 have
landed. Line numbers below were taken at `a91bfea` and drift as those steps land; the
function or IPC name is the anchor._

Argos keeps one way to talk to a CLI: the embedded terminal. The composer, the transcript,
per-chat approvals, quick chat, light mode and the headless SSH/WSL chat all go. What stays
of "chat" is a **terminal host**: a session with a name, a folder, an environment and a
CLI, plus the pre-launch pane that chooses them.

## 0. Holes found during recon — fixed inside the batches

- **H1 (safety, exists today).** In terminal mode, picking an Ops runbook in the setup
  pane's config bar clears `projectPath`, and the terminal then starts **without** the ops
  launch: an ungated CLI in the home folder with an empty timeline beside it. The Ops
  group leaves `ChatConfigBar`; ops lives only in Servers → Ops.
- **H2.** The worktree toggle and add-dir chips never reached the terminal
  (`CreateTerminalOptions` has neither). Decision: **delete both pills and the three
  session fields** (`additionalDirs`, `useWorktree`, `worktreePath`). They can return as
  terminal launch flags if missed.
- **H3.** The terminal never gets `--model`; `session.model` only chose which CLI starts.
  So `model` becomes `provider` and the CLI's own `/model` is the model picker.
- **H4.** The timeline's "Stop run" calls `stopAgent(terminalId)`, which only knows SDK
  runs: it does nothing for an ops terminal. New `ops:stop(terminalId)` →
  `endTerminalOps(id, { aborted: true })`.
- **H5.** The pill, the taskbar progress bar and the attention badges are fed only by SDK
  runs (`activeRuns`). They are re-fed from terminal busy (`onBusy` in `terminal:create`),
  with busy→idle flagging success and the pill's "done".
- **H6.** Budget alerts fire only on `agent:done`. Decision: **drop the banner and the
  notification**; the limits in Usage stay as a reporting threshold. Said in the changelog.
- **H7.** `runPlannerTask` and `startStandupChat` ignored work mode and always used the SDK.
  Both become terminal starts.

## 1. What the Chat view becomes

| Component | After |
|---|---|
| `Chat.tsx` (1 215) | The terminal host, ~250 lines: setup state, `terminalSessionId` backfill, the setup pane, `ChatTerminal` with `onActive`, the title. Deleted: attachments, slash picker, drop overlay, ⋯ menu, transcript loop, inline approval, composer, long-session banner, chips, model picker, Approve/Auto, Light/Full, usage readout, ops timeline slot. |
| `ChatPane.tsx`, `PaneGrid.tsx` | Unchanged (generic over panes; PaneGrid already provides the terminals' WebGL context). |
| `useSessionPane.ts` (240) | Keeps sessions, models, terminal prompts, nonces, default accounts, `patchSession`, `closeChatTerminal`, `createSession`, provider/account derivation. Drops send/stop/retry/edit/branch, model and toggle setters, compact, export, approvals, runningIds, ready, saveError, workMode. ~100 lines. |
| `Sidebar.tsx` (1 107) | Drops the `mode` prop, Quick chat, the transcript-content search (name and folder only; Projects has `cc:search`), the error dot. "New chat" reads "New terminal". |
| `MessageBubble.tsx` + css (1 405) | Deleted. `Markdown.tsx` stays for `OpsReportModal`. |
| `ChatConfigBar.tsx` (599) | Pre-launch only: environment (Local / WSL / SSH), folder, branch. Ops group gone (H1); worktree and add-dir gone (H2); `ready` prop gone. A **CLI seg-control** (Claude Code / Codex / Antigravity) replaces the model picker, the same control `OpsWorkspace` uses. |
| `TerminalPanel.tsx` + css (288) | Deleted, with every `addTerm` call and the `terminalLines` state. |
| `PendingRuns.tsx` | Stays; already fed by terminal busy + live registry. `endRun`'s clearing of `dismissedRunIds` moves to the busy false→true transition. |
| `ChatTerminal.tsx` (930) | Unchanged. `initialPrompt` already works (written once after reveal + 500 ms). |

**The setup pane** (`Chat.tsx` ~871–890) is the only pre-launch UI: heading, environment,
folder, branch, CLI seg, "Start terminal". For a migrated pre-2.0 chat it adds one line,
"Argos chat from before 2.0 — transcript saved as Markdown [Open] [Show in folder]", and
the button reads "Resume in terminal" when a Claude `claudeSessionId` exists. A migrated
chat always stops at this pane instead of spawning a CLI the moment it is clicked.

## 2. `Session` after

Keep: `id`, `name`, `createdAt`, `updatedAt`, `projectPath`, `claudeSessionId` (Claude
only after migration), `terminalSessionId`, `hasTerminalActivity`, `terminalStartedAt`,
`remoteHostId`, `remoteHostName`, `wslDistro`, the six account id/name fields,
`codexThreadId`, `unread`.

Replace: `model` → **`provider: ProviderId`** (migration computes it with main's
`providerFor(model)`).

Add: **`archivedTranscript?: string`** (path of the exported markdown), optional
`preview?: string` for Home "Recent".

Delete: `messages`, `runState`, `ccSynced`, `systemPrompt`, `permissionMode`,
`allowedTools`, `useMcp`, `autoApprove`, `lightMode`, `runbookPath`, `branchedFrom`,
`costUsd`, the four token counters, `additionalDirs`, `useWorktree`, `worktreePath`.

Also from `types.ts`: `Message`, `MessageUsage`, `AgentEvent/Done/Error`, `SlashCommand`,
`Attachment`, `UiPrefs.workMode`, and the electronAPI entries `sendAgent`, `stopAgent`,
`onAgentEvent/Done/Error`, `onAgentWorktree`, `summarizeChat`, `exportSession`,
`exportMarkdown`, `commandsList`. Keep `ToolCall`, `AskDecision` (Claude Code transcript
types), `ApprovalRequest` (ops).

## 3. Existing sessions with transcripts — export and preserve, no viewer

Once at startup, after `ensureDirs` and before the renderer can call `session:list`
(`session-migrate.ts` + `session-migrate-pure.ts`, tested):

1. For every `userData/sessions/*.json` with `messages.length > 0`: copy the file
   byte-for-byte to `userData/sessions-pre-2.0/<id>.json` (tool results and thumbnails
   kept; a downgrade to 1.17 can be restored by hand).
2. Write `userData/exports/chats/<yyyy-mm-dd>-<slug>-<id>.md` with `sessionToMarkdown`,
   moved from the renderer's `lib/markdown-export.ts` into the pure module.
3. Rewrite the session atomically: strip the SDK fields, set `provider`,
   `archivedTranscript`, `hasTerminalActivity: false`; drop `claudeSessionId` when the
   provider is not Claude (a Codex thread id there is not resumable); clear `runbookPath`.
4. A file that fails is left untouched and retried next launch. No `messages` key means
   skip, so it is idempotent. `{ version: '2.0.0', exported, failed[] }` goes in
   `store.json`.

Shown in the setup pane line (§1), in Settings → General ("Chats from before 2.0: N saved
as Markdown [Open folder]") and in one changelog line. `visibleSessions` and friends in
`account-scope.ts` test `hasTerminalActivity || archivedTranscript || claudeSessionId`
instead of `messages.length`.

Why no read-only viewer: it would keep ~1 600 lines alive for a frozen dataset; most
local SDK chats also exist under `~/.claude/projects` with the same id, so Projects and
SessionPeek already read them and Claude ones resume in the terminal; Codex and Gemini
ones are covered by the export; markdown outlives Argos; and the raw JSON is kept, so
nothing is lost silently. **Verify with one old chat id on the owner's machine before B4.**

## 4. Main process

Delete in `index.ts`: `SendPayload`, `relayAgentEvent`, the whole `agent:send` (its
RemoteRun gate, `runRemote`/`runWsl` calls, pill/worktree, the interactive and ops
`resolvePolicy` branches, the ops prepare branch, chat `canUseTool`, `sessionProvider`),
`agent:stop`, `chat:summarize`, `session:export` + `escapeHtml`, `app:export-markdown` +
`sanitizeFileName`, `commands:list`, the `quick` flag of `overlay:submit`.

Delete elsewhere: `runRemote`/`stopRemote` in `ssh.ts` (`testClaude` stays),
`runWsl`/`stopWsl` in `wsl.ts` (`runWslOneShot` stays for sprint backfill),
`claude-stream.ts`, `commands.ts`, `ops-run.ts` and `createOpsMcpServer` (the in-process
server; the relay path stays), `tool-approval-pure.ts`, the `interactive-chat`,
`interactive-light` and `ops-remote` profiles in `ai-policy.ts`, `providers/codex-app-server.ts`
and `gemini-acp.ts` with the `canUseTool` branches in `codex.ts`/`gemini.ts`, and
`canUseTool`/`includePartialMessages` in `providers/types.ts` and `claude.ts`.

Port first: `ops-run.test.ts` (21 tests, the only suite that drives the gate's `canUseTool`
through `ops-session`) becomes `ops-session.test.ts` driving `openOpsSession` +
`callOpsTool`. `OPS_PREAMBLE`/`buildOpsSystemAppend` lose their caller and go with their
tests (the terminal launch does not append them).

Keep: `requestToolApproval`, `agent:approval-response`, `pendingApprovals`,
`requestOpsSecret`, `ops:secret-response`, the toast, `openTerminalOps`/`endTerminalOps`,
the approval queue + `ApprovalModal` + `PlanReviewSheet` in the renderer (minus the
`workMode === 'chat'` and `opsChatVisibleId` conditions).

Rework: `activeRuns` → a busy-terminal set fed from `onBusy` (H5); `busyProjectPaths`
reads it; add `ops:stop` (H4). `buildPrompt`/`appendFiles` move to a small headless
helper used by `planner:assist`, `standup:generate` and `sprint:backfill`, which are the
headless `getEngine(...).run` callers that remain. `providers/claude`, `codex` (exec path),
`gemini` (process path), `registry`, `collect`, `cost*` stay.

## 5. Starting a terminal from elsewhere

One helper, `startTerminal({ prompt?, projectPath?, provider?, accountId?, wslDistro?,
remoteHostId?, name? })`: the existing terminal branch of `startOverlayPrompt`
(`newSession` → `setSessions` → `setActiveId` → `setView('chat')` →
`terminalPrompts[id] = prompt` → `saveSession`); prompt delivery through `useSessionPane`
→ `ChatTerminal.initialPrompt` is already wired.

| Entry point | After |
|---|---|
| Home start box | `startTerminal`; `HomeStartChoice.modelId` → `provider`. |
| Quick launcher | Enter → `startTerminal`. Ctrl+Enter (quick chat) removed from `Overlay.tsx`, `overlay:submit`, shortcuts. |
| Sprint standup "Discuss" | `startTerminal({ name, prompt })`. The multi-line context is written to `userData/prompts/<sessionId>.md` (tiny main IPC) and the typed line is one line: "Read <path>, then: <opener>". Raw `\n` through `terminalWrite` is not bracketed paste on ConPTY. |
| Planner `onRunTask` | `startTerminal` with a single-line prompt. |
| Ops workspace | Chat mode, `openOpsChat`, `opsChatVisibleId`, `renderChat`, `ops.mode.*` prefs deleted. Terminal path unchanged. |
| RemoteView "Ops chat" | → `openOpsWorkspace(matchedRunbook)`. "New chat on host" → `startTerminal({ remoteHostId })`; `connectWsl` likewise. |
| Projects resume | `resumeCCSession` creates `{ claudeSessionId, provider: 'claude', hasTerminalActivity: true }` and the terminal resumes; no message copying. |
| Palette | "New terminal"; `new-quick` removed; "Switch model" group → "Use Claude Code / Codex / Antigravity" for an unlaunched chat, or removed. |
| Jump list | "New terminal"; `--new-chat` argv kept so pinned lists work; messages timestamp fallback dropped. |
| Welcome pane | Terminal copy only. |

## 6. Settings and onboarding

- The Mode row goes, with `workMode` in `types.ts`, `ui-prefs-pure.ts` (+tests),
  `config.ts`, `useSessionPane`, `Sidebar`, `Chat`, `App`. A stored value is ignored.
- Default model stays, retitled "Model for background tasks (standup, sprint backfill,
  planner assist)"; it is `config.defaultModel` and the `resolvePolicy` fallback.
- No approval-default setting exists; the per-chat toggles go with the composer.
  Permissions / Hooks / Notify-hook modals stay (the CLI reads them).
- Budget limits stay as thresholds in Usage; banner and notification dropped (H6).
- Onboarding: no mode step exists; reword welcome + auth copy from chat to terminal and
  background tasks. The api-key path still matters: `buildSubprocessEnv` puts
  `ANTHROPIC_API_KEY` into terminal ptys.
- Shortcuts sheet: delete "Writing a message", "Editing a sent message", the quick-chat
  row and the `@` row (a feature that never existed).

## 7. Tests and the visual-check seed

Go: `tool-approval-pure.test.ts`; `ops-run.test.ts` after its port; the preamble cases in
`ops-run-pure.test.ts`. Edit: `account-scope.test.ts` (fixture on `hasTerminalActivity` /
`archivedTranscript` / `provider`), `ui-prefs-pure.test.ts`, `theme.test.ts` fixture,
`css-scope.test.ts` allowlist (MessageBubble.css). New: `session-migrate-pure.test.ts`
(strip, provider mapping, non-Claude id dropped, markdown, idempotence, corrupt file left
alone), `ops-session.test.ts`.

Seed: rewrite `scripts/visual-check/seed/sessions/demo*.json` with `provider: 'claude'`,
`hasTerminalActivity: true`, no messages; add one `archivedTranscript` fixture + a
`seed/exports/` markdown to shoot the pre-launch pane. Opening a seeded terminal would
spawn a real CLI: add `ARGOS_TERMINAL_FAKE=1` in `terminal.ts` spawning a canned echo
(the `ARGOS_OPS_FAKE` precedent), and update `.claude/skills/visual-check/SKILL.md`.

## 8. Batches

Ownership: **A** owns `src/main/**`, `src/preload/**`, `types.ts`, `OpsTimeline.tsx`.
**B** owns the rest of `src/renderer/**`. A runs B1 → B2 while B runs B3a → B3b; then A
runs B4. Runtime order matters: the renderer must stop using `agent:*` before main drops
it, and the migration may only strip `messages` once nothing renders them.

- **B1 (A, additive, ~+350/−10):** `ops-session.test.ts` port; `ops:stop` + preload +
  types + timeline button (H4); indicators fed from terminal busy, `activeRuns` kept for
  now (H5).
- **B2 (A, additive, ~+400):** `session-migrate-pure.ts` (+test) and `session-migrate.ts`
  with `sessionToMarkdown` in main; not wired yet.
- **B3a (B, ~−3 000/+250):** Chat.tsx and css cut to the terminal host; MessageBubble,
  TerminalPanel, markdown-export deleted; useSessionPane trimmed; App.tsx loses agent
  listeners, buildAgentPayload/send/retry/edit, run plumbing, compact, branch, toggles,
  export, budget-on-done, terminalLines/addTerm, welcome quick chat, palette quick/model
  items, workMode branches, modal condition; Sidebar, Overlay, shortcuts, Settings Mode
  row, clipboard-paste image branch, css-scope test. The renderer stops calling
  `sendAgent`; main still has the IPC, so it compiles and runs.
- **B3b (B, ~−500/+250):** `startTerminal`; Home, Planner, standup (prompt file IPC with
  A), Remote/WSL/Ops entry points, `resumeCCSession`, `syncTerminalChats` without message
  copying, `homeRecent`, ChatConfigBar without Ops/worktree/add-dir (H1, H2), OpsWorkspace
  without chat mode, RemoteView, account-scope (+test), visual-check seed.
- **B4 (A, ~−2 600/+120):** the §4 deletions; preload and types entries; `Session` trimmed
  with `provider` and `archivedTranscript`; `workMode` out of ui-prefs/config (+tests);
  jump list; ai-policy profiles; migration wired at startup; the Settings "Chats from
  before 2.0" row (small renderer edit, by agreement with B).
- **B5 (docs):** changelog 2.0.0 lines; `FEATURE_AUDIT.md` rows to "Removed in"; mark
  `OPS_AGENT_PLAN.md` §1.1, §6 and Phase 5's "SDK chat becomes one more client" as
  superseded; visual-check SKILL.md.

About −6 100 / +1 400 lines over the series; `App.tsx`, `Chat.tsx` and `index.ts` carry
most of it.
