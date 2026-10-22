import type { HTMLAttributes, ReactNode } from 'react'
import './ChatHead.css'

/** Longer names are cut in JS rather than by CSS ellipsis alone, so the cwd chip and the
 *  actions keep their place even in a narrow pane; the full name stays in the tooltip. */
const MAX_TITLE_CHARS = 25

function shortTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

/**
 * The one header bar every chat pane has: its name, the folder it runs in, and whatever
 * actions the host puts on the right. In a split it is also the pane's drag handle, which
 * is why the drag props are spread on the root rather than on an inner grip.
 */
export default function ChatHead({
  title,
  cwd,
  cwdLabel,
  dragProps,
  actions
}: {
  title: string
  cwd?: string
  /** The chip's words in place of the cwd's last segment; the cwd stays its tooltip. */
  cwdLabel?: string
  dragProps?: HTMLAttributes<HTMLDivElement>
  actions?: ReactNode
}) {
  return (
    <div className="chat-head" {...dragProps}>
      <span className="chat-head-name" title={title}>
        {shortTitle(title)}
      </span>
      {cwd && (
        <span className="chat-head-cwd" title={cwd}>
          {cwdLabel ?? cwd.split(/[\\/]/).filter(Boolean).pop()}
        </span>
      )}
      {actions && <div className="chat-head-actions">{actions}</div>}
    </div>
  )
}
