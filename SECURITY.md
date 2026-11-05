# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/JoaoDiasLeite/argos/security/advisories/new>. Only the
maintainer sees the report. If that form is not available to you, email
<joaofilipe.diasleite@gmail.com> with "argos security" in the subject.

Include what you can: the version (the installer name or Settings → About),
the steps to reproduce, and what an attacker gains. You will get an
acknowledgement within a few days and updates as the fix progresses. Please
give the maintainer a reasonable time to ship a fix before disclosing.

## Scope

Argos runs coding-agent CLIs in terminals, holds SSH credentials encrypted at
rest, runs runbooks on remote servers under a policy, and updates itself from
GitHub Releases. Problems in any of these are in scope, in particular:

- credential storage, profile export and import;
- the ops gate: commands, scripts or paths a policy should block but does not;
- the IPC bridge between the renderer and the main process;
- the release and auto-update path.

Bugs in the CLIs themselves (Claude Code, Codex, Gemini) belong to their
vendors.

## Supported versions

Only the latest release receives security fixes. Installed builds update
themselves.
