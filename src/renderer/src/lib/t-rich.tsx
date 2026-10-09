import { Fragment, type ReactNode } from 'react'

/**
 * Renders a translated sentence that has markup inside it (a <code> path, a <strong>
 * name). The dictionary text carries `{name}` markers, the call passes the nodes, so
 * the sentence stays one key and a translation may reorder the pieces freely.
 * Pass the raw `t(key)` (no params): unknown markers survive formatting untouched.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    if (m && m[1] in nodes) return <Fragment key={i}>{nodes[m[1]]}</Fragment>
    return part
  })
}
