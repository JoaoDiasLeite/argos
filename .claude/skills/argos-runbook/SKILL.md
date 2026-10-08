---
name: argos-runbook
description: Create or edit an Argos ops runbook (a folder with RUNBOOK.md, policy.json and scripts/) that the ops agent runs against SSH hosts, and validate it with Argos's own parser. Use when asked for a runbook, a policy.json, or a new ops procedure for a server, Proxmox node, database or service.
---

# Argos runbook

An Argos runbook is what the ops agent is allowed to do on a server, written so the gate
can enforce it. It is not a prose wiki page: `policy.json` decides what runs, `RUNBOOK.md`
tells the model how to behave. Contract and rationale: `docs/OPS_AGENT_PLAN.md` §2 and §3.

## Where it goes

Outside this repo, in a runbooks folder next to it (`../runbooks/<name>/`), because the
plan keeps scripts in the runbook repo and Argos only reads them. Ask where the runbooks
repo is if `../runbooks` does not exist and the user has not said.

```
<name>/
  RUNBOOK.md     appended verbatim to the system prompt
  policy.json    the gate's input
  scripts/       optional; each file sha256-pinned in policy.json
```

The folder name is the runbook's name and lands in report file names and the ledger:
letters, digits, `.`, `_`, `-` only (`runbookName` in `src/main/ops-runbook-pure.ts`).

## Workflow

1. **Pick the class first.** Read-only (diagnose, check, inspect) is the default and needs
   no approvals. Anything that changes a host is `mutate`, needs `"strict": true`, and is
   written as a literal allow rule or a pinned script, never a pattern loose enough to
   cover "similar" commands. When unsure, write the read-only runbook and say what the
   mutating one would need.
2. **Write `policy.json`.** Rules below.
3. **Write `RUNBOOK.md`.** Rules below.
4. **Validate** with the real parser and gate (recipe below). Fix every error: an invalid
   policy refuses the run, it never degrades to fewer rules.
5. **Report** the path, how many rules are read vs mutate, and what the runbook refuses.
   Do not commit unless asked; the runbooks repo is separate from this one.

## policy.json rules

The validator (`src/main/ops-policy-pure.ts`) rejects, never repairs:

- Top level keys only: `version` (must be `1`), `strict` (boolean, required), `platform`,
  `hosts`, `allow`, `scripts`, `read`, `write`, `limits`. An unknown key anywhere is an error.
- `hosts` maps a group name to stored-host names or globs (`pve*`). A group matching no stored
  host is a warning, and a deny at run time. Rules refer to groups, never raw hostnames.
- `platform` is the product's name as the client report should print it, verbatim (one line,
  up to 120 characters, Markdown emphasis kept). Omit it when the runbook serves no product.
- Every regex (`cmd`, `args.pattern`, `read.paths`, `write.paths`) is anchored `^…$`, under
  512 chars, has no top-level `|` (wrap alternatives: `^(a|b)$`), and path patterns start
  with `^/`. In JSON, escape backslashes: `"\\."`.
- Each `allow` rule is `{hosts, cmd, class, approval?, title}`. Give every rule a `title`, in
  the language of the client report; a missing title is a warning.
- `class` is `read` or `mutate`. `approval` defaults to `auto` for read and `ask` for mutate.
  `mutate` with `auto` is only legal when `strict` is `true`.
- `scripts` entries need `name` (a plain file name), a lower-case 64-hex `sha256` that matches
  the file in `scripts/`, `hosts`, `class`, and `args: {max, pattern}` when arguments are
  allowed. Compute the hash from the file's exact bytes
  (`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" scripts/x.sh`)
  and recompute after every edit.
- `limits` are clamped to 10 min, 2 MB output, 4 concurrent per host.

What the gate does regardless of the policy, so do not try to encode it:

- A command is **one simple command**: no `;`, `&&`, `||`, pipes, `$(…)`, backticks, redirects,
  heredocs, `VAR=` prefixes. Composition belongs in a pinned script.
- The regex is matched against the canonical argv (words joined by single spaces), so write
  patterns for `tail -n 100 /var/log/x.log`, not for quoted variants.
- A hard denylist (`reboot`, `shutdown`, `rm -rf /`, `mkfs`, `passwd`, …) cannot be allowed.
- Unmatched calls are denied when `strict`, asked otherwise.

Default to `"strict": true`. Prefer many small literal rules over one clever regex, and
list services or options in a group (`(a|b|c)`) instead of `[a-z-]+`. Never allow `sudo`
generically, and never allow reading secrets (`/etc/shadow`, `authorized_keys`, key files,
`priv/` directories, `.env`); `read.paths` is an allowlist, so what is not listed is refused.

## RUNBOOK.md rules

It is appended verbatim to the system prompt, after a fixed preamble (one command per
call, report non-zero exits verbatim, stop on a failed check, formal European Portuguese to
the operator). So write it as instructions to the model, not as documentation:

- Start with an H1, then one plain paragraph: what it does and that it changes nothing
  (or exactly what it changes). `guidelinesHead` shows that paragraph on the start screen.
- A scope section: which hosts, which user, what is out of bounds, and "if the request
  needs something not covered, say so and stop".
- A numbered procedure, one check per step, naming the exact commands the policy allows, with
  the expected result and where to stop. For a mutating runbook, put a read-only
  verification before every mutate step and say that a failed check ends the run.
- A failure table: symptom, likely cause, what to report.
- Write in European Portuguese when the operator-facing runbook is Portuguese, with no em
  or en dashes. Keep it well under 256 KB (the loader's limit); in practice, one screen
  or two.
- Never put secrets, tokens, passwords or real client IPs in it.

## Validate with Argos's own code

Run from the repo root. `vitest` and `tsx` may not be installed; `esbuild` is. Use Windows
style paths (`C:/…`) in the imports, since the native esbuild does not resolve Git Bash
`/c/…` paths.

```ts
// <scratchpad>/v.ts
import { readFileSync } from 'fs'
import { assembleRunbook } from 'C:/<repo>/src/main/ops-runbook-pure'
import { classify } from 'C:/<repo>/src/main/ops-gate-pure'
import { resolveHostGroups } from 'C:/<repo>/src/main/ops-policy-pure'

const dir = 'C:/<path to the runbook folder>'
const host = { id: 'x', name: '<a name the host glob matches>', host: '10.0.0.5' }
// scriptHashes: { 'name.sh': '<sha256 of its bytes>' } for every file in scripts/, else {}
const r = assembleRunbook({ dir, runbookMd: readFileSync(dir + '/RUNBOOK.md'), policyJson: readFileSync(dir + '/policy.json'), scriptHashes: {}, hosts: [host] })
if (!r.ok) { console.log(JSON.stringify(r, null, 1)); process.exit(1) }
console.log('warnings:', r.runbook.warnings)
const groups = resolveHostGroups(r.runbook.policy, host)
// Allowed commands must say allow; mutations and chained commands must say deny/ask.
for (const cmd of [/* every command the procedure uses */, /* plus a few it must refuse */]) {
  const g = classify({ tool: 'run', hostId: 'x', cmd }, r.runbook.policy, host, groups)
  console.log(cmd.padEnd(48), g.decision, g.class, g.denylist ?? '')
}
```

```
node_modules/.bin/esbuild <scratchpad>/v.ts --bundle --platform=node --outfile=<scratchpad>/v.cjs --log-level=error && node <scratchpad>/v.cjs
```

Done means: `assembleRunbook` returns ok with no warnings, every command the `RUNBOOK.md`
procedure names comes back `allow`, and the things it promises to refuse come back `deny`.
Check both directions; a runbook whose own steps are denied is the common failure. Delete the
scratch files afterwards; nothing goes into `src/`.

## Example

`../runbooks/proxmox-access/` is a complete read-only runbook (17 literal rules, no scripts).
Copy its shape for a new read-only runbook. It runs as a non-root user: the commands that
need privileges are literal `^sudo …$` rules and the rest run without `sudo`. `read.paths`
only lists files that user can read over SFTP, so root-only paths are reached through a
`sudo` command rule instead.
