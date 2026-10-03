/**
 * Cleaning the text fields of a stored SSH host before they are saved. A pasted address
 * often carries a trailing space or a zero-width character, which Node then resolves as a
 * name ("getaddrinfo ENOTFOUND 192.168.1.10") instead of connecting. Secrets are left
 * alone: a password or passphrase may start or end with a space on purpose.
 */

/** Zero-width space/joiners and the word joiner: invisible, and `trim()` keeps them. */
const INVISIBLE = /[​-‍⁠]/g

/** Strip invisible characters, then surrounding whitespace (including a BOM and NBSP). */
export function cleanHostText(value: string): string {
  return value.replace(INVISIBLE, '').trim()
}

interface HostText {
  name: string
  host: string
  username: string
  privateKeyPath?: string
  remotePath?: string
  claudePath?: string
}

/** `input` with its address, name and path fields cleaned; everything else is untouched. */
export function cleanHostFields<T extends HostText>(input: T): T {
  const out = {
    ...input,
    name: cleanHostText(input.name),
    host: cleanHostText(input.host),
    username: cleanHostText(input.username)
  }
  if (input.privateKeyPath !== undefined) out.privateKeyPath = cleanHostText(input.privateKeyPath)
  if (input.remotePath !== undefined) out.remotePath = cleanHostText(input.remotePath)
  if (input.claudePath !== undefined) out.claudePath = cleanHostText(input.claudePath)
  return out
}
