import { useRef } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import './ChangelogModal.css'

interface Props {
  onClose: () => void
}

interface Entry {
  version: string
  date: string
  tag?: 'latest' | 'new'
  sections: { title: string; items: string[] }[]
}

const CHANGELOG: Entry[] = [
  {
    version: '1.15.1',
    date: '2026-09-22',
    tag: 'new',
    sections: []
  },
  {
    version: '1.15.0',
    date: '2026-09-21',
    tag: 'latest',
    sections: [
      {
        title: 'Changes',
        items: [
          'The Git panel can be reached from a chat run in the terminal. It only ever opened from the floating ⋯ menu over the transcript, and that menu is hidden for as long as the embedded terminal is up — it would otherwise sit over the terminal’s own surface — so a chat driven from the terminal, which is most of them, had no way to it at all: not the menu, not the palette, not a key. The terminal’s bar now carries a Git button beside Restart, that bar being the only chrome on screen in terminal mode. A terminal that is nobody’s chat — the Remote Session pane, a tile in the Live view — does not offer one, having no repository to point at. Review joins it there, and all three are in the command palette too, which answers in either mode and costs no room on screen — the Review entry names the direction it will take you, the panel usually being off-screen behind the palette when you ask for it. The review panel had always been able to sit beside a terminal — it is a column of its own, and a chat that had it open before switching kept showing it — there was just nothing left on screen to turn it on with.',
          'Ctrl+/ opens a list of every keyboard shortcut Argos answers to, grouped by where it applies and narrowed by typing; the nav rail and the command palette reach it as well. The keys were spread across the window, the terminal and each dialog, and nothing in the app had ever named them, so the only way to learn one was to be told. The quick launcher’s line reports the chord that actually got registered when Argos started rather than the one it asked for — Alt+Space is often already owned by another launcher, and what you have to press is whatever it fell back to.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'A Codex chat stops being marked as waiting on you the moment you answer it, instead of some way into the turn that follows — or never. The mark used to come off when the terminal looked busy again, and Codex keeps its elapsed-time line ticking underneath an approval prompt: the terminal never falls quiet, so answering the prompt changed nothing Argos could read, and the chat sat there amber in the list and in the bar of pending chats while the terminal beside it said it was working. Argos now takes the keystroke you answer with as the answer — it is the one that carries it to the CLI — and still watches for work resuming, which covers an approval that times out or is answered somewhere Argos is not the one typing. A window opened while a chat is already parked on a prompt now shows that too: the notification behind the mark is sent once, and anything not listening at that moment used to miss it.'
        ]
      }
    ]
  },
  {
    version: '1.14.0',
    date: '2026-09-21',
    sections: [
      {
        title: 'Changes',
        items: [
          'The Git panel groups a chat’s changes by which chat wrote them — this chat, another chat, or nobody — with each group staged in one press, and it says outright in the header when the tree holds work that is not this chat’s. Argos now keeps a record of which chat wrote which file: it used to keep one only in memory, only for chats run from its own composer, and only until the app closed, which left out every chat driven from the terminal and every run that went out to WSL or SSH. A chat older than the record is read back from its checkpoints and, for Claude Code, from the transcript its own CLI wrote; a file nobody claims is shown as unclaimed rather than pinned on somebody.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'A Codex chat waiting on you to approve a command is marked as waiting, in the chat list and in the bar of pending chats, instead of looking like a chat that had finished. That prompt is drawn inside the terminal and never reaches Argos’s own approval queue, so the two states were indistinguishable from the outside — both were simply a terminal that had gone quiet, and the one needing you to act was the one shown as dealt with. Argos now asks the Codex it launches to announce itself through the terminal’s own notification sequence, and reads that back out of the terminal: structured, so it does not break the day a prompt is reworded. The mark clears by itself when the CLI starts working again, which is what answering the prompt does.',
          'A Codex chat driven from the embedded terminal takes the name of the conversation it started, instead of staying “New chat” for good. A Claude chat names its session before its CLI launches and hands it over with --session-id, so Argos can always find the transcript it will write; the Codex CLI accepts no such flag, so the conversation got an id Argos was never told and there was nothing to look up. Argos now asks Codex what it has — through the CLI’s own app-server, so it does not matter which of the two stores that install keeps its history in — and claims the conversation recorded in the chat’s folder just after that chat’s terminal came up. The claim is made as narrowly as the facts allow: same folder, not before the terminal, not already taken by another chat, and oldest first, so two chats opened in one folder take their own. Where it cannot be sure it claims nothing and the chat keeps the name it had. Only a chat still called “New chat” is renamed.',
          'A chat driven from the embedded terminal shows that it is working whichever CLI it is running. The dot in the chat list, and the bar of pending chats above it, both read Claude Code’s own record of which of its sessions are busy — so a Codex or Antigravity chat, which has no such record, and which in Codex’s case cannot even be handed a session id to keep one under, sat there looking idle for the whole of every turn. Argos now also watches what the terminal itself puts out: a CLI part-way through a turn streams continuously, and one waiting at its prompt says nothing at all, which tells the two apart without depending on anything a particular CLI chooses to publish. What a keystroke echoes back is discounted, so typing into an idle chat does not light it up, and where Claude Code does publish its status that is still what is believed.',
          'An image pasted into a WSL chat is attached to the conversation, the way it already was locally, instead of arriving as a file path typed at the prompt. Argos took it that a CLI inside a distro could never reach the Windows clipboard, so it always wrote the picture into the distro’s /tmp and typed where it had put it. Claude Code there reads the clipboard through Windows itself whenever the distro has interop, which most do. Argos now asks the distro once, when the terminal opens: where the answer is yes the paste is handed to the CLI and shows up as “[Image #1]”, and where it is no — no wl-clipboard, no xclip, no interop — the file and its path are still what you get. A terminal running a plain shell rather than a CLI gets the path too, that being the only form it can do anything with.'
        ]
      }
    ]
  },
  {
    version: '1.13.0',
    date: '2026-09-18',
    sections: [
      {
        title: 'Changes',
        items: [
          'A hidden chat list leaves a small tab on the edge of the rail, where the list used to be — press it to bring the list back. Pressing Chat in the rail still does the same, but nothing on screen said so.',
          'The bar of pending chats shows each chat’s state on the pill itself instead of in small print beside it. A chat still working has an arc of accent running round its border, one waiting on you turns amber with an alert icon, and a finished one keeps its green tick. “finished” and “needs approval” were easy to miss, and a chat that was still working had no mark at all. The bar’s label counts each state, and hovering a pill spells it out. A long chat name now shortens with an ellipsis instead of pushing the account chip out of the pill.'
        ]
      }
    ]
  },
  {
    version: '1.12.0',
    date: '2026-09-18',
    sections: [
      {
        title: 'Fixes',
        items: [
          'Clicking a notification opens the conversation it is about, in the chat. It used to land on the Projects list with the conversation in a reading panel beside it — and when the conversation could not be matched against that list, it stopped there and opened nothing, which is how a click came to do nothing at all. A conversation already open in Argos is brought forward rather than resumed a second time, and one only on disk is resumed into a chat, archived transcripts included. Projects is still where a conversation that is nowhere to be found leaves you, because that is somewhere to go looking.',
          'A chat started in a WSL folder from a project group’s “+” knows it runs in WSL. It was handed the folder in the only spelling a plain Windows program can use — the \\\\wsl.localhost\\… share — and nothing recorded which distro that was. The terminal went into the distro anyway, correctly, so the CLI and its transcript lived there while the chat still called itself local with a Windows path. Everything here that keys off the distro then looked in the wrong place: the visible symptom was a terminal chat stuck on “New chat”, never picking up the conversation’s name or its messages, and its environment chip and account were wrong for the same reason. Chats already created this way repair themselves.',
          'A notification answers the click it was shown for. The object holding that click was released as soon as the toast was on screen, so it could be collected while the notification was still sitting there — and a collected one does nothing when pressed. It happened often enough to look like the notifications were not wired up at all, and rarely enough to look random. Note that a toast left unanswered for a minute still stops responding by design: the process behind it does not wait around, and by then the app itself is the better place to answer.',
          'Switching accounts no longer carries off a terminal chat that is still running. An empty chat follows the account you pick, and “empty” was judged by messages alone — which a terminal chat has none of until its transcript catches up, often not before the run is over. So the chat you were watching was moved onto the other account mid-run, vanishing from the list you were on. A chat you have used in the terminal now stays where it is.',
          'The bar of pending chats names an account only when the chat is not on the one you are using. It used to name every account as soon as the bar held chats from more than one place, so a WSL chat beside a local one put your own account’s name on the local chat — while a lone chat on your default account went unlabelled even when you were looking at another one. WSL and remote chats still always say where they run.'
        ]
      },
      {
        title: 'Changes',
        items: [
          'The chat list can be folded away to give the panes its width: use the button beside the account at the top of the list, and press Chat in the rail — while already in Chat — to bring it back, or to hide it again. It stays the way you left it the next time Argos opens.',
          'A chat in the bar at the top of the window can be dragged onto the panes, just like a row from the chat list, to open it beside the one you are in — or in its place, dropped in the middle. That includes chats on another account, which the chat list does not show while you are on this one; the account you are typing in is still the one the sidebar follows.',
          'A chat that finishes while you are somewhere else stays in the bar at the top of the window, marked finished, until you open it. The bar used to list only chats still working, so the moment one was done it vanished — and with the notification already gone, the only way to find out what it had to say was to go looking in the chat list, possibly under another account. Open it from there, or press × to mark it read. Being on Home or Projects now counts as not looking at a chat, even one still sitting in a pane behind them.',
          'New terminal no longer guesses which folder to open in. It used to inherit one from whichever chat happened to be open, which a terminal — a CLI process that starts where it is told and cannot be moved afterwards — leaves you to discover only once it is up. It now asks first, on the same short setup screen a terminal gets when it has no folder at all. A folder that was actually named still skips the question: a project group’s “+”, “Open with Argos”, or the start box on Home. In Chat mode nothing changes, because there the folder is on show under the composer and repointing it costs nothing.'
        ]
      }
    ]
  },
  {
    version: '1.11.0',
    date: '2026-09-18',
    sections: [
      {
        title: 'Features',
        items: [
          'A new terminal asks where it should run before it starts. The row that picks the environment, folder, worktree and extra working directories only ever existed under the chat composer, which Terminal mode hides outright — so a terminal started with no chat open to inherit a folder from opened in your home directory, filed under “No folder”, with nowhere to point it. A terminal that does not know where it runs now opens on a short setup screen instead, and the CLI starts when you press Start terminal. One that already knows — a project group’s “+”, “Open with Argos”, the start box on Home, a WSL distro or a remote host — starts straight away, as before.'
        ]
      }
    ]
  },
  {
    version: '1.10.1',
    date: '2026-09-17',
    sections: [
      {
        title: 'Fixes',
        items: [
          'The terminal opens again in a chat that runs inside a WSL distro. It failed with “File not found (wsl.exe)” whenever Argos had been started by Windows at login: the terminal library resolves a bare program name itself, and hands back nothing at all when that name also happens to sit in the directory Argos was started from — which, for a program started at login, is the very directory wsl.exe lives in. Argos now gives it the full path. PowerShell chats were never affected, which is what made it look like a WSL problem.',
          'A chat that runs inside a WSL distro or on a remote host is listed under the account it was created with again, instead of under every account. It runs against the login that lives there rather than the account it carries, which is why it had been let through, but a chat started while working on one account turning up in another’s list reads as a leak between them. Opening one moves the sidebar onto its account like any other chat, and its row still says where it runs.'
        ]
      }
    ]
  },
  {
    version: '1.10.0',
    date: '2026-09-16',
    sections: [
      {
        title: 'Features',
        items: [
          'Two to four chats or terminals side by side. Drag a conversation out of the sidebar and onto the workspace: drop against the outer third of a pane to open it beside that pane, drop in the middle to open it in place. The highlight covers exactly where it will land, so the choice is visible before letting go, and a conversation already open somewhere lights that pane instead — a drop just moves focus there, because two terminals sharing one process would fight over its size forever.',
          'Dropping high or low in a pane asks for a grid instead of a column: three panes become one large pane with two stacked beside it, four become a 2×2. The vertical zones sit inside the middle band so the side zones keep the hit area they had — columns are the common case, and a grid spends the height a CLI needs for its transcript, so it is somewhere you aim rather than somewhere you land by accident. With a single pane on screen the vertical zones do not exist at all.',
          'The boundary between panes can be dragged, on both axes, and the widths are remembered. A pane cannot be squeezed below 15%. Changing how many panes there are throws the old fractions away rather than rescaling them, which would hand you widths you never chose.',
          'Ctrl/Cmd+1 to 3 focus a pane and Ctrl/Cmd+Shift+W drops the focused one from the layout. Closing a pane only removes it from the layout: the CLI keeps running and the chat stays in the sidebar, which is a different and deliberately gentler thing than the close button inside a terminal.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'Copying from a CLI running inside a WSL distro now reaches the Windows clipboard. A distro without Windows interop has no clip.exe, powershell.exe, wl-copy or xclip to reach a clipboard through, so Claude Code falls back to asking the terminal to copy for it — and that request was being parsed and dropped. It reported the text as copied, correctly from where it stood, and nothing arrived. Terminals over SSH had the same gap. Requests to READ the clipboard are still refused, because that direction would let anything printing to a terminal pull your clipboard into the session.',
          'Switching model from the command palette applies to the chat you are looking at. The palette builds its entries once and keeps them, so “Use <model>” carried whichever chat was open when the list was last built and could set the model on one you had already left.',
          'The Review panel stops being forgotten. Every pane kept its own copy of which chats have it open and wrote the whole thing back on each toggle, so with two panes open one would quietly drop the other’s entry. It survived in memory until a restart, which is what made it look random.',
          'Widths dragged in a grid layout survive a restart. They were validated against the number of panes, but they belong to tracks — four panes share two columns in a 2×2 — so every fraction a grid had saved was discarded on the way back in and the dividers reset to equal.'
        ]
      },
      {
        title: 'Changes',
        items: [
          'Terminals in the workspace panes paint on the GPU. Four CLIs streaming at once is far more work than the previous renderer was meant for. The Live view keeps the old renderer on purpose: it mounts one terminal per running process with no ceiling, and the browser caps how many GPU contexts a window may hold, so accelerating everything would start evicting them. If a context is lost anyway — a laptop waking, a GPU switching — the terminal drops back to the old renderer with its scrollback and session intact.',
          'Opening CLAUDE.md, Checkpoints or Git from a pane acts on that pane’s chat. They used to act on whichever chat was focused, which is the same thing until two are on screen.'
        ]
      }
    ]
  },
  {
    version: '1.9.5',
    date: '2026-09-16',
    sections: [
      {
        title: 'Features',
        items: [
          'A Codex conversation can be renamed, archived, moved and deleted like any other. Every one of those actions used to fail with “this conversation is no longer on disk” — the file was there, Argos simply refused to touch a transcript Codex had written. Each now goes through Codex’s own mechanism, so the CLI sees it too: the name lands in Codex’s session index, archiving moves the transcript into its archive directory, and deleting removes it. Moving is the one that works differently: Codex files a conversation by the folder recorded inside it, so moving rewrites that folder and resuming starts there — the panel says so before you confirm.',
          'Tags on a Codex conversation. They are kept by Argos rather than written into the transcript, because a Codex transcript is read back strictly and a line Argos invented could break the conversation itself — so the Codex CLI does not see them, but renaming, merging or deleting a label still reaches every conversation carrying it.',
          'The terminal has a close button in Terminal mode. There was no way out of it: closing meant picking another chat. Closing ends the terminal and drops back to the welcome pane; the chat stays in the sidebar and opening it again starts a fresh terminal.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'A project reached through a mapped WSL drive is one project again. A folder opened as X:\\home\\me\\proj and as \\\\wsl.localhost\\Ubuntu\\home\\me\\proj is the same folder, and the sidebar and Home already knew that — the Projects list did not, so it showed the same project twice, with its conversations split between the two rows.',
          'Pressing Chat in Terminal mode opens the welcome pane instead of dropping you back into a terminal left running. A terminal is a live CLI process, and landing on it at whatever prompt or half-typed command it sits on is not what the rail entry asks for. The terminal keeps running and stays one click away in the sidebar.'
        ]
      },
      {
        title: 'Changes',
        items: [
          'The Chat/Terminal switch now lives only in Settings. It sat above the Chats/Files tabs as well — the surface it was easiest to hit by accident, on a choice that decides what every chat in the app is.',
          'Connection no longer offers a Claude Code vs API key choice. Chats run under the accounts managed in Accounts, which is where that decision has actually been made for some time.'
        ]
      }
    ]
  },
  {
    version: '1.9.4',
    date: '2026-09-15',
    sections: [
      {
        title: 'Fixes',
        items: [
          'A plan limit warning fires once per window instead of on every refresh. Near or past a limit, the same “Plan limit warning” arrived every ten minutes, and in pairs once past 95% — one per threshold, word for word the same. Each window now warns once at 85% and once at 95%, a jump straight to the limit sends a single warning, and a new window starts over.',
          'Closing a chat no longer switches you to another account. The open chat decides which account the sidebar is on, and closing it opened whichever chat was first in the list — often one on a different account, so the whole sidebar moved with it. It now opens the next chat on the same account, or the welcome pane when there is none. Switching accounts only ever happens when you pick one.'
        ]
      }
    ]
  },
  {
    version: '1.9.3',
    date: '2026-09-15',
    sections: [
      {
        title: 'Features',
        items: [
          'A chat whose terminal started Claude Code without the chat’s own session id finds its way back to it. When the launch fell through to a bare claude — a CLI too old for --session-id, or a terminal started by an older build — the CLI picked an id Argos was never told, and the chat lost its title, transcript and running dot for good. Argos now matches the claude process running under that chat’s terminal and adopts its id. Local shells only, and when two sessions share one terminal it adopts neither rather than guess.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'Entering the chat view no longer creates a chat. In Terminal mode a chat is a CLI process starting in some folder, so merely passing through the view spawned a terminal nobody asked for and filled the sidebar with chats never started on purpose. A chat is created when New chat is pressed; arriving at the view shows the chat you were in, or the welcome pane. Picking an account follows the same rule.',
          'A new chat names its Claude Code session before its terminal starts. The id used to arrive a moment after the CLI had already been launched without one, so the chat could never be matched back to its session — no title, no transcript, no running dot.',
          'A new chat’s terminal no longer opens with a red “No conversation found with session ID”. The launch tried to resume the chat’s session before creating it, and a brand-new chat has nothing to resume; it now creates first and still falls back to resuming.',
          'A chat driven from the terminal shows in Home’s running list. The list only knew Argos’s own runs and dropped the matching CLI row as a duplicate, so a busy terminal chat appeared in neither half.'
        ]
      }
    ]
  },
  {
    version: '1.9.2',
    date: '2026-09-15',
    sections: [
      {
        title: 'Features',
        items: [
          'Argos works in one of two modes: Chat or Terminal. Until now “open new chats in” only chose which panel a new chat landed in, and every chat carried its own toggle on top of that — so a terminal user still had a composer, a model picker and a Quick chat the CLI decides for itself, and could be dropped back into a transcript by opening a chat from anywhere else. The switch sits above the Chats/Files tabs, and in Settings. In Terminal every chat is the CLI, with no composer and no way to flip a single chat back; in Chat the embedded terminal is not offered at all. A config that already said Terminal carries over.',
          'A prompt started outside the chat view lands in the terminal when that is the mode. Home’s start box, the tray and the quick launcher all used to post a message into a transcript and let Argos drive the run — which, in Terminal mode, meant it landed nowhere. The chat is created exactly as before, with the folder, model and account you chose, and the prompt is typed into the CLI once it is up. Once per terminal: restarting one does not silently re-run the task.',
          'The bar of chats still working says which account each is on. With runs on more than one account, or a single run on something other than the account you are using, the name was missing from the one place that lists them all.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'The bar of chats still working counts chats driven from the embedded terminal. It only knew about runs Argos itself had started, so a terminal chat was missing from exactly the strip you use to find your way back to it — even while the rail badge and the sidebar dot showed it working.',
          'A chat that runs inside a WSL distro, or on a remote host, is labelled by where it runs instead of by an account it never used. Every chat is created carrying an account id, but one running against a CLI login inside a distro is not on that account at all, and both the working-chats bar and the chat list were naming it.',
          'The chat list no longer hides a WSL or SSH chat behind the account picker. Filing those chats under the account they merely carry cut both ways: the chat vanished from every account’s list but one, and opening it dragged the whole sidebar onto that account — hiding the local chats of the account you were actually working in, on nothing more than which chat you last clicked.'
        ]
      }
    ]
  },
  {
    version: '1.9.1',
    date: '2026-09-15',
    sections: [
      {
        title: 'Fixes',
        items: [
          'The Projects list shows a project’s name and nothing else. Projects that shared a name had started arriving with a parent folder in front of it — Ubuntu/jdl, Ubuntu-DevOps/wm-project, X:/infra-automations — which made the list harder to read than the ambiguity it was solving. The distro badge beside the name, and the full path on hover, still tell two projects of the same name apart.'
        ]
      }
    ]
  },
  {
    version: '1.9.0',
    date: '2026-09-15',
    sections: [
      {
        title: 'Features',
        items: [
          'Sprints can be closed. “Complete sprint” sits in the sprint’s ⋯ menu and opens on the numbers — points and items done, what is left — then asks the only question closing a sprint really poses: where the unfinished work goes. Hand it to a sprint already on the board, roll it into a new one that starts the day after this one ended, or leave it on the record. The closed sprint keeps a Completed badge, its board turns read-only until you reopen it, and it drops to a Completed group at the bottom of the sprint switcher instead of sitting above the sprint you are actually working in.',
          'The sprint importer also fetches pending merge requests. It is now “Import from GitLab” (or GitHub) in the sprint’s ⋯ menu, with a picker for issues, merge requests, or both — pending meaning open: not yet merged or closed, drafts included. Each merge request arrives with its reference, its source → target branches, whether it is a draft, and whether it is still waiting on review, so a sprint can hold the work that is finished-but-not-landed and not only the work not started. A mixed list tags which rows are which.',
          'Imported items carry their forge reference. The card shows #481 or !49 next to the points, and the item opens with its kind, its reference and a link straight to the issue or merge request — before, the number was buried in the notes text and there was no way back to GitLab. Items imported earlier still show theirs: the reference is read back out of the notes when the field is missing.',
          'The sprint importer speaks GitHub as well as GitLab. Which one a sprint talks to comes from the project’s own git remote — including self-hosted installs on their own domains — and the forge with an MCP configured decides the rest; with both configured, the remote breaks the tie. Every noun follows: pull requests on GitHub, merge requests on GitLab, in the picker, the buttons and the item detail. One caveat the app now handles rather than hides: GitHub numbers issues and pull requests in one sequence, so a bare #49 there cannot say which it points at — imported rows have to state their kind, and one that doesn’t is kept rather than filed under a guess.',
          'Wording that said “Claude” where any provider could be running no longer does. Routines execute under whichever model you pick — Claude, Codex or Antigravity — and so do agent suggestions and the sprint board’s standup and import, but the copy and the error messages still named one of the three. The week planner’s assist keeps saying Claude, because it genuinely is Claude-only.',
          'The start box on Home offers every provider, not just Claude. It was filtered to the default provider’s models with a Claude-only account list beside them — a restriction with nothing behind it, since a chat started there runs through the same engine lookup as any other. The model pill now groups Claude, Codex and Antigravity, the account pill follows whichever provider you pick rather than offering a login that cannot run the model, and a Codex or Antigravity prompt no longer refuses to start on a signed-out Claude. Settings says which logins live where too: Connection is the Anthropic one, Accounts covers all three.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'Home stops leaving a column-wide gap down the left of the window. The columns were fixed tracks, so one with nothing in it kept its share of the width — and with nothing waiting on you and nothing running, which is the ordinary state of the view rather than a rare one, the first column was blank and everything else sat squeezed to the right of it. A column with no sections is no longer drawn, and the ones left divide the width between however many turned up.'
        ]
      }
    ]
  },
  {
    version: '1.8.0',
    date: '2026-09-14',
    sections: [
      {
        title: 'Features',
        items: [
          'Argos opens on Home. It answers the question you actually arrive with — what needs me now — across every chat at once: approvals waiting on you, chats and CLI sessions running, projects with uncommitted work, how much of the plan is left, and the last few conversations with their closing line. The chat you were in is one click away in the rail, where it always was.',
          'A place to type on the landing screen. Write the prompt and press Start; the three pills under it choose where it lands — project, model, account. The project list offers projects already opened here, plus one entry that picks a new folder.',
          'The counters in the Home header are buttons. Each jumps to the section it counts and flashes it, and says the whole sentence on hover, rather than being a number with no way through.',
          'Codex conversations appear in Projects, beside the Claude Code ones. A folder worked on with both CLIs showed half its history and hid the other half. They share the same path encoding, so one folder is one row whichever CLI wrote the transcript.',
          'Filter Projects by account. Chats from a work login, a personal one and Codex sat mixed together with nothing to tell them apart. The filter is by account, not by machine — the local machine and two WSL distros under one login are one entry — and each session says which account it came from when that tells you something.',
          'A project is called what you call it: the name you gave it, then the repository’s own name, then the folder’s. The folder here is claude-gui and the repository is argos, and until now every list said claude-gui. The Sidebar, Projects and Home all ask the same place, so a rename in one shows up in the others.',
          'The Review panel remembers being open. Whether the diff sits beside the transcript is a working preference, and reopening it on every launch was the kind of friction that teaches people not to use a feature.',
          'The Review panel says what a restore point holds. It named a checkpoint and nothing else; it now says when it was taken, how many files it covers, and answers the only question worth asking before restoring — how many files would actually change — without leaving the panel.',
          'Checks that are running are separated from checks that finished. One list showing the command running now among the last five that already ran made the live one hard to find.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'One row per project in the Projects list. The same folder was listed several times over — Claude-GUI twice, jdl three times — because a Windows path, its Git Bash spelling and the three ways to address a WSL directory all counted as different projects. The chat list had already been taught this; the project list had not.',
          'Move and delete reach every directory a project is recorded under, so “delete project” no longer leaves the project on screen. With an account filter on they reach that account’s directories and not the ones the filter is hiding.',
          'Unarchiving a project works when it is recorded more than once. Unarchiving one directory while a sibling stayed archived left the project in the Archived tab, looking like the click did nothing.',
          'A Codex session cannot be resumed by the Claude Code CLI, and Argos no longer pretends otherwise: double-click, Enter and the Resume button open the transcript for reading, and the button says why.',
          'One slow repository no longer holds every row of Home’s project list in its spinner. They resolved together or not at all, so a WSL path or a drive that had gone away left the whole list looking broken rather than partly late.',
          'Today’s spend is today’s. The daily totals were keyed off UTC, so between local midnight and UTC midnight the figure was yesterday’s.'
        ]
      }
    ]
  },
  {
    version: '1.7.1',
    date: '2026-09-09',
    sections: [
      {
        title: 'Changes',
        items: [
          'Live and Agents are not in the rail for now. Nothing about either was removed — the views are still there, still work, and the command palette still opens them — they are just not taking up a place in the rail while they are being worked on.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'One folder is one project again, this time for a folder inside WSL. The same directory reaches the sidebar three ways — `/home/me/proj` from a chat running in the distro, `\\\\wsl.localhost\\Ubuntu\\home\\me\\proj` from the Windows side, and `Z:\\home\\me\\proj` when that root is mapped to a drive letter — and every spelling opened a heading of its own, all with the same name. They fold onto the UNC one now, chosen because it is the spelling both sides can use: Windows opens it directly, and anything launched inside the distro translates it back first. So the group’s “+” gives you a chat with a working directory that exists, whichever kind of chat sat in the group before it.',
          'A chat that recorded a bare POSIX path and no distro of its own still joins its group, on the evidence of another chat in the same folder that named one. A path two distros both claim is left where it is rather than guessed at — merging two folders that are not the same folder is the worse mistake.',
          'A folder opened from inside a distro as `/mnt/c/dev/proj` now groups with the Windows chats working in `C:\\dev\\proj`, because that is the same folder — the distro is only looking at it through a mount. Two distros mounting the same drive land in the one group rather than one each. A path has to be known to be inside WSL for this: on a Linux host reached over SSH, `/mnt/c` is an ordinary mount point and is left alone.',
          'The Git Bash spelling of a Windows path joins its folder too: a chat that recorded `/c/Users/me/proj` sits with the ones that call it `C:\\Users\\me\\proj`. Only where the path says `Users` or `Windows`, which is what makes it safe to read as a drive at all — `/c/dev` could be a real directory on a real Linux machine, so it is left as one.'
        ]
      }
    ]
  },
  {
    version: '1.7.0',
    date: '2026-09-09',
    sections: [
      {
        title: 'Features',
        items: [
          'Rename a conversation from the chat list — double-click its name, or use the pencil. A chat was named once, from its first prompt, and after that you were stuck with it. When the chat has a Claude Code conversation behind it the same title is written there too, so the two never disagree.',
          'A chat that is working now says so from across the room: an accent border travels around its row in the list, amber when it is waiting on you. It reads the same registry Live sessions does, so a chat busy in its terminal — never something Argos itself was running — finally looks different from one sitting idle.',
          'A chat that answered while you were elsewhere says so: its name goes bold and an accent dot sits at the end of the row until you open it. A finished run and an idle chat used to be the same row, so the only way to find out whether the thing you walked away from had replied was to click it.',
          'The Chat entry in the rail carries a count of the chats currently running, the same badge Servers already had. It counts the ones the live registry reports busy too, so a chat working away in its terminal is included rather than only the runs Argos started itself.',
          'Name a project whatever you call it. Double-click a project heading in the chat list, or use the pencil — the folder stays claude-gui and the heading says Argos. The name is filed with the project, so it survives moving the folder and is forgotten when you forget the project.',
          'Notifications can be switched on from the panel that explains them. It used to hand you a block of JSON and leave the edit to you, which is why most people reading that panel still had no notifications. The block is still there for the WSL case and for anyone who would rather paste it, but the button writes it through the same validating merge the Hooks panel uses.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'A chat you drive from the embedded terminal is a real chat now. It used to be a ghost: the CLI invented a session id inside the pty and told nobody, so the chat stayed called “New chat” forever, none of the conversation reached Argos, and reopening it started a stranger instead of resuming. Argos now decides that id before the CLI launches, then reads the conversation back — the title Claude Code gave it, and the whole transcript, so closing the terminal leaves you looking at what was said.',
          'Live sessions stops listing sessions that ended months ago. A WSL row was shown on the strength of its registry file alone — and those files outlive the process that wrote them, so one distro here contributed forty-one rows for one running claude. Each is now checked against that distro’s own /proc, matching the recorded start time exactly so a recycled pid cannot pass for the session that used to hold it.',
          'One folder is one project again. The chat list keyed its groups by the exact path string a session recorded, so the same folder reached as claude-gui by one session and Claude-GUI by another split into two headings with the same name — on a filesystem where those are the same directory.',
          'Saving a hook no longer quietly drops the parts of it this app does not model. Anything beyond the command itself — a timeout, or whatever a later Claude Code adds — was rebuilt away every time the Hooks panel wrote, deleting settings you had put there by hand.',
          'The chat you are already looking at stops running its border animation. The travelling edge exists to catch your eye from across the list, which is not a job that needs doing on the one row already on screen.'
        ]
      }
    ]
  },
  {
    version: '1.6.0',
    date: '2026-09-09',
    sections: [
      {
        title: 'Features',
        items: [
          'Settings is a screen now, not one long modal. A list of sections down the left — Appearance, General, Connection, System, About — and Back to app returns you to whatever you were looking at, not to a new chat.',
          'A light theme and a dark theme, chosen separately. Picking Gruvbox for the evening no longer means Gruvbox at ten in the morning: each side keeps its own palette, and Mode decides which one is showing — or hands that decision to Windows.',
          'Sixteen more palettes, so thirty in all: GitHub, Codex, Catppuccin, Everforest, Gruvbox, Linear, Notion, One, Proof, Raycast, Rose Pine, Solarized, Vercel, VS Code Plus, Xcode and Absolutely. Every one of them was checked against the contrast standard in both modes rather than eyeballed, and four had their muted text darkened because it failed.',
          'Override a palette instead of settling for it. Accent, background and foreground each sit at Default until you say otherwise, and everything else follows: set a background and the whole ladder of surfaces, borders and hovers is derived from it; set a foreground and the two muted text steps come with it.',
          'A contrast slider, for a palette you like except for how close its surfaces sit. It works on a preset you have not otherwise touched, which is the whole point of it.',
          'Choose the interface font, the reading font for messages, and the font for code, each from what is actually installed — the list is filtered by measuring text, so it cannot offer you a font your machine would silently replace. Interface and code sizes are sliders in px.',
          'Both themes are previewed side by side while you edit them, in a small mock of the app itself, down to a diff in a code block. The preview of the theme you are not currently using is real: it is computed with the same maths that paints the app, not borrowed from the theme on screen.',
          'A translucent sidebar, if you want one. Be told what it is: the panel goes partly transparent over the app’s own window, which is not the Windows acrylic effect — that needs a different kind of window and may follow.',
          'When Mode follows the system, the app now actually follows it. Windows switching to dark at dusk repaints the main window, the quick launcher, the toast and the status pill — those three used to read the theme once when they opened and never look again.',
          'A Review panel in a chat, behind the ⋯ menu: what the working tree has changed, the commands this session ran and how they ended, and the restore timeline — next to the conversation they are about, and visible while a run is going. Each of those was a separate modal you could not have open at the same time as anything else.',
          'A routine that came due while Argos was closed can now run when you reopen it, instead of always being skipped. Per routine, because a five-minute poll and a daily report do not want the same answer.',
          'A remote or WSL run asks once, up front, showing the machine, the folder and the fact that per-tool approvals do not exist on that transport. Approvals for the chat you are looking at now appear inside it rather than as a window over it — including when the terminal panel is open, which is where they used to be unreachable.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'A conversation over SSH, and every remote file browse, now verifies the machine it is talking to. There was no host-key check at all: whatever answered the address was trusted, and the credentials went to it. First contact shows you the fingerprint in the same form ssh-keygen prints; a key that changes afterwards is refused outright rather than offered as a choice you could click past.',
          'Restore points stop overwriting each other. Their ids came from a counter that restarted with the app, so the first checkpoint of today took the place of the first checkpoint of yesterday.',
          'A restore can no longer delete a file it never managed to read. An unreadable file was recorded as one that did not exist, which is the same thing a snapshot says about a file you had not created yet — and restoring then acted on it. Snapshots now say which of the two it was, keep binaries intact, and a restore shows you exactly what it would write, delete or leave alone before it does anything. If the files moved under it since that preview, it asks again instead of proceeding.',
          'A scheduled run whose project folder is missing now stops and says so. It used to fall back to your home directory and run there — an unattended agent with write access, pointed somewhere nobody chose.',
          'Choosing WSL or an SSH host no longer turns off your approval prompts behind your back. The reason it did was real — those transports cannot pause at each tool — but silently flipping a permission you set is not the way to say so.',
          'A crash mid-answer no longer takes the answer with it. The transcript is written as it streams rather than at the end of a turn, each write lands whole instead of possibly truncated, and a conversation that was running when the app died reopens as interrupted rather than pretending to still be live. A save that fails now says so in the chat instead of being dropped.',
          'A terminal that fails to start says why, and which shell and folder it was trying. “Failed to start terminal.” was the entire message, whether the shell was missing, the folder was unreachable, or the saved server had been deleted.'
        ]
      }
    ]
  },
  {
    version: '1.5.0',
    date: '2026-08-31',
    sections: [
      {
        title: 'Features',
        items: [
          'A question Claude asked you mid-task, and what you picked, now read as your decision instead of as tool output. The transcript records the exchange as a tool call and its result, so it used to appear as grey machine text with nobody’s name on it — it is now a turn of yours, showing what you chose, and what you turned down one click away.',
          'If the format of those answers ever changes, the conversation falls back to the tool bubbles it showed before rather than drawing a block it half understood.',
          'Search inside a project. The box above the session list searches only the project you have open, and only prose — what you and Claude actually said. Matching every file path Claude ever touched buries the conversation you are looking for.',
          'Search across everything still reads tool calls and their output, and now says so: a hit is labelled when it came from a command, from a tool’s output, or from text the CLI injected, and the matched words are highlighted in place.',
          'Searching for a decision you made now finds the conversation you made it in. Your answer was recorded as tool output, which the narrower search excludes by design — both depths now agree that a choice of yours is yours.',
          'Tidy the project list itself. Archive a project you are done with and it drops out of the list without touching a single conversation inside it — it is a preference, not a move, and an Active / Archived switch appears once there is something in there. Delete only works on a project holding nothing at all, and it rechecks the folder at the moment you press it rather than trusting the count the list drew a moment earlier.',
          'Change a project’s folder, and its history goes with it. Nine checks run before anything is written, both renames roll back together if the second fails, and everything that named the old path is re-keyed: pins, filing, rooms, saved chats, scheduled runs, sprints, and Claude Code’s own project map. A destination on another drive is refused rather than quietly turned into a copy — half a copied project tree is worse than being told no.',
          'A project holding only archived conversations, or nothing at all, now shows up at all. The list skipped any folder with no active transcript, which is exactly the folder you would want to clear out.',
          'See which Claude Code sessions are running on this machine, including ones you never started here. The new Live view reads Claude Code’s own registry: what each session is called, the folder it is in, whether it is busy or idle, how long it has been up. A session that has not reported its state reads as unknown rather than idle, because those are different answers when you are deciding whether to interrupt it.',
          'Take over a session running outside Argos, so you can carry it on here. One conversation can only have one live claude — two on the same id interleave turns and fork the transcript. Argos asks the process to exit, never forces it, and only after proving the process is the one the registry names: same pid space, still running, and started at the exact moment recorded for it. A session inside a WSL distro is listed but never signalled, because that pid number belongs to an unrelated process on this side.',
          'A Terminals tab in the same view shows the terminals Argos is holding, several at a time.',
          'Right-click now works in the app’s own text fields — cut, copy, paste, select all — and over selected text anywhere, so a passage of a conversation can be copied out. Electron ships no such menu; the app simply never had one.',
          'Images you paste into a chat stay in the conversation. They were sent to the model and then vanished from the transcript, which had nowhere to keep one. A thumbnail is stored rather than the original, for the same reason attached files keep only their names: the session file is rewritten on every message.'
        ]
      },
      {
        title: 'Fixes',
        items: [
          'Ctrl+V works again — everywhere. It had stopped working in every field in the app: the composer, settings, every filter box. The application menu deliberately carries no Edit entries, because the paste one also binds Ctrl+V and fired a second paste on top of the terminal’s own — and nobody noticed those entries were the only thing making the key work anywhere else. Ctrl+A, Ctrl+C and Ctrl+X had gone the same way and are back too.',
          'Paste into a terminal, by keyboard or right-click, once. It had been arriving twice on Windows, for a reason that turned out to have nothing to do with Argos: the CLI running inside the terminal answers a right-click by pasting the clipboard itself, so both of us did it. It looked like a Windows-only problem only because the WSL distro it was compared against could not reach the Windows clipboard at all, so the CLI’s half failed silently there.',
          'Pasting text into a local terminal no longer arrives wrapped in stray markers. Those markers are what stop a multi-line paste being run line by line, and a real shell needs them — but a local Windows terminal does not consume them, so they came back out as input.',
          'Paste an image into a chat from a file, not just from a screenshot. A .png copied in Explorer arrives with no type attached, and was being sent down the text path where the extension list rejected it as binary — in a box that offers to take images. And a paste that cannot be used now says so instead of doing nothing at all, which is what made this take so long to spot.',
          'Paste an image into a WSL chat with Alt+V. Inside a distro the CLI cannot reach the Windows clipboard, so Argos writes the image into the distro itself and hands the CLI the path.',
          'The colour palettes in Settings are now checked against the stylesheet that defines them, so a swatch cannot drift from the palette it names, and a palette added to the app cannot go missing from the picker. There are fourteen of them, which is the argument for testing it.'
        ]
      }
    ]
  },
  {
    version: '1.4.0',
    date: '2026-08-27',
    sections: [
      {
        title: 'Features',
        items: [
          'Any Claude Code session on this machine can now notify you, not just the ones started here. Wire up Claude Code’s Notification hook and a session waiting on a permission — in a console, in an editor, anywhere — says so by name: [project] conversation. Clicking the notification opens that conversation in Argos, and starts the app if it was closed.',
          'Settings → Session notifications shows the block to paste into ~/.claude/settings.json, with a copy button and a variant for sessions running inside WSL. Argos shows it and never writes it: that file is yours, and it holds far more than this one hook.',
          'Claude Opus 5 is in the model picker, and new chats now start on Sonnet 5 instead of Sonnet 4.6. Chats you already have keep whatever model you picked for them.',
          'The model list keeps itself current. On launch the app asks Anthropic\'s own model endpoint and the installed Codex CLI what exists, so a model released after this build shows up on its own — with its real name and context window, marked "new" because prices are not something either source publishes.',
          'Discovery no longer needs an API key. It uses whatever credentials you are already signed in with, which previously meant anyone logged in the normal way got no discovery at all.',
          'What discovery finds is remembered between launches, so opening the app offline still lists everything you saw last time instead of quietly falling back to the models baked into the build.',
          'A price you set yourself in models.json is now used for cost, not just for the label in the picker.',
          'Chats run with Claude Code\'s own instructions again, in the form that stays cached. They were running on tool definitions alone, and the working-directory and git-status lines that used to sit inside the cached prompt now travel outside it — so editing a file no longer throws away part of the cache and makes the next turn re-send it.',
          'Cost is no longer understated. Cached context is written with a one-hour lifetime, which costs twice the input rate rather than the 1.25× the app was charging it at, so every figure in Usage was low by about a third.',
          'Fixed: the close button on a chat in the sidebar sat in the middle of the row instead of at its right edge, and the model badge with it. The new sessions list in Projects had claimed a CSS class name the sidebar already used, which turned every chat row into a five-column grid.',
          'Archive, rename, move and delete a conversation, from the preview panel. Archiving moves the transcript into an archived folder inside the project, and an Active / Archived switch shows what is in there — it is where the file sits, not a flag, so it survives the app. Deleting is behind a confirmation that names the conversation and how many messages go with it.',
          'Renaming writes the same line that /rename writes in Claude Code, so a name set here shows up there and one set there shows up here. Argos was ignoring names set in the CLI until now.',
          'Moving a conversation to another project is filing only. Where it ran is recorded inside the transcript and is never rewritten, so resuming still lands in the right folder.',
          'What a conversation "started with" is now what you typed, not what the CLI put in your channel. A loaded skill records its whole body as if you had written it, and that was showing up as the opening line of the conversation — as were pasted images and background-task notices.',
          'Clicking a conversation now shows you what it was, instead of reopening it. A panel on the right gives the model, length, cost and tags, what the conversation started with, and — the part that actually decides it — where it left off. Resume is a button in that panel, or Enter; arrow keys walk the list with the panel following it.',
          'The project sidebar is two lines per project instead of four. The folder path and the account moved into the tooltip: repeated down twenty rows they were the loudest thing in the column. Pin the projects you live in with the star and they stay at the top, and there is a filter box for the rest.',
          'The sessions list is a list again. A grid of cards suits a dozen conversations; these projects run to fifty and more, where the title is the signal and everything else is a column you compare down. Rows put the model, the length and the age in alignment, so which one is long and what ran on which model read without reading each item.',
          'Conversations are banded by date — Today, Yesterday, Last 7 days, and so on — and you can order them by newest, by title, or longest first. The ordering is remembered.',
          'Renaming or tagging a conversation no longer floats it to the top of the list. The list is ordered by when the conversation last had a message in it, not by when the file was last written, and both of those write a line to the file.',
          'Session titles and previews no longer show the plumbing of the CLI. A conversation that opened with a slash command used to be titled with the markup of that command — <local-command-caveat> and friends, on 14 of 52 sessions in one real project. The wrappers are stripped and the first thing you actually typed is shown instead.',
          'A preview that tells you nothing is now hidden. If the same opening line appears on three or more conversations in a project it is a command being re-run, not a subject — in one project that was 33 of 52 cards all reading "Review this change for security vulnerabilities". Previews that only restate the title go too, punctuation and a leading "lets" included.',
          'Tag your conversations. Each session takes coloured tags, and the sessions list filters by them with an ANY/ALL switch. A tag is stored inside the conversation itself — the same place the CLI keeps a renamed title — so it stays with the conversation, is visible to Claude Code, and nothing is ever overwritten to save one.',
          'A Labels button in Projects manages the vocabulary: pick a colour, rename a label everywhere at once, merge two that mean the same thing, or remove one from every conversation. Anything destructive tells you how many conversations it touches first, and renaming onto a name that already exists offers a merge rather than quietly doing one.',
          'Big conversations no longer freeze the window. Opening Projects, searching, or loading Usage used to read each transcript into memory in one go — on a long conversation that stalled everything, the sidebar and the terminal included. They are now read a line at a time, and working out which folder a project belongs to stops at the first line that says so instead of reading the whole file.',
        ],
      },
    ]
  },
  {
    version: '1.3.0',
    date: '2026-08-12',
    sections: [
      {
        title: 'Features',
        items: [
          'Remote & WSL has been rebuilt. Every distro and host is one line instead of a tall card, in a column that no longer stretches its buttons to the far edge of a wide window. There is a filter box and an All / WSL / SSH switch, hidden distros collapse to a single line rather than a card each, and clicking anywhere on a row connects to it.',
          'Each target carries a live status dot: green with a halo while a session on it is connected, plain green when it is running or has answered, and a neutral dot when it simply is not up — connecting will start it. Only something that actually failed turns it red.',
          'Test is now two separate things. "Test connection" answers whether the box is up — it opens an SSH connection, or starts the distro, and tells you how long that took. "Check Claude Code" is the old probe, and it no longer colours the status dot: a missing CLI says nothing about whether the machine is reachable.',
          'Several sessions on the same server or distro at once. Connect opens another one every time you press it; the tab strip folds them into a single tab carrying the host name and a count, with the sessions themselves in a dropdown, so the strip never grows as you pile them up.',
          'Open sessions are visible from anywhere. The tab strip now also appears on the Remote & WSL and MCP screens, and the Servers icon in the sidebar carries a badge with how many sessions you have running.',
          'Terminals have proper colour. All sixteen ANSI colours are now set instead of falling back to xterm\'s washed-out defaults, so build logs, `ls` and deprecation warnings read the way they do in Windows Terminal — on the app\'s own warm background rather than a cold black one.',
          'Right-click in a terminal pastes, or copies when there is a selection. Shift+right-click opens a menu with Copy, Paste, Select all and Clear.',
          'A New file button in the file browser for both SSH and WSL sessions. It refuses to overwrite something that is already there, and drops you into the editor once the file exists.',
          'SSH keys have moved off the Remote & WSL screen to their own page behind the key button in the header, and the long `authorized_keys` command that used to fill each row is now "Copy install command" in the row\'s menu.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Pasting into a terminal no longer duplicates or garbles what you pasted. Ctrl+V was being handled three times over — once by the app, once by the terminal itself, and once by an invisible Edit menu — which arrived as the same text twice, one copy raw and one bracketed.',
          'Testing an SSH host with no Claude Code installed used to report success, with "command not found" as the message. It now says the CLI is missing and gives you the command to install it.',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-08-11',
    sections: [
      {
        title: 'Features',
        items: [
          'The chat screen is a lot calmer. The header bar is gone — the chat\'s name now sits at the top of the conversation and scrolls with it, and the terminal and ⋯ buttons float quietly over the transcript until you reach for them.',
          'Everything about how a chat runs now lives in one row under the composer: environment, folder, branch, worktree, extra directories, model, and the approve and light-mode toggles. Cost and context are stated once, at the bottom right, instead of in three places at once.',
          'Chats in the sidebar are grouped by project. Each group has a "+" that starts a chat already pointed at that folder, groups remember whether you left them open, and a long project stops at five chats behind a "Show more" so it cannot crowd out everything else.',
          'New chat and Quick chat are proper labelled rows at the top of the sidebar rather than two unlabelled icons, and landing on a new chat sweeps a band of light across the composer and puts the caret in it, so the jump has somewhere to look.',
          'The file editor grew up: line numbers, syntax highlighting, find and replace (Ctrl+F / Ctrl+H) with a match count and wraparound, a word-wrap toggle it remembers, and a status bar showing line and column, language, size and whether there are unsaved changes. Ctrl+S saves, and Tab now indents instead of jumping out of the file.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Pressing New chat repeatedly no longer leaves a stack of identical empty chats in the sidebar. An untouched chat is the new chat, so it gets reused — and pointed at whichever project you started it from.',
          'A chat that opens on the terminal pane is no longer counted as used the moment it appears. It counts once you actually type into the terminal, which is also what keeps it out of the sidebar until then.',
          'The file editor no longer throws away unsaved edits when you click outside it. It asks first.',
          'Where a chat runs is now visible for the whole conversation. The folder, branch, worktree and extra directories used to vanish the moment you sent your first message, leaving no way to see or change them.',
          'The composer no longer says "Message Claude" when the chat is running on Codex or Gemini.',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-07-28',
    sections: [
      {
        title: 'Fixes',
        items: [
          'Opening a new chat that defaults to the terminal no longer flashes the folder/project picker screen first — it now lands straight on the terminal.',
          'Updates now install silently in the background instead of popping up the NSIS installer window.',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-07-25',
    sections: [
      {
        title: 'Features',
        items: [
          'The app is now called Argos. Your chats, account logins, SSH hosts, sprints and checkpoints are imported automatically on first launch — nothing to move by hand. The previous data is left untouched, so the old build still works if you need to go back.',
          'Set up a new chat before you send — a config row above the composer lets you pick the environment (Local, a WSL distro, or an SSH host), choose the project folder, see the git branch, and add extra working directories, all in one place.',
          'Run a chat in a throwaway git worktree — flip "Worktree" on a local repo and the chat works inside a fresh `claude/…` branch checked out beside your repo, so its edits never touch your current branch.',
          'Extra working directories — add folders beyond the project root and the engine can read and write across all of them (Claude Code `--add-dir`).',
          'Pick a folder for WSL and remote chats too — WSL opens the native picker straight into the distro\'s filesystem, and SSH hosts take a typed working directory that overrides the host default.',
          'Remote hosts: Connect opens a full SFTP file browser, interactive terminal, and command history for any SSH host.',
          'Servers: Remote & WSL is now the default tab; open remote/WSL sessions stay connected in the background and can be run several at once via tabs.',
          'Chats keep working in the background — leave a chat mid-task, switch to another one or to another view, and its request and terminal carry on. Coming back reattaches to the live terminal and repaints everything it printed while you were away.',
          'Pending requests bar — a strip at the top of the window lists the chats still working, with a click to jump straight to one (and a mark when it is waiting on your approval). Dismiss any entry you would rather not see; it only hides the entry, the chat keeps running and reappears on its next request.',
          'Open project files in the Files tab — clicking a file in the sidebar opens it in the same editor the remote sessions use, so you can read and edit it without leaving the app.',
          'Leaving and returning to Chat, or picking a different account, now lands on a new chat instead of reopening whatever was last active.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Chats run under a non-default account now show up in Projects and Resume — their transcripts live under the account\'s own config dir and were previously invisible even though they were on disk.',
          'A chat driven entirely from the embedded terminal (no messages sent through the composer) now stays in the sidebar and is saved to disk, instead of being treated as a blank draft and dropped.',
          'WSL chats now start in the folder you picked — the `\\\\wsl.localhost\\…` path from the picker is translated to the distro\'s Linux path before the run, instead of silently falling back to your home directory.',
        ],
      },
    ],
  },
  {
    version: '0.6.1',
    date: '2026-07-24',
    sections: [
      {
        title: 'Features',
        items: [
          'Choose the account and model for the sprint\'s AI actions — a "Run with" picker in the standup header spans Claude, Codex and Antigravity; Generate and the GitLab backfill now run under the account you pick (previously they were locked to the Claude default).',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'WSL distros no longer disappear from Projects and Usage — a distro\'s home is now resolved without running its login shell, which on some setups hung on a sudo password prompt from service-start scripts. All of a distro\'s Claude Code sessions are counted again, not just a handful.',
          'The terminal loader now stays up until the CLI has actually drawn its interface, instead of briefly flashing a black screen during the CLI\'s cold start.',
          'Generated standups are now grounded in your git commits rather than the sprint board — on days with nothing in progress on the board they describe what you actually worked on instead of saying the board is empty.',
          'The standup "Today" button sits to the left of the date arrows, so stepping through days no longer nudges the arrows around.',
        ],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-07-23',
    sections: [
      {
        title: 'Features',
        items: [
          'Multiple Codex accounts — add, name, rename and remove separate Codex logins just like Claude ones. Each account gets its own isolated CODEX_HOME, so switching accounts switches the login used by chats, the embedded terminal, and MCP-enabled runs.',
          'The sidebar account picker now spans all three providers — Claude, Codex and Gemini accounts are grouped in one menu. Picking an account switches the whole sidebar onto it — its chat history and usage — and opens your most recent chat there (or a fresh one), also switching the default model to that provider so new chats use it.',
          'The chat list is scoped to the selected provider and account, so each login gets its own history. "Explore all chats" jumps to Projects to browse everything across accounts.',
          'Per-account plan usage — the usage badge tracks the account you have selected. Every Claude account shows its own 5h-window percentage inside the picker, and Codex accounts now show theirs too, read live from the Codex CLI.',
          'Gemini runs through Antigravity, managed from its own section in the accounts modal.',
          'Model catalog is now built at launch: bundled defaults, a user-writable models.json override, and best-effort discovery from the installed Codex CLI (and, when an API key is present, the Anthropic models API). Models found by discovery show a "new" badge instead of invented pricing. Sonnet 5 is now in the catalog.',
          'New chats can open straight into the terminal panel — Settings → Appearance → "Open new chats in".',
          'The project instructions editor follows the chat\'s provider, opening AGENTS.md for Codex and GEMINI.md for Gemini instead of always CLAUDE.md.',
        ],
      },
      {
        title: 'Improvements',
        items: [
          'The embedded terminal shows a loader while the CLI starts up, with the shell banner, launch command, and any resume handling kept hidden — so you only ever see the CLI itself. Local chats launch the CLI directly (no shell in between); inline font-size controls remain.',
          'Quick chat now picks the cheapest model of whichever provider you are on, rather than always Haiku.',
          'The account menu is rendered in a portal, so the sidebar\'s overflow and the nav rail can no longer clip it.',
          'Tightened spacing throughout the accounts modal and removed its stray leading divider.',
          'Faster cold start — the renderer bundle is split so the initial load is much lighter, with heavier views fetched on demand.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Command text in the approval popup was nearly invisible on light palettes — it hardcoded a pale green on a near-white background. It now uses theme tokens, has proper padding, and wraps long commands instead of overflowing.',
          'Chat terminal no longer flashes a spurious "process exited" line and a bare shell on open — a duplicate pty spawned by React\'s dev double-mount is now reused instead of being killed and recreated.',
          'The embedded terminal now opens the shell that matches the chat\'s environment — local, WSL, or an interactive SSH session for remote chats — and launches the right provider CLI inside it, with a clear message if a CLI can\'t be found instead of a bare shell.',
          'Codex chats that never had an account set now run on — and are listed under — the Codex account you have selected, instead of silently falling back to the machine default.',
          'When a Claude session can\'t be resumed, the terminal quietly starts a fresh session in the same folder instead of erroring out.',
        ],
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-07-20',
    sections: [
      {
        title: 'Features',
        items: [
          'Sprint mode in the Planner — a Week/Sprint toggle adds a Scrum board with a drag-and-drop To do / In progress / Done kanban, story points, a points burndown chart, and a daily standup log Claude can draft from your recent git commits and board.',
          'Backfill a sprint backlog from GitLab — the board reads open issues through your project’s configured GitLab MCP (local or inside WSL), first showing which project it’s attributed to, then letting you pick which issues to import as backlog items.',
          'Discuss or schedule your standup — talk through the day in a light, tools-off chat seeded with the standup and board, or one-click create a daily standup routine (read-only, starts disabled) from the sprint.',
          'Sprint board interactions — item checkboxes step through To do → In progress → Done (un-checking Done restores the previous state), each column has a check-all to advance its items, and the GitLab backfill caches its last result so re-opening is instant and only surfaces issues not already on the board.',
          'Conversation branching — fork a chat from any message into a new session; copied history stays visible and context carries over automatically.',
          'Attach any text file to a message via drag-and-drop or the attach button (up to 5 files, 200 KB each); contents ride along with the prompt.',
          'SSH key management in Remote & WSL — discover keys in ~/.ssh, copy public keys with a ready authorized_keys one-liner, generate ed25519 keys, and pick a key per host.',
          'Rooms can be renamed inline and reordered, with layout persisted across restarts.',
          'Context indicator under the chat input shows the real token footprint re-sent each turn, with amber/red escalation as it grows.',
        ],
      },
      {
        title: 'Improvements',
        items: [
          'The long-session warning now triggers on the actual context size (~120k tokens) instead of message count.',
          'Chats no longer load global plugin/skill marketplaces into context — only project settings and per-project permission allowlists; light mode is fully isolated.',
          'Background utility calls (compact, planner assist, agent suggestions) run with no settings tiers at all, cutting their token overhead.',
          'Startup window color follows the configured theme, removing the dark flash on launch for light-theme users.',
          'Plan-usage badge refreshes immediately after switching the default account.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Component stylesheets no longer leak into each other — shared primitives (modals, buttons, inputs, toggles) moved to one canonical stylesheet and all accidental class-name collisions were removed.',
        ],
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-07-09',
    sections: [
      {
        title: 'Features',
        items: [
          'Account selection is now app-wide — switching an account sets the default for all new chats; existing sessions stay bound to the account that created them.',
          'Sidebar status row doubles as the default-account picker when multiple accounts are connected (chevron + dropdown, keyboard & outside-click dismiss).',
          'Nav rail consolidated — Agents, Planner and Servers are each grouped under a single rail entry with a segmented sub-nav.',
          'One-click restart button appears in the status bar once an update has been downloaded.',
        ],
      },
      {
        title: 'Improvements',
        items: [
          'Chat toolbar decluttered — tool calls collapsed into a single summary chip; model picker moved to a compact toggle group.',
          'Chat transcript and input aligned to a fixed 820 px reading column.',
          'Flat opaque surfaces replace the acrylic glass aesthetic for better contrast and readability.',
          'Session cards, activity log and corner radii polished throughout.',
          'Plan session badge on the sidebar now tracks the default account rather than a hardcoded primary key.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Account pill shows the account name only; email / plan live in the tooltip so the row never ellipsises.',
          'Sidebar account row CSS class collision with AccountsModal resolved.',
          'JSON files with a UTF-8 BOM are now read correctly.',
          'Usage chip in the chat header counts only input + output tokens.',
        ],
      },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-06-18',
    sections: [
      {
        title: 'Fixes',
        items: [
          'Claude binary path now resolves correctly in packaged (Electron) builds.',
          'Installer artifact renamed with a dash so latest.yml matches the uploaded asset.',
        ],
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-06-10',
    sections: [
      {
        title: 'Features',
        items: [
          'Agent Rooms — drag agents onto a shared canvas and deploy them together.',
          'Inline approval reviews — amber chips in Rooms let you approve or reject tool calls without leaving the view.',
          'Agent suggestions — the Agents view surfaces agents found in your recent session history.',
          'Concurrent agent runs with per-session state tracking and status dots in the sidebar.',
          'Chat search — filter sessions by keyword directly in the sidebar.',
          'Markdown export — copy or save any chat as a clean Markdown file.',
          'Rich tool-call rendering — file diffs, bash output and web results get dedicated UI cards.',
          'Explorer context menu, --folder CLI flag and Windows Jump List integration.',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-05-20',
    sections: [
      {
        title: 'Features',
        items: [
          'Multi-account support — add, rename and remove Claude accounts from the Accounts manager.',
          'Planner view with task board and scheduled runs.',
          'MCP server manager — add and configure Model Context Protocol servers.',
          'Remote execution view for cloud-hosted agent runs.',
          'Git integration modal — commit, diff and branch controls inside the app.',
          'Checkpoints — save and restore session state at any point in a conversation.',
          'Auto-approve toggle for unattended agent runs.',
        ],
      },
    ],
  },
]

export default function ChangelogModal({ onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Changelog">
      <div className="modal changelog-modal" ref={dialogRef}>
        <div className="modal-header">
          <h3>What's new</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close changelog">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body changelog-body">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="cl-entry">
              <div className="cl-entry-header">
                <span className="cl-version">v{entry.version}</span>
                {entry.tag && (
                  <span className={`cl-tag cl-tag-${entry.tag}`}>
                    {entry.tag === 'new' ? 'Unreleased' : 'Latest'}
                  </span>
                )}
                <span className="cl-date">{entry.date}</span>
              </div>

              {entry.sections.map((section) => (
                <div key={section.title} className="cl-section">
                  <div className="cl-section-title">{section.title}</div>
                  <ul className="cl-list">
                    {section.items.map((item, i) => (
                      <li key={i} className="cl-item">{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
