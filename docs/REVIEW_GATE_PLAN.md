# Review gate — implementation plan

Close the gap between "an agent finished a batch" and "that batch is committed". Argos
already covers both ends — Rooms deploys agents, `GitModal` stages and commits — but the
middle is done by hand, in a terminal, every single batch: work out which of the dirty
files came from *this* chat, stage exactly those, run `npm run typecheck` against that
staged tree, write a Conventional Commits message, commit, then release the next batch.

Three phases, each shippable on its own and each a prerequisite for the next.

## Decisions (already made)
- **Authorship is a main-process, persisted ledger**, not renderer memory. Today it is
  `modifiedFilesRef` (`src/renderer/src/App.tsx:419`), a `Map<sessionId, Set<path>>` fed
  only from SDK `tool-use` events (`App.tsx:624`). It is empty for terminal/CLI chats,
  empty for Codex and Gemini, and gone on restart — none of which a commit gate can live
  with.
- **The gate verifies, it does not trust.** A commit is only allowed after the typecheck
  it claims has actually run against the staged tree, and the failure output is shown.
- **The queue never pushes.** Commits land on `main` locally, as today; releases stay a
  manual tag (see `CLAUDE.md`).
- **One repo, one running batch** — unless the missions run in worktrees, which
  `createWorktree` (`src/main/git.ts:121`) already supports per chat.

## Existing pieces to reuse (do not rebuild)
- `src/main/git.ts` — `getStatus`, `getDiff`, `stageFile`, `commit`, `createWorktree`.
  `GitStatus.files[].path` is repo-relative POSIX; the ledger holds absolute paths, so the
  join needs a normaliser (phase 1).
- `src/main/checkpoints.ts` — `Checkpoint.files` is already a per-session list of touched
  paths, but only for chats that reached `checkpointCreate`. Useful as a *backfill* source
  for existing chats, not as the ledger itself.
- `src/main/json-file.ts` and the `agents.ts` / `planner.ts` pattern — one JSON record
  under `userData`. The ledger and the queue both follow it.
- `src/main/jsonl.ts`, `claude-data.ts`, `codex-data.ts` — transcript readers, for
  recovering authorship of a chat whose CLI wrote its own transcript.
- `src/renderer/src/components/GitModal.tsx` — takes `{ cwd, onClose }` and is already
  opened per pane (`openGit(sid)`, `App.tsx:1576`), so it can take the session id too.
- `src/main/project-prefs.ts` — where the per-project verify command belongs.
- The `*-pure.ts` + `*-pure.test.ts` convention — every decision below that can be tested
  without the disk goes in a pure module.

## 1. Authorship ledger + attributed Git panel

**Shipped** (`7a5aa0e`, `f685b91`), with three deviations from what is written below,
each for a reason found while building it:

- The WSL/SSH feed is taken in `index.ts`, at the relay both headless backends’ events
  already pass through, not in `claude-stream.ts`. That module parses the line protocol
  and has no imports at all; reaching the ledger from it would have given it Electron.
- The transcript feed runs as part of the one-off backfill rather than on run end, since
  the live feed above already covers every run the app itself starts.
- Only Claude Code transcripts are read. `codex-data.ts` deliberately does not parse tool
  calls and Gemini writes no transcript of that shape, so a terminal chat on those two is
  attributed from its checkpoints or shown as unattributed — never as another chat’s work.
  Their extractors are still open work, and phase 2 does not depend on them.

`getRepoRoot` was added to `git.ts` on the way: status paths are relative to the repo
root while a chat’s folder can be any directory inside it.

**New: `src/main/authorship.ts` and `src/main/authorship-pure.ts` (+ test).**

The ledger is `{ [appSessionId]: { paths: string[]; updatedAt: number } }`, one JSON file,
written debounced. It is fed from three places:

- **SDK chats** — in `src/main/claude-stream.ts`, where the `tool-use` event is already
  built, record `Edit | Write | MultiEdit | NotebookEdit` targets. This is the same rule
  the renderer uses today; moving it up means terminal and background chats get it too.
- **CLI / terminal chats** — on run end, scan that chat's transcript through the existing
  readers for the same tool calls. Codex and Gemini transcripts get their own extractor in
  `authorship-pure.ts`, one function per provider shape, all returning `string[]`.
- **Backfill** — on first read for a session with no ledger entry, union the paths from its
  checkpoints, so chats that predate this feature are not blank.

`authorship-pure.ts` owns the decisions worth testing:
- `toRepoRelative(absPath, repoRoot, worktreePath?)` — normalise case and separators, map a
  `\\wsl.localhost\<distro>\…` path and a `/mnt/c/…` path onto the same repo-relative
  POSIX path, and map a worktree path (`<repo>.worktrees/<id>/…`) back onto the repo. A
  path outside the repo returns `null` and is dropped.
- `attribute(statusFiles, ledgers, activeSessionId)` → `{ mine, others, unattributed }`,
  where `others` carries the session id and name per file.

**IPC:** `authorship:for-repo(cwd)` → the attribution for the current `getStatus()`, and
`authorship:forget(sessionId)`.

**UI:** `GitModal` gains an optional `sessionId` prop and renders the file list in three
groups — *This chat*, *Other chats* (each row naming the chat), *Unattributed* (hand edits,
another tool, a rebase). The header says it plainly when the tree holds work that is not
this chat's, because that is the failure this phase exists to prevent: reviewing a diff as
if one agent wrote it when two did.

Renderer tracking (`modifiedFilesRef`) stays as is for checkpoints; it becomes one consumer
of the same rule rather than the only place it lives.

## 2. Batch commit with a verification gate

**New: `src/main/commit-gate.ts` (+ `commit-gate-pure.ts` and test).**

`commitGate(cwd, { paths, message, verify })`:
1. Refuse up front on an empty selection, a message that fails the Conventional Commits
   shape, or an index that already holds paths outside `paths`.
2. `git add --` exactly `paths`.
3. `git stash push --keep-index --include-untracked` — isolate the staged tree.
4. Run the verify command, captured, with a timeout.
5. `git stash pop`, **always**, including on failure and on timeout. If the pop conflicts,
   stop and report it with the stash ref rather than guessing; nothing is committed.
6. On a clean verify, `git commit`. On a failed one, return `{ ok: false, output }` with the
   staging left intact so the fix is one edit away.

Pure half: the Conventional Commits validator (type set, scope shape, ~72-char subject, no
trailing period) and the draft builder that proposes `<type>(<scope>): <subject>` from the
changed paths. **No `Co-Authored-By`, no "Generated with" line** — asserted in the test, so
it cannot come back by accident.

Verify command resolution: per-project override in `project-prefs.ts`, else the `typecheck`
script from the project's `package.json`, else nothing — and then the gate says it verified
nothing rather than reporting a pass.

**UI:** in `GitModal`, "Commit this chat's files" — preselects the *This chat* group, shows
the drafted message for editing, and runs the gate with its output inline. The existing
free-form stage/commit path stays untouched for everything else.

## 3. Batch queue

**New: `src/main/queue.ts` (+ `queue-pure.ts` and test), and a queue panel in `RoomsView`.**

A queue per project: an ordered list of missions, each
`{ id, prompt, agentId, accountId, model, worktree, state, sessionId?, commit? }`, moving
through `queued → running → awaiting-review → committed`, plus `failed` and `skipped`.
`queue-pure.ts` owns the transitions and the release rule — which mission, if any, may
start now, given the others' states and whether they share a working tree.

Running a mission reuses `deployAgent` (`App.tsx:2762`); `awaiting-review` is entered when
its run ends, and only a successful `commitGate` moves it on and releases the next. Nothing
starts while a mission on the same tree awaits review — that is the sequencing currently
kept by a person being at the keyboard between batches.

Missions are added from `BacklogBoard` (a checkbox line becomes a mission), from
`PlannerView`, or typed straight in. The panel shows each mission's state, its chat, and
its commit once it has one.

## Alongside

- **Visual check as a button** — the isolated-instance launch and screenshot, beside the
  diff in the review step, rather than only as a skill invoked by hand.
- **Worktree by default for queued missions** — `createWorktree` per mission makes the
  parallel case safe; today it is opt-in per chat (`useWorktree`, `src/main/index.ts:889`).

## Not in scope
- Pushing, tagging, or anything in the release flow.
- Rewriting `GitModal`'s free-form path, or the renderer checkpoint tracking.
- Splitting one chat's changes into several commits automatically — the gate commits a
  selection, and the selection is the person's.

## Order of work
1. ~~Phase 1 without the UI: ledger, feeds, pure normaliser + tests.~~ Done, `7a5aa0e`.
2. ~~Phase 1 UI: grouped `GitModal`.~~ Done, `f685b91`.
3. Phase 2: gate + tests, then the button.
4. Phase 3: queue state machine + tests, then the panel.

One commit per step, each compiling on its own (`npm run typecheck` per staged tree) —
which is, not by coincidence, what this plan is about automating.
