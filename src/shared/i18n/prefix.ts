// Namespace merging, shared by en/index.ts and pt-PT/index.ts.
//
// A namespace file holds keys relative to itself ('tray.open'); the app addresses them
// by their full dotted path ('main.tray.open'). `prefix` is the one place that joins
// the two, at the type level as well as at runtime, so `MessageKey` is the exact set of
// strings `t()` accepts.

export type Namespace = Record<string, string>

export type Prefixed<P extends string, T> = { [K in keyof T & string as `${P}.${K}`]: string }

export function prefix<P extends string, T extends Namespace>(namespace: P, messages: T): Prefixed<P, T> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(messages)) out[`${namespace}.${key}`] = messages[key]
  return out as Prefixed<P, T>
}
