# MOBILE_PLAN.md — Argos on a phone

Plan only. Nothing here is implemented.

## The fact that decides the shape

Everything Argos is worth using for lives in the **main process**, and none of it can run
on iOS or Android:

| What | Where | Why it can't move |
|---|---|---|
| Agent runs | `@anthropic-ai/claude-agent-sdk` in `src/main/index.ts` | Spawns the `claude` executable (`sdk-exe.ts`) |
| Terminals | `node-pty` (`terminal.ts`, 726 lines) | Native module, forks a shell |
| SSH / SFTP | `ssh2` (`ssh.ts`, `sftp.ts`, `remote-shell.ts`) | Long-lived sockets, keys on disk |
| WSL | `wsl.exe` over `\\wsl.localhost\…` (`wsl.ts`) | Windows-only, by definition |
| Sessions, usage, search | Streamed reads of `~/.claude/**.jsonl` (`jsonl.ts`, `claude-data.ts`) | The transcripts are files on *that* machine |
| Git, checkpoints, file editor | `git.ts`, `checkpoints.ts`, `local-fs.ts` | Operate on a working tree |
| Credentials | `safeStorage` + `CLAUDE_CONFIG_DIR` per account (`auth.ts`, `accounts.ts`) | OS keychain |

So "passar para mobile" is not a port of the renderer. It is a **split**: the desktop keeps
being the whole application and additionally becomes a *host*; the phone becomes a **thin
client** that talks to it over the network. The alternative — a standalone mobile app
calling the Anthropic API directly — is a different product (a chat client with no
sessions, no tools, no terminal, no projects) and is not worth building out of this repo.

The desktop app must keep working exactly as today with the host turned off. Every design
choice below follows from that.

## What is worth taking

First, the criterion — because nothing here *ports*. The desktop UI is 48 files and 329
calls into `window.electronAPI`, built for a mouse and a wide window; every screen on the
phone is written from scratch. What carries over is the **host handler** and the **types**,
never the component. So the question is not "what can be moved" but "what is worth a new
UI", and a screen earns one when all three hold:

1. **It is time-critical while you are away from the machine** — something is blocked or
   broke, and finding out an hour later has a cost.
2. **It is read-mostly, or one tap** — no keyboard, no drag, no precision.
3. **The host side already exists** as a handler, so the cost is the UI and nothing else.

Anything failing (1) is config you touch once a month at a desk. Anything failing (2)
becomes a worse version of something that already works well fifteen steps away.

### Takes itself — this is the product

| Screen | Why | Host side |
|---|---|---|
| **Approvals** | A run is stopped dead on `Edit`/`Write`/`Bash` until someone answers. Allow/Deny with a read-only diff is one tap and unblocks real work. | `requestToolApproval` + `resolveApprovalEverywhere` already fan across two surfaces |
| **Home** | `HomeView` is *already* this dashboard: attention (approvals, routines), what's running, plan %, spend today, next routine, recents. Drop the dirty-repo section and the start pickers and it is a phone screen. | `HomeAttention` / `HomeRunning` / `HomePlan` / `HomeSpend` exist |
| **Routines** (`ScheduledView`) | These fire unattended. The phone is where you find out one ran, or failed, or is about to. Read-only: list, next run, last result. | `scheduler.ts` (5 channels) |
| **Chat, streamed** | Reading what the agent is doing, and answering when it asks. With a prompt box — a one-line correction is worth typing on a phone; nothing longer is. | `agent:event`/`done`/`error`, already normalised for WSL/SSH by `claude-stream.ts` |

### Cheap, because the host already computed it

Read-only, no new main-process work, and each is a single list or a few numbers:

- **Projects + sessions + full-text search** — `claude-data.ts` (`searchSessions`,
  `readSessionPeek`). Reading a transcript on the phone is the "what did it actually do"
  case, and it is the thing `jsonl.ts` streaming was built for.
- **Usage and limit bars** — `plan-usage.ts` computes all of it; the phone renders three
  bars and a total.
- **Backlog topics** — `backlog.ts` reads them from the repo. List, and tick one done.
  Genuinely useful away from the desk, and the write is one boolean.

### Only once the above is real

- **Starting a turn** on an existing session (as opposed to reading one). Needs model and
  account pickers, and it widens the write surface — so it is a decision, not a freebie.
- **Sprint / Planner boards.** The standup on a phone is a fair idea, but `SprintBoard.tsx`
  is 2139 lines and `PlannerView.tsx` 1511, of dense board UI. What would actually be built
  is "today's items", not the board — a new screen wearing the same data.

### Not worth it

| Left behind | Why |
|---|---|
| **Terminals** — `ChatTerminal`, `RemoteTerminal`, `PaneGrid`, `LiveView` takeover | Keyboard-bound by nature, and the only part of the app needing bidirectional streaming. A terminal on a phone is a demo, not a tool. |
| **SFTP browser, `FileEditor`, `RemoteSessionView`** | Two-pane, drag-and-drop, precision editing. |
| **Git staging / commit, checkpoint restore** | Destructive and irreversible, decided by reading a diff properly. A wrong tap costs a working tree. |
| **MCP, Permissions, Hooks, `CLAUDE.md` editor, Settings** | Configured once, at a desk. Fails (1) completely. |
| **Accounts, auth, API keys** | Not merely pointless on the phone — these channels must never leave the machine at all (see Security). |
| **Agents authoring, Rooms, command palette** | Authoring is typing; `Ctrl-K` is a keyboard idea. The one part of Rooms that matters on a phone — its approvals — is already Tier 1. |

## The shape: host + client

```
  Electron main (unchanged behaviour)
    ├── ipcMain.handle(...)  ←─ preload ←─ desktop renderer
    └── host server (opt-in) ←── HTTPS ──→ phone client
             ↑ both call the same handler functions
```

Two transports in front of **one** registry of handler functions. The desktop path stays
byte-for-byte what it is today; the host is a second caller.

### What that costs, honestly

- **190 `ipcMain.handle`/`on` registrations** across `src/main` (177 of them inline in
  `index.ts`, a 2759-line file), **176 `invoke` methods** in `src/preload/index.ts`. They
  are registered as side effects at module scope, so nothing else can call them. Turning
  them into a registry (`channel → (payload, ctx) => result`) is the bulk of the work, and
  it is in the riskiest file in the repo.
- **Push events assume one window.** `send()` in `index.ts:942` is literally
  `mainWindow?.webContents.send(...)`. Twelve channels go through it or its siblings:
  `agent:event`, `agent:done`, `agent:error`, `agent:approval-request`, `agent:worktree`,
  `terminal:data`, `terminal:exit`, `remote-shell:data`, `remote-shell:exit`, `config:ui`,
  `window:maximized`, `overlay:shown`. A phone is a second subscriber that **drops off
  Wi-Fi mid-run**, which the current fan-out has no concept of.
- **48 renderer files** touch `window.electronAPI` in 329 places. None of that is reusable
  as-is on the client; the *types* (`src/renderer/src/types.ts`, 1855 lines) are.

### What is already in the right shape

- `resolveApprovalEverywhere` (`index.ts`) already fans one approval across two surfaces
  (main window + toast window) and makes the first answer win. The phone is a third
  surface on the same mechanism — the hard part of multi-client approval is done.
- `claude-stream.ts` already normalises `claude -p --output-format stream-json` from WSL
  and SSH into the same event shape the SDK emits. The wire protocol to the phone is that
  same event shape again.
- `jsonl.ts` streams; no handler slurps a transcript. A phone asking for a 200 MB session
  cannot blow up the host.
- `window-security.ts` already states the rule the host must not break: a renderer with the
  preload bridge has the full IPC surface, so remote content must never reach it.

## Client technology

**PWA first**, served by the host itself. React + TypeScript, shares `src/shared/`, no store
review, one build for both OSes, and it is the fastest way to find out whether you actually
use the thing. A native shell (Capacitor over the same code, or Expo) is worth it for
exactly one reason — **reliable push** — and should wait until the PWA has proven the
workflow.

The constraint to know before choosing reach: **a PWA needs a trusted-TLS origin** for
service workers and web push (localhost excepted). A self-signed cert on a LAN IP does not
get you there on iOS without profile-installing a CA. Tailscale does (`tailscale cert`
issues a real Let's Encrypt cert for the `*.ts.net` name, and the link itself is
WireGuard-encrypted). So:

| Reach | TLS | Install + push | Verdict |
|---|---|---|---|
| Tailscale / VPN | Real cert for `*.ts.net` | Yes | **Recommended v1** |
| LAN, plain HTTP | None | No SW, no push, token in clear on the LAN | Degraded fallback |
| LAN, self-signed | Untrusted | Manual CA install per device | Not worth it |
| Public relay | Real | Yes | Out of scope — see below |

No public relay in v1. A relay means running infrastructure that holds an open tunnel into
a machine that can run `Bash`, and it turns a "my two devices" security model into a
"trust the operator" one.

### Transport

`node:http`/`node:https` only — **no new dependency**. `POST /rpc` for the request/response
channels, `GET /events` as an SSE stream for pushes. SSE reconnects on its own, carries a
`Last-Event-ID`, and is exactly the shape of the twelve push channels. WebSockets would
only be needed for terminal input, which is out of scope.

## Security

The IPC surface is fully trusted today — it writes arbitrary files, runs commands, and
reads the keychain. Exposing it on a socket without these rules is a remote shell:

- **Off by default.** A switch in Settings, bound to loopback until explicitly changed.
- **Explicit allowlist of channels**, not the 190. Anything under `auth:` that returns a
  key, anything in `accounts:`/`provider-accounts:` that touches credentials, and the
  `dev:` channels never leave the machine. The allowlist is a literal array in one file,
  with a `conventions.test.ts`-style guard asserting no channel joins it implicitly.
- **Pairing**, not a password: a 6-digit code shown on the desktop, exchanged once for a
  per-device token. Tokens are listed and revocable per device in Settings.
- **Every request carries the token**; `Origin` is checked; the host answers nothing before
  pairing completes.
- **The phone is a client, never a peer**: it can never add an SSH host, change permission
  mode, or write settings that widen what a run may do.

## Lots

Each lot is shippable on its own and leaves the desktop app working.

### Lot 0 — the handler registry · 2–3 days · no behaviour change

Move the 177 inline `ipcMain.handle` bodies in `index.ts` into named functions in a
registry keyed by channel; `ipcMain.handle` becomes a loop over it at startup. Split by
domain while moving (`cc:`, `git:`, `ssh:`, `sftp:` … — 37 prefixes exist already), which
also cuts `index.ts` down to something reviewable. Guard: a static test that fails on any
`ipcMain.handle` outside the registry module, in the house style of `conventions.test.ts`.

Do this one even if mobile is cancelled — it is the refactor that makes the handlers
testable.

### Lot 1 — multi-client event bus · 2–3 days · depends on 0

Replace `send()` with a subscriber list: the main window, the toast window, and zero or
more remote clients. Per app-session **ring buffer with a monotonic cursor**, so a client
that reconnects after a tunnel drop replays what it missed instead of showing a dead chat.
This is the invariant the current code has no notion of, and the one that will decide
whether the phone feels real or broken.

### Lot 2 — the host server · 3–4 days · depends on 0, 1

`src/host/`: `POST /rpc`, `GET /events`, pairing, tokens, allowlist, Origin checks, the
Settings panel that turns it on and lists paired devices. Serves the client bundle too.

### Lot 3 — the client shell · 3–4 days · depends on 2

`src/mobile/`: pair, connect, reconnect, session list, live runs, usage. Own tsconfig
project and `typecheck:mobile`; `src/shared/` gets the wire types split out of
`types.ts`. Touch targets and a single-column layout from the start — none of the desktop
CSS survives contact with a phone.

### Lot 4 — chat + approvals · 4–5 days · depends on 3

The stream rendered (text, thinking, tool use), a prompt box, and the approval sheet with a
read-only diff. First answer wins across desktop, toast and phone — extend
`resolveApprovalEverywhere`, do not fork it.

### Lot 5 — notifications · 2–3 days + infra · depends on 4

Web push from the host for "run finished" and "waiting on approval", reusing what
`notify-hook.ts` and `badges.ts` already decide. This is where a native shell may become
necessary; decide with the PWA in hand, not before.

### Lot 6 — hardening · 2–3 days

Offline states, token revocation, request rate limits, and a pass over what the phone can
reach that it should not.

**~3–4 weeks** of focused work to a phone that shows live runs, streams chats, and answers
approvals. Lots 0 and 1 are worth doing on their own merits.

## Open decisions

1. **Reach** — Tailscale-first (recommended) or LAN-with-caveats?
2. **May the phone start work**, or only observe and approve? (Recommended: start turns on
   existing sessions; never create SSH hosts or change permission mode.)
3. **PWA only**, or native shell once push matters?
4. The desktop must be **awake**. Wake-on-LAN, sleep prevention, and any "always-on host"
   mode are out of scope unless you say otherwise.

## Not doing

- A standalone mobile app that talks to the Anthropic API directly — different product.
- Terminals, SFTP, the file editor, git staging on the phone.
- A hosted relay, and anything that puts a third party between the phone and a machine that
  can run `Bash`.
