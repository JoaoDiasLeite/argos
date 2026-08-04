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
    version: '1.1.0',
    date: '2026-07-28',
    tag: 'latest',
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
