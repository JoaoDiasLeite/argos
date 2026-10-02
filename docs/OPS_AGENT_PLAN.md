# Ops agent — operating servers from here, by the book

_Planned with Fable; to be implemented by Opus/Sonnet subagents in reviewed batches, one
commit per batch, `npm run typecheck` + `npm test` against each staged tree. Subagents never
commit._

The daily job this plan serves: **Claude runs on this machine**, reaches servers over SSH
**without anything installed on them**, does only what a runbook allows, and leaves a record
that shows exactly what was done, on which host, with whose approval, and what came back.

Three words carry the design: **local, gated, logged.**

### The actual work this serves

Wiremaze operates municipal platforms (*WireMaze Cityfy Platform*, wireRecruit, wireForms,
wireChannel, wireFix, wirePaper) for câmaras municipais. The servers are the **clients'**:
Rocky Linux 9 and CentOS 7, nginx, Puma/Sidekiq/PM2 under Monit, PostgreSQL with mandatory
TLS and mutual certificate auth, Redis, Elasticsearch. They are reached **over the client's
VPN first, then SSH**, inside an agreed intervention window, and every intervention ends in a
written record the client can read. That shapes four things in this plan:

- **The VPN is a precondition Argos cannot satisfy.** Many different VPN clients, each
  started by hand. A host that is unreachable is reported as "unreachable, is the VPN up?"
  once, never retried in a loop, and the run does not start (§4).
- **Most of the recurring work is read-first.** SAML certificate expiry, SMTP, ActionCable
  behind a firewall, Puma workers crashing on an OpenSSL mismatch, DHCP versus static IP:
  diagnosis is `systemctl status`, `journalctl`, `openssl x509`, `tail` on logs, `psql -c`
  read queries. A read-only runbook covers most days; `mutate` runbooks are the few scripted
  interventions (certificate renewal with the internal Wiremaze script, PostgreSQL 13→17 with
  TLS introduced in the same window, nginx reload).
- **`sudo` is the norm on these boxes**, so the policy lists sudo commands literally instead
  of forbidding sudo outright (§1.10, §2).
- **Two reports from one ledger.** The internal one carries every command and output. The
  client-facing one is a Relatório Técnico de Intervenção: formal European Portuguese, no
  commands, no paths, no configuration parameters, IPs replaced by placeholders, no dashes
  (§5.1). The sanitiser is pure, tested, and the test asserts that nothing from the argv or
  the paths survives.

---

## 0. What exists today, and why it is not enough

| Piece | What it does | Why it cannot be the ops path |
|---|---|---|
| `ssh.ts` `runRemote` | Runs the **host's** `claude -p … --permission-mode acceptEdits` | Needs Claude Code installed on the server, uses the server's login, and has **no approval gate at all** — `canUseTool` does not exist over the line protocol. |
| `remote-shell.ts` + `RemoteSessionView` | Interactive ssh2 shell, SFTP browser, a "run log" | The run log is `localStorage`, capped at 200, per renderer, unsigned, and only records what was typed in the quick-run box — not what ran. |
| Local chat `canUseTool` (`index.ts:961`) | Asks before `Edit/Write/MultiEdit/NotebookEdit/Bash` | A **denylist**: `mcp__*`, `WebFetch`, `Agent`, `KillShell` pass unprompted. New tools are allowed by default. |
| `AgentDef.allowedTools` | A per-agent tool list | Advisory — the SDK honours it, but nothing in Argos verifies it against a policy, and it says nothing about *which commands* Bash may run. |
| `ai-policy.ts` | Capability profiles per call site | The right place for an ops profile; there is none yet. |
| `ssh-trust.ts`, `safeStorage` hosts, `sftp-pure` path guard | Host-key pinning, secrets never in the renderer, `..` rejection | Keep all three. They are the base the executor stands on. |

Reused, not rebuilt: the ssh2 session per host (`sftp.ts` `getSession`/`getRemoteClient`),
`shQuote`, the approval modal + toast pipeline (`agent:approval-request`), the `*-pure.ts`
convention, `json-file.ts`, `ai-policy.ts`, `authorship.ts` as the model for a ledger.

## 1. Decisions

1. **Claude runs locally, always.** The ops chat is the local Agent SDK engine with the
   user's own account. The server sees SSH sessions and nothing else. `runRemote` (Claude on
   the host) stays for people who want it, but it is not the ops path and the UI says so.
2. **Remote reach is a set of in-process MCP tools**, built with the SDK's
   `createSdkMcpServer` + `tool()`, registered under one server name, `ops`. The model sees
   `mcp__ops__run`, `mcp__ops__script`, `mcp__ops__read`, `mcp__ops__list`,
   `mcp__ops__write`. Each one goes through the same gate before it touches ssh2.
3. **The local machine is out of reach.** The ops profile removes `Bash`, `Edit`, `Write`,
   `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `KillShell` from context
   (`disallowedTools`) and allows `Read`/`Grep`/`Glob` only inside the runbook folder
   (`additionalDirectories` = that folder; `cwd` = that folder). A policy that is merely
   *gated* can be argued with; a tool that is not in context cannot be called.
4. **Runbooks are the policy, and they live in a repo**, not in Argos's store. A runbook
   is a folder: `RUNBOOK.md` (the guidelines the model must follow — appended to the
   system prompt), `policy.json` (what may run where), `scripts/` (the only things the
   model can execute by name). Version-controlled, reviewable, diffable. Argos reads;
   Argos never writes a runbook.
5. **One gate, pure, tested, and it logs before it runs.** `ops-gate-pure.ts` takes
   `(tool, input, policy, hostGroup)` and returns `allow | ask | deny` with a reason.
   The decision is appended to the audit ledger *before* execution, so a crash mid-run
   still leaves the intent on disk.
6. **Three tiers, and the top one cannot be configured away.** A hard denylist of
   destructive shapes (§3.3) is checked first and is not overridable by any `policy.json`.
   Then the runbook's allow rules. Then, for anything not allowed, `ask` by default and
   `deny` when the runbook says `strict: true`.
7. **Plan first, then steps.** An ops run opens in plan mode: the model proposes a numbered
   plan of tool calls; the user approves the plan as a whole; execution then runs step by
   step with live status, and any step that leaves the approved plan (different host,
   different command) is a fresh `ask`, never silent.
8. **The ledger is append-only JSONL under `userData/ops-audit/`**, one file per day, one
   line per event, with a per-run markdown report derivable from it. The renderer gets a
   live timeline; it never writes the ledger.
9. **Claude only.** `canUseTool` and in-process MCP exist only on the Claude engine. Codex
   and Gemini get no ops profile — a chat on those providers cannot select a runbook.
10. **No `sudo` unless the runbook says which commands**, as literal entries. A bare
    `sudo` anywhere else is a deny, not an ask.

## 2. The runbook contract

```
runbooks/
  nginx-rollout/
    RUNBOOK.md          # guidelines; appended verbatim to the system prompt
    policy.json         # the gate's input (schema below)
    scripts/
      reload.sh         # executed by name; sha256 pinned in policy.json
      check-config.sh
```

`policy.json` (validated by `ops-policy-pure.ts`; an invalid file refuses the run, it never
degrades to "allow everything"):

```jsonc
{
  "version": 1,
  "strict": true,                       // true: unmatched → deny. false: unmatched → ask.
  "hosts": {                            // host groups by stored-host id or name glob
    "web": ["web-01", "web-02"],
    "db": ["db-*"]
  },
  "allow": [
    { "hosts": ["web"], "cmd": "^systemctl status [a-z0-9@.-]+$", "class": "read" },
    { "hosts": ["web"], "cmd": "^tail -n [0-9]{1,4} /var/log/nginx/[a-z.-]+\\.log$", "class": "read" },
    { "hosts": ["web"], "cmd": "^sudo systemctl reload nginx$", "class": "mutate", "approval": "ask" }
  ],
  "scripts": [
    { "name": "reload.sh", "sha256": "…", "hosts": ["web"], "class": "mutate", "approval": "ask",
      "args": { "max": 1, "pattern": "^[a-z0-9.-]+$" } }
  ],
  "read": { "paths": ["^/etc/nginx/.*$", "^/var/log/nginx/.*$"], "maxBytes": 1000000 },
  "write": { "paths": ["^/etc/nginx/sites-available/.*$"], "approval": "ask", "backup": true },
  "limits": { "timeoutMs": 60000, "maxOutputBytes": 200000, "concurrentPerHost": 1 }
}
```

Rules the validator enforces (each a test):
- Every regex compiles, is anchored on both ends (`^…$`), and is under 512 chars. An
  unanchored rule is an error, not a warning — `systemctl` would otherwise match
  `systemctl stop nginx; rm -rf /`.
- Every script named in `policy.json` exists in `scripts/`, and its sha256 matches at **load
  time and again at call time**. A changed script is a refusal with both hashes shown.
- `class` is `read | mutate`; `approval` is `auto | ask`; `auto` on a `mutate` rule is
  allowed only when `strict` is true (so the owner cannot get `mutate+auto` on a runbook
  that also falls through to `ask` for unknowns).
- A host group that matches no stored host is a warning in the picker and a deny at run
  time.

### 2.1 First runbooks to write (the acceptance set)
These are the day-to-day cases; the gate is done when each runs end to end on the test VM.

| Runbook | Class | Shape |
|---|---|---|
| `diagnose-rails-host` | read | `systemctl status` for puma/sidekiq/nginx/monit, `journalctl -u … -n 200`, `tail -n` on app and nginx logs, `openssl version`, `ruby -v`, `gem list openssl`, `free -m`, `df -h`. No mutate rules. |
| `saml-cert-check` | read | `openssl x509 -in <path> -noout -enddate -subject` on the SP cert and the IdP metadata, `curl -sI` on the ACS URL. Paths pinned in `read.paths`. |
| `pg-tls-check` | read | `psql -c "SHOW ssl"`, `openssl s_client -starttls postgres`, `openssl x509 -enddate` on server and client certs. |
| `pg-cert-renew` | mutate, strict | One script: the internal Wiremaze renewal script, hash-pinned, args = none. `sudo systemctl reload postgresql-17` as a literal allow rule with `approval: ask`. |
| `nginx-config-reload` | mutate, strict | `sudo nginx -t` (read), `sudo systemctl reload nginx` (ask). |
| `pg-13-to-17-upgrade` | mutate, strict | Every step a script with a hash; the runbook's `RUNBOOK.md` is the existing migration runbook verbatim. Backups verified by a `read` step before any `mutate` step, and the preamble (§7) makes the model refuse to continue past a failed check. |

Scripts stay in the runbook repo, not in Argos. When a runbook is written for one client it
is reusable for the next because `hosts` and the cert paths are the only client-specific
parts.

## 3. The gate (`ops-gate-pure.ts`)

```ts
classify(tool, input, policy, host): { decision: 'allow'|'ask'|'deny'; class: 'read'|'mutate'; reason: string; rule?: string }
```

### 3.1 Order of checks — cheapest and most absolute first
1. `hostId` resolves to a stored host **and** that host is in a group the policy names.
2. Hard denylist (§3.3). Match → `deny`, no later check can rescue it.
3. The command is **one simple command**: no `;`, `&&`, `||`, `|`, `` ` ``, `$(`, `<(`,
   `>(`, newline, `\r`, unbalanced quotes, a leading `VAR=` assignment, `eval`, `exec`,
   `bash -c`, `sh -c`, `source`, `.` as a command, heredoc `<<`. Any of these → `deny`
   with the offending token named. Composition is the runbook's job (a script), never the
   model's.
4. `tool`-specific shape: `run` needs `cmd`; `script` needs `name` and `args[]` (array —
   never a string — each matching the script's `args.pattern`, count ≤ `max`); `read`/
   `list`/`write` need an absolute POSIX path with no `..` after `path.posix.normalize`
   (reuse `sftp-pure`'s guard).
5. Allow rules for that host's groups, first match wins → that rule's `class` and
   `approval`. The regex is matched against the **canonical** line rebuilt from the
   parsed argv (words joined by one space, a word quoted only when it holds characters
   outside `[A-Za-z0-9_./:=@%+,-]`), never against the raw string: `tail -n 100
   '/var/log/nginx/error.log'` and the same command without quotes run the same argv, so
   they must meet the same rule. Found in review of Phase 1.
6. No match → `strict ? deny : ask`, class `mutate` (unknown is treated as the worse case).

### 3.2 What the model never controls
- The shell line. `run` is executed as `exec(shQuote-joined argv)` built by the gate from
  its own parse, not from the raw string the model sent. The raw string is logged; the
  argv is what runs.
- Script arguments reach the script as separate `shQuote`d words. No interpolation.
- The host. The model names a host **id**; the gate resolves it. A name the user typed
  in the prompt is not an address.
- Timeouts, output caps and concurrency come from `policy.limits`, clamped by app-wide
  maxima (`timeoutMs ≤ 10 min`, `maxOutputBytes ≤ 2 MB`).

### 3.3 Hard denylist — not configurable
Shapes, matched on the parsed argv (first word and flags), each with its own test:
`rm -rf /` and `rm -rf /*` and `rm -rf ~`; `mkfs*`; `dd` with `of=/dev/`; `shutdown`,
`reboot`, `halt`, `poweroff`, `init 0|6`; `iptables -F`, `nft flush`, `ufw disable`;
`userdel`, `passwd`, `chpasswd`; `chmod -R 777 /`; `chown -R` on `/`; `:(){ :|:& };:`;
`curl|wget … | sh` (already caught by the pipe rule, kept as a named test); `history -c`;
`crontab -r`; writing to `/etc/sudoers*`, `~/.ssh/authorized_keys`, `/etc/shadow`.

A denied call is still **logged with the full input** — the denylist is also the alarm.

### 3.4 What `ask` shows
The existing approval modal, extended: host name + `user@host`, the rule that matched (or
"no rule"), the class, the exact argv that will run, the script's hash when it is a script,
and a **"deny and stop the run"** button beside allow/deny. The toast path works unchanged
(`mcp__ops__*` go through the same `canUseTool`).

## 4. The executor (`ops-exec.ts`)

- One ssh2 `Client` per host, from `getRemoteClient` — the same connection the Remote
  Session view uses, so a Connect tab and an ops run share host-key trust and auth.
- `exec` with `pty: false`; stdout and stderr captured separately; both capped at
  `maxOutputBytes` with a `[truncated N bytes]` marker; `exit code` and `signal` recorded.
- Timeout → `stream.signal('TERM')`, then `close()` after 5 s; the result is marked
  `timedOut`. No `KILL` escalation by default.
- `concurrentPerHost: 1` by a per-host promise chain. A second call on the same host waits;
  the timeline shows "queued behind step 3".
- Abort of the run (`abortController`) ends every in-flight channel on every host and
  writes a `run.aborted` event.
- `write` with `backup: true` copies `<path>` to `<path>.argos-<ts>.bak` via SFTP before
  overwriting, and the ledger records both paths and both sha256s.
- `read` refuses binary (NUL byte) and over-size, same as `sftpRead`.
- Nothing from this module throws across IPC; every failure is `{ ok: false, error }`.
- **Reachability before the plan.** `run.start` is preceded by one `testConnection` per host
  the policy names (15 s each, in parallel). Any failure stops the run before the model is
  called, with the message "`<host>` is unreachable. Is the VPN connected?" and the error.
  No retry, no backoff: on a client VPN a retry loop is a lockout waiting to happen.
- **Session-level `sudo`.** When a `sudo` rule needs a password, the executor requests it
  once per run from the user through the approval modal (masked field), passes it on
  stdin with `sudo -S -p ''`, keeps it only in memory for the run, and the ledger records
  `sudo: password-supplied` and never the value.

The executor interface is abstract (`OpsBackend { exec, read, write, list }`) so tests run
the whole gate + tool + ledger path against an in-memory fake, and a future WSL backend is
one file.

## 5. The ledger (`ops-audit.ts` + `ops-audit-pure.ts`)

Append-only JSONL, `userData/ops-audit/YYYY-MM-DD.jsonl`, written with `O_APPEND`, one
event per line. Event kinds and fields:

| kind | fields |
|---|---|
| `run.start` | runId, appSessionId, runbook{name, path, policySha256, runbookMdSha256}, hosts[], model, account, planText |
| `plan.approved` / `plan.rejected` | runId, by (`user`), at |
| `call.decided` | runId, callId, tool, hostId, host, rawInput, argv, class, decision, reason, rule, scriptSha256? |
| `call.asked` / `call.answered` | callId, answer (`allow`/`deny`/`stop`), updatedInput? |
| `call.started` | callId, at |
| `call.finished` | callId, exitCode, signal?, timedOut, durationMs, stdoutBytes, stderrBytes, stdoutSha256, stderrSha256, stdoutHead (first 4 KB), stderrHead |
| `write.backup` | callId, path, backupPath, beforeSha256, afterSha256 |
| `run.end` | runId, ok, costUsd, usage, aborted?, error? |

Rules:
- The ledger is written by the main process only. The renderer subscribes to
  `ops:event` for the live timeline and may request `ops:report(runId)`.
- `rawInput` is stored verbatim, including denied ones. Secrets the model might echo are
  the user's own stdout; the ledger does not try to redact, and the docs say so.
- Each line carries `prev` = sha256 of the previous line, so a trimmed or edited file is
  detectable (`ops-audit-pure.ts` `verifyChain`). Not tamper-*proof* — tamper-*evident*.
- `ops:report(runId, 'internal')` renders a markdown report: plan, every call in order with
  decision, argv, exit code and output head, totals. The same text can be exported to a
  file next to the runbook or copied.
- Retention: never deleted by Argos. Settings shows the folder and its size.

### 5.1 The client-facing report (`ops-report-pure.ts`)

`ops:report(runId, 'client')` renders the Relatório Técnico de Intervenção from the same
ledger, in the Assunto / Descrição / Motivo shape, in formal European Portuguese, and it is
the one artefact here that leaves the company. Rules, each a test:

- **Nothing executable survives.** No argv, no script name, no path from `read`/`write`,
  no configuration value from stdout. The test takes every `argv`, `path` and `stdoutHead`
  token of the fixture ledger and asserts none appears in the client rendering.
- **IPs and hostnames become placeholders.** IPv4, IPv6 and every stored host's `host`
  field are replaced by `[servidor de aplicações]`, `[servidor de base de dados]` or
  `[servidor]` according to the policy's host group name; a test asserts no IP-shaped token
  remains.
- **No em or en dashes anywhere** in the output; a test asserts it.
- The product name is written *WireMaze Cityfy Platform* when the runbook metadata names
  the platform as `cityfy`; the other platforms by their own names.
- Steps are described by their runbook step titles (a `title` field per allow rule and per
  script in `policy.json`), not by what ran. A rule without a title renders as "operação
  técnica" and the internal report flags it, so the runbook author adds one.
- The text is a draft: it opens in the editor with a "Copiar" button, and nothing is sent
  anywhere. Argos has no ticket-system or GitLab integration in this plan.

## 6. The ops profile (`ai-policy.ts`)

```ts
| 'ops-remote'
```
Resolves to: requested model (no cheap clamp — this is the user's work), `settingSources:
[]` (no plugins, no user-tier skills into an ops session), `disallowedTools` as §1.3,
**no `allowedTools`** (the SDK auto-allows those without calling `canUseTool`, which
would skip the gate; instead `canUseTool` sees every call and allows `Read`/`Grep`/`Glob`
only inside the runbook folder), `maxTurns: 60`, system prompt =
`CLAUDE_CODE_PROMPT` + an ops preamble (§7) + `RUNBOOK.md`. `permissionMode: 'default'` with
`canUseTool` **always** set (the ask/auto toggle is ignored for this profile — `auto` would
mean "`mutate+auto` rules only", and that is what `policy.json` already expresses).

## 7. The ops preamble (system prompt, fixed text)

Short, and the tests assert it is present on every ops run:
- You operate servers through `mcp__ops__*` only. You have no local shell.
- Follow `RUNBOOK.md` literally. If a step is not covered, say so and stop; do not improvise
  an equivalent command.
- Before any `mutate` call, state what it changes and how it is reverted.
- Never chain commands. One command per call. Use a script when the runbook provides one.
- Report every non-zero exit code verbatim before deciding what to do next.
- A failed verification step (a `read` whose output the runbook says must match) ends the
  run. Do not proceed to a `mutate` step past a failed check, even if asked.
- Write to the operator in formal European Portuguese, never Brazilian, with no em or en
  dashes. Commands and output stay in code blocks, exactly as returned.

## 8. UI

- **Chat config bar:** a "Runbook" picker (folder chooser remembered per project, plus
  recent). Picking one switches the chat to the ops profile and shows the hosts the policy
  names, each with its connection dot (`testConnection`, which already ignores whether
  Claude is installed — correct here).
- **Plan step:** the first assistant turn runs in `plan` permission mode; the proposed plan
  renders as a checklist with an "Approve plan" / "Edit and resend" bar. Approval is a
  `plan.approved` ledger event and the second turn runs the steps.
- **Ops timeline panel** (right side of the chat, like the History panel in Remote Session):
  one row per call — host, argv, class pill, decision pill, status (queued / running /
  exit N / timed out / denied), duration, expand for stdout/stderr head. Red rows for deny
  and non-zero exit. A "Stop run" button that aborts.
- **Run report:** at `run.end`, a "Report" button opens the markdown with an
  Internal / Client toggle; "Save beside runbook" writes
  `runbooks/<name>/reports/<date>-<runId>.md` (internal) and `…-cliente.md` (the one place
  Argos writes under a runbook, and always a new file, never an edit).
- **Settings → Ops:** audit folder path and size, "Verify ledger chain", app-wide maxima.
- **Remote & WSL list:** the SSH host card's "New chat here" is relabelled "Chat on host
  (needs Claude installed)"; "Ops chat" is the primary action when at least one runbook is
  known.

## 9. Phases — each shippable, each a reviewed batch

### Phase 0 — close the holes that exist today · done (`d54f4bc`, `75a2385`)
1. **Invert the approval gate.** `index.ts:961` becomes an allowlist of read-only tools
   (`Read, Grep, Glob, LS, WebSearch?` — decide, document) that auto-pass; **everything
   else asks**, including `mcp__*`, `WebFetch`, `Agent`, `KillShell`. Test: a tool name not
   in the list asks.
2. **`runRemote` is labelled.** The SSH host card says it runs Claude *on the host* with
   `acceptEdits` and no approval; the config bar shows a warning chip. No behaviour change.
3. **Run-log honesty.** The Remote Session run log says "commands typed here", not "run
   log", and is left as is.

### Phase 1 — pure core · done (`88f3ddb`, `1257aeb`, see git log for the gate)
`ops-policy-pure.ts` (schema, validator, hashes), `ops-gate-pure.ts` (parser, denylist,
classifier), `ops-audit-pure.ts` (event types, chain, report renderer). Tests first:
- Validator: every rule in §2 has a failing fixture.
- Parser: the adversarial list in §3.1 step 3, each token a test; plus `--flag=value`,
  quoted args with spaces, unicode, 10 KB command (deny by length), `\x00`.
- Denylist: every shape in §3.3, including spacing and flag-order variants
  (`rm -fr /`, `rm -r -f /`).
- Classifier: first-match-wins order, group resolution, strict vs non-strict fallthrough,
  `mutate+auto` only under strict.
- Report: golden-file test from a fixture ledger, internal and client renderings; the
  client one also passes the §5.1 absence tests (argv, paths, IPs, dashes).
No Electron imports. Commit: `feat(ops): add runbook policy, command gate and audit core`.

### Phase 2 — executor, MCP tools, ledger, profile · done (`e1f13d6`, `23d6d8c`, `f02a59d`)
`ops-exec.ts` over `getRemoteClient`; `ops-tools.ts` (`createSdkMcpServer`); `ops-audit.ts`
(append, chain, `ops:report`); `ai-policy.ts` `ops-remote`; the ops branch in the
`agent:send` handler (profile, runbook load, `mcpServers: { ops }`, `canUseTool` extended
to carry host/rule/argv to the modal). Tests against the fake backend: a full run from
`run.start` to `run.end` produces the expected ledger; a denied call never reaches the
backend; a timed-out call is marked and the next call on that host still runs; abort ends
channels. Commit: `feat(ops): run runbook-gated commands over ssh with an audit ledger`.

### Phase 3 — UI · done (`ac00e24`, `8bd21f9`, `65ec7a4`, `b3df5db`, `f87ccd5`, `5643c44`)
Also landed here, carried over from Phase 2: the sudo password prompt (§4), the plan
step (§1.7, as a sixth tool `mcp__ops__propose_plan` rather than the SDK's plan mode, so
the approval goes through the same gate and ledger), deny-and-stop from the modal, and
the timeline's history from the ledger after a restart.

Left open after Phase 3, none blocking:
- The runbook recents are global, not remembered per project (§8).
- The config bar re-tests every runbook host's connection on each mount; no caching.
- A sudo password prompt is not withdrawn when the run aborts; a late answer is ignored.
- A `script` that calls sudo internally gets the "needs a password" note, not the prompt.
- The visual check covered the ops chat (both themes) and the timeline; the approval
  modal with a plan and the sudo prompt were not photographed, since they need a live run.
Runbook picker, plan-approval bar, timeline panel, report button, Settings → Ops, host
card relabel. `visual-check` with a seeded runbook and the fake backend behind a dev flag
(`ARGOS_OPS_FAKE=1`), so screenshots need no server. Commit per surface.

### Phase 4 — the rest of the open backlog, hardened
These were already planned; they are listed here so one document holds everything open.
- **Review gate phase 2 — commit gate** (`docs/REVIEW_GATE_PLAN.md` §2). Hardening added:
  the stash pop is wrapped so a conflict reports the stash ref and commits nothing; the
  Conventional Commits validator rejects any trailer line (`Co-Authored-By`, `Generated
  with`) — asserted in the test; the verify command runs with `shell: false` and an argv.
- **Review gate phase 3 — queue.** Only after phase 2 has been used for a week. Worktree
  per mission by default.
- **Authorship extractors for Codex and Gemini transcripts** — until then those chats show
  as "unattributed" in `GitModal`, never as someone else's.
- **Lot 8, semantic search** — stays optional; nothing here depends on it.

### Phase 5 — ops from the terminal, and an Ops view · done (`18ae07e`, `33ef372`, `a2d677b`)

Landed as planned, with these findings worth keeping:
- **The relay runs as `ELECTRON_RUN_AS_NODE=1 <argos> out/main/ops-relay.js --ops-mcp`**,
  not inside Electron's main process: there, `process.stdin` as a stream delivers nothing
  on Windows (the same trap the notify hook hit) and Electron writes a stray `\r\n` to
  stdout at startup, which is the MCP channel. Under node mode stdin works, stdout is
  clean, Chromium never starts. If the RunAsNode fuse is ever disabled, the relay breaks.
- **A repeat `ops:terminal-session` for a live terminal returns the same token**, because a
  renderer remount reattaches to the same pty and that pty keeps the token it was born
  with. A new token only after `run.end`.
- **Codex starts MCP servers with a cleared environment**, so the token also travels in
  the config file's `env`, not only in the pty's. Its `config.toml` is a complete overlay
  (auth copied in and persisted back) with the runbook folder trusted.
- **Ops terminals are local-shell only**: a WSL distro cannot reach a Windows named pipe.
  WSL and SSH launches are refused with a message rather than started without the server.
- **`MCP_TOOL_TIMEOUT`** is set on the Claude pty (30 min): the default is far below a
  modal wait plus a ten-minute exec. No MCP cancellation is forwarded yet: if the CLI
  gives up on a call, main still waits on the modal.
- Not verified: that Antigravity (`agy`) honours `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. The
  Ops view shows Gemini as "tools only" but nobody has run it.

Phases 0–3 put the gate where Argos sits between the model and the tools: the SDK chat.
The user's daily tool is the **embedded terminal**, where the CLI runs on its own and
Argos only sees the screen. This phase moves the gate to a place both can reach.

**Decisions**
- **The ops MCP server becomes a separate stdio process, and a thin one.** `argos
  --ops-mcp` (guarded before the single-instance lock, like `--notify-hook`) speaks MCP
  over stdio to the CLI and relays every tool call over a local socket to the running
  Argos. It holds no policy, no ledger and no SSH: if the relay is tampered with, main
  re-gates. Main does what it does today — classify, log, ask, execute, log.
- **The socket is per machine user and per token.** A named pipe on Windows
  (`\\.\pipe\argos-ops-<token>`), a socket under `XDG_RUNTIME_DIR` (fallback `userData`)
  elsewhere. Argos issues a fresh token per ops terminal, passes it in the CLI's
  environment as `ARGOS_OPS_TOKEN` with the endpoint in `ARGOS_OPS_PIPE`, and maps it to
  that terminal's ops session. An unknown token is dropped without a reply.
- **A terminal ops session is one run per CLI launch.** `run.start` when the CLI is
  launched, `run.end` when the pty exits or the terminal is closed, plan-first inside it.
- **Any CLI.** A stdio MCP server is universal, so Codex and Gemini get the same tools and
  the same ledger. What they do **not** get is the removal of their own local shell: only
  Claude Code takes `--disallowedTools`, so on the other two the runbook is a rule the
  ledger can show being broken, not one Argos can enforce. The Ops view says which
  guarantee is in force for the chosen CLI.
- **The SDK chat becomes one more client.** It keeps the in-process server (no socket
  needed) but shares `ops-session.ts`, so there is one code path for gate, ledger and
  approvals whatever the front end.
- **Ops gets its own place under Servers.** An "Ops" member beside Remote & WSL: the
  recent runbooks, and per runbook a workspace with the hosts strip (connection dots,
  strict flag, which guarantee applies), a Terminal / Chat toggle, the timeline, Report,
  and the day's ledger status. The chat's environment-menu picker stays as a shortcut.

**Batches**
- **5a — main:** `ops-session.ts` (the per-front-end context, factored out of
  `ops-run.ts`), `ops-bridge.ts` (socket server, token registry, request/response framing:
  newline-delimited JSON `{ id, tool, args }` → `{ id, result | error }`), the `--ops-mcp`
  relay in `ops-relay.ts` using `@modelcontextprotocol/sdk`'s `StdioServerTransport`
  (added to dependencies; it is already installed as the Agent SDK's dependency), and IPC
  `ops:terminal-session(terminalId, runbookPath)` → `{ ok, env: { ARGOS_OPS_PIPE,
  ARGOS_OPS_TOKEN }, mcpConfigPath }` that writes the CLI-specific MCP config under
  `userData/ops-mcp/<terminalId>/`. Tests drive the bridge over a real pipe with a fake
  backend.
- **5b — terminal:** `createTerminal` / `startCliInTerminal` accept `ops?: { env,
  mcpConfigPath, provider }` and launch Claude Code with `--mcp-config <path>
  --strict-mcp-config --allowedTools "mcp__ops__*" --disallowedTools Bash,Edit,Write,
  MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent,Task`; Codex through a `CODEX_HOME`
  overlay with `[mcp_servers.ops]` (the mechanism `prepareCodexHome` already has); Gemini
  through its system settings overlay. The ops env is set on the pty, so the relay the
  CLI spawns inherits the token. On pty exit the terminal reports it so main can log
  `run.end`.
- **5c — renderer:** the Ops member in the Servers group, `OpsView` (runbook list) and
  `OpsWorkspace` (hosts strip, mode toggle, `ChatTerminal` with the ops launch or `Chat`
  with the SDK path, `OpsTimeline`, Report, ledger line). Reuses every component Phase 3
  built; the chat picker is untouched.

**Not in this phase:** running the relay on the server (never), enforcing local-tool
removal on Codex/Gemini (not possible from outside the CLI), and the review-gate backlog.

### First run against a real host · 2026-10-02

The `diagnose-rails-host` runbook (in the sibling `runbooks` repo) ran against the Rocky
9.8 test VM over ssh2 through the real policy, gate, ledger and reports, with the
Electron-wrapped host store replaced by a direct connection. 18 commands ran, 4 were
refused as intended (an unlisted sudo, a `;` chain, a path outside the policy, a `..`),
the ledger verified clean at 67 lines. What it taught:

- **Titles are the client's text, not the sanitiser's input.** The sanitiser redacted
  `nginx`, `Ruby` and `erros` out of step titles because they were argv words. Fixed:
  titles are sanitised only for hosts and addresses, and listed as noun phrases
  (`35e7b7e`).
- **`sudo` with `NOPASSWD` for one command passes silently** (`sudo nginx -t` ran with no
  password), while `sudo -u postgres psql` needed one and the probe, having no prompt,
  got "a password is required". The app's prompt (§4) covers this; the probe did not.
- **Each exec took about 2 s** on this VM, even `nproc`. Measured: `source ~/.bashrc`
  alone is 1.4 s, from `nvm.sh` (bash sources `.bashrc` for every ssh exec because sshd
  sets `SSH_CLIENT`). Not Argos's to fix, but a runbook of twenty reads is a minute of
  waiting; a `[ -z "$PS1" ] && return` before the nvm lines on the host removes it.
- **Rules for services that do not exist return exit 4** (`puma.service could not be
  found`) and the client report then says operations were not concluded. A runbook per
  host profile, or titles that say "quando existir", would read better.
- The VM has nginx, redis, memcached and monit as units; PostgreSQL 17 is installed but
  disabled; no puma or sidekiq units. `sudo` asks for a password for anything not in a
  NOPASSWD rule.

## 10. Verification

- `npm run typecheck` and `npm test` on every staged tree.
- The Phase 1 adversarial suite is the acceptance test for the gate; a PR that touches
  `ops-gate-pure.ts` must add a case or say why none is needed.
- Manual, once, against the existing **Rocky 9 - Testes** VirtualBox VM (the PostgreSQL
  upgrade test box, which already has the real stack and `sshd`). Script: run
  `diagnose-rails-host` end to end; run `pg-cert-renew` and deny at the modal; run a
  chained command and read the deny in the ledger; edit a script after loading and watch
  the hash refusal; disconnect the VM's network mid-run and read `timedOut` +
  `run.aborted`; render both reports and check the client one by eye against the §5.1
  rules before trusting the tests.
- `verifyChain` over the day's ledger after the manual session.

## 11. Not doing

| | Why |
|---|---|
| Installing an agent, daemon or `claude` on servers | The whole point. SSH is the only footprint. |
| Editing `policy.json` or scripts from Argos | Policy changes go through the repo and review. Argos reads. |
| Redacting secrets in captured output | Cannot be done reliably; a false sense of safety is worse than a documented gap. |
| Codex / Gemini ops chats | No `canUseTool`, no in-process MCP. The profile is Claude-only and the picker hides it elsewhere. |
| `tmux` / long-lived remote sessions for ops runs | A run is a sequence of bounded `exec`s. Interactive work stays in the Connect tab. |
| Auto-approval of `mutate` outside `strict` runbooks | See §2 validator rule 3. |
| Starting or checking VPN clients | Eight different clients, each with its own GUI. Argos reports "unreachable" and stops. |
| Sending the client report to the ticket system or GitLab | The report is a draft the user pastes. Integration is a separate decision with its own plan. |
| Ticket triage, SAML metadata editing, GitLab issue drafting | Writing work, not server work. Belongs in an ordinary chat with the writing rules, not in the ops profile. |
