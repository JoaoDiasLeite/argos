# Next fixes — resolved

Follow-ups left open after the 0.6.0 multi-provider work (commits `56364c5`..`34b0c5c`).
All items below have shipped; kept as a record of what was wrong and how it was fixed.
Add new follow-ups above the line as they come up.

---

## Open

_Nothing open. The port leftovers and the pop-out follow-ups below shipped in 3.5.0_
_(docs/OPEN_ITEMS_PLAN.md)._

---

## Done

- **Home "Earlier today" and previews** (3.5.0): the side column folds today's finished chats
  and ops runs (from `ops:runs`) under "Earlier today · N finished"; the terminal sync writes
  each Claude chat's last turn into `session.preview`. No exit codes: the ledger has none and
  the pty's is not stored. (`461253f`)

- **Claude Code check shows the account** (3.5.0): `version · email`, from the distro's
  `.claude.json` the sources already read. The check is WSL-only. (`0376a42`)

- **Pop-out, after the first version** (3.5.0): `popout:update` pushes a rename to the window
  (title + header); main keeps the title's busy/waiting mark from `terminal:busy`/`terminal:notify`;
  a popped-out id counts as seen for unread; `chatInView(terminalId)` lets a focused pop-out
  count as in view for that chat's companion line and hook toast. **Dropped:** answering
  approvals in the pop-out. Argos's approval queue is fed only by ops runs, and an ops terminal
  cannot be popped out, so there is nothing to answer there; a chat's own permission prompts
  are the CLI's, inside the terminal the pop-out already shows. (`295503d`)

- **Pop a chat out into its own window, first version.** The terminal bar's arrow-out
  button opens the chat in a `BrowserWindow` of its own (`chat-popout.ts`, `popout.html`)
  that reattaches to the same pty and replays its scrollback; terminal output is broadcast
  to pop-outs too. The pane leaves the layout while the chat is out, and every way of
  opening the chat brings its window forward instead; closing the window puts the pane
  back. Bounds are remembered per chat. Approvals stay in the main window.

- **Move a pane that is already in a split.** `.pane-head` is a drag handle carrying
  `PANE_DRAG_TYPE`; `planDrop` turns it into a `move` (`movePane`: out, then back in beside
  the target, in the layout an insert of that many panes would give) or a `swap` on a
  centre or where no column shape fits. Two panes get no vertical zones for a move.

- **views.css "premium" card block** (shadows, hover lift on usage, account, MCP and search
  cards) deleted across the Projects, Usage and sweep batches. (`594adc1`)
- **Native `<select>` showed the browser arrow.** `components/Select.tsx` wraps every select
  and paints the design's SVG chevron. (`594adc1`)

- **Terminal bar used undefined tokens** (`--bg-elev`, `--bg`, `--text`, `--text-dim`), text
  `−`/`+` buttons and an accent-filled Reconnect overlay. Fixed in the sidebar batch of the
  port: real tokens, SVG icon buttons, a flat block with a quiet Reconnect. (`c001233`)
- **`Menu` icon-only triggers had no `aria-label`.** `Menu` takes `ariaLabel`; the SSH keys
  "More" and the project menu use it. (`b1066cb`)

1. **Unbound Codex chats ran on the wrong account** — `App.tsx` passed
   `session.codexAccountId` with no fallback, so a chat that never had one set ran on the
   machine-default `CODEX_HOME`. Fixed by falling back to `codexDefaultAccountId` in the run
   payload and in the sidebar's `acctOf`, kept consistent by extracting both into
   `src/renderer/src/lib/account-scope.ts`. (`0ce43de`)

2. **No test for the scoping logic** — extracted `provOf`/`acctOf`/`idFor`/`visibleSessions`
   into `account-scope.ts` and added vitest (`npm test`) covering the four scoping cases,
   including the unbound-legacy-chat regression. (`0ce43de`)

3. **Provider account IPC accepted inert Gemini calls** — the mutating handlers now reject
   `provider === 'gemini'` (add throws; rename/remove/set-default no-op) and `loadGroup`
   drops any stored non-default Gemini accounts. (`4efa54a`)

4. **Stale comment about Gemini env isolation** — reworded `index.ts` to mention only
   `CODEX_HOME` and note Gemini's login is machine-wide in the OS keyring. (`4efa54a`)

5. **Model discovery only covered Codex** — added a best-effort Claude discovery source
   (`client.models.list()` when `ANTHROPIC_API_KEY` is set), run concurrently with Codex.
   Discovered ids render as "pricing not yet catalogued"; ids/pricing are never guessed.
   (`b96337c`)

6. **Renderer bundle was ~1.7 MB in one chunk** — measured, then lazy-loaded the secondary
   views + `ChatTerminal` and split the markdown/highlight stack into its own chunk. Entry
   chunk dropped to ~294 kB. (`f1c5726`)

## Follow-on work (surfaced while fixing the above)

- **Account picker only set the default, didn't switch the view** — with a chat from another
  provider active, picking an account left the row pinned to that provider. Picking now moves
  you onto the chosen account (recent chat there, else the active draft, else a fresh chat).
  (`e08d1c7`)

- **Codex plan-usage badge** — Codex exposes per-account usage via `codex app-server`'s
  `account/rateLimits/read`, so the sidebar `%` badge now works for Codex accounts too (see
  `src/main/codex-usage.ts`). Antigravity/Gemini has no per-account usage and stays badge-less.
  (`098433a`)

---

## Not doing

- **Multi-account Gemini.** Not possible: Antigravity's login is machine-wide in the OS
  keyring, not under a config dir, so there is nothing to isolate per account. The
  contradictory fake-HOME scaffolding was removed in `7021943`. Revisit only if Antigravity
  gains a config-dir override.
