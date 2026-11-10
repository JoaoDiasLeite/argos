# Base intervention: what Argos may change without a runbook (3.6.0)

_Planned 2026-11-10 from an evaluation of the wm-devsecops runbooks (`runbooks/argos/` and
`runbooks/jarvis/`, origin/main 8231115) and of the Jarvis catalog
(`https://jarvis.cityfy.pt/api/v3/wmcp/catalog`). Decisions marked **open** still need the
owner._

## 1. What changes, in one paragraph

Today an intervention is either a **diagnosis** (the read-only runbook shipped with Argos)
or a **runbook intervention** (a runbook from the runbooks folder, and only that runbook's
policy). This plan adds a third, middle option and makes it the default for changes: the
**base intervention**, a second runbook shipped with Argos that holds everything the
diagnosis may read plus the server changes the team already does through Jarvis, each
change needing the operator's approval. A runbook from the folder can still be chosen, and
a toggle says whether it **adds to the base** or **replaces it**. When an intervention
used a runbook of its own, Argos asks at the end whether that runbook should become part
of the base, and if so opens a prefilled GitHub issue on the Argos repo.

## 2. Evaluation of the existing runbooks

Validated with Argos's own parser and gate (`assembleRunbook` + `classify`, the recipe of
the `argos-runbook` skill), every command of each `RUNBOOK.md` against its own policy and
against the built-in diagnosis.

| Runbook | Parses | Rules (read / mutate) | Verdict |
| --- | --- | --- | --- |
| `diagnose-citizen-host` | ok, no warnings, hashes match | 21 / 0 | Keep in the library. Its five scripts are product knowledge (occurrence sync), not base material. |
| `diagnose-rails-host` | ok | 35 / 0 | Mostly covered by the diagnosis; the gaps below go into the diagnosis. Holds a test script `batats.sh` and a step 0 "Teste de scripts" that must go. Then retire it. |
| `trace-message-dispatch` | ok | 14 / 0 | Keep in the library (wireChannel queries). |
| `update-wmcp` | ok | 19 / 2 | **Superseded.** Reads versions from `/api/v2/`, wraps steps in its own `wmcp-step.sh`; the current Jarvis runbook (`update_app/production`, API v3) runs `jarvis run script … --step=N --verify_of=N --timing=true`, and this policy denies all of those. Retire. |
| `update-wmcp-same-lane` | ok | 1 / 1 | Superseded the same way. Retire. |
| `prepare-docker-host` (local, not committed yet) | ok, no warnings | 18 / 15 + 1 write path | Keep in the library: a one-time provisioning (Docker CE, SELinux on `/data`, `daemon.json`), not base material. Every command of its procedure passes; installing another package, touching the firewall or publishing a container port is refused. Its generic reads go into the diagnosis (§2.1, 7 to 10). |
| Jarvis `update_app/production` | Markdown, no policy | — | The canonical update procedure. Jarvis serves exactly the repo file (checked byte for byte, line endings aside). It is the only Jarvis runbook. |

All host groups are hard-coded to stored-host names (`Rocky-9-Testes`, `IPLisboa`): fine
for a personal library, but they must never leave the machine (§6).

### 2.1 Gaps in the diagnosis (things the read-only runbooks need and the diagnosis refuses)

Read-only, so they go into `resources/runbooks/diagnosis` (re-pin with
`npm run pin:diagnosis`) and therefore into the base too:

1. **Root-only nginx logs**: `sudo -n tail -n N /var/log/nginx/<file>.log` and the
   `sudo -n grep|zgrep` form with `-m` (the diagnosis allows `sudo -n` only on
   `/var/log/messages`).
2. **Capistrano layout** `/var/www/<app>/shared/log/*.log` and `ls /var/www`: the
   diagnosis only knows `/home/<user>/www`. Add `/var/www/[^/]+/(shared/log|current/config)`
   to the path set of `tail/head/grep/ls/stat` and to `read.paths` (with `read.deny`
   still closing `database.yml`, `secrets*`, `master.key`).
3. **Runtime versions**: `ruby -v`, `node -v`, `openssl version`, `gem list openssl`,
   `ruby -ropenssl -e 'puts OpenSSL::OPENSSL_LIBRARY_VERSION'`, `pm2 (list|status)`.
4. **Local certificate files**: `openssl x509 -in <file> -noout (-enddate|-subject|-issuer)+`
   under `/etc/nginx/ssl` and the PostgreSQL data folder (`tls-check.sh` only checks a
   listening endpoint). Never `-text` on a key file; keys stay in `read.deny`.
5. `last` with `-s <date> -t <date>`.
6. **Jarvis reads**: the catalog commands with "Changes the server: no" and
   "Interactive: no" (`diagnostics/*`, `backup/list`, `ruby/check`, `app/test_rails`,
   `base_files/check_placeholders`). Today the diagnosis refuses every `jarvis run`.
7. **SELinux and packages** (from `prepare-docker-host`): `getenforce`, `sestatus`,
   `sudo -n semanage fcontext -l -C`, `rpm -q <package>…`, and `-Z` among the options of
   the diagnosis's `ls`.
8. **Disks and users**: `xfs_info <mount point>`, `lsblk`, `findmnt`, and `id <user>`
   (the diagnosis only has a bare `id`); `ls -d…` on a single directory anywhere
   (the entry itself, never its contents).
9. **Firewall reads**: `sudo -n firewall-cmd (--state|--get-active-zones|--list-all)`
   with an optional `--zone=<name>`. Never any other `firewall-cmd` option.
10. **Docker reads**, for hosts like Nexus that run containers (the docker runbook's own
    report already asks for them): `sudo -n docker (ps|ps -a|info|images|stats --no-stream)`,
    `sudo -n docker logs --tail N <container>`, `sudo -n docker compose ls`, and
    `/etc/docker/daemon.json` in `read.paths`. Not `docker inspect` (it prints the
    container's environment, where secrets live), and `~/.docker/config.json` goes into
    `read.deny`.

Not added: `zgrep` without `-m` (the diagnosis forces a cap; `log-window.sh` covers time
windows), `curl` to a host other than the server itself (decided 2026-11-10: not even
with `ask`), and `app/test_rails` (it boots the application). Certificates ending in
`.pem` stay refused: `read.deny` closes `.pem` because keys use it too.

**Done in batch 1** (2026-11-10): the diagnosis went from 43 to 70 rules, all `read`;
`ops-despiste-runbook.test.ts` checks every item above in both directions.

## 3. The base intervention runbook

`resources/runbooks/intervention/`, shipped like the diagnosis (`extraResources`,
`-text` in `.gitattributes`, `builtinRunbookDir('intervention')`).

- **Policy = diagnosis + Jarvis catalog**, generated, never hand-edited:
  `npm run pin:intervention` (add `-- --fetch` to read the catalog from Jarvis first)
  builds `intervention/policy.json` from `resources/runbooks/diagnosis/policy.json`,
  `scripts/intervention/catalog.txt` (the snapshot) and `scripts/intervention/titles.json`
  (the pt-PT title of every runnable catalog command; a new command cannot enter without
  one), and copies the diagnosis scripts byte for byte. The sources sit under `scripts/`
  so they do not ship. `ops-intervention-runbook.test.ts` fails when `policy.json` is not
  what the generator makes, so a hand edit or a stale pin cannot ship; run
  `pin:intervention` after every `pin:diagnosis`.
- **Limits**: 10 min per command, 2 MB of output, one command at a time per host
  (update steps run for minutes; changes never run side by side).
- **One rule per catalog command**, never a generic `jarvis run script [a-z/_]+`:
  - "Changes the server: no" → `class: read`, `approval: auto`;
  - "yes" → `class: mutate`, `approval: ask`;
  - "Interactive: yes" (`accounts/migrate`, `system/install_wmcp_server`,
    `system/renew_postgresql_certificates`, `update_app/production`) → **no rule**: the
    model hands them to the operator through `ask_operator`;
  - `sudo` exactly as the catalog writes it (the gate needs `^sudo ` literal rules);
  - placeholders become patterns: `<a|b>` → `(a|b)`, `<version>` →
    `[0-9]+\.[0-9]+\.[0-9]+(\.[A-Za-z0-9]+)?`, `<user>` → `[a-z0-9._-]{1,64}`, other
    `<x>` → `[A-Za-z0-9._-]{1,64}`, `[ … ]` → optional;
  - every rule also accepts the update runbook's trailing `--step=[0-9]+[a-z]?`,
    `--verify_of=[0-9]+[a-z]?` and `--timing=true`.
- **No update extra.** The `sudo -u wiremaze mv …/tmp/update_backup …` rule of
  `update-wmcp` was left out in batch 2: it belonged to the API v2 procedure, and the
  catalog's `backup/create`, `backup/list` and `backup/restore` now own the update's
  backups. Every change in the base goes through Jarvis.
- **No `curl` to Jarvis from the server**: the update never needs the runbook text, since
  `diagnostics/update_steps` prints the procedure's commands, and the owner ruled out
  external `curl`.
- **No raw `systemctl restart`, `monit restart`, `nginx -s reload`**: the catalog already
  has `app/restart`, `app/reload`, `app/start`, `app/stop`, `app/monitor_service`, which
  know the platform's services. Decided 2026-11-10: the Jarvis commands are enough.
- **`RUNBOOK.md`** (pt-PT, "tu"): the diagnosis's way of working (notes, hypotheses,
  `ask_operator`), plus the Jarvis rules distilled from `jarvis:run` and
  `update_app/production`: only catalog commands, never from memory, one at a time, a
  read-only check before each change, stop on any `ERROR`, never type a password, the
  update follows `update_app/production` as Jarvis serves it. Plan approval stays
  (`planRequired` is derived: the base has mutate rules, so a plan is required).
- **Reading a Jarvis script before running it** (`jarvis:run` rule 3): the approval card
  of a catalog `mutate` call shows the catalog's `What` and links its `Code` address.
  **Open:** whether the model should also read the code itself (needs a read-only
  `jarvis_code` MCP tool, since the ops CLI has no web access).

**Done in batch 2** (2026-11-10): 105 rules (the diagnosis's 70, 24 Jarvis changes, 11
Jarvis reads), 9 scripts; the 4 interactive commands have no rule and are named in
`RUNBOOK.md`. `builtinRunbookDir(name)` takes `'diagnosis'` or `'intervention'`; nothing
loads the intervention yet (batch 4 wires the start screen).

## 4. Start screen and hand-over

- Mode becomes three choices: **Diagnosis** (default, as today), **Intervention** (the
  base), **Runbook** (picker as today).
- With Runbook chosen, a toggle **"Somar à base" / "Só este runbook"**, default "Somar à
  base", remembered per runbook in localStorage. The "what this allows" panel lists the
  base folded to one line and the runbook's own rules in full.
- "Passar a intervenção" from a diagnosis offers the base first and the runbook picker
  second. The diagnosis's handover gets one line: whether its recommended actions are
  covered by the base (the model checks its `action` notes against the base catalog,
  which the diagnosis's `RUNBOOK.md` lists by name).

## 5. Merging a runbook with the base

A pure `mergePolicies(base, extra)` in `ops-policy-pure.ts`, used only for "Somar à base":

- `allow` and `scripts` concatenated, the runbook's first (its own titles win on a tie);
  a script name in both is an error (scripts are looked up by name in one folder each, so
  each merged script keeps its `dir`).
- `hosts`: the base's single `todos: ["*"]` group is rewritten onto the runbook's groups
  so the base rules apply exactly where the runbook's do. `strict: true` always.
- `read.paths` and `write.paths` unioned; `read.deny` unioned (a deny of either side
  wins); `limits` the larger of each, still clamped.
- `RUNBOOK.md`: the base's, then the runbook's under a heading that says its rules win
  where they are stricter.
- The ledger's `run.start` names both runbooks (`runbook` plus `baseRunbook`), with both
  hashes; reports print both.

## 6. "Add to Argos" at the end of a run

When a run with a folder runbook ends (any outcome but `cancelled` before the first call),
and that runbook has at least one rule or script the base does not have:

1. The end-of-run sheet asks: "Este runbook deve passar às permissões base do Argos?"
   with "Criar issue" and "Agora não". "Nunca para este runbook" is remembered.
2. "Criar issue" opens, through `shell.openExternal`, a prefilled
   `https://github.com/JoaoDiasLeite/argos/issues/new?title=…&body=…`, no token needed:
   - title: `runbook: add <name> to the base intervention`;
   - body: the rules and scripts missing from the base, each marked **used in this run**
     (from the ledger's matched rule ids) or not, as JSON; script names and sha256 only,
     never their content; the run's outcome and Argos version.
   - **Never** in the body: host names or group contents (every `hosts` value becomes
     `["*"]`), the server, client, ticket, task text, `RUNBOOK.md`, command output. The
     repo is public.
3. A body longer than ~6 000 characters (URL limits) goes to the clipboard instead, the
   URL carries the title and "o corpo está na área de transferência", and the sheet says
   so.

## 7. Clean-up in wm-devsecops (separate MR there, not this repo)

- Remove `update-wmcp` and `update-wmcp-same-lane` (superseded by the base).
- Remove `diagnose-rails-host` once the §2.1 gaps ship in the diagnosis (or at least its
  `batats.sh` and step 0).
- `runbooks/argos/README.md`: say that runbooks now add to the base, so a runbook only
  needs what is specific to it.
- Commit `prepare-docker-host`. Once the base ships it can drop its generic reads
  (`free`, `df`, `ss`, `systemctl is-active`, `getenforce`, `rpm -q`, firewall reads) when
  used with "Somar à base", keeping only the Docker-specific rules.

## 8. Batches

1. Diagnosis gaps (§2.1) + `npm run pin:diagnosis` + tests in `ops-despiste-runbook.test.ts`
   (both directions). Also fix the `argos-runbook` skill: esbuild is gone since vite 8,
   bundle the validator with `node_modules/.bin/rolldown`.
2. Catalog generator + `resources/runbooks/intervention` + sync test + gate tests for
   every catalog shape (read, mutate, sudo, interactive refused, `--step/--verify_of`).
3. `mergePolicies` + loader + ledger `baseRunbook` + tests.
4. Start screen (three modes, toggle, panel) + hand-over + i18n en/pt-PT.
5. End-of-run "add to Argos" + issue body builder (pure, with a test that no host, client
   or ticket leaks) + i18n.
6. wm-devsecops MR (§7).
