import type { SelectHTMLAttributes } from 'react'

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & {
  /** Goes on the wrapper, so a width, margin or `flex-shrink` class sizes the whole control. */
  className?: string
}

/**
 * The design's select (SYSTEM-DESIGN.md §6): the native control with its own arrow
 * removed and the chevron painted 10 px from the right edge. Styles in shared.css.
 */
export default function Select({ className, children, ...props }: Props) {
  return (
    <span className={`select${className ? ` ${className}` : ''}`}>
      <select className="text-input" {...props}>
        {children}
      </select>
      <svg
        className="select-chevron"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  )
}
