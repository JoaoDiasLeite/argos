# Interventions — the ops flow as the owner works (2.0.0)

_Planned with Fable after the first real run against the Rocky 9 VM; implemented by Opus
subagents in the batches of §6, one commit each, each compiling on its own. Wireframes
approved 2026-10-02: boards C2, D2, E2, F2 of the "Ops plan approval wireframe" canvas;
their HTML sources sit beside this plan's batches as the reference the UI must match._

## 1. What changes, in one paragraph

Ops stops being "pick a runbook, get a workspace, the hosts come from the policy" and
becomes an **intervention**: one server (or, deliberately, any server the runbook allows),
one runbook, one task described by the operator, optional ticket and client. The start
screen says in plain words what the runbook allows before anything runs. The workspace is
the terminal plus **one activity column**: a compact run header, whatever is waiting for
the operator as the only highlighted block with Allow / Deny right there, one line per
call, earlier runs folded to a line each. No cards, no modals for ops. The report opens
as a sheet that reads like a document. The task typed at start becomes the CLI's first
message, the run's record and the client report's Assunto.

Since 2026-10-21 an intervention comes in two modes. **Diagnosis** (despiste), the
default, runs the read-only runbook shipped with Argos (`docs/OPS_AGENT_PLAN.md` §2.2):
no plan to approve, the model records hypotheses and findings as it goes, hands the
operator any command it may not run, and the run ends in a handover report. **Runbook
intervention** is the flow above, with a runbook from the runbooks folder of Settings. A
diagnosis that reaches a fix with a procedure is **handed over** to a runbook intervention
on the same server, and the two runs name each other.

## 2. Decisions

- **Scope per intervention.** `{ kind: 'host', hostId }` locks the whole run to one host:
  a call naming another host is refused ("outside this intervention's scope") whatever the
  policy says. `{ kind: 'open' }` lets the model ask for any host the policy knows; the
  **first touch of each host asks the operator once per run** and is logged
  (`host.approved` / `host.denied`). A host outside the policy is refused as today.
- **The task is data.** `run.start` carries `task`, `ticket?`, `client?`. The client
  report's Assunto becomes the task (sanitised), with ticket and client in the header. The
  initial prompt typed into the CLI is fixed text plus the task: "Read RUNBOOK.md in this
  folder before proposing a plan, then: <task>".
- **Claude Code only.** Already landed (`39badc7`).
- **No modal, no toast while focused.** Ops approvals (plan and per-call) render inline in
  the activity column for the terminal they belong to. The toast still exists for a hidden
  window and uses board F2. `ApprovalModal` stays only for non-ops requests, of which none
  exist today; it is kept as dead-safe code until a later cleanup.
- **One intervention at a time per server** in the UI. The bridge keeps supporting more.
- **Diagnosis first, by default.** The start screen opens in Diagnosis mode on every
  mount and does not remember the mode: an intervention that can change a server is
  chosen on purpose. Whether a run needs a plan is derived from its policy
  (`planRequired`, OPS_AGENT_PLAN §1.7), not from the mode, so a team runbook that is
  strict and all-read also skips the plan and can also be handed over.
- **Runbooks are references, reports are not written beside them.** The runbooks folder
  and the single runbooks are paths in `config.ops`; Argos reads them where they are (a
  `git pull` updates them) and never copies or writes them. Reports and handovers are
  saved to their own folders in Settings.
- **Design rule, app-wide for new ops surfaces:** 4 px radius on surfaces (panels, inputs,
  rows, code blocks, tiles), 8 px only on things you click (buttons, segmented toggles),
  chevron icons as inline SVG never text carets, theme tokens only, no cards inside cards.
  Add `--radius-surface: 4px` to `global.css`; `--radius` (8 px) stays for buttons.

## 3. Main process

- `ops-types.ts`: `OpsScope`, `run.start` gains `task`, `ticket?`, `client?`, `scope`;
  new events `host.approved` / `host.denied` `{ runId, hostId, host, by: 'user' }`.
- `ops-session.ts`: `openOpsSession` takes `scope` and `task` fields; `decide()` applies the
  scope before the gate (host scope: `hostId !== scope.hostId` → deny; open scope: unknown
  host → ask once via the existing `ask` hook with an `ApprovalOpsContext` of
  `tool: 'host'`, remember the answer for the run). Pure helper `scopeVerdict(scope, hostId,
  approvedHosts)` + tests.
- `ops-report-pure.ts`: Assunto from `task` when present (sanitised; falls back to the
  runbook name); header line with client and ticket when present; internal report shows
  task, ticket, client.
- `index.ts`: `ops:terminal-session(terminalId, { runbookPath, scope, task, ticket?,
  client? })` (the old positional form goes); `ops:runs({ hostId?, limit })` → run
  summaries from the ledger (newest first, across day files, cap 30 files) for the history
  list; `ops:load-runbook` gains `summary: { autoReads, asks, mutates, scripts, readPaths,
  guidelinesHead /* first paragraph of RUNBOOK.md, ≤ 300 chars */ }` computed by a pure
  helper in `ops-policy-pure.ts` (+tests); `ops:open-runbook-file(dir, 'RUNBOOK.md' |
  'policy.json')` via `shell.openPath`, path-checked.
- `ApprovalOpsContext.tool` gains `'host'` with `hostName`/`hostAddress` of the host asked
  for.
- Added with the despiste work: `ops:builtin-runbook` → the built-in runbook's folder;
  `ops:scan-runbooks` → the runbooks folder's subfolders that carry `RUNBOOK.md` or
  `policy.json` (pure `runbookLibraryEntries`, dot-folders left out, nothing validated;
  each is loaded on its own); `config:ops-dirs` / `config:set-ops` for `config.ops`
  (`reportsDir`, `handoversDir`, `runbooksDir`, `runbookFolders`, absolute paths only);
  `ops:open-folder('reports' | 'handovers' | 'runbooks')`; `ops:report` and
  `ops:save-report` take a third kind, `handover`; `ops:operator-request` /
  `ops:operator-response` carry `ask_operator`; `ops:terminal-session`'s intervention
  gains `parentRunId`.

## 4. Renderer

- **`views/InterventionStart.tsx` + css** replaces `OpsView`'s body (board C2): Server
  select (stored SSH hosts with connection dot, plus "Any server this runbook allows"),
  Runbook select (recents + Choose folder…), Task textarea, Ticket and Client inputs,
  "Start intervention" with a play icon; right column "What this runbook allows" from
  `summary` with the two file buttons, and "Earlier on <server>" from `ops:runs`. Validation
  inline: runbook unusable, host not in any policy group ("this runbook does not know
  rocky-test; add it to a group"), empty task. The Ops member of Servers opens here.
  **Mode field** first, a two-option segmented radio: Diagnosis ("Read-only, built into
  Argos", always the default) or Runbook intervention ("Changes the server by a
  runbook"). In Diagnosis the runbook field is hidden, the built-in runbook is loaded on
  its own, the button reads "Start diagnosis" and the right column says what the diagnosis
  allows and what it leaves out. In Runbook mode the **runbook field** (`components/
  RunbookPicker.tsx`, shared with the hand over dialog) lists the runbooks folder's
  subfolders under one header (with a rescan button) and the single runbooks under
  another (each with Forget), then "Choose runbooks folder…" (imports every subfolder)
  and "Choose a runbook…" (that folder only). The old localStorage recents move into the
  single runbooks once; the default pick is the runbook the last runbook intervention
  used. **Settings → Interventions** holds the same lists (runbooks folder, single
  runbooks) and the reports and handovers folders, each with Change, Open and Reset.
- **`views/OpsWorkspace.tsx`** rewritten to board D2: header `‹ runbook · ● host ·
  read-only/strict · Claude Code · gated · Restart`; terminal left; **`components/
  ActivityColumn.tsx`** right (replaces `OpsTimeline` and the embedded `PlanReviewSheet`):
  run header (Running since HH:MM · k of n steps · progress bar · Report · Stop), the
  **waiting block** when an approval for this terminal is at the head of the queue (plan:
  the step list in the v2 style; call: title, command, Allow / Deny; host: "The model wants
  to reach db-01. Allow for this intervention?"), one row per call (dot · command · duration
  or verdict, strike-through on denied, click to expand output), "Earlier today · N runs"
  folded lines with Report. The plan sheet drawer is no longer used (ops chats are gone);
  `PlanReviewSheet` becomes the waiting block's plan variant. From the model's `note`
  calls the column shows **Hypotheses** (each with its status: open, confirmed, ruled
  out; the latest note per id wins) and **Findings**, nothing when it noted none. An
  `ask_operator` call shows an **operator card** ("For you to run"): the command with
  Copy, the host, why, what to look for, a field to paste the output, Send output and
  "I won't run it". The model's call waits until one of those; afterwards the command
  sits among the call rows as run by you (output behind a click), declined, or waiting.
  What the operator typed survives a tab switch.
- **`components/OpsReportSheet.tsx`** replaces `OpsReportModal` (board E2): right-hand
  sheet over the terminal, Internal / Client / Handover toggle, Copy, Save, title line,
  four tiles, Plan, Calls table (time · command · result), "Show output of every call",
  footer with audit identifiers. Three kinds of report: **Internal** (everything the
  ledger holds), **Client** (the sanitised Relatório Técnico de Intervenção) and
  **Handover** (the operator's own `INC-…md` incident file, built from the notes and the
  commands, OPS_AGENT_PLAN §5.2). A diagnosis (a run without a plan) opens on Handover
  unless a tab was chosen. Save writes a new file, never over one: Internal and Client to
  the reports folder (default `~/argos/reports`), Handover to the handovers folder
  (default `~/argos/interventions`); the button's tooltip names the folder and, once
  saved, Open folder appears.
- **Hand over to a runbook** (`components/OpsHandoverDialog.tsx`): a workspace button,
  shown only on a run without a plan. The dialog picks the runbook as the start screen
  does (the built-in diagnosis cannot follow a diagnosis) and fills the task from the
  notes (summary, confirmed cause, actions for now), editable; scope, ticket and client
  carry over. Confirming opens the intervention's run first with `parentRunId` = the
  diagnosis; main then logs `run.handover` in the diagnosis and ends it as finished (not
  aborted). A refusal (runbook does not load, host unreachable) leaves the diagnosis
  running and shows in the dialog. Then the diagnosis's CLI is closed and the workspace
  moves to the intervention. Each run's internal report names the other; the
  intervention's client report says only that it followed an earlier diagnosis.
- **Toast** (board F2): already reworded; apply the radii and layout.
- **App.tsx**: routes `ops` → `InterventionStart`, `ops-workspace` → the new workspace with
  the intervention object; passes the head approval for the terminal down (as today).
- Visual check: the four boards against screenshots of the real app, dark and light.

## 5. Not in scope

Multiple simultaneous interventions in the UI; ticket-system integration; a client list.

## 6. Batches · all landed 2026-10-02

A `3643b12` (+ step skipping `ad31876`), B `8ee7a73` (+ optional task `880abb7`), C
`64f46e8`. What differed from the text below: the task is optional (the CLI is told to
read RUNBOOK.md and wait); the operator can **skip individual plan steps** when approving,
and the gate refuses a skipped step's command if the model runs it anyway; a locked scope
checks and records only its host; in an open scope the host prompt comes after the gate,
so a call that would be refused never asks about a host; the workspace shows the oldest
ops approval for its own terminal; "Earlier today" folds only today's runs, older ones stay
in the start screen's history; the toast window is 420×160.

- **A (main, Opus):** §3 entirely; keep the renderer compiling by leaving the old IPC names
  available until C lands? No: A changes `ops:terminal-session`'s signature, so A also
  updates the single call site in `OpsWorkspace.tsx` to the new object (minimal), and
  `types.ts`. Tests for scope, host approval, summary, report Assunto/header, runs listing.
- **B (renderer, Opus):** `InterventionStart` + css, `App.tsx` routing for `ops`, the
  `OpsView` file deleted, `--radius-surface` token.
- **C (renderer, Opus, after A's types land):** `OpsWorkspace` rewrite, `ActivityColumn`,
  `OpsReportSheet`, toast radii, `OpsTimeline`/`OpsReportModal`/drawer use of
  `PlanReviewSheet` deleted, `App.tsx` workspace routing.
- **D (docs):** `OPS_AGENT_PLAN.md` §8 superseded by this plan; changelog 2.0.0 "Changed"
  gains the intervention flow; `FEATURE_AUDIT.md` untouched.

A and B run in parallel (disjoint files: A owns `src/main/**`, `preload`, `types.ts` and
the one call in `OpsWorkspace.tsx`; B owns `InterventionStart*`, `OpsView*`, `App.tsx`'s
`ops` route, `global.css`). C starts when A reports, and owns `OpsWorkspace*`,
`ActivityColumn*`, `OpsReportSheet*`, `OpsTimeline*`, `OpsReportModal*`,
`PlanReviewSheet*`, `Toast*`, `lib/ops-timeline*`, `lib/ops-approval*`, and `App.tsx`'s
`ops-workspace` route (B must be done with `App.tsx` first; C waits for both).
