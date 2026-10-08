# Argos

A desktop workspace for coding-agent CLIs. Argos runs **Claude Code** and **Codex** in
embedded terminals, on this machine, inside WSL distros or on SSH hosts, and keeps the
sessions, projects, sprints, usage and server operations around them in one window.

Argos does not reimplement the agents: every chat is the real CLI in a terminal, with
its own login, its own `/model` and its own tool prompts. Argos adds the workspace.

## What it does

- **Home** shows the day: the current plan window, what needs you, what is running and
  what is uncommitted, plus the chats to pick up and recent projects.
- **Chats** are CLI terminals. Several can run at once in a split layout (drag a pane by
  its header to move or swap it), pop out into a window of their own, and keep running
  in the background while you are elsewhere.
- **Accounts**: keep several Claude Code and Codex logins side by side (Work and
  Personal, say) and pick which one a chat starts under.
- **Projects** lists the real sessions on disk, local and in every WSL distro, grouped by
  project, with full-text search and resume.
- **Planner** is a sprint board with progress, burndown and a daily standup.
- **Usage** shows tokens, estimated cost and plan limits per account.
- **Servers** holds SSH hosts (password, key or agent, encrypted at rest) and WSL
  distros, with remote terminals and an SFTP file browser. **MCP** lists and edits the
  configured MCP servers.
- **Operations** runs an agent against servers over SSH, with nothing installed on them,
  under a runbook: a folder with `RUNBOOK.md`, a `policy.json` that says which commands,
  scripts (pinned by sha256) and paths each host group allows, and the scripts
  themselves. Every call is checked against the policy, asks for approval where the
  policy says so, lands in a hash-chained audit ledger and in the server's syslog
  (`journalctl -t argos`), and the run ends in a report written for the client.
- Command palette (Ctrl/Cmd+K), desktop notifications when a chat needs you, tray icon,
  light and dark themes, auto-update from GitHub Releases.

## Install

Download the latest installer from
[Releases](https://github.com/JoaoDiasLeite/argos/releases): `Argos-Setup-x.y.z.exe` for
Windows or the `.AppImage` for Linux. Installed builds update themselves.

Argos needs the CLIs it drives: install [Claude Code](https://claude.com/claude-code)
and/or Codex and log in once in a terminal. For WSL and SSH chats the CLI must be
installed and logged in on that target too. Operations needs only SSH access to the
servers.

## Development

Requires Node.js 20.

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

## License

[MIT](LICENSE) © 2026 João Dias Leite
