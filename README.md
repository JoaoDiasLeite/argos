# Argos

A desktop workspace for coding-agent CLIs. Argos runs **Claude Code** and **Codex** in
embedded terminals, on this machine, inside WSL distros or on SSH hosts, and keeps the
sessions, projects, sprints, usage and server operations around them in one window.

Argos does not reimplement the agents: every chat is the real CLI in a terminal, with
its own login, its own `/model` and its own tool prompts. Argos adds the workspace.

## What it does

- **Home** shows the day: the current plan window, what needs you, what is running and
  what is uncommitted, plus the chats to pick up and recent projects. Each repo's
  uncommitted files expand in place with their line counts, and every diff opens beside
  the column.
- **Chats** are CLI terminals. Several can run at once in a split layout, side by side or
  stacked (drag a pane by its header to move or swap it), pop out into a window of their
  own, and keep running in the background while you are elsewhere. When a CLI exits, the
  terminal says so and offers Resume.
- **Accounts**: keep several Claude Code and Codex logins side by side (Work and
  Personal, say) and pick which one a chat starts under.
- **Projects** lists the real sessions on disk, local and in every WSL distro, grouped by
  project, with full-text search and resume.
- **Planner** is a sprint board with progress, burndown and a daily standup.
- **Usage** shows tokens, estimated cost and plan limits per account.
- **Servers** holds SSH hosts (password, key or agent, encrypted at rest) and WSL
  distros, with remote terminals and an SFTP file browser that follows the shell's `cd`.
  **MCP** lists and edits the configured MCP servers.
- **Interventions** run an agent against servers over SSH, with nothing installed on
  them, under a runbook: a folder with `RUNBOOK.md`, a `policy.json` that says which
  commands, scripts (pinned by sha256) and paths each host group allows (and which paths,
  such as secrets, nothing may reach), and the scripts themselves. Every call is checked
  against the policy, asks for approval where the policy says so, lands in a hash-chained
  audit ledger and in the server's syslog (`journalctl -t argos`), and the run ends in a
  report written for the client. Interventions run the CLI with your plugins switched off.
  - **Diagnosis** mode needs no runbook: a read-only runbook built into Argos checks the
    system, processes, services, logs, network, the app and PostgreSQL on any stored
    server, and never restarts, kills or writes. The activity column tracks the
    hypotheses being tested, and a command the agent may not run is handed to you to run
    in your own session and paste back. It ends in a handover report (summary, timeline,
    root cause, what was ruled out, actions, the exact commands run), and once a fix is
    found it hands over to a runbook intervention on the same server and ticket.
  - **Runbook library**: point Argos at a runbooks folder (a git checkout, say) and every
    runbook in it is listed, read in place on each visit. Report and handover folders are
    set in Settings → Interventions.
- **Argos the dog**: a pixel-art companion on the desktop for todos, notes and reminders.
  Ctrl+Alt+A opens a speech bubble where "ligar à Câmara amanhã às 14h" becomes a todo
  with a reminder, read locally in Portuguese or English; Ctrl+Alt+S dictates with a local
  Whisper model, so audio never leaves the machine. Missed reminders arrive together on the
  next launch, quiet mode holds them, a todo can be promoted to the active sprint, and notes
  can also be written to an Obsidian vault. Hidden from screen shares by default.
- **Move to another machine**: export the profile and chats to one `.argos` file and
  import it elsewhere. Logins never travel; server passwords travel only encrypted with a
  passphrase.
- English and European Portuguese, switched live in Settings → General → Language.
- Command palette (Ctrl/Cmd+K), desktop notifications when a chat needs you, tray icon,
  light and dark themes, auto-update from GitHub Releases. Launching Argos with
  `--toggle` (from a hotkey, say) hides the window if it is in front and brings it
  forward otherwise.

## Install

Download the latest installer from
[Releases](https://github.com/JoaoDiasLeite/argos/releases): `Argos-Setup-x.y.z.exe` for
Windows or the `.AppImage` for Linux. Installed builds update themselves.

Argos needs the CLIs it drives: install [Claude Code](https://claude.com/claude-code)
and/or Codex and log in once in a terminal. For WSL and SSH chats the CLI must be
installed and logged in on that target too. Operations needs only SSH access to the
servers.

## Development

Requires Node.js 22 and npm 11 (`npm install -g npm@11`).

```bash
npm install
npm run dev        # run the app with hot reload
npm test           # vitest
npm run typecheck  # main and renderer
npm run package    # build an installer into release/
```

| Folder | Responsibility |
|--------|----------------|
| `src/main` | Electron main process: terminals (node-pty), SSH and SFTP, sessions, accounts, usage, the ops gate, audit and reports |
| `src/preload` | The IPC bridge (`window.electronAPI`) |
| `src/renderer` | The React UI |

Files ending in `-pure.ts` hold logic with no Electron or I/O dependency and carry most
of the tests.

Releases are cut by pushing a `vX.Y.Z` tag; `.github/workflows/release.yml` builds the
Windows and Linux installers and publishes them. See `CLAUDE.md` for the full process.

## Maintainer and contributors

Argos was created and is maintained by [João Dias Leite](https://github.com/JoaoDiasLeite),
who reviews and merges every change and cuts the releases.

Contributions arrive by fork and pull request; see [CONTRIBUTING.md](CONTRIBUTING.md).
Everyone whose work is merged keeps authorship of their commits and appears on the
[contributors page](https://github.com/JoaoDiasLeite/argos/graphs/contributors).
Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## License

[MIT](LICENSE) © 2026 João Dias Leite
