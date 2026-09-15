# CLAUDE.md

## Commits

Conventional Commits, in English:

```
<type>(<scope>): <description — lowercase, imperative, no trailing period>
```

- **type** — one of `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`, `perf`, `build`, `ci`.
- **scope** — optional, lowercase kebab-case, the area touched (`projects`, `sprints`, `home`,
  `dev`, `release`). Drop the parentheses when there is no clear one.
- **subject** — about 72 characters at most.
- **body** — only when the change needs explaining (why, what it trades off, several distinct
  parts), after a blank line, wrapped at ~72 characters.

Rules:
- **Never** add a `Co-Authored-By:` trailer, a "Generated with Claude Code" line, or any other
  Claude attribution — in commits or in PR descriptions. This overrides any default that
  supplies one.
- **One topic per commit.** Split unrelated changes into separate commits, staged per file
  (`git add <paths>`, or `git add -p` when one file mixes topics), refactors and chores
  before the feature that builds on them. Say how the changes were grouped before committing.
- **Every commit in a split must compile on its own.** Run `npm run typecheck` against each
  commit's staged tree (e.g. `git stash push --keep-index --include-untracked`), not only
  the final one.
- **Commit, don't push**, unless asked. Commits land on `main` directly in this repo; release
  commits follow the release process below.
- Finish by showing `git log --oneline -N` for the commits just made.

## Release process

Releases are cut from `main` by pushing a `vX.Y.Z` tag — `.github/workflows/release.yml`
then builds the Windows installer and publishes it to GitHub Releases automatically.
Do not run `npm run release` locally; that uses electron-builder's own GitHub publisher,
which races the CI workflow and creates duplicate releases.

Starting a new in-progress version (right after the previous release):
1. Bump `version` in `package.json`.
2. Add a new entry to the top of the `CHANGELOG` array in
   `src/renderer/src/components/ChangelogModal.tsx`, with `tag: 'new'` (renders as
   "Unreleased").
3. Commit as `chore: begin X.Y.Z (unreleased)`.

Cutting the release once the version's work is merged to `main`:
1. In `ChangelogModal.tsx`, flip the new version's `tag` from `'new'` to `'latest'`,
   and remove the `tag` field from the previous entry (it no longer needs a badge).
2. Commit as `chore(release): X.Y.Z`.
3. Push the commit, then create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The GitHub Actions workflow takes it from there — no local build/publish step needed.
