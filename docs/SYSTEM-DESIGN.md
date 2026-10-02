# Argos system design

_The rules the ops surfaces were rebuilt on in 2.0.0 (wireframes C2, D2, E2, F2 in
`docs/wireframes/`), written down so the rest of the app can be brought to them. Every
rule here was either already in `global.css` or was decided with the owner on 2026-10-02.
Tokens are the ones in `src/renderer/src/styles/global.css`; never hard-code a colour._

## 1. Shape

**Rounded means clickable.** The eye learns one thing: a rounded corner is something you
can press.

| Element | Radius | Token |
|---|---|---|
| Buttons, segmented controls, toggles, tabs, pills that act | 8 px | `--radius` |
| Panels, inputs, textareas, rows, code blocks, tiles, toasts, sheets | 4 px | `--radius-surface` |
| Chips and badges that only label | 3 px | inline |
| Dots | 50 % | |
| Nothing | 12 px | `--radius-lg` is legacy; do not add new uses |

A control that looks like a button but is not one (a disabled "Report" with no run) still
takes 8 px: shape says what it *is*, state says whether it works now.

## 2. Surfaces and depth

Four backgrounds, used as steps, never as decoration: `--bg-0` the page, `--bg-1` a
column or sheet, `--bg-2` a block inside it, `--bg-3` a hover or a pressed state. Borders
are `--border`; `--border-light` only on the one element that has focus or is the active
choice. **No cards inside cards**: a block inside a column is a flat `--bg-2` area with a
4 px radius; a list inside a block is rows separated by nothing but spacing.

Tint carries meaning, so it is rare. Only an element that needs the operator (an approval
waiting, a refused call, a failed exit) is tinted, with a 6 % wash of its state colour and
a 22–45 % border of the same. Routine rows stay untinted.

Sheets, not modals. A document or a decision that needs room opens as a right-hand sheet
over the content (`--bg-1`, 1 px `--border` on the left, a soft shadow); it has its own
close control and is never dismissed by clicking the scrim. Modals are for the rare
blocking question with no context of its own (a password). Toasts exist only while the
window is hidden and withdraw when it is focused.

## 3. Colour

| Role | Token | Where |
|---|---|---|
| Primary action | `--accent` fill, `--bg-0` text | One per screen. |
| Ran, allowed, intact | `--success` | Dots, counts, "exit 0". |
| Asks, sudo, exit ≠ 0, waiting | `--warn` | Dots, counts, the waiting block's border. |
| Refused, failed, stop, destructive | `--error` | Dots, counts, Stop, "Deny and stop". |
| Queued, pending, unknown | `--text-2` | Grey dot, muted text. |

The same colour means the same thing everywhere: green never decorates, red never
emphasises. A proportion bar is these colours in order (success, warn, error) on `--bg-2`.
Both themes must pass by reading `global.css`, not by testing one.

## 4. Type

`--font-sans` for everything the operator reads, `--font-mono` for anything that runs or
identifies (commands, paths, hashes, ids, file names). Sizes: 22 px page title (650),
15 px section title (650), 13.5 px body, 13 px rows, 12.5 px commands, 12 px secondary,
11.5 px helper text, 11 px eyebrow in uppercase with 0.12 em tracking and `--text-2`.
Weight 650 for titles and numbers, 600 for labels and pills, 400 for text. Letter-spacing
−0.01 em on titles only. Line height 1.5 for prose, 1.7 for terminal-like text.

Numbers that matter are the biggest thing in their block (20 px, 650) with an 11.5 px
`--text-2` caption under them: "33 / commands run on their own".

## 5. Icons

Inline SVG, 24-unit viewBox, 2 px stroke, round caps and joins, `currentColor`, 13–16 px
rendered. A chevron is `M6 9l6 6 6-6`, never a text caret (`v`, `⌄`, `▾`). No emoji. An
icon-only control carries `aria-label`.

## 6. Controls

- **Primary button**: `--accent` fill, dark text, 8 px, 36–40 px tall, one per screen,
  may carry a small icon before the label (play on Start).
- **Quiet button**: transparent, 1 px `--border-light`, `--text-1`, 8 px, same height.
- **Danger**: text in `--error` with no fill, or a quiet button with an `--error` border;
  never a red fill.
- **Segmented control**: one 8 px frame, the active segment on `--bg-2`.
- **Select**: a 4 px input-shaped surface with the value, optional muted detail, and a
  chevron at the right, 10 px from the edge; opens a 4 px list below with the same rows.
- **Inputs and textareas**: 4 px, `--bg-1`, 1 px `--border`, `--border-light` on focus,
  36–40 px tall, 12 px side padding. Labels above at 12 px, 600, `--text-1`; "optional"
  in `--text-2` 400 after the label, never an asterisk.
- **Keyboard**: Enter confirms the primary action, Esc the quiet one; say so in a helper
  line under the buttons ("Enter approves · Esc rejects"). Ignore Enter for the first
  400 ms after a decision appears, so a keystroke meant for the terminal cannot approve it.

## 7. Layout

Desktop only. A workspace is content left and one column right (440–520 px) with a 1 px
`--border` between. Column sections are separated by borders, not boxes. The thing that
needs the operator sits at the top of the column and is the only highlighted block. Lists
of past things fold to one line each under a divider with a centred caption ("Earlier
today · 2 runs"). Spacing scale: 4, 6, 8, 10, 12, 14, 16, 18, 22, 28, 36, 48, 64.

## 8. Words

- Say what happens, not what the system is: "Approve 14 of 16 steps", "will ask you
  first", "not in runbook", "outside this intervention".
- Never show a raw identifier where a name exists: the host's name, not its address; the
  step's title, not the tool id; "Audit log", not "ledger".
- English in the UI, formal European Portuguese in anything that reaches a client; no em or
  en dashes in client text, hyphens only.
- Helper text is one sentence, 11.5 px, `--text-2`, under the control it explains.
- A refusal is a sentence that names the token or rule that refused it.

## 9. Bringing the rest of the app here

Done on 2026-10-02, in the batches of `docs/PORT_PLAN.md` (`f1edc18` to `732fec0`): shared
controls and a `Sheet` first, then Servers, Settings, Projects, Sprint, Home, the sidebar and
setup pane, Usage, and a sweep over everything else. Each batch was checked in both themes
with the visual-check skill. What the wireframes show and the renderer cannot yet feed is
listed under "Open" in `docs/NEXT_FIXES.md`.

Two rules were added along the way and belong here:

- **A detail column that exists only while something is selected** (Projects, Servers)
  closes on a click outside it or Esc, slides its width open and shut over 160 ms while
  keeping its last content (`useLingering`, `.slide-col`), and respects
  `prefers-reduced-motion`. A column that is always live (Home, Sprint, Usage) does not
  slide, and when a section of it is empty it says so in one `.help` line rather than
  disappearing.
- **A footer sits under the content**, never pinned to the bottom of a column with nothing
  above it.
