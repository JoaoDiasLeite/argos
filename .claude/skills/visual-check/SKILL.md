---
name: visual-check
description: Launch an isolated instance of the built app with a seeded demo session and screenshot it for visual verification. Use after UI changes to see them rendered without touching the user's running instance.
---

# Visual check

Renders the real, built Electron app — not a mock — with a seeded config and
demo chat session, and screenshots it. Use this after making renderer/UI
changes to confirm what actually landed on screen, instead of guessing from
source alone.

## One-liner

```
powershell -File scripts/visual-check/run.ps1 -View chat
```

This builds the app, launches an isolated instance, waits for it to render,
screenshots it to `scripts/visual-check/visual-check.png`, and kills the
instance. Pass a different `-View` to land on a specific screen, `-OutFile
<path>` to change where the PNG goes, `-KeepOpen` to leave the instance
running for manual poking, `-Wide` to capture at 1900x1150 (or `-Wide -Size WxH`)
for layouts whose breakpoints sit above the default window, or `-SkipBuild` to reuse the existing `out/`
bundle (much faster — use this if you haven't changed anything since the
last build, or already ran `npx electron-vite build` yourself).

Valid `-View` names: `chat`, `projects`, `agents`, `rooms`, `planner`,
`scheduled`, `usage`, `mcp`, `remote`, `settings`.

## How it works

- `scripts/visual-check/launch.js` boots the built `out/main/index.js` with
  `app.setPath('userData', ...)` pointed at an isolated temp dir, then (if
  `VISUAL_CHECK_VIEW` is set) sends the same `app:open-view` IPC event the
  real app uses for plan-limit notification clicks, deep-linking to that view.
- `VISUAL_CHECK_LOCALSTORAGE` seeds renderer `localStorage` before the app reads it:
  pass a JSON object of `{key: value}` (values are JSON-encoded into the store) and the
  launcher writes them on first load, then reloads. This is how to photograph state that
  otherwise only exists after a gesture — the pane layout lives under `argos.panes.v1`,
  e.g. `{"argos.panes.v1":{"v":1,"layout":"cols-2","panes":[{"sessionId":"demo"},{"sessionId":"demo2"}],"focused":"demo"}}`
  splits the two seeded chats into two columns. Every session id named there must exist
  in `seed/sessions/`, or it is dropped as stale.
- `VISUAL_CHECK_CONFIG_PATCH` merges a JSON object one level deep into the seeded
  `config.json` before the app starts. `{"ui":{"workMode":"terminal"}}` is the one that
  matters: it puts real embedded terminals on screen instead of chat transcripts, which
  is the only way to photograph anything about how terminals look. The CLIs do start for
  real in the isolated instance, so expect a trust prompt in the capture.
- `VISUAL_CHECK_CC_SESSION` does the same for a Claude Code conversation: set it
  to a JSON target (`{"encodedDir":"-home-x-repo","sessionId":"<uuid>"}`) and the
  launcher sends `app:open-cc-session`, the channel a notification click uses. The
  conversation has to exist on disk — create a disposable project under
  `~/.claude/projects/` for it and delete it afterwards.
- `scripts/visual-check/seed/` holds a pre-built `config.json` (onboarding
  already marked done, dark theme) and a `sessions/demo.json` demo chat so
  the transcript isn't empty.
- `scripts/visual-check/run.ps1` copies the seed into a fresh temp userData
  dir, builds, launches `electron.exe scripts/visual-check/launch.js`, waits
  ~11s for render, calls `snap.ps1`, then kills the process.
- `scripts/visual-check/snap.ps1` grabs the process's `MainWindowHandle` and
  calls `PrintWindow(hwnd, hdc, 3)` (PW_RENDERFULLCONTENT) to capture it as a
  PNG — this works even if the window isn't focused or is behind other
  windows.

## Gotchas

- **Why isolation is required at all**: `npm run dev` instances share
  `%APPDATA%\argos` userData and enforce a single-instance lock, so a
  second `npm run dev` just focuses the first window instead of starting
  fresh — you cannot visually check a change without either disrupting a
  running dev session or (this skill's approach) launching a separate
  instance from the built `out/` bundle with a redirected userData dir.
- **Seed JSON must be BOM-free UTF-8.** The app now tolerates a leading BOM
  (see `src/main/json-file.ts`), but don't take that as license to regenerate
  the seed files carelessly — PowerShell 5.1's `Set-Content`/`Out-File`
  default to UTF-8 **with** BOM, so if you ever rewrite
  `seed/config.json` or `seed/sessions/demo.json` from PowerShell, pass
  `-Encoding utf8NoBOM` or write them with Node/another BOM-free path
  instead. The checked-in seed files are already correct — just copy them
  as-is (`Copy-Item` preserves bytes untouched).
- **`PrintWindow` works without focus.** `snap.ps1` never clicks, focuses, or
  brings the window to front — it captures via a device context handle.
  Do **not** add synthetic mouse clicks or key presses to this flow: the
  app's frameless title bar has a large `-webkit-app-region: drag` area that
  swallows synthetic clicks, and a stray click/keystroke from the driving
  script can land on the *user's real windows* if focus ends up elsewhere.
  If you need to reach a specific screen, use `VISUAL_CHECK_VIEW` deep-linking
  (the `-View` param) instead of simulating navigation clicks.
- **`run.ps1` wipes the isolated userData dir on every run** (`Remove-Item -Recurse`
  before copying the seed), so anything placed there by hand — an extra session file,
  a tweaked config — is gone before the app starts. Put fixtures in `seed/` instead.
  The failure is quiet and misleading: a pane layout naming a session that no longer
  exists is discarded by `normalize()`, so a seeded split comes back as a single pane
  and reads like the split itself is broken.
- **A deep-linked run that also builds can land on the wrong screen.** The launcher
  sends its `app:open-view` / `app:open-cc-session` at 6s and 10s, and `run.ps1`
  captures at 11s; on a run that just spent ten seconds building, the app starts late
  enough that the second send arrives with no margin and the screenshot shows the
  default view. It looks like the deep link is broken and is not — build once
  (`npx electron-vite build`) and pass `-SkipBuild` for deep-linked checks.
- **The capture picks the biggest window, not `MainWindowHandle`.** The app also opens
  small always-on-top helpers (pill, overlay), and which of them Windows calls the main
  window changes with z-order — enough that resizing the real one handed back a 969x651
  helper instead. `snap.ps1` enumerates the process's visible top-level windows and takes
  the largest, falling back to `MainWindowHandle` if none enumerate.
- **`-Wide` sets bounds; it does not maximise.** `win.maximize()` is not honoured by this
  window — the capture comes back unchanged — while `setBounds` takes. The launcher
  applies it twice (t+5s, t+9s) for the same reason the deep link is sent twice.
- **A minimized/not-yet-shown window screenshots as ~160x28.** `snap.ps1`
  detects a degenerate rect (width < 300 or height < 200), calls
  `ShowWindow(hwnd, 9)` (SW_RESTORE), sleeps ~900ms, and re-measures before
  capturing — this is automatic, but if you still get a tiny image, the wait
  in `run.ps1` before capture (~11s) may need to be longer on a slow machine.
