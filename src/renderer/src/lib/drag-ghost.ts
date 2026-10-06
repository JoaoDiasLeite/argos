import './drag-ghost.css'

/**
 * The image a dragged chat carries: a small pill with its name, instead of the browser's
 * translucent snapshot of the row it came from (which drags along the row's chips and
 * clips them mid-word).
 *
 * setDragImage needs an element that is in the document and laid out at the moment of
 * the call, so the pill is placed off screen, handed over, and removed on the next frame;
 * the browser has rasterised it by then.
 */
export function setChatDragImage(e: { dataTransfer: DataTransfer }, name: string): void {
  try {
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    const dot = document.createElement('span')
    dot.className = 'drag-ghost-dot'
    const label = document.createElement('span')
    label.className = 'drag-ghost-name'
    label.textContent = name || 'New chat'
    ghost.append(dot, label)
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 14, 16)
    requestAnimationFrame(() => ghost.remove())
  } catch {
    // The default image is a worse picture of the same drag, never a broken one.
  }
}
