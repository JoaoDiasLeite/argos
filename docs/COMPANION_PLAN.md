# Companion — a desktop pet that takes notes, todos and reminders

_Brainstormed and designed by Fable on 2026-11-02 from the owner's brief: "a kind of
companion to Argos, like a mini pet, that lets me interact with him by voice or text,
where I can add things to a todo list or notes, and if I say 'I need to do this tomorrow
by 2pm' it shows up then if the companion is activated. Practically a kind of Clippy on
the desktop." Nothing here is implemented. Every file reference was read on 2026-11-02 at
`2.9.1` / `1787e6c`. Claims flagged **[unverified]** need a 20-minute spike before the
batch that depends on them starts._

## 1. What this is, in one paragraph

A small original character lives on the desktop, outside the Argos window, always on top
and click-through except where it is drawn. Pressing a key (or clicking it) opens a one-
line bubble; typing `ligar à Câmara de Vila Real amanhã às 14h` and pressing Enter files a
todo with a reminder at 14:00 tomorrow and shows a confirmation card for two seconds. At
14:00 the pet wakes, walks into view and says the line, with **Done · Snooze 10m · Open**.
Everything is parsed locally and instantly; the model is only asked when the local parser
is not confident. Nothing leaves the machine. The companion is a second window of the same
Argos process, reusing the overlay/toast patterns at `src/main/overlay.ts:21` and
`src/main/toast.ts:20`, and its data lives in `userData/companion/`.

**One app, not two.** Recommended without reservation. The companion needs the main
process it would otherwise have to duplicate: the tray (`src/main/tray.ts:40`), the
single-instance lock and `--toggle` handling (`src/main/index.ts:296`, `c8eac19`), the
headless engine runner (`src/main/index.ts:2318`, `:2404`), i18n (`src/main/i18n.ts:12`),
the config file, and the notification path (`src/main/index.ts:856`). A second app would
duplicate all of it and fight the first one over the global shortcut and the tray. The
extra cost inside Argos is one `BrowserWindow`, one renderer entry in
`electron.vite.config.ts` next to `overlay`/`toast`/`popout`, and ~6 main modules.

---

## 2. Concept and personality

### 2.1 Three original characters (divergent)

**A — Argos, the dog.** Odysseus' hound: the one who waited twenty years and recognised him
at the door. A small, flat, two-colour dog in the house icon style (inline SVG, 2 px
stroke, round caps — `docs/SYSTEM-DESIGN.md` §5), drawn from a side three-quarter view so
it can sit, lie down and look up. States read instantly on a shape this simple: ears up =
listening, head tilt = thinking, tail wag = done, curled with closed eyes = dozing, one ear
twitching = a reminder is due. Animatable by a developer with no animator: six to eight
drawn poses plus CSS transforms (ear rotation, tail rotation, a 2 px body bob, an eyelid
path that morphs). Warm, not cute-aggressive, and reads well at 72–96 px.

**B — Óculo, the eye.** Argos Panoptes, the hundred-eyed giant, reduced to one floating eye
inside a ring of small eye-marks. Cheapest possible animation: the pupil tracks the cursor,
the iris takes `--accent` / `--warn` / `--error` by state, the lid is a single path.
Visually it is the most "Argos" of the three and matches the existing abstract brand mark
(`src/renderer/src/brand/argos-mark.json`, a single swirl path). Rejected as the lead:
an eye that watches you all day, in an app that also holds your todos and SSHes into
client servers, reads as surveillance — and reads much worse on someone else's screen
during a Teams call.

**C — Pavo, the feather.** The myth's ending: Argos' eyes were set into the peacock's tail.
A tiny bird whose single tail feather carries one eye-mark that opens when it has something
to say. Charming and the most distinctive, but the hardest to draw convincingly without an
illustrator — a badly drawn bird looks broken, a badly drawn dog looks like a dog.

### 2.2 Recommendation

**Argos the dog**, with the Panoptes lineage as a detail only: the collar tag is the
existing Argos mark, and the dog's eyes are the one element that takes a state colour. No
Clippy geometry, no eyebrows-on-a-paperclip, no "It looks like you're writing a letter."
It never speaks unprompted except for a reminder or an alert the owner opted into.

Voice: the i18n register already decided for the app — pt-PT, second person singular
("tu"), English when `ui.language` is `en`. Short. It confirms by repeating the parse, not
by being friendly: `Amanhã 14:00 · Ligar à Câmara de Vila Real`, not `Com certeza! Vou
lembrar-te disso :)`.

### 2.3 States

| State | Trigger | Look |
|---|---|---|
| `dozing` | idle > 90 s | curled, eyes shut, slow breathing (a 2 px, 4 s bob) |
| `idle` | summoned, or after any interaction | sitting, blinks every 4–9 s (randomised) |
| `listening` | push-to-talk held | ears up, a level ring around the body driven by RMS |
| `thinking` | parse fell through to the model | head tilt + three dots over the head |
| `talking` | bubble open with text | speech bubble anchored to the head |
| `alert` | a reminder is due | stands, one bark-shape, bubble with the reminder |
| `happy` | an item marked done | 600 ms tail wag, then back to `idle` |
| `shh` | do-not-disturb on | lying down, a small crescent badge, no bubbles |

All animation respects `prefers-reduced-motion` (already a house rule,
`docs/SYSTEM-DESIGN.md` §9): with it set, states are static poses and transitions are
instant.

### 2.4 Where it lives on screen

Docked to a screen edge, not free-floating. Default position: bottom-right of the work
area of the display holding the cursor when first shown, 12 px margin — the same
arithmetic as `showToast()` (`src/main/toast.ts:70`), but on
`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` like `toggleOverlay()`
(`src/main/overlay.ts:79`) so it is multi-monitor correct. Draggable by grabbing the pet
itself; on release it snaps to the nearest edge and the position is persisted **per
display id** so unplugging a monitor does not strand it (same defensive pattern as
`restoredBounds` in `src/main/chat-popout.ts:68`).

DPI: the window is sized in DIPs, the sprite is SVG, so scaling is free. The only real
risk is dragging between displays with different scale factors — Electron reports bounds
in DIPs of the primary display; clamp the final position to the target display's
`workArea` after the drop.

**Full-screen apps:** `setAlwaysOnTop(true, 'screen-saver')` already floats over them
(`src/main/overlay.ts:42`). That is usually right for a reminder and wrong for a game or a
presentation, so: when the foreground window is full-screen, the pet still shows reminders
but as a Windows toast instead of the bubble. Detecting "something is full-screen" without
native code is awkward — v1 ships the simpler rule in §3.3 instead.

**Teams screen-share:** `win.setContentProtection(true)` on Windows 10 2004+ maps to
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, which makes the window invisible to
screen capture while staying visible on the physical screen. **[unverified in this
Electron 42 build — 15-minute spike: set it, share the screen in Teams, confirm the pet
disappears from the shared view and not from yours.]** If it works it is the single best
feature in this document for João's job: the companion can stay on screen through a client
call. Ship it as a checkbox, default on.

---

## 3. "Activated": the state machine

João's phrase "if the companion is activated" has to become four concrete states.

| State | What it means | Reminder behaviour |
|---|---|---|
| `summoned` | the pet window is visible | bubble on the pet |
| `dozing` | visible but idle; same window | pet wakes to `alert`, bubble |
| `hidden` | pet window hidden, Argos running in tray | Windows notification (`app:notify` path, `src/main/index.ts:856`), clicking it summons the pet with the reminder |
| `closed` | Argos not running | nothing fires; caught up on next launch |

### 3.1 The scheduler is in main, not in the pet window

Timers live in `companion-scheduler.ts` in the main process and survive the pet window
being hidden or destroyed. Three rules:

- **Never `setTimeout` to a far-future reminder.** Keep one timer to the next due instant,
  capped at 60 s; re-arm from the store each tick. A 14-hour `setTimeout` is wrong across
  sleep, clock changes and DST.
- **`powerMonitor.on('resume')` re-evaluates everything.** Nothing in the repo uses
  `powerMonitor` today (grepped: zero hits) so this is new wiring. A laptop that slept
  through 14:00 fires the reminder on resume, marked late.
- **Catch-up on launch.** On startup, every reminder whose `remindAt` passed while the app
  was closed and that is not `done` is collected into **one** bubble: `3 lembretes
  passaram enquanto o Argos esteve fechado`, expandable. Never three toasts in a row at
  08:30. A reminder more than 7 days late is marked `missed` and only shows in the list.

### 3.2 Snooze

Three buttons on the reminder bubble: **Feito** · **+10 min** · **Abrir**. A long-press or
a chevron on `+10 min` offers 10 min / 1 h / amanhã de manhã (09:00) / escolher. Snoozing
appends to `remindAt[]` rather than replacing, so the history of a nagging item is visible.
Cap: after 5 snoozes the pet says so and offers to move the due date instead.

### 3.3 Do not disturb

Automatic detection is where this feature can quietly burn a week.

- Windows **Focus Assist** state is readable via `SHQueryUserNotificationState`, which
  needs a native module or a helper exe — out of proportion for v1.
- "Is Teams sharing my screen?" has no supported API at all. Process-name heuristics
  (`ms-teams.exe` running) are useless: Teams runs all day.
- `powerMonitor.getSystemIdleState(n)` is free and already available.

**v1: a manual `shh` toggle only**, reachable three ways — the tray menu, a right-click on
the pet, and typing `shh 1h` into the bubble. It silences bubbles and sound; reminders
still queue and are delivered as one catch-up when it lifts. Plus one automatic rule that
costs nothing: `setContentProtection` (§2.4) means the pet does not need to hide during a
screen share at all. Revisit Focus Assist only if João asks twice.

### 3.4 Start with Windows

`config.system.openAtLogin` already exists (`src/main/config.ts:145`). The companion makes
it matter: a reminder app that only runs when you remember to open it is not one. The
companion settings pane says so in one line and offers to turn it on, rather than turning
it on silently.

---

## 4. Input

### 4.1 Text — v1, and the thing that must be instant

One global shortcut summons the pet **with the input already focused**. Reuse the
fall-through registration of `registerOverlayShortcut()` (`src/main/overlay.ts:98`)
verbatim: try the user's preference, then two defaults. Proposed defaults:
`Ctrl+Shift+A`, then `Ctrl+Alt+A`. Do not touch `Alt+Space` — the quick launcher owns it.

The bubble is one line with the house input styling (4 px radius, 36–40 px tall,
`docs/SYSTEM-DESIGN.md` §6). Enter files, Esc dismisses, Up recalls the last entry to edit.
Target: keystroke to confirmation card under 50 ms, which means no model call on the happy
path (§5).

### 4.2 Voice — evaluated concretely

| Option | Works offline | pt-PT | Verdict |
|---|---|---|---|
| Web Speech API (`webkitSpeechRecognition`) | no | n/a | **Dead.** Chromium's implementation posts audio to Google's speech endpoint using a Google API key compiled into Chrome. Electron ships no such key, so recognition fails with a `network` error. Confirmed knowledge, long-standing; do not spend time on it. |
| `System.Speech` via PowerShell (SAPI desktop) | yes | no | Uses installed desktop recognizers, which on a normal Windows 11 install means `en-US` only, and its dictation grammar is from the Windows 7 era. Unusable for pt-PT free speech. |
| `Windows.Media.SpeechRecognition` (WinRT) | yes (with a language pack) | yes, if the pt-PT speech pack is installed | Genuinely decent quality and zero model shipping. Cost: no maintained Node ↔ WinRT bridge (the `nodert-win10-*` packages are abandoned), so it means shipping a small C# helper exe and talking to it over stdio — a new build toolchain in a repo that has none, plus the pt-PT speech pack is a manual OS install João must do by hand. **[unverified: whether pt-PT is offered in Settings → Time & language → Speech on his machine.]** |
| **whisper.cpp binary + model** | yes | yes, good | **Recommended.** Spawn a prebuilt `whisper-cli.exe` on a recorded WAV, same shape as every other subprocess in this app. `ggml-small` quantised (q5_1, ~190 MB) is the sweet spot for Portuguese; `base` (~57 MB q5) makes too many errors on names like "Câmara de Vila Real". A 5-second clip on a modern laptop CPU with 4 threads transcribes in roughly 1–3 s **[unverified: benchmark on João's machine before committing to it]** — fine for push-to-talk with a `thinking` pose, not fine for a wake word. |
| Cloud STT (OpenAI, Deepgram, …) | no | excellent | **Refused by policy.** Dictated audio will contain client names, ticket numbers and server hostnames. The Wiremaze GDPR rules put that in the "do not send" column. Not an option even as a fallback, and the settings pane should say so rather than offering a toggle. |

**Packaging:** do **not** put a 190 MB model in `extraResources` — the installer is a
one-click NSIS build (`package.json` → `build.nsis.oneClick: true`) and tripling it to buy
a feature that may be used twice a week is a bad trade. Ship the small
`whisper-cli.exe` + its DLLs in `extraResources` (the `resources/runbooks` entry shows the
pattern) and **download the model on first use** into `userData/companion/models/`, with a
progress line in the bubble and a checksum. Linux AppImage: the same binary built for
Linux, or fall back to text-only there — João's primary is Windows and the AppImage is
secondary.

**Capture:** `getUserMedia` in the pet renderer, 16 kHz mono, written to a temp WAV. Must
be paired with `session.setPermissionRequestHandler` (§8) allowing `media` **only** for the
companion window's `webContents`, and the settings pane must point at Windows Settings →
Privacy → Microphone → "Allow desktop apps", which blocks packaged Electron apps silently
when off.

**Push-to-talk, not a wake word.** Hold the global shortcut (or hold-click the pet) to
record; release to transcribe. A wake word means a model running on the microphone
permanently: openWakeWord is a Python stack, and Porcupine is Picovoice's — its free tier
is personal-use only with an AccessKey that must be renewed, which is wrong for a tool used
at work. **[unverified: current Picovoice terms — but the dependency on a hosted key alone
disqualifies it here.]** Recommendation: **wake word never**, and say so in this document
so it stops being re-litigated.

### 4.3 Talking back (TTS)

Cheap and, unlike recognition, actually works offline in Electron: the renderer's
`speechSynthesis` maps to installed SAPI voices on Windows. pt-PT availability is the
catch — `Microsoft Helia` is the pt-PT voice and is often not installed, while `Maria` is
pt-BR and sounds wrong reading "tu" forms. **[unverified: which voices exist on João's
machine — `(New-Object -ComObject SAPI.SpVoice).GetVoices() | % { $_.GetDescription() }`.]**

Recommendation: **off by default**, a single "falar os lembretes em voz alta" checkbox, and
if no pt-PT voice is found, the checkbox is disabled with a one-line reason instead of
reading Portuguese in a Brazilian or English accent.

### 4.4 Phased path

1. Text bubble + global shortcut. (MVP)
2. Push-to-talk → local whisper, model downloaded on demand.
3. TTS checkbox, if a pt-PT voice exists.
4. Wake word: no.

---

## 5. Understanding — intents and dates

### 5.1 The two-layer rule

**Layer 1, deterministic, always first.** `companion-nlu-pure.ts`: no Electron, no network,
fully unit-tested, and it answers in under a millisecond. It covers the shapes João
actually types, in both languages:

- Relative: `amanhã`, `hoje`, `depois de amanhã`, `daqui a 20 minutos`, `daqui a 2 horas`,
  `na próxima semana`
- Weekdays: `sexta`, `na sexta`, `sexta de manhã` (→ 09:00), `sexta à tarde` (→ 14:00),
  `sexta à noite` (→ 20:00), `segunda que vem`
- Times: `às 14h`, `às 14:30`, `14h30`, `às 2 da tarde`, `ao meio-dia`, `2pm`, `at 2`
- Dates: `dia 12`, `12/11`, `12 de novembro`
- Intent verbs: a leading `nota:` / `note:` files a note; everything else is a todo; a
  bare question (`o que tenho amanhã?`, `what do I have tomorrow?`) is a query.

Output: `{ intent, title, when: { at: epochMs, precision: 'minute'|'day' } | null,
confidence: 0..1, matchedSpan: [start,end] }`. The matched span is removed from the title,
so `ligar à Câmara amanhã às 14h` stores the title `Ligar à Câmara`, not the whole
sentence.

**Layer 2, the model, only when `confidence < 0.6`.** Reuse the existing headless pattern
exactly — `resolvePolicy({ profile: 'headless-reasoning' })` + `getEngine(...).run(...)` +
`collectText` + `extractJson`, as `standup:generate` does at `src/main/index.ts:2437`. The
prompt is one paragraph plus the current local datetime, asking for the same JSON shape.
While it runs, the pet is in `thinking` and the bubble shows a spinner; typical latency is
seconds, which is acceptable *because it is the exception*. If the model fails or the user
is offline, the item is filed with no date and the bubble says `Guardei sem data` with an
inline date picker.

**Why not chrono-node as layer 1?** It is **not installed** (verified: nothing matching
`chrono` in `node_modules`). It does ship a Portuguese locale (`chrono.pt`), but its
Portuguese rules are thinner than its English ones and lean Brazilian. **[unverified:
whether `chrono.pt` handles `às 14h`, `daqui a 20 minutos`, `sexta de manhã`.]** Decision:
spend 30 minutes feeding it a list of 25 real phrases João would type; if it clears 20, use
it as the engine behind `companion-nlu-pure.ts` and keep the pure module as the wrapper
that handles intent, title extraction and the pt-PT gaps. If it does not, hand-write the
grammar — it is perhaps 250 lines of regex for a closed set of forms, and it will be more
predictable than a dependency.

**Spike result (2026-11-02): chrono-node 2 `chrono.pt` cleared 7 of 25 → hand-write the
grammar, no dependency.** Reference time Mon 2026-11-02 10:00. It got `hoje às 17:30`,
`na sexta`, `12/11`, `12 de novembro`, `ao meio-dia`, `às 14:30` and the English control
right. Worse than the misses, several were silently wrong: `daqui a 20 minutos` → 20:00,
`daqui a 2 horas` → 02:00 next day, `às 2 da tarde` → 02:00 next day, `depois de amanhã`
→ tomorrow, `segunda que vem` → today. It drops the time after `amanhã` (`amanhã às 14h`
→ 10:00), uses 12:00 for `de manhã` and 15:00/22:00 for `à tarde`/`à noite`, and finds
nothing in `dia 12`, `na próxima semana`, `em 15 minutos`, `14h30 reunião` or `dia 5 às
16h`. These 25 phrases with their expected values become the first fixtures of
`companion-nlu-pure.test.ts`:

| Phrase | Expected |
|---|---|
| ligar à câmara amanhã às 14h | 11-03 14:00 |
| enviar relatório hoje às 17:30 | 11-02 17:30 |
| rever logs daqui a 20 minutos | 11-02 10:20 |
| reiniciar puma daqui a 2 horas | 11-02 12:00 |
| reunião sexta de manhã | 11-06 09:00 |
| call com leiria sexta à tarde | 11-06 14:00 |
| backup na sexta | 11-06 (day) |
| standup segunda que vem | 11-09 (day) |
| pagar fatura dia 12 | 11-12 (day) |
| renovar certificado 12/11 | 11-12 (day) |
| entregar proposta 12 de novembro | 11-12 (day) |
| almoço ao meio-dia | 11-02 12:00 |
| ligar ao joão às 2 da tarde | 11-02 14:00 |
| deploy às 14:30 | 11-02 14:30 |
| testar vpn amanhã 9h | 11-03 09:00 |
| ver isto depois de amanhã | 11-04 (day) |
| preparar sprint na próxima semana | 11-09 (day) |
| tenho de fazer isto amanhã até às 14h | 11-03 14:00 (due; remind 13:50) |
| quinta às 10h30 migração | 11-05 10:30 |
| lembra-me em 15 minutos de beber água | 11-02 10:15 (remind) |
| terça à noite atualizar runbook | 11-03 20:00 |
| amanhã de manhã ver tickets | 11-03 09:00 |
| 14h30 reunião com cliente | 11-02 14:30 |
| dia 5 às 16h formação | 11-05 16:00 (see note) |
| call with team tomorrow at 2pm | 11-03 14:00 |

Note on `dia 5`: on 2 Nov the 5th is still ahead, so it is **11-05**; a day number already
past this month rolls to next month. The test must pin that rule both ways.

**How João reads them (2026-11-02):** `sexta que vem` / `próxima sexta` is simply the next
Friday (on Monday 2 Nov → 6 Nov); when the weekday is today it is a week on (`próxima
quarta` on a Wednesday → the following Wednesday). Only `sexta da próxima semana` means
next calendar week's. `às 1h`…`às 7h` with no day part read as afternoon, like a bare
`às 2`; a colon clock (`às 2:00`) stays as written.

### 5.2 Intents, ranked by value

**v1:** add todo · add note · set reminder · list today / tomorrow · mark done · snooze.
**v2:** search notes · "promover para o sprint" · standup draft from the week's done items
(the generator already exists, `src/main/index.ts:2404`).
**v3, Argos-native and genuinely nice:** `abrir o projeto X`, `começar um chat no projeto
Y` — the overlay already does exactly this (`overlay:submit` / `overlay:open-session`,
`src/main/index.ts:822`), so the companion routes to the same handlers rather than
inventing a path. Do not build this in v1: it makes the companion compete with the quick
launcher, which is better at it.

### 5.3 "by 2pm" — due or remind?

Both, with one default that is stated out loud. `amanhã às 14h` sets `dueAt` = 14:00 and
`remindAt` = [14:00 − lead], with **lead = 10 minutes** by default and configurable. The
confirmation card shows both lines, so the rule is learned in one use:

```
Amanhã, qui 3 nov
14:00   Ligar à Câmara de Vila Real
13:50   aviso
                                     ✓ Guardar   ✎ Editar
```

Day-precision input (`amanhã`, `sexta`) gets no time and one reminder at the configured
morning hour (09:00). A phrase with both an explicit "lembra-me às X" and a due time sets
them independently.

### 5.4 Confirmation UX

The card appears for 2.5 s and auto-commits — the item is already saved when it appears, so
the card is a *receipt*, not a question. `✎` opens it for editing, Esc dismisses the card
(not the item), Ctrl+Z within the 2.5 s undoes. Never block on a confirm dialog for an
action this small; nothing kills a capture tool faster.

**A date with nothing to do** (`amanhã às 14h` alone parses to an empty title): nothing is
saved; the bubble keeps the date as a chip and asks `O que é para amanhã às 14:00?` in the
same input, and Enter saves the two together (decided 2026-11-02, batch D).

---

## 6. Data model and storage

`userData/companion/` — one folder, three files, all through `writeJsonFileAtomic`
(`src/main/json-file.ts:19`), all read through `readJsonFile` for the BOM tolerance.

```ts
// companion-types.ts
export interface CompanionTodo {
  id: string
  title: string
  notes?: string | null
  /** Epoch ms. null = someday. */
  dueAt?: number | null
  /** 'day' when no time was given — the UI shows a date, not 09:00. */
  duePrecision?: 'day' | 'minute'
  /** Every time it should speak, oldest first; snoozes append. */
  remindAt: number[]
  /** How far each remindAt fired, so a restart doesn't repeat one. */
  firedAt?: number[]
  done: boolean
  doneAt?: number | null
  createdAt: number
  source: 'voice' | 'text' | 'argos'
  /** Set when promoted; the sprint item is then the source of truth for `done`. */
  sprintId?: string | null
  sprintItemId?: string | null
  projectPath?: string | null
}

export interface CompanionNote {
  id: string
  text: string
  createdAt: number
  source: 'voice' | 'text'
  tags?: string[]
  /** Set once exported, so a re-export doesn't duplicate the file. */
  obsidianPath?: string | null
}
```

- `todos.json` · `notes.json` · `state.json` (pet position per display, dnd-until, last
  catch-up timestamp).
- Volatile UI state (which display, last bubble geometry) goes to `store.ts`
  (`src/main/store.ts:36`), not config. Preferences (shortcut, lead time, morning hour,
  voice on/off) go to `config.ts` under a new `companion` key next to `ui` / `system` /
  `ops` (`src/main/config.ts:121`), which gets it into the existing profile export/import
  for free.

**Recurrence: no, not in v1.** It triples the scheduler's complexity (RRULE, exceptions,
"snoozed one occurrence"), and João's described use is a stream of one-off commitments from
tickets and calls. Revisit only after a month of real use.

### 6.1 Todos vs Sprint — the decision

**Their own store, with one-way promotion into Sprint.** The reasoning:

- A sprint item is a *committed, estimated unit of sprint work* with points, status,
  burndown and a forge reference (`src/main/sprints.ts:17`). "Ligar à Câmara às 14h" is
  none of those. Forcing captures into `SprintItem` either pollutes the burndown with
  unpointed noise or forces a "not really an item" flag — which is exactly the kind of
  sprawl João dislikes.
- A capture tool must accept anything in under a second. Picking a sprint first breaks that.
- But the overlap is real: some captures *are* sprint work. So the todo row carries a
  **Promover para o sprint** action that creates a `SprintItem` in the active sprint via
  the existing `sprint:save` (`src/main/index.ts:2172`) and stores `sprintItemId` back on
  the todo. After promotion the sprint item owns `done`; the companion row shows a small
  sprint badge and reads its status through, rather than keeping a second truth.
- **No reverse sync, ever.** Sprint items do not become companion todos. One direction
  means one source of truth per item and no merge logic.

### 6.2 Obsidian

João has a vault at `C:\Obsidian\argos-obsidian`. Optional, off by default, two settings
(decision 5 in §10): the vault folder (any vault, picked with a folder dialog; a folder
without `.obsidian/` gets a warning, not a refusal) and a subfolder inside it, default
`Argos/`. When set, each note is **also** written as
`<folder>/YYYY-MM-DD-<slug>.md` with frontmatter (`created`, `source`, `tags`), and
`obsidianPath` is stored so edits rewrite the same file. Notes stay in `notes.json` as the
source of truth; the markdown is an export, not a sync — reading Obsidian back means
watching a folder, resolving conflicts and handling a vault on a synced drive, which is a
project of its own. Todos do **not** go to Obsidian: a todo whose state lives in two places
is a todo that is done in neither.

---

## 7. Integration with the rest of Argos — ranked by value, cut at the line

| # | Idea | Value | Clutter | Verdict |
|---|---|---|---|---|
| 1 | Tray: "Companheiro" toggle + "O que tenho hoje" | high | none | **v1** |
| 2 | Main-window **Companion** panel (list, edit, promote) | high | one sidebar entry | **v1** |
| 3 | A chat terminal finished / needs input → pet reacts | high | none (the hook exists, `src/main/notify-hook.ts:21`) | **v2** |
| 4 | Promote to sprint, from the panel and the bubble | high | one button | **v2** |
| 5 | Plan usage crossed 85 % → pet mentions it once | medium | none; `plan-alerts-pure.ts` already decides when | **v2**, reusing the existing latch so it cannot double-fire |
| 6 | Standup draft from the week's done todos | medium | a button in the panel | **v3** |
| 7 | Ops intervention finished → pet says so | low | the workspace already shows it | **no** |
| 8 | Pet comments on commits / cheers on green CI | low | high | **no.** This is where Clippy actually went wrong. |

The line is between 6 and 7. Everything below it is the pet talking because it can.

**The main-window panel** is a new sidebar entry `Companion`, not a tab inside Sprint:
a two-column layout per `docs/SYSTEM-DESIGN.md` §7 — Hoje / Amanhã / Mais tarde / Sem data
on the left, the selected item's detail on the right in a column that slides and dismisses
(the `useLingering` / `.slide-col` rule, §9). Notes are a second segment at the top of the
left column, not a second view.

---

## 8. Privacy and security

- **Microphone.** `session.setPermissionRequestHandler` on the default session, allowing
  `media` only when `webContents.id` is the companion window's and only while a push-to-talk
  gesture is active; everything else denied. Also set `setPermissionCheckHandler` — the
  check handler is what `navigator.permissions.query` and some getUserMedia paths actually
  consult, and leaving it unset defeats the request handler. None of this exists in the repo
  today (grepped: no `setPermissionRequestHandler` anywhere), so it is new and belongs in
  its own batch.
- **Audio never leaves the machine.** Recording goes to
  `userData/companion/audio/<uuid>.wav`, is passed to a local binary, and is **deleted in a
  `finally`** whether transcription succeeded or not. No audio retention setting — retention
  of client voice would be the exact thing GDPR policy forbids, so it is not offered.
- **`hardenWebContents(petWindow)`** like every other window (`src/main/overlay.ts:54`,
  `src/main/toast.ts:49`): renderers run `sandbox: false`, so a navigation away from the app
  would inherit the full preload bridge.
- **The model path sees text only**, and only on the low-confidence fallback. The settings
  pane should say which engine that is, since it is the one place a captured sentence can
  leave the process.
- **Storage** is `userData`, which is per-user and already covered by the profile
  export/import. Not encrypted — consistent with everything else Argos stores — but the
  companion folder must be in the export's candidate list so a profile move does not silently
  drop someone's todos.

---

## 9. Architecture

### 9.1 Windows

```ts
new BrowserWindow({
  width: 220, height: 220,
  show: false, frame: false, transparent: true, hasShadow: false,
  resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
  skipTaskbar: true, alwaysOnTop: true, focusable: false,
  backgroundColor: '#00000000',
  webPreferences: { preload: …, sandbox: false, contextIsolation: true }
})
```

Notes that matter:

- **`transparent: true` instead of `backgroundMaterial: 'acrylic'`.** The two are mutually
  exclusive on Windows: acrylic needs a surface to blur, which is what `overlay.ts:33` and
  `toast.ts:36` want and the pet must not have.
- **`focusable: false`** by default, like the toast (`src/main/toast.ts:31`) — the pet must
  never steal focus from a terminal João is typing in. The bubble is the exception: opening
  it calls `setFocusable(true)` + `focus()`, and closing it reverts. **[unverified: whether
  Electron 42 applies `setFocusable` without a show/hide cycle on Windows — 10-minute spike;
  the fallback is a separate focusable bubble window, which also neatly separates
  click-through from text entry.]**
- **Click-through:** `setIgnoreMouseEvents(true, { forward: true })` on the whole window,
  with the renderer tracking `mousemove` (which `forward: true` still delivers) and calling
  back to disable ignoring whenever the cursor is over the drawn silhouette's bounding box.
  This is the standard desktop-pet pattern; keep the hit area a generous rounded rect, not a
  per-pixel test.

A **second window for the bubble** is likely cleaner than one window that grows: the pet
stays tiny, click-through and non-focusable forever, and the bubble is a focusable window
positioned relative to it — the toast already proves that a small, positioned, acrylic
flyout works well here. Decide after the `setFocusable` spike.

### 9.2 Renderer entries

Add `companion` to `electron.vite.config.ts` → `renderer.build.rollupOptions.input`
alongside `index`/`overlay`/`toast`/`popout`, with `src/renderer/companion.html` →
`src/renderer/src/companion/main.tsx`. The `manualChunks` markdown rule in that file is
keyed off module ids, so it never touches an entry that does not import markdown — the
companion must not import `react-markdown` or `highlight.js`, which keeps its bundle tiny
and its first paint instant.

### 9.3 Main modules

| Module | Responsibility |
|---|---|
| `companion-types.ts` | the interfaces of §6, shared with the renderer via `types.ts` |
| `companion-store.ts` | load/save todos and notes, atomic writes, migrations |
| `companion-nlu-pure.ts` | text → intent + date; no Electron; fully tested |
| `companion-schedule-pure.ts` | given now + todos + state → what is due, what is late, what to re-arm; no timers; fully tested |
| `companion-scheduler.ts` | the one timer, `powerMonitor` wiring, catch-up, delivery routing (bubble vs notification) |
| `companion-window.ts` | the pet (and bubble) windows, placement, click-through, dnd |
| `companion-voice.ts` | whisper binary discovery, model download, transcribe, temp-file cleanup |

The `-pure` / `.test.ts` split is the house pattern (`ops-policy-pure.ts`,
`plan-alerts-pure.ts`, `notify-hook-pure.ts` …) and is what makes the two genuinely risky
parts — date parsing and "what is due now" — testable without launching Electron.

### 9.4 IPC surface

```
companion:list            → { todos, notes }
companion:capture(text, source)  → { item, parsed }   // the hot path
companion:update(todo)    companion:delete(id)
companion:done(id, done)  companion:snooze(id, ms)
companion:promote(id, sprintId)  → { sprintItemId }
companion:note(text)      companion:notes-search(q)
companion:dnd(untilMs | null)
companion:state           → { position, dnd, voiceReady }
companion:voice-start     companion:voice-stop → { text, ms }
companion:voice-install   → progress events while the model downloads
companion:settings        companion:set-settings(partial)

// main → renderers
companion:due             { todo, late }        // to the pet window
companion:changed         { todos?, notes? }    // to the main window panel
companion:shown                                 // reset + focus the bubble (overlay:shown's twin)
```

All of them go through `src/preload/index.ts` the same way everything else does.

### 9.5 Sprite and animation technology

| Option | Bundle | Authoring without an animator | Verdict |
|---|---|---|---|
| **SVG paths + CSS transforms** | ~5 kB | draw 6–8 poses once; animate by rotating groups | **Recommended.** It is already the house icon language (`docs/SYSTEM-DESIGN.md` §5: inline SVG, 24-unit viewBox, 2 px stroke, `currentColor`), so the pet takes theme tokens for free and looks like it belongs. `currentColor` on the eyes means state colour is one CSS variable. |
| PNG sprite sheet | 100–400 kB | needs frame-by-frame art — i.e. an animator | no |
| Lottie (`lottie-web` ~250 kB) | heavy | needs After Effects | no |
| Rive | runtime + a `.riv` | needs the Rive editor and its learning curve | no — and it would be the only non-code asset pipeline in the repo |

One `Pet.tsx` with a `state` prop, one `pet.css` holding the keyframes, every pose a
`<g>` toggled by class. A dozen CSS keyframe blocks beat any runtime.

**Superseded (2026-11-02):** João chose **pixel art** (a chibi Portuguese Podengo in the
spirit of the Codex desktop pets), so the pet is a **PNG sprite sheet per state**, 48×48
frames, played with CSS `steps()` and scaled with `image-rendering: pixelated`. The art is
generated and cleaned up outside the repo (`docs/COMPANION_ART_PROMPT.md`), which removes
the "needs an animator" objection above. `Pet.tsx` keeps the same `state` prop; until the
sheets exist it renders the inline-SVG placeholder from the wireframes.

---

## 10. Decisions (João, 2026-11-02)

These close the open questions below and override the defaults where they differ.

1. **Character:** the dog, named **Argos** (not "Argo"), like Odysseus' hound, drawn as a
   **chibi pixel-art Portuguese Podengo, all orange** (big semi-folded ears, wiry coat,
   sickle tail; replaces the flat look of §2.1 and the art tech of §9.5). The art
   will be produced with an image-generation AI from `docs/COMPANION_ART_PROMPT.md`, then
   vectorised; the inline-SVG placeholder in the wireframes stands in until then.
2. **Voice is in the MVP.** Batch H (push-to-talk, local whisper) joins the MVP cut, right
   after E. Still no wake word, no cloud STT.
3. **Todos separate from Sprint**, with one-way promotion (§6.1) — as proposed.
4. **Visibility follows the "Ficar no ecrã" preference:** on → the pet stays on screen;
   off (default) → it appears only when summoned or for a reminder.
5. **Obsidian export: yes, as an option**, with the target configurable — pick the vault
   folder and an optional subfolder in it (default `Argos/`). Notes only, export not sync.
6. **Recurrence:** not for now.
7. **Argos events through the pet:** not for now; may come later (§7 items 3 and 5).
8. **Reminders while Argos is closed:** caught up on next launch in one bubble — agreed.

### Original open questions, with the defaults proposed before the decisions

Each has a recommended default — if João says nothing, these are what get built.

1. **Which character?** → **Argos the dog.** (§2.2)
2. **Voice in the MVP?** → **No.** Text first; whisper lands in phase 3 once the capture
   loop is proven. If voice turns out to be the whole point for him, batches D/E move up.
3. **Companion todos separate from Sprint?** → **Separate, with one-way promotion.** (§6.1)
4. **Does the pet stay visible all day, or is it summoned?** → **Summoned by default**, with
   a "ficar no ecrã" preference; a permanently visible pet is the fastest way to a feature
   he turns off in week two.
5. **Obsidian export?** → **Off by default**, one folder setting, notes only, export not
   sync. (§6.2)
6. **Recurrence in v1?** → **No.** (§6)
7. **Should the pet surface Argos events (chat needs input, usage at 85 %)?** → **Not in
   the MVP**, then only items 3 and 5 of §7, both reusing the existing latches.
8. **Where do reminders go when Argos is closed?** → **Nowhere; caught up on next launch**,
   collapsed into one bubble, plus a nudge to enable `openAtLogin`. A background service
   that outlives the app is a different product.

---

## 11. Batches

One commit each, Conventional Commits, scope `companion`. Every commit must typecheck on
its own (`npm run typecheck` against the staged tree). Main-process and pure-logic batches
first, renderer after the types land — the ordering that worked for the interventions work
(`docs/INTERVENTIONS_PLAN.md` §6).

**MVP cut = batches A–E plus H** (voice moved into the MVP, decision 2 in §10). At the
end of H, João can press a key anywhere in Windows, type or say `ligar à Câmara amanhã às
14h`, and be reminded at 13:50 by a dog on his desktop, with the list in the main window.
Order: A, B, C, D, E, H, then F, G, I, J, K.

| | Batch | Files | Tests |
|---|---|---|---|
| **A** | `feat(companion): todo and note store with the date parser` | `companion-types.ts`, `companion-store.ts`, `companion-nlu-pure.ts` | `companion-nlu-pure.test.ts` — 40+ pt-PT and en phrases from §5.1, including the ones that must *not* parse (`a 20 metros`) |
| **B** | `feat(companion): due-reminder scheduling that survives sleep` | `companion-schedule-pure.ts`, `companion-scheduler.ts`, `powerMonitor` wiring in `index.ts` | `companion-schedule-pure.test.ts` — due/late/catch-up/snooze/fired-once, with injected `now` |
| **C** | `feat(companion): the pet window and its ipc` | `companion-window.ts`, IPC block in `index.ts`, `preload/index.ts`, `types.ts`, `config.ts` (`companion` prefs), `electron.vite.config.ts` entry | none (window code); typecheck + a manual visual check |
| **D** | `feat(companion): argos the pet and its capture bubble` | `src/renderer/companion.html`, `src/renderer/src/companion/*` (`main.tsx`, `Pet.tsx`, `Bubble.tsx`, `Confirm.tsx`, `pet.css`) | — |
| **E** | `feat(companion): the companion panel in the main window` | `views/CompanionView.tsx` + `.css`, `App.tsx` route, sidebar entry, `src/shared/i18n/{en,pt-PT}/companion.ts` + the `index.ts` of each | i18n parity is already covered by `src/shared/i18n/i18n.test.ts` |
| **F** | `feat(companion): promote a capture to the active sprint` | `companion-store.ts`, IPC, `CompanionView.tsx` | store test: promotion writes `sprintItemId` and does not duplicate |
| **G** | `feat(companion): ask the model when the local parse is unsure` | `index.ts` (a handler shaped like `standup:generate`), `companion-nlu-pure.ts` (the confidence gate) | gate tests only; the engine call is not unit-tested, as elsewhere |
| **H** | `feat(companion): push-to-talk dictation with a local whisper model` | `companion-voice.ts`, model download + progress IPC, `setPermissionRequestHandler` in `index.ts`, `electron-builder` `extraResources` | `companion-voice-pure.test.ts` for model-path resolution and checksum; transcription itself is manual |
| **I** | `feat(companion): quiet mode and screen-share invisibility` | `companion-window.ts` (`setContentProtection`), dnd in store + tray + bubble command | pure dnd window test |
| **J** | `feat(companion): export notes to the obsidian vault` | `companion-obsidian-pure.ts` (slug, frontmatter, collision), `companion-store.ts` | `companion-obsidian-pure.test.ts` |
| **K** | `docs: companion` | `CHANGELOG` entry in `ChangelogModal.tsx`, `README`, this file's status line | — |

A and B are disjoint and can run in parallel. C depends on A+B's types; D depends on C's
IPC; E depends on C. F–J are independent of each other once E has landed. Spikes to run
*before* the batch that needs them: `chrono.pt` coverage (before A),
`setFocusable`/click-through (before C), `setContentProtection` under Teams (before I),
whisper pt-PT latency and the SAPI voice list (before H).

---

## 12. Wireframe list

The screens another agent should draw next, in this order. House rules apply
(`docs/SYSTEM-DESIGN.md`): 4 px on surfaces, 8 px on things you click, theme tokens only,
inline SVG icons, no emoji, both themes.

1. **Pet idle on the desktop.** The 220×220 transparent window over a neutral desktop
   screenshot, bottom-right, 12 px from both edges. Show Argos sitting in the idle pose at
   about 96 px tall, with the surrounding window area fully transparent and its bounds
   indicated by a dashed guide that is annotation, not UI. Three thumbnails beside it for
   `dozing` (curled, eyes shut), `alert` (standing, ears forward) and `shh` (lying down with
   a small crescent badge at the collar). Annotate the drag handle (the body) and the
   click-through region (everything outside the silhouette's bounding box).

2. **Quick input bubble.** The pet with a speech bubble anchored to the top-right of its
   head, tail pointing at it. The bubble is ~380 px wide, `--bg-1`, 1 px `--border`, 4 px
   radius, holding a single borderless input at 13.5 px with the placeholder `O que
   precisas?` and a caret. Under the input, one 11.5 px `--text-2` helper line: `Enter
   guarda · ↑ edita o último · Esc fecha`. A small microphone icon at the right edge of the
   input, 16 px, `--text-2`. Show the bubble opening both upward-left (pet docked bottom-
   right) and downward-right (pet docked top-left) to prove the anchoring flips.

3. **Voice listening.** Same bubble, input replaced by a level meter: a row of 16 thin
   vertical bars in `--accent` at varying heights, and to their left the elapsed time
   `0:03` in `--font-mono` 12.5 px. The pet is in the `listening` pose with ears up and a
   thin `--accent` ring around the body. Helper line: `Solta para transcrever`. Draw the
   `thinking` variant too: bars replaced by three pulsing dots and the line `A transcrever…`.

4. **Confirmation card.** Replaces the bubble's contents for 2.5 s. An 11 px uppercase
   `--text-2` eyebrow `GUARDADO`, then the day line `Amanhã, qui 3 nov` at 13 px, then two
   rows: `14:00` in `--font-mono` beside `Ligar à Câmara de Vila Real` at 13.5 px, and
   below it `13:50` beside `aviso` in `--text-2`. A thin progress line along the bottom edge
   of the card, draining left to right over the 2.5 s. Two quiet controls bottom-right: `✎
   Editar` and `Desfazer`. Also draw the no-date variant: `Guardado sem data` with an inline
   `Definir data` quiet button.

5. **Reminder pop with snooze.** The pet in `alert`, bubble showing the title at 13.5 px
   with the due time above it in 11.5 px `--text-2`, and three controls in one row:
   a `--accent`-filled **Feito** (8 px radius, 36 px tall) and two quiet buttons **+10 min**
   and **Abrir**, the first with a chevron for the longer snooze menu. Draw the open snooze
   menu as a 4 px list below: `10 minutos · 1 hora · Amanhã de manhã · Escolher…`. And draw
   the late variant, where an 11 px `--warn` chip reading `atrasado 1 h` sits before the
   title.

6. **Catch-up on launch.** One bubble, collapsed: `3 lembretes passaram` at 13.5 px with an
   11.5 px `--text-2` second line `enquanto o Argos esteve fechado`, and a chevron. Expanded
   below it, three rows of time + title separated by spacing only (no boxes), each with a
   small check control at its right edge, and one quiet **Ver todos** at the bottom that
   opens the main-window panel.

7. **Companion panel in the main window.** The house two-column workspace: a left column
   with a segmented control at the top (`Tarefas` / `Notas`) and, under it, four sections
   separated by 1 px `--border` dividers — `Hoje`, `Amanhã`, `Mais tarde`, `Sem data` —
   each an 11 px uppercase `--text-2` eyebrow with a count, then rows of check + title +
   right-aligned time in `--font-mono` 12 px. An empty section shows one `.help` line, not
   nothing. The right column (440–520 px, 1 px `--border` on the left, slides open with the
   selection) holds the item: title as an editable 15 px field, a notes textarea, a due
   date + time pair, a reminders list with an add control, and at the bottom a quiet
   **Promover para o sprint** carrying the active sprint's name as muted detail. Show the
   promoted state too: the button replaced by a small sprint badge and the sprint item's
   status, read-only.

8. **Companion settings.** A section inside the existing Settings view, not a new screen.
   Rows, each a label + control + one helper line: the summon shortcut (a recorder input
   showing `Ctrl+Shift+A`), `Ficar no ecrã` (toggle), `Aviso antes da hora` (a select,
   `10 minutos`), `Hora da manhã` (a time field, `09:00`), `Invisível em partilhas de ecrã`
   (toggle, on, helper naming Teams), `Ditado por voz` (toggle, with an inline model-download
   row showing `190 MB` and a progress bar once started), `Falar os lembretes` (toggle, shown
   disabled with the reason `Nenhuma voz em português instalada`), and `Pasta do Obsidian`
   (a path picker, empty by default). Draw the download row mid-progress.

9. **Tray menu.** The existing menu (`src/main/tray.ts:22`) with two new entries between the
   quick launcher and the separator: `Companheiro` (a checkmark when visible) and `O que
   tenho hoje`, plus `Silêncio por 1 hora` under them. Draw it as the real Windows 11 context
   menu, not a styled panel.
