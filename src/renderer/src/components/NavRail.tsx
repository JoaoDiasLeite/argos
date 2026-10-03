import './NavRail.css'

/**
 * Every view, as a runtime value — and the type derived from it, not beside it.
 *
 * It was the other way round once: a `View` union here, and a second hand-written
 * list in App.tsx that deep links were validated against. Adding a view to the union
 * and the rail left it unreachable from a notification click, and nothing said so —
 * the type checker cannot see a missing entry in a list of string literals it is not
 * the source of. Deriving the type from the array is what makes the two impossible
 * to disagree.
 */
export const ALL_VIEWS = [
  'home',
  'chat',
  'projects',
  'planner',
  'usage',
  'mcp',
  'remote',
  'remote-session',
  'ops',
  // A runbook's workspace, opened from the Ops list — an extra of the Servers group, like
  // 'remote-session'. Reached by deep link it has no runbook to show and falls back to
  // the list (see App.tsx).
  'ops-workspace',
  // A full screen rather than a modal, so it is a view like any other — and being in
  // this list is what makes it reachable from a deep link. It is deliberately absent
  // from RAIL below: its entry lives at the bottom of the rail, next to Changelog,
  // where users already look for it.
  'settings'
] as const

export type View = (typeof ALL_VIEWS)[number]

interface Props {
  view: View
  onChange: (view: View) => void
  onSettings: () => void
  /** The chat list is collapsed. Pressing Chat while in Chat toggles it (see App.tsx's
      goToView), and the entry's tooltip says so. */
  chatListHidden?: boolean
  /** Open Remote/WSL sessions — surfaced as a badge on the Servers entry so they
      stay discoverable from anywhere in the app. */
  serverSessionCount?: number
  /** Chats currently running (Argos's own runs plus any the live registry reports
      busy) — the same badge as Servers, on the Chat entry, so a run finishing in a
      chat you've navigated away from is still visible from anywhere in the app. */
  chatRunningCount?: number
  /** Approvals waiting across all sessions — badged on the Home entry so the app's
      landing point always shows whether something needs attention. */
  attentionCount?: number
  /** Interventions whose CLI is running (a pty outlives the Ops workspace), pipped on the
      Servers entry so one left running is visible from anywhere in the app. */
  opsRunningCount?: number
  /** One of them is waiting on an approval: the pip turns to the warning colour. */
  opsNeedsYou?: boolean
}

const ICONS: Record<string, JSX.Element> = {
  home: <path d="M3 11.5 12 4l9 7.5M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />,
  chat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  projects: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  planner: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <path d="M8 14h.01M12 14h4M8 18h4" />
    </>
  ),
  usage: (
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ),
  mcp: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </>
  ),
  remote: (
    <>
      <path d="M5 9l-3 3 3 3M19 9l3 3-3 3M14 4l-4 16" />
    </>
  ),
  // A clipboard with a checklist: a runbook is a list of steps someone signs off on.
  ops: (
    <>
      <rect x="5" y="4" width="14" height="18" rx="2" />
      <path d="M9 2h6v4H9z" />
      <path d="m8.5 12 1.5 1.5 3-3M8.5 17.5h7" />
    </>
  )
}

// A group bundles several views under one rail entry. Exported so App.tsx can
// derive the active group and render the segmented sub-nav for its members.
export interface ViewGroup {
  key: string
  label: string
  members: View[]
  /** Views that belong to the group but get no sub-nav button of their own — they're
      reached from within a member (e.g. a Remote/WSL session opened from the list).
      Kept out of `members` precisely because `members` drives the sub-nav buttons. */
  extras?: View[]
}

/** Whether `view` is shown under this group — a sub-nav member or one of its extras. */
export function groupOwnsView(group: ViewGroup, view: View): boolean {
  return group.members.includes(view) || (group.extras?.includes(view) ?? false)
}

export const VIEW_GROUPS: ViewGroup[] = [
  { key: 'servers', label: 'Servers', members: ['remote', 'ops', 'mcp'], extras: ['remote-session', 'ops-workspace'] }
]

// A rail entry is either a standalone view or a group of views. Groups use the
// icon of their first member.
type RailEntry =
  | { kind: 'single'; view: View; label: string }
  | { kind: 'group'; group: ViewGroup }

const RAIL: RailEntry[] = [
  { kind: 'single', view: 'home', label: 'Home' },
  { kind: 'single', view: 'chat', label: 'Chat' },
  { kind: 'single', view: 'projects', label: 'Projects' },
  { kind: 'single', view: 'planner', label: 'Planner' },
  { kind: 'single', view: 'usage', label: 'Usage' },
  { kind: 'group', group: VIEW_GROUPS[0] }
]

export default function NavRail({
  view,
  onChange,
  onSettings,
  serverSessionCount = 0,
  chatRunningCount = 0,
  attentionCount = 0,
  opsRunningCount = 0,
  opsNeedsYou = false,
  chatListHidden = false
}: Props) {
  return (
    <div className="nav-rail">
      <div className="nav-items">
        {RAIL.map((entry) => {
          if (entry.kind === 'single') {
            return (
              <button
                key={entry.view}
                className={`nav-item ${view === entry.view ? 'active' : ''}`}
                onClick={() => onChange(entry.view)}
                title={
                  entry.view === 'chat' && view === 'chat'
                    ? `${chatListHidden ? 'Show' : 'Hide'} the chat list`
                    : entry.label
                }
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS[entry.view]}
                </svg>
                <span className="nav-item-label">{entry.label}</span>
                {entry.view === 'chat' && chatRunningCount > 0 && (
                  <span
                    className="nav-item-badge live"
                    aria-label={`${chatRunningCount} chat${chatRunningCount === 1 ? '' : 's'} running`}
                  >
                    {chatRunningCount}
                  </span>
                )}
                {entry.view === 'home' && attentionCount > 0 && (
                  <span
                    className="nav-item-badge warn"
                    aria-label={`${attentionCount} approval${attentionCount === 1 ? '' : 's'} waiting`}
                  >
                    {attentionCount}
                  </span>
                )}
              </button>
            )
          }
          const { group } = entry
          // Extras count as active so the entry stays lit while, say, a Remote/WSL
          // session is showing.
          const active = groupOwnsView(group, view)
          // Clicking a group jumps to its first member — unless a *member* is already
          // showing, in which case it's a no-op. Note the deliberate `members` (not
          // `active`) test: from an extra view the click is the way back to the list.
          const onClickGroup = () => {
            if (!group.members.includes(view)) onChange(group.members[0])
          }
          return (
            <button
              key={group.key}
              className={`nav-item ${active ? 'active' : ''}`}
              onClick={onClickGroup}
              title={group.label}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {ICONS[group.members[0]]}
              </svg>
              <span className="nav-item-label">{group.label}</span>
              {group.key === 'servers' && (serverSessionCount > 0 || opsRunningCount > 0) && (
                <span
                  className={`nav-item-badge${opsRunningCount > 0 ? (opsNeedsYou ? ' warn live' : ' live') : ''}`}
                  aria-label={[
                    serverSessionCount > 0
                      ? `${serverSessionCount} open session${serverSessionCount === 1 ? '' : 's'}`
                      : null,
                    opsRunningCount > 0
                      ? `${opsRunningCount} intervention${opsRunningCount === 1 ? '' : 's'} running${opsNeedsYou ? ', one waiting for you' : ''}`
                      : null
                  ]
                    .filter(Boolean)
                    .join(', ')}
                >
                  {serverSessionCount > 0 ? serverSessionCount : opsRunningCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="nav-bottom">
        <button
          className={`nav-item ${view === 'settings' ? 'active' : ''}`}
          onClick={onSettings}
          title="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="nav-item-label">Settings</span>
        </button>
      </div>
    </div>
  )
}
