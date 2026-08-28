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
  'chat',
  'projects',
  'live',
  'agents',
  'rooms',
  'planner',
  'scheduled',
  'usage',
  'mcp',
  'remote',
  'remote-session'
] as const

export type View = (typeof ALL_VIEWS)[number]

interface Props {
  view: View
  onChange: (view: View) => void
  onSettings: () => void
  onChangelog: () => void
  /** Open Remote/WSL sessions — surfaced as a badge on the Servers entry so they
      stay discoverable from anywhere in the app. */
  serverSessionCount?: number
}

const ICONS: Record<string, JSX.Element> = {
  chat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  projects: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  // A pulse: the view is about what is running right now, and a heartbeat says that
  // without borrowing the terminal glyph the Servers group already owns.
  live: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  agents: (
    <>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4M8 16h.01M16 16h.01" />
    </>
  ),
  rooms: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="12" y2="12" />
      <path d="M7 12v6M17 3v9" />
    </>
  ),
  planner: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <path d="M8 14h.01M12 14h4M8 18h4" />
    </>
  ),
  scheduled: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 12" />
      <path d="M5.5 5.5A7 7 0 0 1 19 12" strokeDasharray="3 2" />
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
  { key: 'agents', label: 'Agents', members: ['agents', 'rooms'] },
  { key: 'planner', label: 'Planner', members: ['planner', 'scheduled'] },
  { key: 'servers', label: 'Servers', members: ['remote', 'mcp'], extras: ['remote-session'] }
]

// A rail entry is either a standalone view or a group of views. Groups use the
// icon of their first member.
type RailEntry =
  | { kind: 'single'; view: View; label: string }
  | { kind: 'group'; group: ViewGroup }

const RAIL: RailEntry[] = [
  { kind: 'single', view: 'chat', label: 'Chat' },
  { kind: 'single', view: 'projects', label: 'Projects' },
  { kind: 'single', view: 'live', label: 'Live' },
  { kind: 'group', group: VIEW_GROUPS[0] },
  { kind: 'group', group: VIEW_GROUPS[1] },
  { kind: 'single', view: 'usage', label: 'Usage' },
  { kind: 'group', group: VIEW_GROUPS[2] }
]

export default function NavRail({ view, onChange, onSettings, onChangelog, serverSessionCount = 0 }: Props) {
  return (
    <div className="nav-rail">
      <div className="nav-logo">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M8 12h8M12 8v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>

      <div className="nav-items">
        {RAIL.map((entry) => {
          if (entry.kind === 'single') {
            return (
              <button
                key={entry.view}
                className={`nav-item ${view === entry.view ? 'active' : ''}`}
                onClick={() => onChange(entry.view)}
                title={entry.label}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS[entry.view]}
                </svg>
                <span className="nav-item-label">{entry.label}</span>
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
              {group.key === 'servers' && serverSessionCount > 0 && (
                <span
                  className="nav-item-badge"
                  aria-label={`${serverSessionCount} open session${serverSessionCount === 1 ? '' : 's'}`}
                >
                  {serverSessionCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="nav-bottom">
        <button className="nav-item" onClick={onChangelog} title="What's new">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <span className="nav-item-label">Changelog</span>
        </button>

        <button className="nav-item" onClick={onSettings} title="Settings">
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
