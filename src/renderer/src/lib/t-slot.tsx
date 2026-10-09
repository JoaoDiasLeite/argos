import type { ReactNode } from 'react'

/** Placeholder to pass as a `t()` param when that spot must render as markup (bold, mono…). */
export const SLOT = '\u0001'

/** Splits a translated string at `SLOT` and puts `node` there, so one sentence stays one key. */
export function withSlot(text: string, node: ReactNode): ReactNode {
  const i = text.indexOf(SLOT)
  if (i === -1) return text
  return (
    <>
      {text.slice(0, i)}
      {node}
      {text.slice(i + 1)}
    </>
  )
}
