import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** One open Remote/WSL session, as far as the tab strip cares — App.tsx's richer
    ServerSession (which also carries the RemoteTarget) is structurally compatible. */
export interface ServerTabItem {
  id: string
  /** The target this session belongs to. Sessions sharing one collapse into a single tab. */
  groupKey: string
  /** The target's name — the same for every session in a group. */
  title: string
}

interface Props {
  sessions: ServerTabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Opens another session on an already-grouped target (the dropdown's "New session"). */
  onAddToGroup: (groupKey: string) => void
  /** Rendered under the Servers sub-nav rather than as the session layer's own top
      strip: drops the drag region (the sub-nav above it owns that) — see views.css. */
  inline?: boolean
}

interface TabGroup {
  key: string
  title: string
  sessions: ServerTabItem[]
}

/** Group by target, keeping first-opened order for both the groups and their members. */
function groupSessions(sessions: ServerTabItem[]): TabGroup[] {
  const groups: TabGroup[] = []
  for (const s of sessions) {
    const existing = groups.find((g) => g.key === s.groupKey)
    if (existing) existing.sessions.push(s)
    else groups.push({ key: s.groupKey, title: s.title, sessions: [s] })
  }
  return groups
}

/**
 * A target with several sessions open: ONE tab carrying the host name and a count, with the
 * individual sessions in a dropdown. The strip therefore never grows as you open more
 * sessions on the same box — which is the whole point over bracketing sibling tabs inline,
 * where the host name ended up repeated on every one.
 */
function GroupTab({
  group,
  activeId,
  onSelect,
  onClose,
  onAdd
}: {
  group: TabGroup
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const activeIndex = group.sessions.findIndex((s) => s.id === activeId)
  const hasActive = activeIndex !== -1

  // The strip is `overflow-x: auto` (it has to scroll when there are many targets), which
  // would clip a popover positioned inside it — so the dropdown is fixed-positioned off the
  // trigger's rect instead, and re-measured each time it opens.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const width = popRef.current?.offsetWidth ?? 200
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: r.bottom + 5
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        className={`server-tab server-tab-multi ${hasActive ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`${group.sessions.length} sessions on ${group.title}`}
        aria-expanded={open}
      >
        <span className="server-tab-title">{group.title}</span>
        {/* Position/total while one of this group's sessions is the visible pane, so you can
            tell which of them you're in without opening the dropdown; bare count otherwise. */}
        <span className="server-tab-count">
          {hasActive ? `${activeIndex + 1}/${group.sessions.length}` : group.sessions.length}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          className="server-tab-pop"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          role="menu"
        >
          {group.sessions.map((s, i) => (
            <div
              key={s.id}
              className={`server-tab-pop-item ${s.id === activeId ? 'active' : ''}`}
              onClick={() => {
                setOpen(false)
                onSelect(s.id)
              }}
              role="menuitem"
              tabIndex={0}
            >
              <span>Session {i + 1}</span>
              <button
                className="server-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  // Closing the last one takes the dropdown's reason to exist with it.
                  if (group.sessions.length <= 2) setOpen(false)
                  onClose(s.id)
                }}
                title="Close session"
                aria-label={`Close ${group.title} session ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
          <div className="server-tab-pop-sep" />
          <button
            className="server-tab-pop-item add"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
            role="menuitem"
          >
            New session
          </button>
        </div>
      )}
    </>
  )
}

/**
 * The open-session tab strip. Rendered in two places (see App.tsx): at the top of the
 * server-sessions layer, where clicking a tab just switches the visible pane, and
 * inline on the Servers screens, where it also has to jump into the session view.
 * That difference lives entirely in the `onSelect` the caller passes.
 */
export default function ServerTabs({ sessions, activeId, onSelect, onClose, onAddToGroup, inline }: Props) {
  return (
    <div className={`server-tabs ${inline ? 'inline' : ''}`}>
      {groupSessions(sessions).map((g) =>
        g.sessions.length === 1 ? (
          <div
            key={g.key}
            className={`server-tab ${g.sessions[0].id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(g.sessions[0].id)}
          >
            <span className="server-tab-title">{g.title}</span>
            <button
              className="server-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                onClose(g.sessions[0].id)
              }}
              title="Close session"
              aria-label={`Close ${g.title}`}
            >
              ×
            </button>
          </div>
        ) : (
          <GroupTab
            key={g.key}
            group={g}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
            onAdd={() => onAddToGroup(g.key)}
          />
        )
      )}
    </div>
  )
}
