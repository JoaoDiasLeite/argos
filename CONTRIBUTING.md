# Contributing to Argos

Thank you for considering a contribution. Argos is maintained by one person,
João Dias Leite, who decides what goes in. This guide keeps that process short
and predictable.

## Scope

Welcome: bug fixes, small improvements to existing features, translations
(English and European Portuguese), documentation, tests.

Open an issue first for anything larger: a new view, a new provider, a change
to the ops gate or the runbook format, a dependency swap, or anything that
changes how data is stored. A short description of the problem and the
intended approach is enough. This avoids work that cannot be merged.

The maintainer decides what is merged, and may decline a contribution that
does not fit the project's direction even when the code is fine.

## How to contribute

Nobody has write access besides the maintainer. Work from a fork:

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep the pull request focused on one topic.
3. Run the checks (below) and make sure they pass.
4. Open a pull request against `main`. CI runs on it; pull requests are
   merged with squash, so the branch history does not need to be tidy, but
   the pull request title becomes the commit title on `main`.

## Checks

Requires Node.js 20.

```bash
npm install
npm test           # vitest
npm run typecheck  # main and renderer
npm run build      # electron-vite build
```

There is no separate lint step. Files ending in `-pure.ts` hold logic with no
Electron or I/O dependency and carry most of the tests; put new logic there
when you can, with a test next to it.

## Commits

Conventional Commits, in English, and every commit signed off:

```
<type>(<scope>): <description, lowercase, imperative, no trailing period>
```

- `type`: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`,
  `perf`, `build`, `ci`.
- `scope`: optional, the area touched (`companion`, `projects`, `ops`, ...).
- Subject about 72 characters at most.

Sign off with `git commit -s`. This adds a `Signed-off-by: Name <email>`
trailer that certifies the [Developer Certificate of Origin](https://developercertificate.org/):
you wrote the change, or have the right to submit it, under the project's MIT
license. CI rejects pull requests with unsigned commits.

## What not to submit

Do not submit code, data, configuration, credentials or other material that
belongs to an employer or a client, or that you produced under an agreement
that gives someone else the rights to it. Contribute on your own time and with
your own resources, or with written permission from your employer. The pull
request template asks you to confirm this.

Never include secrets, tokens, real server addresses or real session data in
code, tests, fixtures or screenshots.

## Credit

Contributors keep authorship of their commits on `main` and are listed on the
repository's [contributors page](https://github.com/JoaoDiasLeite/argos/graphs/contributors).
