import {
  SECRET_FIELDS,
  cleanHostText,
  effectiveElevation,
  isElevateCommand,
  isElevationMode,
  isSafeSshUsername,
  type ElevateCommand,
  type ElevationMode,
  type HostSecretFlags,
  type SecretField,
  type SshAuthType,
  hostAuthSource,
  type AuthSource,
  type SshHost,
  type SshHostPublic
} from './ssh-host-pure'
import { hostIdsLoggingInWith, type GroupedHostRef, type SshGroup } from './ssh-group-pure'

/**
 * A login kept once and linked by many hosts: the same account usually exists on every
 * server of a client, so rotating its password should be one edit. Stored on its own in
 * `ssh-credentials.bin`, encrypted like the hosts file.
 */
export interface SshCredential {
  id: string
  name: string
  username: string
  authType: SshAuthType
  privateKeyPath?: string
  elevation?: ElevationMode
  elevateCommand?: ElevateCommand
  password?: string
  passphrase?: string
  /** Only kept while `elevation` is `other`, as on a host. */
  elevationPassword?: string
}

/** The fields of a credential the renderer may see. An allowlist, like PUBLIC_HOST_FIELDS:
 *  a field not named here never leaves the main process. */
export const PUBLIC_CREDENTIAL_FIELDS = ['id', 'name', 'username', 'authType', 'privateKeyPath', 'elevation', 'elevateCommand'] as const
export type PublicCredentialField = (typeof PUBLIC_CREDENTIAL_FIELDS)[number]

// Every SshCredential key is either public or one of the host secrets (the same names, so the
// secret handling of hosts, from mergeSecrets to the profile envelope, applies unchanged). A
// field added without being classified fails the typecheck.
type UnclassifiedCredentialField = Exclude<keyof SshCredential, PublicCredentialField | SecretField>
const everyCredentialFieldClassified: [UnclassifiedCredentialField] extends [never] ? true : UnclassifiedCredentialField = true
void everyCredentialFieldClassified

/** A credential as the renderer sees it: no secrets, whether each exists, and how many hosts
 *  link it. */
export type SshCredentialPublic = Pick<SshCredential, PublicCredentialField> &
  HostSecretFlags & {
    usedBy: number
    /** How many server groups carry it. A credential a group carries cannot be deleted either. */
    usedByGroups: number
  }

/** What the renderer sends: `undefined` keeps a stored secret, `null` clears it. */
export type SshCredentialInput = Omit<SshCredential, 'id' | SecretField> & { id?: string } & {
  [K in SecretField]?: string | null
}

const AUTH_TYPES: readonly SshAuthType[] = ['password', 'key', 'agent']

export function isAuthType(v: unknown): v is SshAuthType {
  return typeof v === 'string' && (AUTH_TYPES as readonly string[]).includes(v)
}

export function secretFlags(h: {
  authType: SshAuthType
  elevation?: unknown
  password?: string
  passphrase?: string
  elevationPassword?: string
}): HostSecretFlags {
  const mode = effectiveElevation(h)
  return {
    hasPassword: !!h.password,
    hasPassphrase: !!h.passphrase,
    hasElevation: (mode === 'login' && !!h.password) || (mode === 'other' && !!h.elevationPassword)
  }
}

export function toPublicCredential(c: SshCredential, usedBy: number, usedByGroups = 0): SshCredentialPublic {
  const out: Partial<Record<PublicCredentialField, unknown>> = {}
  for (const k of PUBLIC_CREDENTIAL_FIELDS) {
    if (c[k] !== undefined) out[k] = c[k]
  }
  if (!isElevationMode(out.elevation)) delete out.elevation
  if (!isElevateCommand(out.elevateCommand)) delete out.elevateCommand
  return { ...(out as Pick<SshCredential, PublicCredentialField>), ...secretFlags(c), usedBy, usedByGroups }
}

/** How many saved hosts log in with credential `id`: those linking it and those inheriting
 *  it from their group. */
export function credentialUsage(hosts: readonly GroupedHostRef[], id: string, groups: readonly SshGroup[] = []): number {
  return hostIdsLoggingInWith(hosts, groups, id).length
}

/** `input` with its text fields cleaned (as cleanHostFields does for a host) and an elevation
 *  mode or command that is not on the list dropped. Secrets are left alone. */
export function cleanCredentialFields<T extends { name: string; username: string; privateKeyPath?: string; elevation?: string; elevateCommand?: string }>(
  input: T
): T {
  const out = {
    ...input,
    name: cleanHostText(typeof input.name === 'string' ? input.name : ''),
    username: cleanHostText(typeof input.username === 'string' ? input.username : '')
  }
  if (input.privateKeyPath !== undefined) out.privateKeyPath = cleanHostText(String(input.privateKeyPath))
  if (input.elevation !== undefined && !isElevationMode(input.elevation)) delete out.elevation
  if (input.elevateCommand !== undefined && !isElevateCommand(input.elevateCommand)) delete out.elevateCommand
  return out
}

export type CredentialFieldProblem = 'name' | 'username' | 'authType'

/** The first field of a (cleaned) credential that may not be saved, or null. */
export function credentialFieldProblem(c: { name: string; username: string; authType: unknown }): CredentialFieldProblem | null {
  if (!c.name) return 'name'
  if (!isSafeSshUsername(c.username)) return 'username'
  if (!isAuthType(c.authType)) return 'authType'
  return null
}

/**
 * Did a credential edit change what a pooled connection of a linked host was opened with?
 * Compares the saved records (secrets merged), so a password retyped unchanged is no change.
 * The elevation settings are left out on purpose, as for a host: they are only typed into a
 * terminal later, so changing them must not drop live sessions.
 */
export function credentialConnectionChanged(prev: SshCredential, next: SshCredential): boolean {
  return (
    prev.username !== next.username ||
    prev.authType !== next.authType ||
    (prev.privateKeyPath ?? '') !== (next.privateKeyPath ?? '') ||
    (prev.password ?? '') !== (next.password ?? '') ||
    (prev.passphrase ?? '') !== (next.passphrase ?? '')
  )
}

/** The host fields a linked credential supplies. A linked host's saved record keeps none of
 *  them, and resolveHostAuth never lets one of its own show through. */
export const CREDENTIAL_AUTH_FIELDS = ['username', 'authType', 'privateKeyPath', 'elevation', 'elevateCommand', ...SECRET_FIELDS] as const
export type CredentialAuthField = (typeof CREDENTIAL_AUTH_FIELDS)[number]

/** A host as saved: a linked one has no username or auth type of its own. */
export type StoredSshHost = Omit<SshHost, 'username' | 'authType'> & Partial<Pick<SshHost, 'username' | 'authType'>>

/**
 * A host with its login resolved, the shape every connecting path uses. `authSource` says
 * where the login came from. `credentialId` is the credential really used: the host's own
 * link, or its group's when it inherits, so a check like "has a credential, so no password
 * of its own to save" holds either way. `credentialMissing` marks a host whose credential is
 * gone (deleted, a broken import, a group deleted or left without one): it has no login at
 * all, and every connect path refuses it with a clear error instead of trying an empty
 * password or asking for one.
 */
export type EffectiveSshHost = SshHost & {
  authSource: AuthSource
  credentialName?: string
  credentialMissing?: boolean
  /** Set when the login is inherited: the group it comes from. */
  groupName?: string
}

/** What resolveHostAuth hands back: the host as it logs in, and where its login came from,
 *  so the UI can always name the origin. */
export interface HostAuthResolution {
  effective: EffectiveSshHost
  source: AuthSource
  credentialName?: string
}

/** `h` without any field a credential supplies. */
export function stripCredentialAuth<T extends object>(h: T): Omit<T, CredentialAuthField> {
  const out = { ...h } as Record<string, unknown>
  for (const k of CREDENTIAL_AUTH_FIELDS) delete out[k]
  return out as Omit<T, CredentialAuthField>
}

/**
 * The host as it logs in. The chain is explicit, by `authSource` (hostAuthSource for a host
 * saved before it existed): `own` is the host itself; `credential` takes the login from the
 * credential it links; `group` from the credential of its group. A host with a login of its
 * own never inherits, whatever group it is in. A linked or inheriting host takes its
 * username, auth type, key path, elevation and secrets from the credential, field by field:
 * whatever the saved record still holds of its own (an older file, an import) never shows
 * through, and the host keeps its own id, name, address and the rest.
 */
export function resolveHostAuth(
  host: StoredSshHost,
  credentials: readonly SshCredential[],
  groups: readonly SshGroup[] = []
): HostAuthResolution {
  const source = hostAuthSource(host)
  if (source === 'own') {
    const own = { ...host, authSource: source } as EffectiveSshHost
    // A credential id left on a host with a login of its own links nothing.
    delete own.credentialId
    return { effective: own, source }
  }
  const base = stripCredentialAuth(host)
  delete base.credentialId
  let credentialId = host.credentialId
  let groupName: string | undefined
  if (source === 'group') {
    const group = host.groupId ? groups.find((g) => g.id === host.groupId) : undefined
    credentialId = group?.credentialId
    groupName = group?.name
  }
  const cred = credentialId ? credentials.find((c) => c.id === credentialId) : undefined
  if (!cred) {
    const missing: EffectiveSshHost = { ...base, username: '', authType: 'password', authSource: source, credentialMissing: true }
    // The id it points at, so the form can show which link is broken.
    if (credentialId) missing.credentialId = credentialId
    if (groupName !== undefined) missing.groupName = groupName
    return { effective: missing, source }
  }
  const out: EffectiveSshHost = {
    ...base,
    credentialId: cred.id,
    username: cred.username,
    authType: cred.authType,
    authSource: source,
    credentialName: cred.name
  }
  if (groupName !== undefined) out.groupName = groupName
  if (cred.privateKeyPath !== undefined) out.privateKeyPath = cred.privateKeyPath
  if (cred.elevation !== undefined) out.elevation = cred.elevation
  if (cred.elevateCommand !== undefined) out.elevateCommand = cred.elevateCommand
  for (const k of SECRET_FIELDS) {
    if (cred[k] !== undefined) out[k] = cred[k]
  }
  return { effective: out, source, credentialName: cred.name }
}

/** The renderer's view of a resolved host: its public fields (with the login it really uses)
 *  plus which credential supplies it, if any. */
export function withCredentialInfo(pub: SshHostPublic, h: EffectiveSshHost): SshHostPublic {
  // The resolved source, so a host saved before groups still says where its login comes from.
  const out: SshHostPublic = { ...pub, authSource: h.authSource }
  if (h.authSource === 'own') return out
  if (h.groupName !== undefined) out.groupName = h.groupName
  if (h.credentialMissing) out.credentialMissing = true
  else out.credentialName = h.credentialName
  return out
}

/**
 * Did saving a host change what its pooled connection was opened with? Compares the resolved
 * host before and after, so a switch to or from a credential, or to another one, counts, and
 * so does any login field or secret that differs, and the gateway. Organisation fields and
 * elevation do not.
 */
export function hostConnectionChanged(prev: EffectiveSshHost, next: EffectiveSshHost): boolean {
  return (
    prev.host !== next.host ||
    (prev.port || 22) !== (next.port || 22) ||
    prev.username !== next.username ||
    prev.authType !== next.authType ||
    (prev.privateKeyPath ?? '') !== (next.privateKeyPath ?? '') ||
    (prev.password ?? '') !== (next.password ?? '') ||
    (prev.passphrase ?? '') !== (next.passphrase ?? '') ||
    (prev.credentialId ?? '') !== (next.credentialId ?? '') ||
    !!prev.credentialMissing !== !!next.credentialMissing ||
    // A connection through a gateway (or no longer through one) is another connection.
    (prev.jumpHostId ?? '') !== (next.jumpHostId ?? '')
  )
}
