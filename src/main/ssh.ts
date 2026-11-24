import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import { randomUUID } from 'crypto'
import { isEndpointKeyStored, trustedKnownHostsPath, verifyHostKey, type TrustVia } from './ssh-trust'
import { sshOptionPath, trustAlias, trustKey } from './ssh-trust-pure'
import { t } from './i18n'
import { plural } from '../shared/i18n'
import { keyboardInteractiveDecision, keyNeedsPassphrase, type KbdPrompt } from './connect-auth-pure'
import { createEncryptedListStore } from './encrypted-list-store'
import { loadJsonFileGuarded, writeJsonFileAtomic } from './json-file'
import {
  cleanGroup,
  groupUsage,
  groupsFromFile,
  groupsUsingCredential,
  hostIdsInheritingFrom,
  hostIdsLoggingInWith,
  isGroupsFile,
  removeGroupFromHosts,
  type SshGroup,
  type SshGroupInput,
  groupJumpLookup,
  groupVpnLookup,
  hostIdsTakingGroupJump
} from './ssh-group-pure'
import {
  cleanHostFields,
  hostAuthSource,
  hostFieldProblem,
  hostFieldProblemKey,
  mergeSecrets,
  stripSecrets,
  toPublicHost,
  remoteCommandWord,
  sshDestinationArgs,
  type HostsRead,
  type SecretField,
  type SshHost,
  type SshHostPublic
} from './ssh-host-pure'
import {
  cleanCredentialFields,
  credentialFieldProblem,
  credentialUsage,
  resolveHostAuth,
  stripCredentialAuth,
  toPublicCredential,
  withCredentialInfo,
  type EffectiveSshHost,
  type SshCredential,
  type SshCredentialInput,
  type SshCredentialPublic,
  type StoredSshHost
} from './ssh-credential-pure'
import { checkForwards, forwardProblemKey, usableForwards, type PortForward } from './port-forwards-pure'
import {
  buildProxyCommand,
  hostIdsUsingJump,
  jumpBreakage,
  jumpSaveProblem,
  resolveJump,
  type JumpProblem,
  type JumpSaveProblem
} from './ssh-jump-pure'
import type { Duplex } from 'stream'
import { checkVpns, groupVpnProblem, resolveVpn, usableVpns, vpnProblemKey, vpnSaveProblem, type VpnProfile, type VpnResolveProblem } from './vpn-pure'
import { ensureVpn } from './vpn-exec'

export type { SshAuthType, SshHost, SshHostPublic } from './ssh-host-pure'
export type { EffectiveSshHost, SshCredential, SshCredentialInput, SshCredentialPublic, StoredSshHost } from './ssh-credential-pure'
export type { SshGroup, SshGroupInput } from './ssh-group-pure'

/** What the renderer sends: `undefined` keeps a stored secret, `null` clears it. A host whose
 *  `authSource` is `credential` (or that carries a `credentialId` and no source, as before
 *  groups) takes its login from that credential, one whose source is `group` from its
 *  group's; its own login fields are ignored then. */
export type SshHostInput = Omit<SshHost, 'id' | SecretField> & {
  id?: string
} & { [K in SecretField]?: string | null }

const hostStore = createEncryptedListStore<StoredSshHost>(path.join(app.getPath('userData'), 'ssh-hosts.bin'), 'ssh', {
  unreadable: 'main.ssh.hostsUnreadable',
  saveFailed: 'main.ssh.hostsSaveFailed'
})

const credentialStore = createEncryptedListStore<SshCredential>(path.join(app.getPath('userData'), 'ssh-credentials.bin'), 'ssh', {
  unreadable: 'main.ssh.credentialsUnreadable',
  saveFailed: 'main.ssh.credentialsSaveFailed'
})

export type HostsWriteResult = { ok: true; hosts: SshHostPublic[] } | { ok: false; error: string }

// ─── Server groups: storage ─────────────────────────────────────────────────
// Plain JSON: a group holds a name and the id of a credential, never a secret.

const groupsFile = path.join(app.getPath('userData'), 'ssh-groups.json')

type GroupsRead = { ok: true; groups: SshGroup[] } | { ok: false; error: string }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The saved groups. A missing file is none; a corrupt one is copied aside and read as none
 *  (loadJsonFileGuarded); one that cannot be read right now is an error, so no write path
 *  saves over it. */
function readGroups(): GroupsRead {
  const res = loadJsonFileGuarded(groupsFile, isGroupsFile)
  if (res.kind === 'ok') return { ok: true, groups: groupsFromFile(res.value) }
  if (res.kind === 'unreadable') {
    return { ok: false, error: t('main.ssh.groupsUnreadable', { error: errText(res.error), file: groupsFile }) }
  }
  return { ok: true, groups: [] }
}

function readGroupsOrEmpty(): SshGroup[] {
  const res = readGroups()
  return res.ok ? res.groups : []
}

function writeGroups(groups: SshGroup[]): { ok: true } | { ok: false; error: string } {
  try {
    writeJsonFileAtomic(groupsFile, { groups })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: t('main.ssh.groupsSaveFailed', { error: errText(e) }) }
  }
}

function updateHosts(mutate: (hosts: StoredSshHost[]) => StoredSshHost[]): HostsWriteResult {
  const res = hostStore.update(mutate)
  return res.ok ? { ok: true, hosts: listHosts() } : res
}

/** Whether saved secrets are really encrypted: on Linux without a keyring Electron reports
 * encryption as available but uses a hard-coded key ('basic_text'). */
export function secretStorageState(): { encrypted: boolean; backend?: string } {
  const available = safeStorage.isEncryptionAvailable()
  if (process.platform !== 'linux') return { encrypted: available }
  let backend: string | undefined
  try {
    backend = safeStorage.getSelectedStorageBackend()
  } catch {
    backend = undefined
  }
  return { encrypted: available && backend !== 'basic_text', backend }
}

/** The hosts as the renderer sees them: the login each one really uses (its own or its
 *  credential's), never a secret, plus the name of a linked credential. */
export function listHosts(): SshHostPublic[] {
  const credentials = credentialStore.readOrEmpty()
  const groups = readGroupsOrEmpty()
  const stored = hostStore.readOrEmpty()
  return stored.map((h) => {
    // Forwards are re-checked on the way out: an imported host never went through saveHost.
    const own = h.forwards === undefined ? h : { ...h, forwards: usableForwards(h.forwards) }
    const eff = resolveHostAuth(own, credentials, groups).effective
    const pub0 = withCredentialInfo(toPublicHost(eff), eff)
    // Only profiles that pass the check are shown (an import never went through the save).
    const pub = h.vpns === undefined ? pub0 : { ...pub0, vpns: usableVpns(h.vpns) }
    // The gateway's name for the "via" hint, or that the one it names cannot be used.
    const jump = resolveJump(h, stored, groupJumpLookup(groups))
    if (!jump.ok) return { ...pub, jumpMissing: true }
    // The VPN it needs on that gateway, or that the one it asks for is not there (a group's
    // VPN on a server that connects directly cannot be reached: the connect refuses it).
    const vpn = resolveVpn(h, stored, groupJumpLookup(groups), groupVpnLookup(groups))
    if (!jump.jump) return vpn.ok ? pub : { ...pub, vpnMissing: true }
    const withJump = { ...pub, jumpHostName: jump.jump.name, jumpViaId: jump.jump.id, jumpSource: jump.source }
    if (!vpn.ok) return { ...withJump, vpnMissing: true }
    if (!vpn.vpn) return withJump
    return {
      ...withJump,
      vpnViaId: vpn.vpn.id,
      vpnName: vpn.vpn.name,
      vpnSource: vpn.vpnSource === 'group' ? ('group' as const) : ('host' as const),
      vpnAuto: vpn.autoUp
    }
  })
}

/** The message for a jump that does not resolve. */
function jumpProblemMessage(problem: JumpProblem | JumpSaveProblem, hosts: readonly StoredSshHost[], jumpHostId?: string, riders = 0): string {
  if (problem === 'self') return t('main.ssh.jump.self')
  if (problem === 'unknown') return t('main.ssh.jump.unknown')
  if (problem === 'isGateway') return plural(t, 'main.ssh.jump.isGateway', riders)
  const name = hosts.find((h) => h.id === jumpHostId)?.name ?? ''
  return t('main.ssh.jump.chained', { name })
}

/**
 * The save's jump check, on the list as it would be after the save (the host replaced or
 * added): its own gateway must resolve, and a host other servers go through must stay direct.
 * An unreadable hosts file is left to the write itself, which refuses it.
 */
function checkJumpOnSave(next: StoredSshHost): string | null {
  const read = hostStore.read()
  if (!read.ok) return null
  const after = read.hosts.some((h) => h.id === next.id) ? read.hosts.map((h) => (h.id === next.id ? next : h)) : [...read.hosts, next]
  const groups = readGroupsOrEmpty()
  const groupJumpOf = groupJumpLookup(groups)
  const problem = jumpSaveProblem(next.id, after, groupJumpOf)
  if (!problem) {
    // The server's own VPN must be one of its gateway's.
    const vpnProblem = vpnSaveProblem(next.id, after, groupJumpOf, groupVpnLookup(groups))
    return vpnProblem ? vpnResolveMessage(vpnProblem) : null
  }
  const named = resolveJump(next, after, groupJumpOf)
  return jumpProblemMessage(problem, after, named.ok ? undefined : named.jumpHostId, hostIdsUsingJump(next.id, after, groupJumpOf).length)
}

/** The message for a VPN choice that does not resolve. */
function vpnResolveMessage(problem: 'vpnNoGateway' | 'vpnMissing'): string {
  return t(problem === 'vpnNoGateway' ? 'main.vpn.noGateway' : 'main.vpn.missing')
}

/** The VPN profiles a host is saved with, or the save's error naming the one at fault. */
function checkedVpns(value: unknown): { ok: true; vpns: VpnProfile[] } | { ok: false; error: string } {
  const res = checkVpns(value)
  if (res.ok) return res
  return { ok: false, error: t(vpnProblemKey(res.problem), { n: (res.index ?? 0) + 1 }) }
}

/** `fields` with the checked VPN profiles in place, an empty list dropped. */
function withVpns<T extends { vpns?: VpnProfile[] }>(fields: T, vpns: VpnProfile[]): void {
  if (vpns.length) fields.vpns = vpns
  else delete fields.vpns
}

function genId(): string {
  return `ssh_${randomUUID()}`
}

function genCredentialId(): string {
  return `cred_${randomUUID()}`
}

/** The forwards a host is saved with, or the save's error naming the tunnel at fault. */
function checkedForwards(value: unknown): { ok: true; forwards: PortForward[] } | { ok: false; error: string } {
  const res = checkForwards(value)
  if (res.ok) return res
  return { ok: false, error: t(forwardProblemKey(res.problem), { n: (res.index ?? 0) + 1 }) }
}

export function saveHost(raw: SshHostInput): HostsWriteResult {
  // Main decides from the source, whatever else the input carries: a credential id sent
  // with a login of its own, or with an inherited one, is dropped.
  const source = hostAuthSource(raw)
  if (source === 'group') return saveInheritingHost(raw)
  if (source === 'credential') {
    const credentialId = typeof raw.credentialId === 'string' && raw.credentialId ? raw.credentialId : undefined
    if (!credentialId) return { ok: false, error: t('main.ssh.credentialMissing') }
    return saveLinkedHost(raw, credentialId)
  }
  const cleaned = stripSecrets(cleanHostFields({ ...raw, username: typeof raw.username === 'string' ? raw.username : '' }))
  // Unlinked: a credential id the input carried is dropped.
  const fields: Omit<typeof cleaned, 'credentialId'> & { credentialId?: string } = { ...cleaned, authSource: 'own' }
  delete fields.credentialId
  const groupProblem = groupRefProblem(fields.groupId)
  if (groupProblem) return { ok: false, error: groupProblem }
  const problem = hostFieldProblem(fields)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  const forwards = checkedForwards(raw.forwards)
  if (!forwards.ok) return forwards
  if (forwards.forwards.length) fields.forwards = forwards.forwards
  else delete fields.forwards
  const vpns = checkedVpns(raw.vpns)
  if (!vpns.ok) return vpns
  withVpns(fields, vpns.vpns)
  // The id is settled before the write so the jump check can place the host in the list.
  const id = fields.id || genId()
  const jumpError = checkJumpOnSave({ ...fields, id })
  if (jumpError) return { ok: false, error: jumpError }
  return updateHosts((hosts) => {
    const idx = hosts.findIndex((h) => h.id === id)
    // A host that was linked or inheriting has no secrets of its own to keep.
    const prev = idx >= 0 && hostAuthSource(hosts[idx]) === 'own' ? hosts[idx] : undefined
    const secrets = mergeSecrets(prev, raw)
    if (idx >= 0) {
      hosts[idx] = { ...fields, id, ...secrets }
    } else {
      hosts.push({ ...fields, id, ...secrets })
    }
    return hosts
  })
}

/** A host that logs in with a shared credential: only its own fields are kept (address,
 *  name, paths, organisation), never a login or a secret. */
function saveLinkedHost(raw: SshHostInput, credentialId: string): HostsWriteResult {
  const creds = credentialStore.read()
  if (!creds.ok) return { ok: false, error: t('main.ssh.credentialsUnreadable', { error: creds.error, file: credentialStore.file }) }
  const cred = creds.hosts.find((c) => c.id === credentialId)
  if (!cred) return { ok: false, error: t('main.ssh.credentialMissing') }
  // Cleaned with the credential's username in place, so the checks below see the login
  // the host will really use.
  const cleaned = cleanHostFields({ ...raw, username: cred.username })
  const groupProblem = groupRefProblem(cleaned.groupId)
  if (groupProblem) return { ok: false, error: groupProblem }
  const problem = hostFieldProblem(cleaned)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  const forwards = checkedForwards(raw.forwards)
  if (!forwards.ok) return forwards
  const fields = { ...stripCredentialAuth(cleaned), credentialId }
  if (forwards.forwards.length) fields.forwards = forwards.forwards
  else delete fields.forwards
  const vpns = checkedVpns(raw.vpns)
  if (!vpns.ok) return vpns
  withVpns(fields, vpns.vpns)
  const id = fields.id || genId()
  const jumpError = checkJumpOnSave({ ...fields, id })
  if (jumpError) return { ok: false, error: jumpError }
  return updateHosts((hosts) => {
    const idx = hosts.findIndex((h) => h.id === id)
    if (idx >= 0) hosts[idx] = { ...fields, id, authSource: 'credential' }
    else hosts.push({ ...fields, id, authSource: 'credential' })
    return hosts
  })
}

/** Why a host may not be saved in group `groupId`, or null: no group, or one that exists. */
function groupRefProblem(groupId: string | undefined): string | null {
  if (!groupId) return null
  const groups = readGroups()
  if (!groups.ok) return groups.error
  return groups.groups.some((g) => g.id === groupId) ? null : t('main.ssh.groupMissing')
}

/**
 * A host that logs in with its group's credential: it must be in a group that carries one.
 * Kept like a linked host, with no login or secret of its own, and without a credential id:
 * the group's is looked up on every connect, so changing it there changes it here.
 */
function saveInheritingHost(raw: SshHostInput): HostsWriteResult {
  const groupId = typeof raw.groupId === 'string' ? raw.groupId : ''
  const groups = readGroups()
  if (!groups.ok) return { ok: false, error: groups.error }
  const group = groups.groups.find((g) => g.id === groupId)
  if (!group) return { ok: false, error: t('main.ssh.groupMissing') }
  if (!group.credentialId) return { ok: false, error: t('main.ssh.groupNoCredential', { group: group.name }) }
  const creds = credentialStore.read()
  if (!creds.ok) return { ok: false, error: t('main.ssh.credentialsUnreadable', { error: creds.error, file: credentialStore.file }) }
  const cred = creds.hosts.find((c) => c.id === group.credentialId)
  if (!cred) return { ok: false, error: t('main.ssh.credentialMissing') }
  const cleaned = cleanHostFields({ ...raw, username: cred.username, groupId })
  const problem = hostFieldProblem(cleaned)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  const forwards = checkedForwards(raw.forwards)
  if (!forwards.ok) return forwards
  // No credential id of its own: undefined is dropped when the file is written.
  const fields = { ...stripCredentialAuth(cleaned), groupId, authSource: 'group' as const, credentialId: undefined }
  if (forwards.forwards.length) fields.forwards = forwards.forwards
  else delete fields.forwards
  const vpns = checkedVpns(raw.vpns)
  if (!vpns.ok) return vpns
  withVpns(fields, vpns.vpns)
  const id = fields.id || genId()
  const jumpError = checkJumpOnSave({ ...fields, id })
  if (jumpError) return { ok: false, error: jumpError }
  return updateHosts((hosts) => {
    const idx = hosts.findIndex((h) => h.id === id)
    if (idx >= 0) hosts[idx] = { ...fields, id }
    else hosts.push({ ...fields, id })
    return hosts
  })
}

/**
 * Deletes a host no other host goes through. A gateway still in use is refused, as a shared
 * credential is: its riders would be left pointing at nothing. Read strictly, so an unreadable
 * file never passes for "nobody uses it".
 */
export function deleteHost(id: string): HostsWriteResult {
  const read = hostStore.read()
  if (!read.ok) return { ok: false, error: t('main.ssh.hostsUnreadable', { error: read.error, file: hostStore.file }) }
  const groups = readGroupsOrEmpty()
  const riders = hostIdsUsingJump(id, read.hosts, groupJumpLookup(groups)).length
  if (riders > 0) return { ok: false, error: plural(t, 'main.ssh.jump.inUse', riders) }
  // A group naming it would hand every server added later a gateway that is gone.
  const carriers = groups.filter((g) => g.jumpHostId === id).length
  if (carriers > 0) return { ok: false, error: plural(t, 'main.ssh.jump.inUseByGroups', carriers) }
  return updateHosts((hosts) => hosts.filter((h) => h.id !== id))
}

/** The ids of the hosts that connect through `gatewayId`, for closing them with it. */
export function hostIdsBehindGateway(gatewayId: string): string[] {
  return hostIdsUsingJump(gatewayId, hostStore.readOrEmpty(), groupJumpLookup(readGroupsOrEmpty()))
}

/**
 * Saves a login password typed at the connect prompt with "save" ticked. Only the password
 * field changes, on a fresh read of the store (fail-closed like every write here), and only
 * while the host still exists and still logs in with a password of its own: the form may have
 * changed it while the prompt was up, and a host linked to a shared credential never stores
 * one (the prompt does not offer to save for it). Not through saveHost, whose callers close
 * the pooled connection when a password is touched, and this one has just been opened with
 * it. Not ok when nothing was saved, so the caller keeps the password for the session.
 */
export function saveHostPassword(id: string, password: string): HostsWriteResult {
  let saved = false
  const res = updateHosts((hosts) =>
    hosts.map((h) => {
      if (h.id !== id || hostAuthSource(h) !== 'own' || h.authType !== 'password') return h
      saved = true
      return { ...h, password }
    })
  )
  if (res.ok && !saved) return { ok: false, error: t('main.ssh.hostNotFound') }
  return res
}

// ─── Shared credentials ─────────────────────────────────────────────────────

export type CredentialsWriteResult = { ok: true; credentials: SshCredentialPublic[] } | { ok: false; error: string }

/** The credentials as the renderer sees them: no secrets, and how many hosts link each. */
export function listCredentials(): SshCredentialPublic[] {
  const hosts = hostStore.readOrEmpty()
  const groups = readGroupsOrEmpty()
  return credentialStore
    .readOrEmpty()
    .map((c) => toPublicCredential(c, credentialUsage(hosts, c.id, groups), groupsUsingCredential(groups, c.id).length))
}

/** One saved credential with its secrets, for main only (comparing before and after a save). */
export function getStoredCredential(id: string): SshCredential | null {
  return credentialStore.readOrEmpty().find((c) => c.id === id) ?? null
}

/** The ids of the hosts that log in with credential `id`, linked or through their group. */
export function hostIdsUsingCredential(id: string): string[] {
  return hostIdsLoggingInWith(hostStore.readOrEmpty(), readGroupsOrEmpty(), id)
}

/** Same keep / clear / replace rules for its secrets as a host (mergeSecrets). */
export function saveCredential(raw: SshCredentialInput): CredentialsWriteResult {
  const fields = stripSecrets(cleanCredentialFields(raw))
  const problem = credentialFieldProblem(fields)
  if (problem) {
    const key =
      problem === 'name' ? 'main.ssh.credentialNameMissing' : problem === 'username' ? 'main.ssh.invalid.username' : 'main.ssh.credentialAuthInvalid'
    return { ok: false, error: t(key) }
  }
  const res = credentialStore.update((creds) => {
    const idx = fields.id ? creds.findIndex((c) => c.id === fields.id) : -1
    const prev = idx >= 0 ? creds[idx] : undefined
    const secrets = mergeSecrets(prev, raw)
    if (idx >= 0) creds[idx] = { ...fields, id: fields.id as string, ...secrets }
    else creds.push({ ...fields, id: fields.id || genCredentialId(), ...secrets })
    return creds
  })
  return res.ok ? { ok: true, credentials: listCredentials() } : res
}

/**
 * Deletes a credential no host links. One still in use is refused rather than unlinked: those
 * hosts would be left with no login at all. Read strictly: an unreadable hosts file must not
 * pass for "no host uses it".
 */
export function deleteCredential(id: string): CredentialsWriteResult {
  const hosts = hostStore.read()
  if (!hosts.ok) return { ok: false, error: t('main.ssh.hostsUnreadable', { error: hosts.error, file: hostStore.file }) }
  // Read strictly too: a group carrying it keeps it in use even with no host inheriting yet.
  const groups = readGroups()
  if (!groups.ok) return groups
  const used = credentialUsage(hosts.hosts, id, groups.groups)
  if (used > 0) return { ok: false, error: plural(t, 'main.ssh.credentialInUse', used) }
  const carriers = groupsUsingCredential(groups.groups, id).length
  if (carriers > 0) return { ok: false, error: plural(t, 'main.ssh.credentialInUseByGroups', carriers) }
  const res = credentialStore.update((creds) => creds.filter((c) => c.id !== id))
  return res.ok ? { ok: true, credentials: listCredentials() } : res
}

/** Every saved credential with its secrets, for a profile export. A failed read is an error. */
export function readCredentialsWithSecrets(): HostsRead<SshCredential> {
  return credentialStore.read()
}

/** Replace the saved credentials through `mutate`, fail-closed. For a profile import. */
export function updateCredentialsWith(mutate: (creds: SshCredential[]) => SshCredential[]): CredentialsWriteResult {
  const res = credentialStore.update(mutate)
  return res.ok ? { ok: true, credentials: listCredentials() } : res
}

// ─── Server groups: list, save, delete ─────────────────────────────────────

/** A group as the renderer sees it: its fields (none is secret), the name of the credential
 *  it carries, and how many hosts are in it and inherit that credential. */
export interface SshGroupPublic extends SshGroup {
  credentialName?: string
  hosts: number
  inheriting: number
}

export type GroupsWriteResult = { ok: true; groups: SshGroupPublic[] } | { ok: false; error: string }
export type GroupDeleteResult =
  | { ok: true; groups: SshGroupPublic[]; hosts: SshHostPublic[]; orphaned: string[] }
  | { ok: false; error: string }

export function listGroups(): SshGroupPublic[] {
  const hosts = hostStore.readOrEmpty()
  const creds = credentialStore.readOrEmpty()
  return readGroupsOrEmpty().map((g) => {
    const usage = groupUsage(hosts, g.id)
    const cred = g.credentialId ? creds.find((c) => c.id === g.credentialId) : undefined
    return { ...g, ...(cred ? { credentialName: cred.name } : {}), hosts: usage.hosts, inheriting: usage.inheriting }
  })
}

/** One saved group, for main only (comparing its credential before and after a save). */
export function getStoredGroup(id: string): SshGroup | null {
  return readGroupsOrEmpty().find((g) => g.id === id) ?? null
}

/** The ids of the hosts that inherit group `id`'s credential. */
export function hostIdsInheritingGroup(id: string): string[] {
  return hostIdsInheritingFrom(hostStore.readOrEmpty(), id)
}

function genGroupId(): string {
  return `grp_${randomUUID()}`
}

/** Creates or edits a group. The credential it carries must exist; none is fine. */
export function saveGroup(raw: SshGroupInput): GroupsWriteResult {
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : genGroupId()
  const group = cleanGroup({ ...raw, id })
  if (!group) return { ok: false, error: t('main.ssh.groupNameMissing') }
  if (group.credentialId) {
    const creds = credentialStore.read()
    if (!creds.ok) return { ok: false, error: t('main.ssh.credentialsUnreadable', { error: creds.error, file: credentialStore.file }) }
    if (!creds.hosts.some((c) => c.id === group.credentialId)) return { ok: false, error: t('main.ssh.credentialMissing') }
  }
  const groups = readGroups()
  if (!groups.ok) return groups
  const list = groups.groups
  const jumpError = checkGroupJump(group, list)
  if (jumpError) return { ok: false, error: jumpError }
  const vpnProblem = groupVpnProblem(group, hostStore.readOrEmpty())
  if (vpnProblem) return { ok: false, error: t(vpnProblem === 'vpnNoGateway' ? 'main.vpn.groupNoGateway' : 'main.vpn.groupMissing') }
  const idx = list.findIndex((g) => g.id === id)
  if (idx >= 0) list[idx] = group
  else list.push(group)
  const res = writeGroups(list)
  return res.ok ? { ok: true, groups: listGroups() } : res
}

/**
 * A group's gateway must be a saved host, and giving it to the group must not break any
 * host's jump that worked before: the gateway sitting in the group and so taking itself, a
 * gateway that has one, or a member that other servers go through.
 */
function checkGroupJump(group: SshGroup, groups: readonly SshGroup[]): string | null {
  const before = groups.find((g) => g.id === group.id)
  if ((before?.jumpHostId ?? '') === (group.jumpHostId ?? '')) return null
  const hosts = hostStore.readOrEmpty()
  if (group.jumpHostId && !hosts.some((h) => h.id === group.jumpHostId)) return t('main.ssh.jump.unknown')
  const after = [...groups.filter((g) => g.id !== group.id), group]
  const broken = jumpBreakage(hosts, groupJumpLookup(groups), groupJumpLookup(after))
  if (!broken) return null
  const gateway = hosts.find((h) => h.id === broken.jumpHostId)?.name ?? ''
  if (broken.problem === 'self' && broken.jumpHostId === group.jumpHostId) return t('main.ssh.jump.groupGatewayInGroup', { name: gateway })
  const who = hosts.find((h) => h.id === broken.hostId)?.name ?? ''
  return t('main.ssh.jump.groupBreaks', { name: who, error: jumpProblemMessage(broken.problem, hosts, broken.jumpHostId) })
}

/** The ids of group `id`'s hosts that take its gateway, for closing them when it changes. */
export function hostIdsTakingGroupJumpOf(id: string): string[] {
  return hostIdsTakingGroupJump(hostStore.readOrEmpty(), id)
}

/**
 * Deletes a group after moving its hosts to "no group" (the renderer confirms first). Hosts
 * first, then the group: a failure between the two leaves a group with no hosts, never hosts
 * pointing at a group that is gone. Those that inherited its credential have no login until
 * edited; `orphaned` lists them, for the caller to drop their pooled connections.
 */
export function deleteGroup(id: string): GroupDeleteResult {
  const groups = readGroups()
  if (!groups.ok) return groups
  let orphaned: string[] = []
  const hostsRes = hostStore.update((hosts) => {
    const res = removeGroupFromHosts(hosts, id)
    orphaned = res.orphaned
    return res.hosts
  })
  if (!hostsRes.ok) return hostsRes
  const res = writeGroups(groups.groups.filter((g) => g.id !== id))
  return res.ok ? { ok: true, groups: listGroups(), hosts: listHosts(), orphaned } : res
}

/** The saved groups, read strictly: a failed read is an error, not an empty list. */
export function readSavedGroups(): GroupsRead {
  return readGroups()
}

/** Replace the saved groups through `mutate`, refusing a file that cannot be read. For a
 *  profile import. */
export function updateGroupsWith(mutate: (groups: SshGroup[]) => SshGroup[]): { ok: true } | { ok: false; error: string } {
  const groups = readGroups()
  if (!groups.ok) return groups
  return writeGroups(mutate(groups.groups))
}

export interface ConnectAuthOptions {
  /** True only for the user-opened Remote Session: someone is there to answer a prompt. */
  interactive: boolean
  /** Asks the user for one keyboard-interactive answer; null when they cancelled. */
  askSecret?: (prompt: string, echo: boolean) => Promise<string | null>
  /** The gateway the connection rides, so the host key is trusted under its scope. */
  via?: TrustVia
}

/**
 * keyboard-interactive is only tried when it can be answered: someone is there to ask, or
 * the host has a login password for a lone password prompt. Otherwise a server offering it
 * would get an empty answer, which OpenSSH may take as a protocol error and drop the link
 * instead of failing the method, and the checks would end in a timeout rather than an
 * authentication failure.
 */
export function buildConnectConfig(h: EffectiveSshHost, opts: ConnectAuthOptions = { interactive: false }): ConnectConfig {
  // A host whose shared credential is gone has no login at all: say so, rather than dial
  // with an empty password.
  if (h.credentialMissing) throw new Error(t('main.ssh.credentialMissing'))
  const conf: ConnectConfig = {
    host: h.host,
    port: h.port || 22,
    username: h.username,
    readyTimeout: 120000,
    // A session left idle (its tab in the background while you work in a chat) is what a
    // VPN gateway or a NAT drops first, and the shell channels and every process under
    // them go with it. ssh2 sends nothing on its own; this is `ServerAliveInterval 15` /
    // `ServerAliveCountMax 4` for the ssh CLI — one minute of silence before giving up.
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    // Servers that only take keyboard-interactive (PAM, an OTP) are reached after the
    // primary method; the Client's `keyboard-interactive` listener answers (see
    // connectClient), so a config that tries it must never be connected without one.
    tryKeyboard: (opts.interactive && !!opts.askSecret) || (h.authType === 'password' && !!h.password),
    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
      verifyHostKey(h.host, h.port || 22, key, opts.via).then(callback, () => callback(false))
    }
  }
  if (h.authType === 'password') {
    conf.password = h.password
  } else if (h.authType === 'key' && h.privateKeyPath) {
    conf.privateKey = fs.readFileSync(h.privateKeyPath)
    if (h.passphrase) conf.passphrase = h.passphrase
  } else if (h.authType === 'agent') {
    conf.agent =
      process.env.SSH_AUTH_SOCK ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
  }
  return conf
}

/**
 * Answers ssh2's keyboard-interactive rounds for `conn`: a lone password prompt gets the
 * known login password (once), anything else goes to `askSecret` when interactive, and fails
 * otherwise (see keyboardInteractiveDecision). The listener belongs on the Client, not the
 * config, hence this helper for every place that dials.
 */
export function attachKeyboardInteractive(conn: Client, knownPassword: string | undefined, opts: ConnectAuthOptions): void {
  let autoAnswered = false
  conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts: KbdPrompt[], finish: (answers: string[]) => void) => {
    const answer = (answers: string[]) => {
      try {
        finish(answers)
      } catch {
        // The connection went away while the user was typing.
      }
    }
    const decision = keyboardInteractiveDecision(prompts, {
      knownPassword,
      autoAnswered,
      interactive: opts.interactive && !!opts.askSecret
    })
    if (decision.kind === 'answer') {
      if (decision.auto) autoAnswered = true
      answer(decision.answers)
      return
    }
    if (decision.kind === 'fail' || !opts.askSecret) {
      answer([])
      return
    }
    const ask = opts.askSecret
    void (async () => {
      const answers: string[] = []
      for (const p of prompts) {
        const v = await ask(p.prompt, !!p.echo)
        if (v === null) return answer([])
        answers.push(v)
      }
      answer(answers)
    })()
  })
}

/** Dials `conn` for `h`: the config plus the keyboard-interactive listener. Throws what
 *  buildConnectConfig or ssh2's connect throws (an unreadable or unparsable key). With `sock`
 *  (a channel through a gateway, see openJumpSocket) the connection rides it instead of
 *  dialling `h.host`; the host key is still checked against `h.host:h.port`. */
export function connectClient(
  conn: Client,
  h: EffectiveSshHost,
  opts: ConnectAuthOptions = { interactive: false },
  sock?: Duplex
): void {
  const conf = buildConnectConfig(h, opts)
  if (sock) conf.sock = sock
  attachKeyboardInteractive(conn, h.authType === 'password' ? h.password || undefined : undefined, opts)
  conn.connect(conf)
}

// ─── Jump hosts (gateways) ──────────────────────────────────────────────────

/** Opens (or reuses) the pooled connection of a saved host. Set by sftp.ts, which owns the
 *  pool, so a gateway's connection is shared by everything that goes through it and keeps
 *  its own login, including a password asked for when it opened. */
export type JumpDialer = (hostId: string, interactive: boolean) => Promise<{ ok: true; conn: Client } | { ok: false; error: string }>
export interface JumpPool {
  dial: JumpDialer
  /** Whether the host has a pooled connection, live or still opening. */
  isPooled: (hostId: string) => boolean
  /** Closes a gateway's pooled connection that a background check opened, unless a session
   *  tab or a pooled rider holds it by now. */
  release: (hostId: string) => void
}
let jumpPool: JumpPool | null = null
export function setJumpPool(pool: JumpPool): void {
  jumpPool = pool
}

/** The VPN a server needs on its gateway, and whether to bring it up without asking. */
export interface NeededVpn {
  profile: VpnProfile
  autoUp: boolean
}

/** `vpn`: the failure is about the VPN the server needs (one its gateway does not have). The
 *  ops agent's connects hear a generic message instead, as VPN state stays out of its context. */
export type JumpLookup = { ok: true; jump: EffectiveSshHost | null; vpn: NeededVpn | null } | { ok: false; error: string; vpn?: true }

/**
 * The gateway a saved host connects through, its login resolved, or null for direct. A jump
 * that does not resolve (itself, a deleted host, a gateway behind another gateway) is an
 * error, checked before anything dials: waiting on its own pooled entry would never end.
 */
export function getJumpFor(hostId: string): JumpLookup {
  const hosts = hostStore.readOrEmpty()
  const h = hosts.find((x) => x.id === hostId)
  if (!h) return { ok: true, jump: null, vpn: null }
  const groups = readGroupsOrEmpty()
  // resolveVpn resolves the jump too, and refuses a VPN that is asked for and not there:
  // connecting without it would dial the client's address on the wrong network.
  const res = resolveVpn(h, hosts, groupJumpLookup(groups), groupVpnLookup(groups))
  if (!res.ok) {
    const error = vpnLookupMessage(res.problem, hosts, res.jumpHostId)
    return res.problem === 'vpnNoGateway' || res.problem === 'vpnMissing' ? { ok: false, error, vpn: true } : { ok: false, error }
  }
  return {
    ok: true,
    jump: res.jump ? resolveHostAuth(res.jump, credentialStore.readOrEmpty(), groups).effective : null,
    vpn: res.vpn ? { profile: res.vpn, autoUp: res.autoUp } : null
  }
}

function vpnLookupMessage(problem: VpnResolveProblem, hosts: readonly StoredSshHost[], jumpHostId?: string): string {
  if (problem === 'vpnNoGateway' || problem === 'vpnMissing') return vpnResolveMessage(problem)
  return jumpProblemMessage(problem, hosts, jumpHostId)
}

export type JumpSocket = { ok: true; sock?: Duplex; gateway?: Client; via?: TrustVia } | { ok: false; error: string }

/**
 * The socket a connection to `host` rides: none for a direct host, or a channel opened from
 * its gateway's pooled connection to `host:port` (what `ssh -J` does). Each failure says which
 * hop failed. `interactive` is whether the gateway may ask for its password if it is not
 * connected yet; a background check that cannot connect it without asking reports it as not
 * connected instead.
 */
export async function openJumpSocket(host: EffectiveSshHost, interactive: boolean): Promise<JumpSocket> {
  const gw = await reachGateway(host.id, interactive)
  if (!gw.ok) return gw
  if (!gw.gateway) return { ok: true }
  // A background check only looks at the VPN: it never brings one up.
  if (gw.gateway.vpn) {
    const v = await ensureVpn(gw.gateway.conn, gw.gateway, gw.gateway.vpn.profile, { bringUp: false })
    if (!v.ok) return { ok: false, error: v.error }
  }
  return forwardThroughGateway(gw.gateway, host)
}

/** A reached gateway: its pooled connection and name, and the VPN the server needs on it;
 *  or none for a direct host. */
export type GatewayReach =
  | { ok: true; gateway?: { conn: Client; id: string; name: string; vpn: NeededVpn | null } }
  | { ok: false; error: string; vpn?: true }

/** The first half of openJumpSocket: the host's gateway connected (or reused), not yet any
 *  channel through it. Split so a Remote Session asks for the gateway's password before the
 *  target's, and holds no idle channel to the target while the user types. */
export async function reachGateway(hostId: string, interactive: boolean): Promise<GatewayReach> {
  const lookup = getJumpFor(hostId)
  if (!lookup.ok) return lookup
  const jump = lookup.jump
  if (!jump) return { ok: true }
  if (!jumpPool) return { ok: false, error: t('main.ssh.jump.gatewayFailed', { name: jump.name, error: 'not available' }) }
  const gw = await jumpPool.dial(jump.id, interactive)
  if (!gw.ok) {
    return {
      ok: false,
      error: interactive
        ? t('main.ssh.jump.gatewayFailed', { name: jump.name, error: gw.error })
        : t('main.ssh.jump.notConnected', { name: jump.name, error: gw.error })
    }
  }
  return { ok: true, gateway: { conn: gw.conn, id: jump.id, name: jump.name, vpn: lookup.vpn } }
}

/** The second half: a channel from the gateway to `host:port`, for the target's connection to
 *  ride. A refusal here is the target's (or the gateway's network's), and says so. */
export function forwardThroughGateway(gateway: { conn: Client; id: string; name: string }, host: EffectiveSshHost): Promise<JumpSocket> {
  const port = host.port || 22
  return new Promise<JumpSocket>((resolve) => {
    const unreachable = (error: string): void =>
      resolve({ ok: false, error: t('main.ssh.jump.targetUnreachable', { name: gateway.name, target: `${host.host}:${port}`, error }) })
    try {
      // The gateway's sshd opens the TCP connection to the target; the originator address is
      // only informational for it.
      gateway.conn.forwardOut('127.0.0.1', 0, host.host, port, (err, stream) => {
        if (err) unreachable(err.message)
        else resolve({ ok: true, sock: stream, gateway: gateway.conn, via: { id: gateway.id, name: gateway.name } })
      })
    } catch (e) {
      // A gateway connection that closed between the pool handing it over and now.
      unreachable(e instanceof Error ? e.message : String(e))
    }
  })
}

/**
 * A clearer message for the background checks when the failure is a secret nobody saved: a
 * password host without its password, or an encrypted key without its passphrase. Those
 * hosts are asked for it when a session opens, so "authentication failed" would mislead.
 */
function explainCheckFailure(h: SshHost, message: string): string {
  // Only an authentication failure: an unreachable server must still say so.
  if (h.authType === 'password' && !h.password && /authentication/i.test(message)) return t('main.ssh.noSavedPassword')
  if (h.authType === 'key' && !h.passphrase && keyNeedsPassphrase(message)) return t('main.ssh.noSavedPassphrase')
  return message
}

/** Every saved host as stored (a linked one without a login of its own), with its secrets,
 *  for a profile export. A failed read is an error, not an empty list. */
export function readHostsWithSecrets(): HostsRead<StoredSshHost> {
  return hostStore.read()
}

/** Replace the saved hosts through `mutate`, re-encrypted for this machine. Fail-closed,
 *  like every other write here. For a profile import. */
export function updateHostsWith(mutate: (hosts: StoredSshHost[]) => StoredSshHost[]): HostsWriteResult {
  return updateHosts(mutate)
}

/**
 * A saved host as it logs in: its login resolved through its shared credential, if it links
 * one (resolveHostAuth). What every connecting path uses, so none of them has to know about
 * credentials. A host whose credential is gone comes back marked `credentialMissing`, and the
 * connect paths refuse it.
 */
export function getHost(id: string): EffectiveSshHost | null {
  const h = getStoredHost(id)
  return h ? resolveHostAuth(h, credentialStore.readOrEmpty(), readGroupsOrEmpty()).effective : null
}

/** A saved host exactly as stored: a linked one has no login of its own. For the paths that
 *  edit or copy the record itself, never for connecting. */
export function getStoredHost(id: string): StoredSshHost | null {
  return hostStore.readOrEmpty().find((h) => h.id === id) ?? null
}

/**
 * Build an interactive `ssh` CLI invocation for a stored host, for the embedded terminal
 * to spawn directly (distinct from the headless ssh2 connection `runRemote` uses for
 * one-shot `claude -p` calls). Password auth has no non-interactive flag here — the user
 * is prompted by `ssh` itself inside the terminal.
 *
 * The CLI checks the server against the keys Argos trusts, not `~/.ssh/known_hosts`: an
 * endpoint whose full key is not stored yet goes through testConnection first (the same
 * trust prompt as every other first use), and a server Argos does not trust is an error
 * here rather than a terminal that opens anyway.
 */
export async function getSshTerminalCommand(
  hostId: string,
  sshPath = 'ssh'
): Promise<{ shell: string; args: string[]; remotePath?: string; claudePath?: string } | null> {
  const h = getHost(hostId)
  if (!h) return null
  if (h.credentialMissing) throw new Error(t('main.ssh.credentialMissing'))
  // Checked again here, not only on save: a host can arrive through a profile import or a
  // hosts file written by an older version.
  const problem = hostFieldProblem(h)
  if (problem) throw new Error(t(hostFieldProblemKey(problem)))
  const lookup = getJumpFor(hostId)
  if (!lookup.ok) throw new Error(lookup.error)
  const jump = lookup.jump
  if (jump) {
    if (jump.credentialMissing) throw new Error(t('main.ssh.jump.gatewayFailed', { name: jump.name, error: t('main.ssh.credentialMissing') }))
    const jumpProblem = hostFieldProblem(jump)
    if (jumpProblem) throw new Error(t('main.ssh.jump.gatewayFailed', { name: jump.name, error: t(hostFieldProblemKey(jumpProblem)) }))
    // The inner ssh checks the gateway against the same trusted list, so its key must be
    // there first, learnt the usual way (the trust prompt) like the target's below.
    const jumpPort = jump.port || 22
    if (!isEndpointKeyStored(jump.host, jumpPort)) {
      const check = await testConnection(jump.id)
      if (!isEndpointKeyStored(jump.host, jumpPort)) {
        const why = check.ok ? t('main.ssh.notTrusted') : `${t('main.ssh.notTrusted')} (${check.message})`
        throw new Error(t('main.ssh.jump.gatewayFailed', { name: jump.name, error: why }))
      }
    }
  }
  const port = h.port || 22
  // Behind a gateway the target is trusted under that gateway's scope, and the ssh CLI finds
  // it by alias (the generated known_hosts lists it only that way).
  const scopedKey = jump ? trustKey(h.host, port, jump.id) : null
  if (jump && !scopedKey) throw new Error(t('main.ssh.notTrusted'))
  if (!isEndpointKeyStored(h.host, port, jump?.id)) {
    // The verifier records the key before authentication, so a check that then fails to
    // log in (a password the terminal will ask for) still leaves the server trusted.
    const check = await testConnection(hostId)
    if (!isEndpointKeyStored(h.host, port, jump?.id)) {
      throw new Error(check.ok ? t('main.ssh.notTrusted') : `${t('main.ssh.notTrusted')} (${check.message})`)
    }
  }
  const knownHosts = await trustedKnownHostsPath()
  if (!knownHosts) throw new Error(t('main.ssh.notTrusted'))
  const args: string[] = ['-t']
  if (port !== 22) args.push('-p', String(port))
  if (h.authType === 'key' && h.privateKeyPath) {
    args.push('-i', h.privateKeyPath, '-o', 'IdentitiesOnly=yes')
  }
  // One argv element each, never shell-quoted; sshOptionPath only applies ssh's own
  // option syntax (the userData path can hold spaces, `%` and non-ASCII characters).
  args.push('-o', `UserKnownHostsFile=${sshOptionPath(knownHosts)}`, '-o', 'StrictHostKeyChecking=yes')
  if (jump) {
    // ProxyCommand rather than -J: -J's inner ssh gets none of the -o options above (it would
    // check the gateway against ~/.ssh/known_hosts), and the -F file that could carry them is
    // passed on unquoted, which breaks on a path with a space. See buildProxyCommand.
    const proxy = buildProxyCommand({ sshPath, jump, knownHostsPath: knownHosts, platform: process.platform })
    if (!proxy.ok) {
      const why =
        proxy.problem === 'port'
          ? t('main.ssh.jump.badPort', { name: jump.name })
          : proxy.problem === 'host'
            ? t('main.ssh.invalid.host')
            : proxy.problem === 'username'
              ? t('main.ssh.invalid.username')
              : t('main.ssh.jump.unsafePath', {
                  name: jump.name,
                  path: proxy.problem === 'keyPath' ? jump.privateKeyPath ?? '' : proxy.problem === 'knownHosts' ? knownHosts : sshPath
                })
      throw new Error(why)
    }
    args.push('-o', `ProxyCommand=${proxy.command}`)
    // Letters, digits and `-` only (trustAlias): safe as one argv element.
    if (scopedKey) args.push('-o', `HostKeyAlias=${trustAlias(scopedKey)}`)
  }
  const destination = sshDestinationArgs(h.username, h.host)
  if (!destination) throw new Error(t('main.ssh.invalid.host'))
  args.push(...destination)
  return { shell: sshPath, args, remotePath: h.remotePath, claudePath: h.claudePath }
}

/** Upper bound for a whole check (handshake + exec); readyTimeout only covers the handshake. */
const CHECK_TIMEOUT_MS = 20_000

/**
 * Does this host accept an SSH connection? Nothing more — it authenticates, reports how
 * long that took, and hangs up. This is what the Remote & WSL list's status dot reflects,
 * so it deliberately does NOT care whether Claude Code is installed: a box can be perfectly
 * reachable without it, and conflating the two meant a green/red dot that answered the wrong
 * question. Use testClaude for that.
 */
export function testConnection(id: string): Promise<{ ok: boolean; message: string }> {
  const host = getHost(id)
  if (!host) return Promise.resolve({ ok: false, message: t('main.ssh.hostNotFound') })
  if (host.credentialMissing) return Promise.resolve({ ok: false, message: t('main.ssh.credentialMissing') })

  return new Promise((resolve) => {
    const conn = new Client()
    const startedAt = Date.now()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, message: t('main.ssh.timedOut') }), CHECK_TIMEOUT_MS)
    conn.on('ready', () =>
      done({
        ok: true,
        message: t('main.ssh.connectedAs', { user: host.username, host: host.host, port: host.port, ms: Date.now() - startedAt })
      })
    )
    // Still dialled without a saved password: the host key is recorded before
    // authentication, which getSshTerminalCommand relies on.
    conn.on('error', (e) => done({ ok: false, message: explainCheckFailure(host, e.message) }))
    // A server that drops the link without an error (one that took an unanswered prompt as
    // a protocol error) ends the check now rather than at the timeout. done ignores the close
    // its own conn.end() causes.
    conn.on('close', () => done({ ok: false, message: explainCheckFailure(host, t('main.ssh.closedEarly')) }))
    dialForCheck(conn, host, () => settled, (message) => done({ ok: false, message }))
  })
}

/**
 * Starts a background check's connection: through the host's gateway when it has one (only
 * if the gateway is pooled already or connects without asking), directly otherwise. `failed`
 * gets the message of a failure before the dial; `isSettled` stops a dial for a check that
 * already ended (its timeout) while the gateway was being reached.
 */
function dialForCheck(conn: Client, host: EffectiveSshHost, isSettled: () => boolean, failed: (message: string) => void): void {
  void (async () => {
    // A gateway this check had to connect is closed again when the check ends, so a status
    // probe does not leave a session open on it that nothing would ever close.
    const lookup = getJumpFor(host.id)
    const gatewayId = lookup.ok ? lookup.jump?.id : undefined
    const opensGateway = !!gatewayId && !!jumpPool && !jumpPool.isPooled(gatewayId)
    const release = (): void => {
      if (opensGateway && gatewayId) jumpPool?.release(gatewayId)
    }
    const via = await openJumpSocket(host, false)
    if (!via.ok) {
      release()
      return failed(via.error)
    }
    if (isSettled()) {
      via.sock?.destroy()
      release()
      return
    }
    conn.once('close', release)
    try {
      connectClient(conn, host, { interactive: false, via: via.via }, via.sock)
    } catch (e) {
      via.sock?.destroy()
      release()
      failed(explainCheckFailure(host, e instanceof Error ? e.message : String(e)))
    }
  })()
}

/**
 * Connects and asks the host's `claude` for its version — the "is Claude Code actually
 * installed and runnable over there" check, which is a separate question from whether the
 * host is up (see testConnection).
 */
export function testClaude(id: string): Promise<{ ok: boolean; message: string }> {
  const host = getHost(id)
  if (!host) return Promise.resolve({ ok: false, message: t('main.ssh.hostNotFound') })
  if (host.credentialMissing) return Promise.resolve({ ok: false, message: t('main.ssh.credentialMissing') })
  const problem = hostFieldProblem(host)
  if (problem) return Promise.resolve({ ok: false, message: t(hostFieldProblemKey(problem)) })

  return new Promise((resolve) => {
    const conn = new Client()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, message: t('main.ssh.timedOut') }), CHECK_TIMEOUT_MS)
    conn.on('ready', () => {
      // exec runs the line through the remote user's shell: the path is one quoted word.
      const claude = host.claudePath ? remoteCommandWord(host.claudePath) : 'claude'
      conn.exec(`${claude} --version`, (err, stream) => {
        if (err) return done({ ok: false, message: t('main.ssh.connectedBut', { error: err.message }) })
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.stderr.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => {
          const text = out.trim()
          const firstLine = text.split('\n')[0] ?? ''
          // Previously this resolved ok:true whenever the stream closed, so a missing
          // `claude` reported success with "command not found" as its message.
          const looksLikeVersion = /\d+\.\d+\.\d+/.test(firstLine)
          if (looksLikeVersion) return done({ ok: true, message: firstLine })
          if (/not found|no such file/i.test(text)) {
            return done({
              ok: false,
              message: t('main.ssh.claudeNotFound', { path: host.claudePath || 'claude' })
            })
          }
          done({ ok: false, message: text.slice(0, 300) || t('main.ssh.claudeNoOutput') })
        })
      })
    })
    // Still dialled without a saved password: the host key is recorded before
    // authentication, which getSshTerminalCommand relies on.
    conn.on('error', (e) => done({ ok: false, message: explainCheckFailure(host, e.message) }))
    // A server that drops the link without an error (one that took an unanswered prompt as
    // a protocol error) ends the check now rather than at the timeout. done ignores the close
    // its own conn.end() causes.
    conn.on('close', () => done({ ok: false, message: explainCheckFailure(host, t('main.ssh.closedEarly')) }))
    dialForCheck(conn, host, () => settled, (message) => done({ ok: false, message }))
  })
}
