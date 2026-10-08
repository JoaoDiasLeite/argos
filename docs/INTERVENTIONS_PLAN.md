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

## 4. Renderer

- **`views/InterventionStart.tsx` + css** replaces `OpsView`'s body (board C2): Server
  select (stored SSH hosts with connection dot, plus "Any server this runbook allows"),
  Runbook select (recents + Choose folder…), Task textarea, Ticket and Client inputs,
  "Start intervention" with a play icon; right column "What this runbook allows" from
  `summary` with the two file buttons, and "Earlier on <server>" from `ops:runs`. Validation
  inline: runbook unusable, host not in any policy group ("this runbook does not know
  rocky-test; add it to a group"), empty task. The Ops member of Servers opens here.
- **`views/OpsWorkspace.tsx`** rewritten to board D2: header `‹ runbook · ● host ·
  read-only/strict · Claude Code · gated · Restart`; terminal left; **`components/
  ActivityColumn.tsx`** right (replaces `OpsTimeline` and the embedded `PlanReviewSheet`):
  run header (Running since HH:MM · k of n steps · progress bar · Report · Stop), the
  **waiting block** when an approval for this terminal is at the head of the queue (plan:
  the step list in the v2 style; call: title, command, Allow / Deny; host: "The model wants
  to reach db-01. Allow for this intervention?"), one row per call (dot · command · duration
  or verdict, strike-through on denied, click to expand output), "Earlier today · N runs"
  folded lines with Report. The plan sheet drawer is no longer used (ops chats are gone);
  `PlanReviewSheet` becomes the waiting block's plan variant.
- **`components/OpsReportSheet.tsx`** replaces `OpsReportModal` (board E2): right-hand
  sheet over the terminal, Internal / Client toggle, Copy, Save beside runbook, title line,
  four tiles, Plan, Calls table (time · command · result), "Show output of every call",
  footer with audit identifiers.
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
