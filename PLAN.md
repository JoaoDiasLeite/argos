# PLAN.md — porting FRIDAY into Argos

FRIDAY (`~/secops/friday`, WSL) is a local web viewer for the same Claude Code
transcripts Argos reads: Express + vanilla JS, no build step. It has features Argos
does not. This is the plan for bringing them across, and the record of what has
landed.

Two facts shape the whole thing:

- **The server halves are compatible.** FRIDAY's `lib/*.js` are ESM with no external
  dependencies, so they port into `src/main` with little more than type annotations.
- **The interface halves are not.** 762 KB of vanilla `app.js` against typed React
  components. Every feature gets a new UI, and that is two thirds of each lot's cost.

**Copy the invariants, not just the behaviour.** FRIDAY knows things because it broke
first: a `findIndex` by text that wrote to the wrong line once two topics matched, a
validator that guarded an HTTP handler instead of the write point, an `ENOENT` that
made a cascade skip sessions in silence. Each lot below carries the rules it inherited
and why. Porting the behaviour without the rule reintroduces the bug.

---

## Done

| Lot | What | Commits |
|---|---|---|
| **0** | Streaming JSONL reads | `1715d1d` |
| **1** | Session tags + label vocabulary | `21c341f`, `5e89ae7` |
| **1.5** | Projects view rework (not from FRIDAY — see below) | `b795bd6`, `c0a9ef0`, `c8c4adc`, `e3cabc2`, `2b209b2` |
| **2** | Archive / rename / move / delete a conversation | `7d5f197` |
| **3** | The notification hook | `38f4716` |
| **4** | The rest of transcript fidelity | pending |

Alongside these, two things that were not ports but came out of the same work:

- **Cache writes priced by TTL** (`44fd930`). Claude Code writes 1h-TTL cache entries,
  which cost 2× input, not the flat 1.25× the app charged. Every figure in Usage was
  low by about a third.
- **Chats run on Claude Code's cache-stable system prompt** (`2d2a1fc`). They were
  running on tool definitions alone. Measured: the preset costs ~5.3k tokens once, and
  `excludeDynamicSections` stops git-status churn invalidating ~7.7k tokens per turn.

### Lot 0 — streaming

`src/main/jsonl.ts` is the only way this process reads a transcript. Rules kept:

- A line that fails to parse is skipped (a live `claude` is appending, so the last one
  can be a partial write); a **read error propagates**, because a caller that treats
  "unreadable" as "empty" reports a real session as having no content.
- `iterJsonlEntries` takes a raw prefilter applied **before** `JSON.parse`. The usage
  sweep wants the ~5% of lines carrying `"usage"`, and parsing the rest to discard them
  costs more than the read.
- `sniffCwd` stops at the first line carrying a `cwd`. On a 7 MB transcript that is
  7ms instead of 56ms of blocked main thread.

### Lot 1 — tags

The tag set lives in the transcript as an appended `custom-tags` line, last one wins —
the same append-only shape the CLI uses for `custom-title`. Only the colour is local.
Rules kept, each from a real FRIDAY defect:

- **Normalisation at the write point, not in the handler.** With it in the handler, the
  rename path built its line by hand and wrote `["ui","ui"]`.
- **One sweep** (`scanSessionsWithTag`) serves cascade, merge and the count the
  confirmations show, so the number that talks you into a destructive action is the one
  that action uses.
- **Renaming onto an existing label is a conflict, not a merge.** Merging silently
  loses a label nobody asked to lose.
- **A partial sweep leaves the registry alone.** Dropping the entry while the name is
  still applied somewhere would strand it, and the next fold-in resurrects it with a
  new colour.
- **Deleting a label always cascades.** Clearing the registry alone looks like it
  worked and undoes itself on the next listing.

### Lot 2 — session lifecycle

- **"Archived" is not a flag.** It is the file sitting in the project's `archived/`
  subdirectory, which is what makes it survive the app and makes unarchiving the same
  operation in reverse.
- **Rename appends `custom-title`**, so a name set here shows in Claude Code and one
  set there shows here. Reading it also fixed a plain omission: Argos ignored CLI
  renames entirely.
- **Move is filing only.** The `cwd` inside the transcript is never rewritten — where a
  conversation ran is a fact about the past, and resume resolves from it.
- **A move onto an existing id is refused, not overwritten.**
- **Delete is irreversible and says so**; archive is the reversible one and acts on a
  single press.

### Lot 3 — the notification hook

Claude Code's `Notification` hook fires for every session on the machine. Wired to
Argos, each one names `[project] conversation` and its click opens that conversation.
`src/main/notify-hook-pure.ts` holds everything that decides what reaches a URL or
the user's settings; `notify-title.ts` holds the bounded transcript read.

- **The hook process is not the app.** `--notify-hook` is guarded before the single
  instance lock and returns out of `whenReady` before anything else runs — no
  userData migration, no scheduler, no window. A hook flag with an unusable payload
  **aborts rather than falling through**, or one malformed notification boots the
  entire application.
- **The lock is the question and the delivery in one call.** `requestSingleInstanceLock`
  with the payload as `additionalData`: not getting it means Argos is running *and*
  has just been handed the notification. Getting it means Argos is closed — so the
  lock is **released immediately** (this process is about to exit and a real launch
  would be waiting on it) and a detached process shows the toast instead. The relay
  must exit: Claude Code waits for it, and a notifier that lingers stalls the CLI.
- **A relayed notification does not raise the window.** A session on another desktop
  asking for attention is not a reason to throw a window in front of what you are
  doing. That is what the click is for.
- **Sanitise what reaches the deep link** — the session id is `[0-9a-f-]` or nothing,
  and `argos://` is re-validated on the way in as well as out: any process on the
  machine can invoke a registered protocol.
- **Never read a whole transcript for the title.** A bounded tail (`tailJsonlEntries`,
  which drops the fragment its window opened on) for `custom-title` / `ai-title`, a
  capped head for the opening message. Some of these files pass 100 MB and this runs
  on every notification.
- **Never edit the user's `settings.json`.** The panel shows the block and copies it.
- **`ARGOS_NOTIFY_DRYRUN=1` prints what the hook worked out.** Everything on this
  path is swallowed on purpose, which means a notifier that does nothing looks
  exactly like one that was never wired up. Ported from FRIDAY's `FRIDAY_NOTIFY_DRYRUN`
  and immediately earned it: **`process.stdin` as a stream delivers nothing in
  Electron's main process on Windows** — no `data`, no `end` — while `readFileSync(0)`
  returns the payload. Without the dry-run that reads as a hook that was never
  installed.
- **A deep link beats the view's own default.** Projects auto-selects the first
  project, and reading a large one takes seconds — long enough for a click to arrive
  and pick another. Listings now carry a request token, and the auto-selection stands
  down when a target exists; without it the slow read landed last and replaced the
  conversation the user was sent to.

### Lot 4 — the rest of transcript fidelity

Half of this landed with the Projects rework, in `isInjectedUserEntry`. What was left
was the mirror of the same problem, and the search that suffered from it.

**`AskUserQuestion` answers are decisions, not tool output.** The question is a
`tool_use` and the answer a `tool_result`, so a viewer that knows only about tools
prints the owner's own choice as grey machine text with nobody's name on it. It is the
exact mirror of the injected-user-entry defect: there the CLI's text was attributed to
him, here his text is attributed to a machine.

- **Anchor, don't regex.** The statements come from the `tool_use` and are matched
  literally, quotes included. A real question was `Which entries should move to the
  grey "system" bubble?` — a `/"([^"]+)"="([^"]+)"/` cuts it in half.
- **Match labels longest-first, removing what matched.** A `split(', ')` is simpler
  and wrong: a label can contain a comma (`Yes, fix everything (Recommended)` is
  real), and a label that prefixes another (`Yes` inside `Yes, fix everything`)
  matches twice without the removal. What is left over is the "Other" option — text
  he typed.
- **The tool call is dropped only when the parser returned something.** The format is
  the harness's, not this repo's; on the day it changes the viewer must fall back to
  the two tool bubbles rather than draw a block it half understood. `withDecisions`
  is where that rule lives, and it is tested from both sides.
- **Strip the mockups before the 4000-char cap.** `readSession` truncates tool
  results, and an answer's appended previews are most of its length — truncated, the
  last question loses its anchor and disappears from the block without a trace.

**Two search depths, one collector.** `collectMatches` is the matcher; the depths
differ only in what they feed it. `proseSegments` (per-project) is what people said;
`searchableSegments` (global) adds tool inputs and results.

- **A decision is the owner's in both depths.** Per-project excludes tool output by
  design, and his answer *was* tool output — so searching for a decision he made did
  not return the conversation he made it in. Both depths run the same extractor, or
  one choice is his prose in one search and a machine's in the other.
- **A question is indexed as prose, not as its JSON.** Indexing the raw input gives
  snippets of `"questions":` instead of the statement he read.
- **The raw-line prefilter is not valid for every query.** Skipping the segment build
  for lines that cannot match is most of what makes the sweep affordable, but the raw
  line is JSON: a quote is `\"` there and a newline is `
`. A prefilter may only let
  extra lines through, never drop one, so `rawPrefilterable` turns it off for those.
- **The project's own name matches only in the global depth.** Inside one project it
  would match every session in it and tell you nothing.

### Lot 1.5 — the Projects view

Not a port. Measured on `wm-project` (52 sessions): 46 distinct titles, but **33
previews were the same `/security-review` sentence** and **14 titles were raw CLI
markup**. The grid looked cluttered because two thirds of it said the same thing, so
the content came first and the layout second.

Three content rules: strip command wrappers by *shape* (backreferenced tag name, not a
list — the CLI adds variants without asking); hide a preview shared by three or more
sessions in a project, or one that only restates the title; keep the accent for things
you act on.

Then the layout, as [52 conversas, 4 layouts](https://claude.ai/code/artifact/180360d7-40a5-41ff-aa5d-85825a161302)
worked out: projects sidebar → aligned rows banded by date → a full-height reading
panel that opens on selection. Selecting stopped being resuming, because a decision
taken with the same gesture as the action is not a decision.

---

## Next

### Lot 5 — project-level lifecycle · 2–3 days · depends on 2

The half of Lot 2 deliberately left out.

- Archive a project (a flag in preferences — organisation, not files; orthogonal to
  archiving *sessions*), delete an empty project (only when it holds no `.jsonl`,
  active **or** archived, so it can never wipe a conversation).
- **Change a project's folder** is the heavy one: FRIDAY's `move-project.js` runs nine
  blocks before any write, with rollback on the first two steps, re-keys eight
  preference files, and refuses a different volume rather than copying. Worth its own
  round.
- **The rule that matters for any new preference:** it must be added to *both* the
  forget-project and move-project paths. One that lands only in forget survives a
  delete and vanishes on a move.

### Lot 6 — backlog fused with the repo, and memory diagnostics · 4–5 days · depends on 0

Where FRIDAY went furthest. Argos's Planner manages tasks that exist only in Argos;
FRIDAY's manages the `- [ ]` boxes already in the repo — and those survive the app.

- `pickPrimary`: BACKLOG > TODO > TASKS > ROADMAP, root before `docs/`. With a primary
  record, the topics **are** those checkboxes: create appends, complete ticks, plus
  edit-in-place, duplicate and delete-one-line.
- **Index first, text only as a fallback, and two distinct conflicts:** no line matches
  is *stale*; more than one matches is *ambiguous*. Without the second, a tick wrote to
  the first identical line — invisible until someone duplicated a topic.
- **Duplicate inserts immediately after**, not at the end, or the copy leaves the
  section its topic lives in.
- **The pending count is the real one**, not the length of a list capped at twelve.
- Memory diagnostics (`memory-diagnostic.js`) is read-only, three layers, with a score
  and gaps. It fits the Planner as a third source.

**Decide before starting:** two sources of truth for tasks is the real risk. The rule
to adopt is that when a primary record exists in the repo, the repo wins, and Argos's
own store shows as legacy with a migration.

### Lot 7 — live sessions: takeover and terminal grid · 2–3 days · independent

Argos lists sessions but cannot see which are live *outside* it. FRIDAY derives that
from Claude Code's own `~/.claude/sessions/` registry with a PID-liveness check.

- **Takeover** signals a process that is not our child — the most conservative
  treatment available: a terminate, never a kill; the pid from the registry, never from
  the request; and only after the liveness and PID-reuse guards.
- One conversation, one live `claude`: hide the resume affordance over a session that
  is already live, because two instances on one sid interleave turns and fork the
  `parentUuid` chain.
- If several panels ever share one terminal stream, **count consumers, not sockets** —
  FRIDAY counted sockets and closing one panel killed the stream for all of them.

### Lot 8 — semantic search · 5–7 days · optional · depends on 0

Eight modules and a derived int8 index over embeddings from a local Ollama. The most
expensive and the most dispensable — **only if substring search is actually failing**.

- The index is derived and disposable: no content, only vectors and pointers. Deleting
  it loses nothing.
- **Read the dimension from the index manifest, never from configuration.** Reading
  config makes the index and the query disagree in silence when the model changes.
- Local by default; a remote endpoint means conversation prose leaves the machine in
  clear text, and that is an owner-chosen exception, never a default.

### Lot 9 — hygiene · 1–2 days · independent

- A **single tested theme registry**. Argos has nine palettes defined only in CSS, so
  a swatch in the picker can drift from the palette it names. FRIDAY has one module the
  picker, the meta theme-colour and the terminal background all read from.
- **Static guard tests** for conventions that have already failed once. They do not
  catch a new case; they catch the rule being deleted, which is how these come back.

---

## Not porting

| | Why |
|---|---|
| Remote access (passkey + FRP tunnel) | Argos is a desktop app, not a server, and FRIDAY's model is explicitly single-owner. |
| Host federation | Depends on the above. Argos already reads WSL distros directly and connects over SSH. |
| PWA, service worker, web-push | These are how a page behaves like an application. Argos is one. |
| `tmux` persistence | Solves "the browser closed". In a desktop app the window is the process, and checkpoints are the safety net that matters. |
| Supervisor + Makefile | Replaced by the installer and the auto-updater. |
| The "no database" discipline | Excellent for a viewer that should store nothing. Argos has `store.ts` and needs it — accounts, agents, sprints, checkpoints. |
| Export / import zip | Solves moving conversations without disk access. On a desktop the file explorer is already there. |
| Translating the UI to pt-PT | Argos is in English and that is coherent. Translation is ongoing work, not a lot. |

---

## Conventions for every lot

1. **JS → TS with the repo's pure split.** Anything that touches neither `fs` nor
   `electron` goes in a `*-pure.ts` with its test beside it. That is what makes
   `normalizeTags`, `splitCacheWrite`, `groupByAge` and `previewRestatesTitle` testable
   without simulating Electron. Where a module must touch `fs` but not `electron`, split
   it the way `tags.ts` / `tags-sweep.ts` and `session-files.ts` /
   `session-lifecycle.ts` are split — the half worth testing is the half that writes.
2. **HTTP → IPC, with conflicts as values.** FRIDAY's `409 stale`, `409 ambiguous` and
   `409 label-exists` must reach the renderer as discriminated return values, not
   thrown errors. Each needs a different move in the UI, and a `catch` flattens them
   into one failure.
3. **Streaming is the rule.** No new transcript read may use `readFileSync`.
4. **Preferences go in `store.ts`** under `userData`, and a new one must be added to
   both the forget-project and move-project paths.
5. **Every transcript write goes through `safeSessionPath`.** Ids come from the
   renderer and reach the filesystem.
6. **Scope your CSS class names.** Both stylesheets land in one global sheet, so a bare
   class defined in two files silently collides — `shared.css` says so at the top, and
   the Projects rework proved it anyway by naming its rows `.session-row`, which the
   sidebar already owned, and turning every chat row into a five-column grid.
