import type { CSSProperties } from 'react'
import mark from '../brand/argos-mark.json'

interface Props {
  /** Rendered size in px (the mark is square). */
  size?: number
  /** Thickens the line for 16–24 px, where the drawing's own stroke gets thin. */
  bold?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}

/**
 * The Argos mark: the dog's head, one SVG path in currentColor. The path and its viewBox
 * live in brand/argos-mark.json, which scripts/gen-icon.mjs also reads for the app icon,
 * so the window, the tray and the title bar never drift apart.
 */
export default function ArgosMark({ size = 20, bold = false, className, style, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      className={className}
      style={style}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path
        d={mark.d}
        fill="currentColor"
        stroke={bold ? 'currentColor' : undefined}
        strokeWidth={bold ? mark.boldStroke : undefined}
        strokeLinejoin="round"
      />
    </svg>
  )
}
