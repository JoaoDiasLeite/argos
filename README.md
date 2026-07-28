# Argos

A desktop GUI for Claude Code, built with Electron + React + TypeScript. It runs the
**Claude Agent SDK** under the hood, so it reuses your existing Claude Code login and
gets real tool use (file edits, bash, search) streamed into a live activity panel.

## Features

A Claudia-style toolkit for Claude Code, navigated from the left icon rail:

- **Chat** — talk to Claude with adaptive thinking and live tool use (file edits, bash,
  grep) shown inline and in the activity panel. Per-chat **model switcher** in the header.
- **Projects** — browse the **real** Claude Code sessions from your local `~/.claude` **and
  every connected WSL distro** (read over `\\wsl.localhost\…`), grouped by project with a
  source badge, and **resume** any of them — local sessions continue locally, WSL sessions
  continue inside that distro. Includes **full-text search across all sessions** (local + WSL)
  by content, project, and date.
- **Command palette** (Ctrl/Cmd-K) — fuzzy-jump to any session, project, view, or switch the
  active chat's model.
- **Desktop notifications** — native notification when a run finishes or errors while the
  window isn't focused.
- **Agents** — create, save, and run custom agents, each with its own icon, system prompt,
  model, permission mode, and allowed tools.
- **Usage** — token usage and estimated cost **combined across local + all connected WSL
  distros** (toggle sources on/off), with time-range filters (last 2 days / week / month /
  year / all) and breakdowns by day, model, and project. Includes **limit progress bars** for
  the current hour, the current 5-hour session window, and the week, against caps you set
  (Anthropic plan caps aren't exposed locally).
- **MCP** — view configured MCP servers (transport, scope, auth status, full config) and
  add/remove global servers.
- **CLAUDE.md editor** — edit a project's `CLAUDE.md` and your global `~/.claude/CLAUDE.md`
  (document icon in the chat header).
- **Connect with your Anthropic account** — reuses the Claude Code CLI login on this
  machine, with a secure API-key fallback (stored encrypted via the OS keychain).
- **Multiple Claude accounts** — keep several Claude Code logins side by side (e.g. Work and
  Personal) and choose which one a chat runs under from the **account picker** in the chat
  header (or the command palette). Each account is an isolated Claude Code config dir
  (`CLAUDE_CONFIG_DIR`) with its own login and identity (email/org/plan shown in **Manage
  accounts**); adding one launches a guided `claude` login in its own terminal. The default
  account is your existing machine login.
- **Model selection** — set the default in Settings or override per chat
  (Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5, Fable 5).
- **Tool approval + diff viewer** — before any mutating tool (`Edit`, `Write`, `MultiEdit`,
  `NotebookEdit`, `Bash`) runs, you get an Allow/Deny prompt with a real before/after diff
  (Bash shows the command). Read-only tools auto-approve. A per-chat **Approve / Auto**
  toggle flips to auto-accept; agents honor their own permission mode.
- **Checkpoints / timeline** — snapshots the contents of every file Claude touches in a chat
  (auto before each turn, plus manual). Restore rewrites those files and auto-saves a safety
  checkpoint first. Open from the clock icon in the chat header.
- **Git panel** — review the diff Claude produced, stage/unstage, stage-all, and commit from
  inside the app (branch icon in the chat header).
- **Image attachments** — paste or attach screenshots into the chat (vision input).
- **Remote & WSL** — run Claude Code somewhere other than your local machine, all rendered
  in the same chat:
  - **WSL** — auto-detects every WSL distro on the machine; "New chat here" runs that distro's
    `claude` via `wsl.exe` (optionally in a chosen working dir).
  - **SSH** — add a host (password / key / agent auth, encrypted at rest); drives the remote
    `claude` over SSH.
  Both use `claude -p --output-format stream-json --include-partial-messages` (so remote/WSL
  output **streams token-by-token** like local) and require Claude Code installed + logged in
  on that target.

## Setup

```bash
npm install
npm run dev
```

### Connecting your account

Open **Connection** settings (gear icon or the status chip in the sidebar):

1. **Use my Claude Code account** *(recommended)* — if you've run `claude` and logged in
   on this machine, the app reuses that login automatically. No API key needed.
2. **Use an API key** — paste a key from
   [console.anthropic.com](https://console.anthropic.com/account/keys). It's stored
   encrypted in your OS keychain.

> Not logged into Claude Code yet? Run `claude` in a terminal once, complete the login,
> then reopen this app — it'll be detected.

## Build a distributable

```bash
npm run package
```

## Architecture

| Process  | Responsibility |
|----------|----------------|
| `src/main` | Electron main: Agent SDK runs, file system, sessions, auth (`auth.ts`) |
| `src/preload` | Secure IPC bridge (`window.electronAPI`) |
| `src/renderer` | React UI (chat, sidebar, file tree, activity panel, settings) |

The agent runs in the main process and streams events (`text`, `thinking`, `tool-use`,
`tool-result`, `result`) to the renderer over IPC.

## Note on permissions

By default, mutating tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`) pause for
an Allow/Deny prompt with a diff, via a `canUseTool` callback in `src/main/index.ts` that
calls back into the renderer; read-only tools auto-approve. Flip the per-chat **Approve /
Auto** toggle to skip the prompts (`permissionMode: 'acceptEdits'`), and custom agents run
under their own permission mode.
