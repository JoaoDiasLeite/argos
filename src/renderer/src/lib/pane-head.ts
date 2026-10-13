import type { HTMLAttributes } from 'react'

/**
 * What a split-view pane adds to its chat's header. Only PaneGrid hands one out, and only
 * with more than one pane on screen: a lone pane has nothing to drag anywhere and nothing
 * to close back to, so its header is just the name.
 */
export interface PaneHead {
  /** The chat's display name, as the drag ghost and the close button's label read it. */
  name: string
  /** Makes the header the pane's drag handle (draggable, onDragStart/End, title). */
  dragProps: HTMLAttributes<HTMLDivElement>
  /** Drops the pane from the layout. The chat and its CLI keep running. */
  onClosePane: () => void
}
