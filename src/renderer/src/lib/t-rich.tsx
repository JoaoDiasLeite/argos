import { createElement, Fragment, type ReactNode } from 'react'

/**
 * Renders a translated sentence that has markup inside it (a <code> path, a <strong>
 * name). The dictionary text carries `{name}` markers, the call passes the nodes, so
 * the sentence stays one key and a translation may reorder the pieces freely.
 *
 * Fetch the text with `t(key)` and no params for the markup slots: `format` leaves an
 * unknown marker untouched, so it survives to here. Plain string params may go either
 * to `t()` or into `nodes`; text that comes from the user (a runbook line, a file name)
 * belongs in `nodes`, so a `{word}` inside it is never mistaken for a slot.
 *
 * A slot may appear more than once (each occurrence gets the same node); a marker with
 * no entry in `nodes` stays as written. Always returns an array of strings and keyed
 * fragments, empty strings dropped. Written without JSX so vitest (no JSX transform
 * configured) can load it and its test.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = []
  text.split(/(\{\w+\})/g).forEach((part, i) => {
    if (part === '') return
    const m = /^\{(\w+)\}$/.exec(part)
    if (m && Object.prototype.hasOwnProperty.call(nodes, m[1])) {
      out.push(createElement(Fragment, { key: i }, nodes[m[1]]))
    } else {
      out.push(part)
    }
  })
  return out
}
