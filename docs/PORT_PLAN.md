# Porting the rest of Argos to the system design

_Planned with Fable on 2026-10-02 from `SYSTEM-DESIGN.md` §9 and the inventories of every
screen; implemented by Opus and Sonnet subagents in the batches of §4, one commit each,
each compiling on its own. The wireframes the owner chose are in
`docs/wireframes/port-2026-10.html` (frames marked "Escolhido"); the frames not chosen stay
in that file as the record of what was considered._

## 1. What changes, in one paragraph

Every screen outside ops gets the same anatomy the ops surfaces got in 2.0.0: rounded
corners only on what you press, flat 4 px surfaces with no card inside a card, colour only
where it carries state, one primary action per screen, a right-hand column (440–520 px)
for whatever is live or needs the operator, sheets instead of modals for anything with
room to breathe, SVG chevrons, no emoji, numbers that matter set large with a caption.
Shared controls move into one place first so the batches delete per-screen styles rather
than add overrides beside them.

## 2. Decisions (owner, 2026-10-02)

| Surface | Chosen | What it means |
|---|---|---|
| Servers | **1B + 1C** | Remote & WSL is a list on the left and a column for the selected target on the right. The "More" menu goes away: Connect, New terminal, Ops, Test connection, Check Claude Code, Edit host, Delete host, working dir, "Hide from Usage & Projects" are all visible in the column. A failed test is the only tinted block, at the top of the column. The Remote & WSL / Ops / MCP sub-nav becomes a segmented control in the page header. Add/Edit host opens as a sheet. Session tabs are 8 px buttons; the path is a mono 4 px input; a connection error is a tinted block inside the files pane, not a banner. |
| Settings | **2B + 2C** | Mode is a segmented control (System / Light / Dark); one live preview of the theme being edited (Light / Dark segmented), no mode tiles, no mocks. Sections are rows separated by `--border`, no cards. Permissions, Hooks, Session notifications and Accounts open as sheets; their Settings rows state the current value ("12 allow · 3 deny · 2 ask"). Coloured section badges become dot + word. |
| Projects | **3A, footer from 3B, column dismisses** | Project list, sessions, and the detail column on the right. The column opens when a session is selected and **closes when the operator clicks outside it** (the list, empty space) or presses Esc; the list then takes the full width. Footer is one row: Resume (primary, flex) · Rename · Move · Archive · Delete (text in `--error`). Date groups are centred captions with counts; model chips are mono 3 px; the WSL badge is a neutral chip. |
| Planner Sprint | **4B** | Board on the left; a column on the right with the points bar, a small burndown, the blocked item as the only tinted block (with "Move to next sprint" / "Unblock"), today's standup with Generate, and earlier standups folded to one line each. The Board / Standup / Burndown tabs go away. Priority is a chip, never a coloured edge. Sprint / Item / Complete-sprint modals become sheets. Week mode (PlannerView) only gets radii and tokens. |
| Home | **5B** | Left: the day as title, the active account and when its window resets as subtitle, the start box (textarea, Project / CLI / Account selects, one primary Start, helper line), "Pick up where you left off", "Recent projects". Right column: "Needs you" as the one tinted block at the top with an action per item, "Running", "Uncommitted work", "Earlier today" folded. The header's counter chips go away. |
| Sidebar + setup | **6, without a CLI choice** | Group headers use an SVG chevron; the account badge is a 3 px chip in `--warn` from 70 % and `--error` from 90 %, from tokens; Chats / Files is the shared segmented control; "New terminal" is a quiet button. The start pane has **no CLI control**: the account chosen at the top of the sidebar already fixes the CLI, and the pane's subtitle says which ("Claude Code, as the Default account chosen above"). Fields: Where it runs (select), Folder (select, optional) with the branch as helper text; one primary "Start terminal"; "Enter starts · Esc goes back to the list". |
| Usage | **7B with All** | History on the page: range segmented, source chips, four large numbers with captions, the cost chart in `--accent` with the selected day solid, By model / By project tables filtered by the selected day (the detail modal goes away). Right column: "Plan usage" with a segmented **All / per-account**; the limit closest to its ceiling is the one tinted block; the other limits are rows with bars; Budgets; other accounts folded. With All, each account is a block of its own bars and whatever needs attention sorts to the top. Gradients, icon tiles, emoji and the ⊞ glyph go. |

Everything else follows the rules of the design doc without a wireframe: McpView, FileEditor,
LocalBrowser, DiffView, OnboardingModal, ApprovalModal, context menus get radii, tokens and
chevrons only.

## 3. Rules every batch applies

From `SYSTEM-DESIGN.md`, restated as acceptance checks the reviewer runs on each diff:

1. No `border-radius` literal other than `3px` (label chips), `2px` (bars), `50%` (dots).
   Buttons, segmented controls, tabs, toggles: `var(--radius)`. Surfaces, inputs, rows,
   blocks, sheets: `var(--radius-surface)`. No new `--radius-lg`, `999px`, `20px`, `14px`.
2. No colour literal in a component stylesheet or TSX except inside `color-mix()` with a
   token, and the syntax-highlight palette in `FileEditor.css` / `DiffView.css`. `#e2b341`,
   `#3fb950`, `#d29922`, `#4fc3f7`, `#e0a458`, `#fff` are gone. Tint = 6 % wash + 22–45 %
   border of the state colour, only on the element that needs the operator.
3. No gradients, no `translateY` hover lifts, no shadows except on sheets and popovers.
4. No cards in cards: a block inside a column is flat `--bg-2`; a list inside a block is
   rows separated by spacing; sections in a column are separated by `--border`.
5. One `--accent` fill per screen. Danger is text in `--error` or a quiet button with an
   `--error` border; never a red fill.
6. Chevrons are the inline SVG `M6 9l6 6 6-6`; no `▸ ▾ ⌄ v`, no `×` as text where an
   icon control exists, no emoji, no `⊞ ★ ⋯ ◆ ✦ ✓ ✗ →` as text in controls.
7. Type scale per §4: 22 / 15 / 13.5 / 13 / 12.5 / 12 / 11.5 / 11 px; eyebrows uppercase
   with 0.12 em tracking in `--text-2`; mono for anything that runs or identifies.
8. Words per §8: say what happens; names over identifiers; "optional" after a label, never
   an asterisk; a helper line under the buttons names Enter and Esc.
9. Delete the style a rule replaces. A batch that leaves the old selector in place beside a
   new one is sent back.
10. Both themes checked with the visual-check skill (`-View <name> -SkipBuild -Wide`,
    `VISUAL_CHECK_CONFIG_PATCH='{"theme":"light"}'` for the second), screenshots looked at
    by the reviewer, not only by the implementer.

## 4. Batches

One batch at a time; the next starts only when the previous is on `main`. Fable writes the
brief from the chosen frame and these notes, the subagent implements in a worktree and
reports, Fable reviews the diff against §3, runs `npm run typecheck` and the visual check,
and commits. Subagents never commit.

| # | Surface | Scope | Model | Commit |
|---|---|---|---|---|
| 0 | Foundations | `shared.css` rewritten to the design: `.btn-primary` (accent fill, `--bg-0` text, 8 px, no gradient/shadow/lift), `.btn-ghost` → quiet (transparent, `--border-light`), `.btn-secondary` folded into `.btn-ghost`, `.btn-text.danger`, `.seg-control` (one 8 px frame, active on `--bg-2`, no accent tint), `.text-input` / `select.text-input` (4 px, `--bg-1`, `--border`, `--border-light` on focus, no accent focus ring), `.form-group label` (12 px 600 `--text-1`, sentence case, `.optional` span), `.status-pill` → `.chip` (3 px, variants `ok warn err`), `.eyebrow`, `.divider-caption`, `.block` / `.block.warn` / `.block.err`. A `Sheet` component (`components/Sheet.tsx` + `.css`) extracted from `OpsReportSheet`'s shell: scrim that does **not** close on click, Esc closes, 440–720 px width prop, header slot, footer slot, focus trap; `OpsReportSheet` and `PlanReviewSheet`'s shell switch to it. Literal status colours replaced by tokens in the 13 files that have them (`AccountPicker`, `AccountsModal`, `ChangelogModal`, `FileTree` (extension colours stay), `PendingRuns`, `SftpBrowser`, `Sidebar`, `HomeView`, `McpView`, `ProjectsView`, `RemoteSessionView`, `RemoteView`, `UsageView`). Screens may look slightly different after this batch (squarer buttons); that is the point. | Opus | `refactor(ui): shared controls, a sheet, and tokens for the system design` |
| 1 | Servers | `RemoteView` per 1B (list + target column, sub-nav as header segmented, Add/Edit host as `Sheet`, SSH keys screen restyled), `ServerTabs` + `RemoteSessionView` + `SftpBrowser` + `RemoteTerminal` bar per 1C, `SecretPrompt` stays a modal (a password is the one blocking question). `App.tsx` sub-nav row removed in favour of the header segmented. | Opus | `feat(servers): one column per target, the session chrome squared` |
| 2 | Settings | `SettingsView` + `AppearanceSettings` per 2B; `PermissionsModal`, `HooksModal`, `NotifyHookModal`, `AccountsModal` become sheets (2C), rows in Settings show the current value; `ShortcutsModal`, `ChangelogModal` radii and tokens only. | Sonnet | `feat(settings): flat sections, editors as sheets` |
| 3 | Projects | `ProjectsView` per 3A with the dismissing column; `SessionPeek` becomes the column's content; `LabelManager` as a sheet; `ProjectActions`, `SessionTags`, `PendingRuns`, `Menu` restyled. | Opus | `feat(projects): flat lists and a detail column that gets out of the way` |
| 4 | Sprint | `SprintBoard` per 4B; `SprintModal`, `ItemModal`, `CompleteSprintModal`, `BacklogBackfillModal` as sheets; `PlannerView` radii, tokens, chip priorities, SVG icons for `‹ › ◆ ✦ ✓ ✗ →`. | Opus | `feat(sprints): the board beside a column that says what is blocked` |
| 5 | Home | `HomeView` per 5B. | Opus | `feat(home): what you start on the left, what is live on the right` |
| 6 | Sidebar + setup | `Sidebar`, `NavRail`, `TitleBar`, the setup pane in `Chat.tsx` (no CLI control; subtitle names the CLI from the account), `ChatConfigBar` (selects in the pane, compact pills with the same radii in the terminal bar), `ModelPicker`, `AccountPicker`, `CommandPalette` (`↑↓ ↵` as `<kbd>`), `SessionPeek` leftovers. | Sonnet | `feat(sidebar): chevrons, chips and a start form without a CLI choice` |
| 7 | Usage | `UsageView` per 7B with All. | Opus | `feat(usage): plan limits in the column, history on the page` |
| 8 | Sweep | `McpView`, `FileEditor`, `LocalBrowser`, `DiffView`, `OnboardingModal`, `ApprovalModal`, `TerminalContextMenu`, `TextContextMenu`, `PaneGrid` chrome: radii, tokens, chevrons. `SYSTEM-DESIGN.md` §9 rewritten as "done on <date>", `--radius-lg` removed from `global.css` if nothing uses it. | Sonnet | `chore(ui): finish the sweep to the system design` |

## 5. Out of scope

- Terminal internals (xterm theme, context menu behaviour) beyond their chrome.
- Any change to IPC, data shapes or the ops engine. This is presentation only; where a
  wireframe needs a value the renderer does not have (e.g. the host's Claude Code version
  in 1B, the account's reset time in 5B), the batch uses what exists and leaves a `TODO`
  naming the missing field, and Fable records it in `NEXT_FIXES.md`.
- Light-theme palette changes; both themes are checked, neither is redesigned.
