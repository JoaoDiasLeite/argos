# Intervention history — resume an intervention, refer to past ones

_Planned 2026-11-03 after the owner asked for "forma de retomar intervenções ou referir
intervenções passadas". Decisions closed with the owner the same day (§2). Implemented in
the batches of §6, one commit each, each compiling on its own._

## 1. What changes, in one paragraph

Today an intervention ends for good: the ops terminal launches `claude` with no pinned
session id, so a Relaunch starts a conversation that remembers nothing, and the start
screen's "Earlier on <server>" list only opens a Report. After this work an intervention
can be **resumed**: a new run (own ledger lines, own approvals, plan asked again when the
runbook needs one) with the same server, runbook, task, ticket and client, linked to the
run it continues, where the model either **continues its Claude conversation**
(`claude --resume`) or, when that conversation is not available, starts fresh with a
**briefing** of the earlier run built from the ledger. And any intervention can **refer**
to earlier ones three ways: picked on the start screen, pointed at by the operator in the
middle of a run, or looked up by the model itself through a read-only `ops` tool.

## 2. Decisions

- **Resume = a new run, never a reopened one.** The ledger is append-only and hash-chained;
  a run that ended stays ended. The new run's `run.start` carries `resumesRunId`.
- **Memory on resume: both.** Every ops launch from now on pins a Claude session id and
  logs it (`run.start.cliSessionId`). Resuming a run whose session id is known and whose
  transcript still exists → `claude --resume <id>`, and the new run logs the same
  `cliSessionId`. Otherwise (runs from before this work, transcript gone, a different
  machine) → a new pinned session whose first message tells the model to read the
  briefing of the earlier run through the tool below.
- **The gate does not carry over.** A resumed run starts with `planApproved = false` like
  any run. The resume message says so in plain words, because the resumed conversation
  holds a plan approved in a run that is over and tool results from a relay that is gone.
- **Briefings travel through the `ops` tool, never on the command line.** Ops Claude has
  its own file tools switched off, so it cannot read a file Argos writes, and a long
  positional prompt would hit cmd.exe's 8191-char limit. The first message only names run
  ids; the model calls `past_interventions` to read them.
- **`past_interventions` is read-only, local and scoped.** It reads the ledger on this
  machine, never a host. It is not gated by the plan (like `note`), and it only lists or
  reads runs that touched a host this run may reach: the locked host for a host scope,
  the runbook's hosts for an open scope. Every read is logged (`history.read`).
- **Ledger and model text stay English**; the UI strings go to `en` and `pt-PT` (tu).
- **Briefing content** (pure, English, ≤ 8 KB): when, server(s), runbook, task, ticket,
  client, outcome (finished / stopped / error + reason), approved plan steps, hypotheses
  with their last status, findings, calls (command or script, verdict, exit code; last 40,
  no output), operator requests (command, answered / declined, first 300 chars of the
  pasted output), the run it was handed over to or resumed by. For a run that itself
  resumed another, one line per ancestor (at most 3) before it. Nothing the ledger does
  not hold (no secrets are ever logged).
- **Reports mention the link.** Internal: resumes / related / referenced / read run ids.
  Handover (INC file): "Na sequência de" with the earlier runs' date and task. Client:
  only "Continuação da intervenção de <data>" for a resumed run, no ids.
- **Where resume appears:** a **Retomar** button on every row of "Earlier on <server>",
  and the workspace's exited strip (Relaunch becomes Retomar; the header's Restart stays
  a fresh run). Disabled with a tooltip when the runbook no longer loads or the locked
  host is gone. A row whose intervention still has a live terminal opens that terminal
  instead of starting a run.

## 3. Ledger and types (`ops-types.ts`, `ops-audit*.ts`)

- `run.start` gains `resumesRunId?: string`, `relatedRunIds?: string[]` (≤ 5),
  `cliSessionId?: string` (a UUID).
- New events: `run.referenced { runId, refRunId, by: 'operator' }` (the mid-run button)
  and `history.read { runId, refRunId?: string }` (the model's tool; no refRunId = list).
- `OpsRunListItem` gains `runbookPath`, `scope?`, `ticket?`, `client?`, `cliSessionId?`,
  `resumesRunId?`, so a history row carries what a resume needs.
- `ops-briefing-pure.ts`: `renderBriefing(run: OpsAuditLine[], ancestors: OpsAuditLine[][])`
  and `historyListText(items)` + tests. Reuses the folding the handover report already
  does for notes (latest note per id wins).
- Report renderers (`ops-report-pure.ts`, `ops-handover-pure.ts`) pick up the links.

## 4. Main process

- **Tool** (`ops-tool-defs-pure.ts`, `ops-relay.ts`, `ops-tools.ts`, `ops-session.ts`):
  `past_interventions { runId?: string }`. Added to `OPS_BRIDGE_TOOLS`; canUseTool allows
  it without a plan; the handler filters by scope (`historyScopeHosts(ctx)`), reads with
  `ctx.ledger.listRuns` / `readRun`, logs `history.read`, returns `historyListText` (≤ 15
  runs) or `renderBriefing`. An id outside scope or unknown → a plain refusal text.
  `OPS_TOOL_RULES` gains one sentence on when to use it.
- **Launch** (`index.ts` openTerminalOps, `terminal.ts`): `OpsIntervention` gains
  `resumesRunId?` and `relatedRunIds?` (same id regex as `parentRunId`, ≤ 5, deduped).
  main picks the session: resume + known `cliSessionId` + transcript file present
  (`~/.claude/projects/<encoded runbook cwd>/<id>.jsonl`, encoding helper from
  `claude-data.ts`) → `{ resumeSessionId }`; else a new `crypto.randomUUID()` →
  `{ pinSessionId }`. `TerminalOpsResult` gains `resumeSessionId?` / `pinSessionId?`, the
  renderer passes them to `ChatTerminal`. The first message, from a pure
  `interventionPrompt(task, { planRequired, resume?: { runId, conversation: boolean },
  related?: string[] })` in `ops-scope-pure.ts`:
  - resume with conversation: "This is a new Argos run resuming the intervention above
    (earlier run <id>). Its plan approval and tool connection ended with it: <propose a
    new plan before any other ops call | carry on>. <task>";
  - resume without: "This intervention resumes run <id>. Call past_interventions with
    that runId first, then: <task>";
  - related: "...Related earlier interventions: <ids>. Call past_interventions for each
    before you start."
  On a resume the message goes as the positional prompt of the **resume** step
  (`claude --resume <id> "<msg>"`); the chain's create fallback gets the no-conversation
  variant. `claudeChain` grows that option; its tests cover both.
- `interventionKey` includes `resumesRunId` and `relatedRunIds`.
- **Mid-run reference** `ops:reference(terminalId, refRunId)`: checks the run is live and
  the ref in scope, logs `run.referenced`, returns the one line to type: "The operator
  points you to the earlier intervention <id> (<date>, <task>). Call past_interventions
  with that runId and take it into account." The renderer writes it to the pty.

## 5. Renderer

- `InterventionStart.tsx`: each history row gets **Retomar** and a **Referir** toggle
  beside Report. Toggled rows show as chips above the Start button ("Relacionada com: …",
  × each, at most 5); they go into `onStart` as `relatedRunIds`. Retomar calls a new
  `onResume(row)` that builds the intervention from the row (`runbookPath`, `scope`,
  `task`, `ticket`, `client`, `resumesRunId: row.runId`).
- `opsTerminalIdFor` leaves `resumesRunId` and `relatedRunIds` out of the hash, so a
  resumed intervention lands in the same terminal and its earlier runs fold in the
  activity column as today.
- `OpsWorkspace.tsx`: exited strip's Relaunch → Retomar (resumes the last run of this
  terminal); passes `resumeSessionId` / `pinSessionId` to `ChatTerminal`.
- `ActivityColumn.tsx`: a **Referir intervenção…** button in the run header while the
  run is live; a small dropdown of runs on the same server (`ops:runs`), pick one →
  `ops:reference` → write the returned line + `\r` to the terminal.
- Activity rows for `history.read` ("Consultou a intervenção de dd/mm") and
  `run.referenced` ("Referiste a intervenção de dd/mm").
- i18n keys in `ops.ts` (en, pt-PT), changelog entry.

## 6. Batches

| # | Model | Files | Commit |
|---|-------|-------|--------|
| A | Opus | ops-types, ops-audit(-pure), ops-briefing-pure (+test), report renderers, types.ts (OpsRunListItem) | `feat(ops): record intervention links and build run briefings` |
| B | Opus | ops-tool-defs-pure, ops-relay, ops-tools, ops-session (+tests) | `feat(ops): let the model read past interventions in scope` |
| C | Opus | index.ts, ops-scope-pure (+test), terminal-ops-pure (+test), terminal.ts, preload | `feat(ops): resume an intervention and start one with related runs` |
| D | Sonnet | InterventionStart, OpsWorkspace, ActivityColumn, ops-terminal, i18n, ChangelogModal | `feat(ops): resume and refer to interventions from the ui` |

Sequential (A → D share types). Verify each with `npm run typecheck`, the ops tests, and a
visual check of D in an isolated instance.
