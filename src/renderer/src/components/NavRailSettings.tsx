// Settings → General → Navigation: which rail entries show, in what order, and where
// the app opens.
//
// The entries are chips rather than one switch per row: seven rows of switches were
// taller than the rest of General put together. A chip is pressed to show or hide its
// entry and dragged to move it; Alt+←/→ moves the focused chip, so the order can be
// changed without a pointer.

import { useEffect, useRef, useState } from 'react'
import { moveNavItem, orderNavItems, START_VIEWS, type NavItemId, type StartView } from '../../../shared/nav-items'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import type { UiPrefs, UiPrefsPatch } from '../types'
import { RAIL_LABELS } from './NavRail'
import Hint from './Hint'

/** Its own type, never 'text/plain', so a chip cannot be dropped on a terminal as text. */
const NAV_DRAG_TYPE = 'application/x-argos-nav-item'

const START_LABELS: Record<StartView, MessageKey> = {
  home: 'sidebar.nav.home',
  chat: 'sidebar.nav.chat',
  last: 'settings.general.startView.last'
}

interface Props {
  ui: UiPrefs
  onSetUi: (patch: UiPrefsPatch) => void
}

export default function NavRailSettings({ ui, onSetUi }: Props) {
  const t = useT()
  const hidden = ui.hiddenNavItems ?? []
  const order = orderNavItems(ui.navOrder)
  const [dragging, setDragging] = useState<NavItemId | null>(null)
  const [over, setOver] = useState<NavItemId | null>(null)
  // A chip moved with Alt+arrow keeps the focus: React re-inserts the node when it moves
  // towards the end, and a re-inserted element loses focus, so a second press would go
  // nowhere. The chip is focused again once the new order has rendered.
  const chips = useRef<Partial<Record<NavItemId, HTMLButtonElement | null>>>({})
  const refocus = useRef<NavItemId | null>(null)
  const orderKey = order.join()
  useEffect(() => {
    if (!refocus.current) return
    chips.current[refocus.current]?.focus()
    refocus.current = null
  }, [orderKey])

  const toggle = (id: NavItemId) =>
    onSetUi({ hiddenNavItems: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] })
  const move = (id: NavItemId, to: number) => {
    const next = moveNavItem(order, id, to)
    if (next.join() !== order.join()) onSetUi({ navOrder: next })
  }
  const start = ui.startView ?? 'home'

  return (
    <>
      <div className="srow">
        <div className="srow-text">
          <span className="srow-label">{t('settings.general.navRail.label')}</span>
          <div className="settings-chips" role="group" aria-label={t('settings.general.navRail.label')}>
            {order.map((id, index) => {
              const shown = !hidden.includes(id)
              const name = t(RAIL_LABELS[id])
              return (
                <button
                  key={id}
                  ref={(el) => {
                    chips.current[id] = el
                  }}
                  type="button"
                  className={`settings-chip${shown ? ' on' : ''}${over === id && dragging !== id ? ' drop' : ''}`}
                  aria-pressed={shown}
                  aria-label={t('settings.general.navRail.toggle', { name })}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                  onClick={() => toggle(id)}
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                    e.preventDefault()
                    refocus.current = id
                    move(id, index + (e.key === 'ArrowLeft' ? -1 : 1))
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NAV_DRAG_TYPE, id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDragging(id)
                  }}
                  onDragOver={(e) => {
                    if (!dragging) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setOver(id)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragging) move(dragging, index)
                    setDragging(null)
                    setOver(null)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                >
                  {name}
                </button>
              )
            })}
          </div>
          <span className="help">{t('settings.general.navRail.hint')}</span>
        </div>
      </div>

      <div className="srow">
        <div className="srow-text">
          <span className="srow-label">{t('settings.general.startView.label')}<Hint text={t('settings.general.startView.hint')} /></span>
        </div>
        <div className="seg-control" role="group" aria-label={t('settings.general.startView.label')}>
          {START_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={start === v ? 'on' : ''}
              aria-pressed={start === v}
              onClick={() => onSetUi({ startView: v })}
            >
              {t(START_LABELS[v])}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
