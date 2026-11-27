import { describe, it, expect } from 'vitest'
import { NAV_ITEM_IDS, isDefaultNavOrder, moveNavItem, orderNavItems, sanitizeHiddenNavItems } from './nav-items'

describe('orderNavItems', () => {
  it('is the default order for anything that is not a list', () => {
    expect(orderNavItems(undefined)).toEqual([...NAV_ITEM_IDS])
    expect(orderNavItems('chat')).toEqual([...NAV_ITEM_IDS])
  })

  it('puts the named ids first and appends the ones a stored list does not know', () => {
    expect(orderNavItems(['usage', 'chat'])).toEqual(['usage', 'chat', 'home', 'projects', 'planner', 'companion', 'servers'])
  })

  it('drops unknown ids and repeats', () => {
    expect(orderNavItems(['chat', 'settings', 'chat', 42]).slice(0, 2)).toEqual(['chat', 'home'])
  })
})

describe('moveNavItem', () => {
  const order = orderNavItems(undefined)

  it('moves an entry to a position', () => {
    expect(moveNavItem(order, 'servers', 0)[0]).toBe('servers')
    expect(moveNavItem(order, 'home', 2).slice(0, 3)).toEqual(['chat', 'projects', 'home'])
  })

  it('clamps the position and keeps every entry', () => {
    const moved = moveNavItem(order, 'home', 99)
    expect(moved[moved.length - 1]).toBe('home')
    expect(moveNavItem(order, 'chat', -5)[0]).toBe('chat')
    expect([...moved].sort()).toEqual([...order].sort())
  })

  it('does not change the list it was given', () => {
    moveNavItem(order, 'usage', 0)
    expect(order).toEqual([...NAV_ITEM_IDS])
  })
})

describe('isDefaultNavOrder', () => {
  it('tells the default order from a changed one', () => {
    expect(isDefaultNavOrder(orderNavItems(undefined))).toBe(true)
    expect(isDefaultNavOrder(moveNavItem(orderNavItems(undefined), 'chat', 0))).toBe(false)
  })
})

describe('sanitizeHiddenNavItems', () => {
  it('keeps known ids once, in rail order', () => {
    expect(sanitizeHiddenNavItems(['usage', 'nope', 'home', 'usage'])).toEqual(['home', 'usage'])
  })
})
