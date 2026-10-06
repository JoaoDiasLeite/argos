# Next fixes — resolved

Follow-ups left open after the 0.6.0 multi-provider work (commits `56364c5`..`34b0c5c`).
All items below have shipped; kept as a record of what was wrong and how it was fixed.
Add new follow-ups above the line as they come up.

---

## Open

### From the port to the system design (docs/PORT_PLAN.md)

- **Claude Code check returns only the version.** The target column (Servers, batch 1)
  wants "2.1.4 · logged in as <account>"; the check only runs `claude --version`. Add the
  logged-in account to the check result. (`// TODO(port)` in `RemoteView.tsx`.)
- **Home has no ops runs, no finished-today list and no previews.** Wireframe 5B shows an
  ops intervention as a running row (accent dot), "Earlier today · N finished" folded, and a
  preview line under each resumable session. The renderer gets none of these today
  (`TODO(port)` in `HomeView.tsx`; the preview is the older `TODO(B4)` in `App.tsx`). Needs a
  small IPC: today's finished chats and ops runs, and the last message of a session.

### Panes (asked for on 2026-10-06, after 2.2.3)

- **Pop a chat out into its own window (later).** Open a chat outside the main window, as a
  separate `BrowserWindow`, so it can sit on another monitor. The pty already outlives its
  view (it is keyed by terminal id in main), so the new window can attach to the same
  terminal the pane had, and the pane can attach back when the window closes. Open
  questions: sessions live in the main window's App state, so the pop-out needs them pushed
  over IPC (name, unread, status) rather than its own copy; approvals for that chat must be
  answered in the window that shows it; the main window shows a placeholder or drops the
  pane while the chat is out; window bounds remembered per chat; the pill/toast "window out
  of view" checks must count the pop-out as a window that is in view.

---

## Done

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
