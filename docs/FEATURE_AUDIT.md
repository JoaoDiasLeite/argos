# Feature audit — what to keep, hide or remove

_Inventory as of 2026-10-02 (after the ops work, 1.16.4 unreleased). Read-only: nothing here
is a decision yet. Fill the **Call** column with `keep`, `hide` (behind a module profile) or
`remove`, then the cleanup lands one removal per commit in 1.17.0._

The problem being solved: everything that exists is always visible. Two tools do the work:
a **module profile** (Ops / Full) that hides groups of the rail, and **removal** of what has
no use. Hiding is cheap; removing is better when nothing would be missed.

## 0. Things found on the way that are not about taste

- **Three views are routed but not in the rail.** `live` has no entry point at all (not in
  the rail, not in the palette, nothing calls it): dead to the UI. `agents` and `rooms` are
  reachable only from the command palette.
- **`useMcp` has no UI.** Every new chat hard-codes it to `false`; the MCP view only edits
  server definitions. Either a toggle is missing or the view is a config editor and should
  say so.
- **Planner is four task surfaces behind one entry**: Week, Sprint, Backlog (a toggle
  inside the view) plus Routines (a sub-nav member). Four stores: planner JSON, sprints
  JSON, the repo's BACKLOG/TODO file, scheduler JSON.
- `App.tsx` is 3 841 lines and `index.ts` 3 286 with 192 IPC handlers. Any removal shrinks
  both.

## 1. Rail and views

| Surface | Since | Lines | What it does | Call |
|---|---|---|---|---|
| **Home** | 09-14 | 1 045 | Landing: needs you, running, pick up, plan & spend, next up, uncommitted work, recent projects, start box. Default view. | |
| **Chat** | 06-16 | ~3 000 | Sidebar + up to 3 panes + composer, or the embedded CLI terminal. | |
| **Projects** | 06-16 | 1 542 | Browser of Claude Code / Codex transcripts: search, tags, resume, archive, move, delete. | |
| **Planner · Week** | 06-18 | 1 511 | Weekly tasks, priorities, AI review/rebalance/draft. Store: `planner/<monday>.json`. | |
| **Planner · Sprint** | 07-20 | 2 139 | Scrum board, burndown, standup, forge import of issues/MRs. Store: `sprints/<id>.json`. | |
| **Planner · Backlog** | 08-28 | 517 | Edits the repo's own BACKLOG/TODO/TASKS/ROADMAP checkboxes. Hosts the memory diagnostic. | |
| **Planner · Routines** | 06-19 | 494 | Prompts on a cadence (interval/daily/weekly), read-only or full tools. Engine runs in main. | |
| **Usage** | 06-16 | 888 | Tokens and cost across local/WSL, per account plan window. | |
| **Servers · Remote & WSL** | 06-16 | 680 | Distros and SSH hosts, status dots, Connect, Ops chat, SSH keys. | |
| **Servers · remote session** | 07-27 | 340 + 1 500 | Per-host workspace: SFTP browser, local browser, file editor, terminal, tabs. | |
| **Servers · Ops** | 10-02 | 650 | Runbooks, workspace with terminal or chat over the gate, timeline, reports. | |
| **Servers · MCP** | 06-16 | 164 | Add/remove MCP server definitions in `~/.claude.json`. | |
| **Agents** (palette only) | 06-16 | 390 | Custom agents: prompt, model, permissions, tools. | |
| **Rooms** (palette only) | 07-03 | 667 | One room per project; drag an agent in to deploy; inline approvals. | |
| **Live** (unreachable) | 08-28 | 416 | `claude` processes running outside Argos; terminal grid; take over. | |
| **Settings** | 09-09 | 630 + 654 | Appearance, General, Connection, System, Ops audit, About. | |

## 2. Secondary surfaces

| Surface | Since | Lines | What it does | Call |
|---|---|---|---|---|
| Command palette (Ctrl+K) | 06-16 | 124 | Actions and Go-to for every view. | |
| Shortcuts sheet (Ctrl+/) | 09-21 | 108 | Cheat sheet. | |
| Changelog modal | 07-09 | 899 | In-app release notes. | |
| Onboarding | 06-16 | 134 | First-run wizard. | |
| Accounts modal | 06-16 | 439 | Claude multi-login, Codex/Gemini logins. | |
| Approval modal | 06-16 | 151 | Tool approvals with diff; ops calls with host/argv/rule. | |
| Plan review sheet | 10-02 | ~300 | Ops plan approval as a side sheet. | |
| Secret prompt | 10-02 | 56 | Sudo password for an ops run. | |
| Checkpoints modal | 06-16 | 281 | Snapshot / restore files a chat edited. | |
| Git modal | 06-16 | 279 | Stage and commit, grouped by authoring chat. | |
| CLAUDE.md modal | 06-16 | 114 | Edit CLAUDE.md / AGENTS.md / GEMINI.md. | |
| Workspace review panel | 09-09 | 124 | Side column with tree status + checkpoints. | |
| Permissions / Hooks / Notify-hook modals | 06-19, 08-27 | 517 | Edit Claude Code settings from Argos. | |
| Memory panel | 08-28 | 156 | Memory diagnostic score and gaps (inside Backlog only). | |
| Session peek, labels, tags | 08-27 | 906 | Transcript reading pane, label vocabulary, per-conversation tags (Projects). | |
| Project actions | 08-28 | 437 | Archive, move folder, delete project. | |
| Pending runs strip | 07-27 | 121 | Window-wide strip of running / finished-unread chats. | |
| Agent output panel | 06-16 | 147 | Bottom log of tool lines in the chat view. | |
| Server tabs | 08-11 | 213 | Tab strip of open remote sessions. | |
| SFTP / local browsers, file editor | 07-27 | 1 497 | Remote file panes and the code editor. | |
| Ops timeline, report modal | 10-02 | 350 | Ledger timeline, internal/client report. | |
| Quick-launcher overlay (window) | 07-02 | 276 | Alt+Space acrylic window: new chat, quick chat, 6 recents. | |
| Status pill (window) | 07-02 | 236 | Always-on-top pill while a run is in flight and the window is hidden. | |
| Approval toast (window) | 07-02 | 180 | Flyout for approvals when the window is hidden. | |
| Taskbar badges, tray, jump list, Explorer menu | 07-02/03 | 287 | OS integration. | |

## 3. Chat composer and sidebar controls

| Control | What it does | Call |
|---|---|---|
| New chat | Sidebar, Ctrl+N, palette, tray, jump list, overlay Enter. | |
| Quick chat | New chat on the cheapest model. Sidebar, palette, overlay Ctrl+Enter. | |
| Chats / Files tabs | Chat list vs file tree that opens the editor. | |
| Account picker + plan badge | Switch account/provider; plan % and reset time. | |
| Environment pill | Local / WSL / SSH / Ops runbook. | |
| Project folder, branch pill | Folder chooser; read-only branch. | |
| Worktree toggle | Run in a fresh git worktree. | |
| Add directory chips | Extra working dirs. | |
| Model picker | Per-chat model. | |
| Approve / Auto | Ask before mutating tools, or not. | |
| Light / Full | No tools (cheaper) vs tools. | |
| Attach, slash commands, @ mentions | Composer helpers. | |
| Usage readout, long-session banner | Context tokens and cost; Compact / Start fresh. | |
| ⋯ menu | Export .md/.html, copy, Git, Checkpoints, Review, Edit CLAUDE.md. | |
| Message actions | Edit and resend, retry, branch, copy. | |
| Work mode Chat / Terminal | App-wide: every chat is the CLI in a terminal. | |
| Terminal bar | Font size, Git, Review, Restart, Close. | |
| Multi-pane grid | Up to 3 chats, Ctrl+1..3, drag from sidebar. | |

## 4. Main-process features without UI of their own

| Feature | Lines | Backs | Call |
|---|---|---|---|
| Scheduler engine | 448 | Routines, Home "next up", standup routine | |
| Agents store, rooms layout | 183 | Agents, Rooms | |
| Forge backfill (GitLab/GitHub via MCP) | 308 + handler | Sprint board import | |
| Planner / sprint / backlog stores | 121 / 151 / 611 | Planner modes | |
| Memory diagnostic | 586 | Memory panel | |
| Authorship ledger | 405 | Git modal grouping | |
| Checkpoints | 475 | Checkpoints modal, review panel | |
| Live sessions + takeover + session adoption | 811 | Live view, busy state in Chat and Home, terminal transcript link | |
| Notify hook | 724 | Session notifications → Argos | |
| Updater + log | 216 | Settings → About (log never shown) | |
| Plan usage (Claude) / Codex usage | 708 | Sidebar badge, Usage, Home | |
| Provider accounts, engines | ~1 500 | Accounts, pickers, every run | |
| Tags, labels, search, project lifecycle, Codex data | ~2 500 | Projects | |
| Ops backend (gate, ledger, exec, relay, bridge…) | ~5 000 | Servers → Ops, ops chats | |
| Remote plumbing (ssh, sftp, wsl, pty) | ~2 500 | Everything remote and every terminal | |

## 5. Where the same job is done in more than one place

| Cluster | Places | Note |
|---|---|---|
| Tasks | Week, Sprint, Backlog, Routines, Home "next up" | Four stores. Backlog can absorb Week tasks; the repo file was declared the truth in Lot 6. |
| Agents | Agents view, Rooms view, `@` mentions in chat | Same store, two views, neither in the rail. |
| Conversations | Sidebar, Projects, Live, Home, Pending runs, palette, overlay recents, jump list | Eight listings of the same conversations. |
| Chat engines | SDK chat vs CLI terminal (app-wide switch); Ops has its own per-runbook choice | Git/Review/Checkpoints reachable from both. |
| New vs Quick chat vs Light mode | Three cost levers in three places | |
| Plan numbers | Sidebar badge, Usage, Home, per-chat readout | |
| Accounts | Sidebar picker, Planner/Sprint "run with", palette, Settings, Accounts modal | |
| Settings-like | Settings, three Claude Code modals, MCP view, composer toggles, CLAUDE.md modal | |
| Approvals | App modal, Chat inline, Rooms inline, toast window, Home, badge, Pending strip, plan sheet | |
| Git and review | Git modal, review panel, Checkpoints, terminal bar, Home "uncommitted" | |
| Floating windows | Overlay, pill, toast, tray, jump list, Explorer menu | Three always-on-top windows. |

## 6. How the module profile would work (for the `hide` calls)

A module is a rail group or a standalone entry. `config.ui.modules` lists the enabled ones;
the rail, the palette's Go-to list, the shortcuts sheet and the deep-link validator all read
the same list. Two presets, chosen at onboarding and switchable in Settings → General:

- **Ops**: Servers (Remote & WSL, Ops), Chat in terminal work mode, Usage, Settings.
- **Full**: everything that survives this audit.

A hidden module keeps its data and its main-process code; only the entry points go.
